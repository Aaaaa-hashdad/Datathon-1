
import {SquatAnalyzer, summarize, trends} from './analysis.mjs';

// Provisional targets: calibrate against manually reviewed recordings.
export const EXERCISES = Object.freeze({
  squat: {label: 'Squat', joint: 'knee', target: 100},
  bicep_curl: {label: 'Bicep curl', joint: 'elbow', target: 60},
  bench_press: {label: 'Bench press', joint: 'elbow', target: 90}
});

const finite = n => typeof n === 'number' && Number.isFinite(n);
const round = n => Math.round(n * 10) / 10;

export function repFeedback(rep) {
  const config = EXERCISES[rep.exercise || 'squat'];
  const tips = [];

  if (rep.mistakes.includes('not_deep')) {
    tips.push(
      `Measured knee angle ${rep.knee_angle_min}°. ` +
      `Try a comfortable deeper squat; provisional target ${config.target}°.`
    );
  }

  if (rep.mistakes.includes('limited_curl')) {
    tips.push(
      `Smallest elbow angle was ${rep.elbow_angle_min}°. ` +
      `Try a comfortable fuller curl; provisional target ${config.target}°.`
    );
  }

  if (rep.mistakes.includes('limited_lowering')) {
    tips.push(
      `Smallest elbow angle was ${rep.elbow_angle_min}°. ` +
      `Review the lowering range; provisional target ${config.target}°. ` +
      'Do not force depth.'
    );
  }

  if (rep.mistakes.includes('too_fast')) {
    tips.push('Slow the next rep down and keep the movement controlled.');
  }

  return tips.length
    ? tips
    : ['Range of motion and tempo met the prototype targets.'];
}

export class ExerciseAnalyzer {
  constructor(exercise = 'squat') {
    if (!EXERCISES[exercise]) throw new Error('Unsupported exercise');
    this.exercise = exercise;
    this.config = EXERCISES[exercise];
    this.detector = new SquatAnalyzer();
    this.reps = [];
  }

  update(frame) {
    const config = this.config;
    const angles = frame?.pose?.angles;
    const mapped = {};

    // Reuse the extended -> flexed -> extended rep detector.
    // Adapt internal angle slots without changing original tracking data.
    for (const side of ['L', 'R']) {
      mapped[`${side} knee`] = angles?.[`${side} ${config.joint}`];
      mapped[`${side} hip`] = angles?.[`${side} hip`];
    }

    const samples = this.detector.active;
    const result = this.detector.update({
      ...frame,
      pose: frame?.pose ? {angles: mapped} : null
    });

    if (!result.rep) {
      if (this.exercise === 'squat') return result;

      const status = result.status
        .replace(
          'Keep hips, knees and ankles visible',
          'Keep shoulders, elbows and wrists visible'
        )
        .replaceAll(
          'stand upright',
          'return to a comfortable extended-arm position'
        )
        .replace(
          'Stand upright to begin',
          'Begin with arms comfortably extended (elbow angle at least 160°)'
        )
        .replace(
          'Ready: squat, then return to standing',
          'Ready: bend elbows, then return to comfortable extension'
        );

      return {status};
    }

    const raw = result.rep;
    const minimum = Math.min(...samples.map(s => s.knee));
    const seconds = (samples.at(-1).t - samples[0].t) / 1000;

    const flag = this.exercise === 'squat'
      ? 'not_deep'
      : this.exercise === 'bicep_curl'
        ? 'limited_curl'
        : 'limited_lowering';

    const mistakes = [];
    if (minimum > config.target) mistakes.push(flag);
    if (raw.mistakes.includes('too_fast')) mistakes.push('too_fast');

    const rangeScore = Math.max(
      0, 100 - Math.max(0, minimum - config.target) * 2
    );
    const tempoScore = Math.min(100, seconds / 1.5 * 100);

    const rep = {
      ...raw,
      exercise: this.exercise,
      joint: config.joint,
      joint_angle_min: round(minimum),
      mistakes,
      mistake: mistakes[0] || 'none',
      form_score: round(rangeScore * .8 + tempoScore * .2),
      rule_version: `${this.exercise}-v1`
    };

    if (this.exercise !== 'squat') {
      delete rep.knee_angle_min;
      delete rep.hip_angle;
      rep.elbow_angle_min = round(minimum);
    }

    this.reps.push(rep);

    return {
      rep,
      status: `Rep ${rep.rep_number}: ${repFeedback(rep).join(' ')}`
    };
  }
}

export function analyzeExerciseFrames(frames, exercise = 'squat') {
  if (!Array.isArray(frames)) {
    throw new Error('Expected a JSON array of tracking frames');
  }
  const analyzer = new ExerciseAnalyzer(exercise);
  for (const frame of frames) analyzer.update(frame);
  return analyzer.reps;
}

export function summarizeExercise(reps) {
  const result = summarize(reps);
  const values = reps
    .map(r => r.joint_angle_min ?? r.knee_angle_min)
    .filter(finite);

  const mean = values.length
    ? round(values.reduce((a, b) => a + b, 0) / values.length)
    : null;

  delete result.mean_depth;
  delete result.depth_target_met_percent;

  return {...result, mean_joint_angle_min: mean};
}

export function exerciseTrends(sessions, current = null) {
  const exercise = current?.exercise || 'squat';
  return trends(
    sessions.filter(s => (s.exercise || 'squat') === exercise),
    current
  );
}

export function exerciseCSV(sessions) {
  const fields = [
    'session_id', 'exercise', 'participant_id', 'location', 'time_block',
    'year', 'college', 'workout_freq', 'rep_number', 'joint',
    'joint_angle_min', 'knee_angle_min', 'elbow_angle_min', 'hip_angle',
    'rep_time_sec', 'side', 'form_score', 'mistake',
    'frame_count', 'rule_version'
  ];

  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  return [
    fields.join(','),
    ...sessions.flatMap(s => s.reps.map(r => {
      const row = {
        ...s.metadata,
        ...r,
        session_id: s.session_id,
        exercise: s.exercise || 'squat',
        joint: r.joint || 'knee',
        joint_angle_min: r.joint_angle_min ?? r.knee_angle_min
      };
      return fields.map(f => cell(row[f])).join(',');
    }))
  ].join('\n');
}
