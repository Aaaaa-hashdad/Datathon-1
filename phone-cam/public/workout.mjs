
import {
  SquatAnalyzer, summarize, trends, analyzeFrames, toCSV
} from './analysis.mjs';

const $ = id => document.getElementById(id);
const key = 'aggie-workout-sessions-v1';
let sessions = [];
try {
  const saved = JSON.parse(localStorage.getItem(key) || '[]');
  if (Array.isArray(saved)) sessions = saved;
} catch {}

let active = null, analyzer = null, frames = [];

function persist() {
  try {
    localStorage.setItem(key, JSON.stringify(sessions));
  } catch {
    $('workout-status').textContent =
      'Browser storage full or unavailable. Export before closing.';
  }
}

function newSession() {
  return {
    session_id: crypto.randomUUID(),
    exercise: 'squat',
    collected_at: new Date().toISOString(),
    source: 'live-tracking',
    metadata: {
      participant_id: $('participant-id').value.trim(),
      location: $('workout-location').value.trim()
    },
    reps: []
  };
}

function render() {
  const current = active || sessions.at(-1);
  const s = summarize(current?.reps || []);
  $('workout-summary').textContent =
    `${s.rep_count} reps · score ${s.mean_score ?? '—'}/100`
    + ` · mean depth ${s.mean_depth ?? '—'}°`
    + ` · mean time ${s.mean_rep_seconds ?? '—'}s`
    + ` · tempo SD ${s.tempo_std_seconds ?? '—'}s`
    + ` · first-to-last score drop ${s.score_drop_first_to_last ?? '—'}`;

  $('workout-reps').replaceChildren(...(current?.reps || []).map(r => {
    const row = document.createElement('div');
    row.textContent = `#${r.rep_number}: ${r.form_score}/100`
      + ` · ${r.knee_angle_min}° · ${r.rep_time_sec}s`
      + ` · ${r.mistakes.join(', ') || 'targets met'}`;
    return row;
  }));

  const t = trends(sessions, current);
  $('workout-trends').textContent =
    `${t.sessions} other saved sessions · mean score ${t.mean_score ?? '—'} · `
    + (t.percentile === null
      ? 'Comparison requires 5 other sessions.'
      : `Percentile ${t.percentile} among saved sessions.`);
}

$('workout-start').onclick = () => {
  if (!$('workout-consent').checked) {
    $('workout-status').textContent =
      'Confirm participant consent before recording.';
    return;
  }
  active = newSession();
  analyzer = new SquatAnalyzer();
  frames = [];
  $('workout-start').disabled = true;
  $('workout-stop').disabled = false;
  $('workout-import').disabled = true;
  $('workout-status').textContent =
    'Recording keypoints only. Stand upright to begin.';
  render();
};

function stop() {
  if (!active) return;
  sessions.push(active);
  active = null;
  persist();
  $('workout-start').disabled = false;
  $('workout-stop').disabled = true;
  $('workout-import').disabled = false;
  render();
  $('workout-status').textContent =
    'Session finished. Incomplete reps excluded. Export files to keep/share results.';
}

$('workout-stop').onclick = stop;

window.addEventListener('tracking', ({detail}) => {
  if (!active) return;
  const pose = detail.pose ? {angles: detail.pose.angles} : null;
  if (pose) {
    for (const field of ['landmarks', 'worldLandmarks']) {
      pose[field] = detail.pose[field]?.map((p, i) =>
        i < 11 ? null : {
          x: p.x, y: p.y, z: p.z, visibility: p.visibility
        });
    }
  }
  const frame = {t: detail.t, pose};
  frames.push(frame);
  const result = analyzer.update(frame);
  $('workout-status').textContent = result.status;
  if (result.rep) {
    active.reps.push(result.rep);
    render();
  }
  if (frames.length >= 30000) stop();
});

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const all = () => active ? [...sessions, active] : sessions;

$('workout-csv').onclick = () =>
  download('workout-reps.csv', toCSV(all()), 'text/csv');

$('workout-json').onclick = () =>
  download('workout-sessions.json',
    JSON.stringify(all(), null, 2), 'application/json');

$('workout-frames').onclick = () =>
  download('workout-frames.json',
    JSON.stringify(frames), 'application/json');

$('workout-import').onchange = async event => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      throw new Error('Frame file must be smaller than 20 MB');
    }
    const imported = JSON.parse(await file.text());
    const reps = analyzeFrames(imported);
    if (!reps.length) {
      throw new Error(
        'No complete squats found. Import tracking frames, not session summaries.'
      );
    }
    const session = newSession();
    session.source = 'imported-tracking';
    session.reps = reps;
    sessions.push(session);
    persist();
    render();
    $('workout-status').textContent =
      `Imported ${reps.length} reps. Only import real collected tracking data here.`;
  } catch (e) {
    $('workout-status').textContent = e.message;
  }
  event.target.value = '';
};

render();
