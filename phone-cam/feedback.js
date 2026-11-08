// Set analysis by Claude (Claude Code on this PC, `claude -p`).
//
//  • Form Check's "Get feedback" button → the user's LAST SET (POST /feedback).
//  • Person Statistics' "Analyze" button → any earlier set (analyze(key, recording)).
//
// One set = one recording in the motion log (a pause of more than 10 s starts a new one).
// The app still only records; Claude does the interpreting. The set's numbers go to
// Claude in the prompt (on stdin), so it needs no tools and answers in ~10-30 s. It runs
// in the temp folder so no project settings, hooks or CLAUDE.md files get loaded, and
// uses the user's own Claude Code login.
//
// Besides the feedback text, Claude returns one line of JSON (exercise, reps, range of
// motion, tempo, best jump, form score). That is saved per user in
// <motion-log dir>/<user>/analyses.json, keyed "<session key>#<recording>", and is what
// Person Statistics counts and graphs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TIMEOUT_MS = 150_000;
const MAX_ROWS = 400;
const MIN_ROWS = 20;
const MODEL = process.env.FEEDBACK_MODEL || 'sonnet';

const ANGLES = ['L elbow', 'R elbow', 'L shoulder', 'R shoulder', 'L hip', 'R hip', 'L knee', 'R knee'];
const COLS = [
  ...ANGLES.map((a) => `${a} angle`), ...ANGLES.map((a) => `${a} raw angle`),
  'foot_cm', 'feet', 'dist',
  ...['L hip', 'R hip', 'L wrist', 'R wrist', 'L knee', 'R knee'].flatMap((j) => [`${j} room X`, `${j} room Y`]),
];
const JUMP_COLS = ['n', 'takeoff_s', 'land_s', 'airtime_s', 'height_airtime_cm', 'feet_peak_cm', 'hip_rise_cm', 'agree_cm', 'fps', 'quality'];

const INSTRUCTIONS = `You are the RevGym form coach. Below is raw body-tracking data from ONE recording the user made in front of their phone camera. Nothing in it says what the exercise was: work it out from the movement (it may be no exercise at all).

The recording may contain MORE THAN ONE exercise done back to back (for example curls, then squats, then jumps, without a long pause). Find every exercise that has at least one full rep and report EACH of them; do not drop one because another came first or had more reps. Short fidgets, setting up, holding still or a single shallow knee bounce are not exercises.

Write the feedback the user sees on screen, in plain text, at most 140 words:
- First, one line per exercise, in the order done: "Exercise: <name> · Reps: <n>" (or a single line "Exercise: none detected").
- Then 2 to 5 lines starting with "- ", each one concrete observation with numbers from the data, covering every exercise: range of motion (joint angles at top and bottom), tempo (seconds per rep, up vs down), consistency or fatigue across reps, left vs right, and jump heights if there are jumps (trust only jumps with quality "ok").
- Then: "Tip: <one specific thing to do differently next time>".
If the data is too short or too patchy to judge, say that in one line and suggest how to set up the camera.
Do not mention CSV, columns, data, tracking or that you are an AI. Talk to the user directly ("your elbow").

Finally add ONE last line that starts with "JSON: " followed by a single-line JSON object, used for the user's statistics:
{"exercises": [ one object per exercise found, in order: {"exercise": lowercase common name like "bicep curl", "squat", "push-up", "jumping jacks", "jump", "reps": integer, "start_s": t_s where it starts, "end_s": t_s where it ends, "side": "left"|"right"|"both", "main_joint": the joint that does the work, like "R elbow" or "L knee", "rom_min_deg": that joint's smallest angle in the reps, "rom_max_deg": its largest angle, "sec_per_rep": number, "form_score": integer 1-10} ], "best_jump_cm": number or null (only from jumps with quality "ok")}
Use "exercises": [] when there is no exercise. Use null for anything that does not apply.

How to read the data:`;

// Different spellings of the same exercise → one name, so statistics add them up.
function normalizeExercise(name) {
  if (!name || typeof name !== 'string') return null;
  let n = name.toLowerCase().trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!n || /^(none|no exercise|unknown|n\/a)/.test(n)) return null;
  n = n.replace(/\bbiceps\b/g, 'bicep').replace(/\bpushups?\b|\bpush ups?\b/g, 'push-up').replace(/\bsquats\b/g, 'squat')
    .replace(/\bcurls\b/g, 'curl').replace(/\bjumps\b/g, 'jump').replace(/\blunges\b/g, 'lunge');
  return n;
}

// A session's rows → sets: one per recording, and also split wherever nobody was tracked
// for more than SET_GAP_S (older logs were written before recordings existed). Each set
// gets a part id: "<recording>" or "<recording>.<n>" when a recording splits.
const SET_GAP_S = 10;
function splitSets(rows) {
  const byRec = new Map();
  for (const r of rows) {
    const rec = Number(r.recording) || 1;
    if (!byRec.has(rec)) byRec.set(rec, []);
    byRec.get(rec).push(r);
  }
  const sets = [];
  for (const [rec, rs] of byRec) {
    const parts = [[]];
    for (const r of rs) {
      const cur = parts[parts.length - 1], prev = cur[cur.length - 1];
      if (prev && r.elapsed_s - prev.elapsed_s > SET_GAP_S) parts.push([r]); else cur.push(r);
    }
    parts.forEach((p, i) => sets.push({ part: parts.length === 1 ? String(rec) : `${rec}.${i + 1}`, recording: rec, rows: p }));
  }
  return sets;
}

// A saved analysis → { exercises: [...], best_jump_cm }. Also upgrades the older
// one-exercise shape ({ exercise, reps, … }) so earlier analyses keep counting.
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
function normalizeResult(r) {
  if (!r || typeof r !== 'object') return { exercises: [], best_jump_cm: null };
  const list = Array.isArray(r.exercises) ? r.exercises : r.exercise ? [r] : [];
  const exercises = list.filter((e) => e && typeof e === 'object').map((e) => ({
    exercise: normalizeExercise(e.exercise), reps: num(e.reps), start_s: num(e.start_s), end_s: num(e.end_s),
    side: typeof e.side === 'string' ? e.side : null, main_joint: typeof e.main_joint === 'string' ? e.main_joint : null,
    rom_min_deg: num(e.rom_min_deg), rom_max_deg: num(e.rom_max_deg), sec_per_rep: num(e.sec_per_rep), form_score: num(e.form_score),
  })).filter((e) => e.exercise);
  return { exercises, best_jump_cm: num(r.best_jump_cm) };
}

function createFeedback({ motionLog }) {
  let busy = false;

  const storeFile = (user = motionLog.user) => path.join(motionLog.dir, user, 'analyses.json');
  function loadAnalyses(user) {
    try { return JSON.parse(fs.readFileSync(storeFile(user), 'utf8')); } catch { return {}; }
  }
  function saveAnalysis(id, record) {
    const user = id.split('/')[0];
    const all = loadAnalyses(user);
    all[id] = record;
    fs.mkdirSync(path.dirname(storeFile(user)), { recursive: true });
    fs.writeFileSync(storeFile(user), JSON.stringify(all, null, 1));
  }

  function boardResult(set, result) {
    const source = `${set.key.split('/').slice(1).join('/')}#${set.recording}`;
    if (!/^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.xlsx#\d+(?:\.\d+)?$/.test(source)) return null;
    const [day, file] = source.split('/');
    const time = file.slice(0, 5).replace('-', ':');
    const date = new Date(set.recordedAt || `${day}T${time}:00`);
    if (Number.isNaN(date.valueOf())) return null;
    const exercises = result.exercises.filter((item) => /^[a-z0-9][a-z0-9 -]{0,59}$/.test(item.exercise)
      && Number.isInteger(item.reps) && item.reps >= 1 && item.reps <= 1000
      && item.form_score >= 1 && item.form_score <= 10)
      .slice(0, 50).map((item) => ({ exercise: item.exercise, reps: item.reps, score: item.form_score }));
    if (result.exercises.length && !exercises.length) return null;
    return { source, recorded_at: date.toISOString(), exercises };
  }

  function savedBoardResults(owner) {
    return Object.values(loadAnalyses(owner))
      .filter((record) => record?.set?.key?.startsWith(`${owner}/`) && (Array.isArray(record.exercises) || record.exercise))
      .map((record) => boardResult(record.set, normalizeResult(record))).filter(Boolean);
  }

  // One set of a session (part = "<recording>" or "<recording>.<n>"), as a compact text
  // block for the prompt.
  async function buildSet(key, part) {
    const s = await motionLog.readSession(key);
    const found = splitSets(s.rows).find((x) => x.part === String(part));
    if (!found) throw new Error('That set no longer exists.');
    const rec = found.recording;
    let rows = found.rows;
    if (rows.length < MIN_ROWS) throw new Error('That set is too short to judge. Do a full set with your whole body in view, then try again.');
    const t0 = rows[0].elapsed_s, total = rows.length;
    const step = Math.ceil(rows.length / MAX_ROWS);
    if (step > 1) rows = rows.filter((_, i) => i % step === 0);
    const used = COLS.filter((c) => rows.some((r) => r[c] != null && r[c] !== ''));
    const fmt = (v) => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 10) / 10) : String(v).replace(/,/g, ';'));
    const csv = [['t_s', ...used].join(','), ...rows.map((r) => [fmt(r.elapsed_s - t0), ...used.map((c) => fmt(r[c]))].join(','))];
    const t1 = found.rows[found.rows.length - 1].elapsed_s;
    const jumps = (s.jumps || []).filter((j) => (Number(j.recording) || 1) === rec && j.takeoff_s >= t0 - 1 && j.land_s <= t1 + 1)
      .map((j) => ({ ...j, takeoff_s: j.takeoff_s - t0, land_s: j.land_s - t0 }));
    const dur = rows[rows.length - 1].elapsed_s - t0;
    const text = [
      `Set: ${Math.round(dur * 10) / 10} s, ${total} video frames${step > 1 ? ` (every ${step}th shown)` : ''}. t_s = seconds since the set started.`,
      `User-selected exercise: ${s.selected?.join(', ') || 'none'} (a claim; check it against the movement).`,
      ...(s.locks || []),
      ...motionLog.GUIDE.filter((g) => !/black row|recording = /.test(g)),
      '',
      `Jumps measured: ${jumps.length}`,
      ...(jumps.length ? [JUMP_COLS.join(','), ...jumps.map((j) => JUMP_COLS.map((c) => fmt(j[c])).join(','))] : []),
      '',
      ...csv,
    ].join('\n');
    const started = new Date(`${s.day}T${String(found.rows[0].time).slice(0, 8)}`);
    return { key, recording: String(part), seconds: Math.round(dur * 10) / 10, frames: total, text,
      recordedAt: Number.isNaN(started.valueOf()) ? null : started.toISOString() };
  }

  async function lastSet(owner = motionLog.user) {
    const key = motionLog.latestKey(owner);
    if (!key) throw new Error('No set recorded yet. Connect your phone, do a set, then press Get feedback.');
    const s = await motionLog.readSession(key);
    const sets = splitSets(s.rows);
    if (!sets.length) throw new Error('No set recorded yet. Connect your phone, do a set, then press Get feedback.');
    return buildSet(key, sets[sets.length - 1].part);
  }

  function runClaude(prompt) {
    return new Promise((resolve, reject) => {
      // Fixed arguments only (the set data goes in on stdin, never on the command line).
      // On Windows `claude` is a .cmd script, which needs a shell.
      const model = /^[\w.-]+$/.test(MODEL) ? MODEL : 'sonnet';
      const cmd = `claude -p --output-format text --model ${model}`;
      let child;
      try {
        child = process.platform === 'win32'
          ? spawn(cmd, { cwd: os.tmpdir(), shell: true, windowsHide: true })
          : spawn('claude', cmd.split(' ').slice(1), { cwd: os.tmpdir() });
      } catch (e) { return reject(new Error(`Could not start Claude Code: ${e.message}`)); }
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Claude took too long. Try again.')); }, TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not start Claude Code (${e.code || e.message}). Is it installed and signed in?`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && out.trim()) return resolve(out.trim());
        const why = (err || out).trim().split('\n').slice(-3).join(' ');
        reject(new Error(/not recognized|not found|ENOENT/i.test(why)
          ? 'Claude Code is not installed on this PC (the `claude` command was not found).'
          : `Claude Code failed${why ? `: ${why.slice(0, 300)}` : ` (exit code ${code})`}`));
      });
      child.stdin.end(prompt);
    });
  }

  // Split Claude's answer into the on-screen text and the JSON statistics line.
  function parseAnswer(answer) {
    const lines = answer.split(/\r?\n/);
    const i = lines.map((l) => l.trim()).findLastIndex((l) => /^JSON:/i.test(l));
    let result = null;
    if (i >= 0) {
      try {
        const raw = lines[i].trim().replace(/^JSON:\s*/i, '').replace(/^`+|`+$/g, '');
        result = JSON.parse(raw);
        lines.splice(i, 1);
      } catch { result = null; }
    }
    return { text: lines.join('\n').trim(), result: result && normalizeResult(result) };
  }

  // Analyse one set and save the result. Returns { text, result, set }.
  async function analyze(set, publish) {
    if (busy) { const e = new Error('Already working on a set. Try again in a moment.'); e.code = 429; throw e; }
    busy = true;
    try {
      const t0 = Date.now();
      const { text, result } = parseAnswer(await runClaude(`${INSTRUCTIONS}\n${set.text}`));
      const info = { key: set.key, recording: set.recording, seconds: set.seconds, frames: set.frames, recordedAt: set.recordedAt };
      const id = `${set.key}#${set.recording}`;
      try { saveAnalysis(id, { ...(result || {}), text, set: info, analyzedAt: new Date().toISOString(), model: MODEL }); }
      catch (e) { console.error('[feedback] could not save analysis', e.message); }
      const summary = result && boardResult(info, result);
      let published = null;
      if (summary && publish) {
        try { await publish([summary]); published = true; }
        catch { published = false; }
      }
      return { text, result, set: info, id, published, ms: Date.now() - t0 };
    } finally { busy = false; }
  }

  // POST /feedback  → { ok, text, set } or { ok: false, error }.   ?dry=1 → the prompt only.
  async function route(req, res, url, sendJson, owner, publish) {
    try {
      const set = await lastSet(owner);
      if (url.searchParams.get('dry')) {
        return sendJson(res, { ok: true, set: { key: set.key, recording: set.recording, seconds: set.seconds, frames: set.frames }, prompt: `${INSTRUCTIONS}\n${set.text}` });
      }
      return sendJson(res, { ok: true, ...(await analyze(set, publish)) });
    } catch (e) {
      return sendJson(res, { ok: false, error: e.message }, e.code === 429 ? 429 : 200);
    }
  }

  return { route, analyze, buildSet, lastSet, loadAnalyses, savedBoardResults, normalizeExercise };
}

module.exports = { createFeedback, splitSets, normalizeResult };
