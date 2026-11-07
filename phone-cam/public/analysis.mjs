
// Squat analysis using the existing MediaPipe tracking events.
// Prototype thresholds: calibrate with manually reviewed real recordings.
export const RULES = Object.freeze({
  version: 'squat-v1', standing: 160, entry: 145, targetDepth: 100,
  minSeconds: 0.6, maxSeconds: 15, maxGapMs: 750, minFrames: 5
});

const finite = x => typeof x === 'number' && Number.isFinite(x);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const round = x => x === null ? null : Math.round(x * 10) / 10;

export function measure(frame) {
  if (!finite(frame?.t) || !frame.pose) return null;
  const sides = ['L', 'R'].map(side => {
    const knee = frame.pose.angles?.[`${side} knee`];
    const hip = frame.pose.angles?.[`${side} hip`];
    return finite(knee) && knee >= 0 && knee <= 180
      ? {side, knee, hip: finite(hip) ? hip : null}
      : null;
  }).filter(Boolean);
  return sides.length ? {t: frame.t, sides} : null;
}

export function scoreRep(samples, number) {
  const depth = Math.min(...samples.map(x => x.knee));
  const bottom = samples.find(x => x.knee === depth);
  const seconds = (samples.at(-1).t - samples[0].t) / 1000;
  const mistakes = [];
  if (depth > RULES.targetDepth) mistakes.push('not_deep');
  if (seconds < 1.5) mistakes.push('too_fast');
  const depthScore = Math.max(0, 100 - Math.max(0, depth - RULES.targetDepth) * 2);
  const tempoScore = Math.min(100, seconds / 1.5 * 100);
  return {
    rep_number: number,
    knee_angle_min: round(depth),
    hip_angle: round(bottom.hip),
    rep_time_sec: round(seconds),
    side: bottom.side,
    form_score: round(depthScore * .8 + tempoScore * .2),
    mistake: mistakes[0] || 'none',
    mistakes,
    frame_count: samples.length,
    rule_version: RULES.version
  };
}

export function feedback(rep) {
  const tips = [];
  if (rep.mistakes.includes('not_deep')) {
    tips.push(`Measured knee angle ${rep.knee_angle_min}°. Try a comfortable deeper squat; prototype target is ${RULES.targetDepth}°.`);
  }
  if (rep.mistakes.includes('too_fast')) {
    tips.push('Slow the next rep down and keep the movement controlled.');
  }
  return tips.length ? tips : ['Depth and tempo met the prototype targets.'];
}

export class SquatAnalyzer {
  constructor() {
    this.reps = [];
    this.lastT = null;
    this.resetMotion();
  }

  resetMotion() {
    this.ready = false;
    this.anchor = null;
    this.active = null;
    this.side = null;
  }

  update(frame) {
    if (!finite(frame?.t) || (this.lastT !== null && frame.t <= this.lastT)) {
      return {status: 'Ignored out-of-order frame'};
    }
    if (this.lastT !== null && frame.t - this.lastT > RULES.maxGapMs) {
      this.resetMotion();
    }
    this.lastT = frame.t;
    const m = measure(frame);
    if (!m) {
      this.resetMotion();
      return {status: 'Keep hips, knees and ankles visible'};
    }
    const sample = m.sides.find(s => s.side === this.side)
      || (!this.side && m.sides[0]);
    if (!sample) {
      this.resetMotion();
      return {status: 'Tracking lost: stand upright to restart'};
    }
    const s = {...sample, t: m.t};
    if (!this.ready) {
      if (s.knee >= RULES.standing) {
        this.ready = true;
        this.side = s.side;
        this.anchor = s;
      }
      return {
        status: this.ready
          ? 'Ready: squat, then return to standing'
          : 'Stand upright to begin'
      };
    }
    if (!this.active) {
      if (s.knee >= RULES.entry) {
        this.anchor = s;
        return {status: 'Ready: squat, then return to standing'};
      }
      this.active = [this.anchor];
    }
    this.active.push(s);
    const seconds = (s.t - this.active[0].t) / 1000;
    if (seconds > RULES.maxSeconds) {
      this.resetMotion();
      return {status: 'Rep timed out: stand upright to restart'};
    }
    if (s.knee >= RULES.standing) {
      const samples = this.active;
      this.active = null;
      this.anchor = s;
      if (seconds < RULES.minSeconds || samples.length < RULES.minFrames) {
        return {status: 'Movement too short to score'};
      }
      const rep = scoreRep(samples, this.reps.length + 1);
      this.reps.push(rep);
      return {
        status: `Rep ${rep.rep_number}: ${feedback(rep).join(' ')}`,
        rep
      };
    }
    return {status: 'Rep in progress: move at a controlled pace'};
  }
}

export function summarize(reps) {
  const scores = reps.map(r => r.form_score);
  const times = reps.map(r => r.rep_time_sec);
  const avgTime = mean(times);
  return {
    rep_count: reps.length,
    mean_score: round(mean(scores)),
    mean_depth: round(mean(reps.map(r => r.knee_angle_min))),
    mean_rep_seconds: round(avgTime),
    tempo_std_seconds: round(times.length
      ? Math.sqrt(mean(times.map(t => (t - avgTime) ** 2))) : null),
    score_drop_first_to_last: scores.length >= 2
      ? round(scores[0] - scores.at(-1)) : null,
    depth_target_met_percent: reps.length
      ? round(100 * reps.filter(r => !r.mistakes.includes('not_deep')).length / reps.length)
      : null
  };
}

export function trends(sessions, current = null) {
  const peers = sessions.filter(s =>
    s.session_id !== current?.session_id && s.reps.length);
  const scores = peers.map(s => summarize(s.reps).mean_score);
  const own = current?.reps.length ? summarize(current.reps).mean_score : null;
  return {
    sessions: scores.length,
    mean_score: round(mean(scores)),
    percentile: own === null || scores.length < 5 ? null
      : round(100 * scores.reduce((n, s) =>
          n + (s < own ? 1 : s === own ? .5 : 0), 0) / scores.length)
  };
}

export function analyzeFrames(frames) {
  if (!Array.isArray(frames)) {
    throw new Error('Expected a JSON array of tracking frames');
  }
  const analyzer = new SquatAnalyzer();
  for (const frame of frames) analyzer.update(frame);
  return analyzer.reps;
}

export function toCSV(sessions) {
  const fields = [
    'session_id', 'participant_id', 'location', 'time_block',
    'year', 'college', 'workout_freq', 'rep_number', 'knee_angle_min',
    'hip_angle', 'rep_time_sec', 'side', 'form_score', 'mistake',
    'frame_count', 'rule_version'
  ];
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [
    fields.join(','),
    ...sessions.flatMap(s => s.reps.map(r => fields.map(f =>
      cell(({...s.metadata, ...r, session_id: s.session_id})[f])
    ).join(',')))
  ].join('\n');
}
