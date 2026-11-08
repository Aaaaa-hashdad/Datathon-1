// Person Statistics: everything one RevGym user has recorded, for the statistics page.
//
//   sets      every set (= motion-log recording) of every session, newest first, with
//             Claude's analysis when there is one (from feedback.js → analyses.json)
//   totals    active days, sessions, sets, analysed sets, reps, minutes, best jump
//   exercises per exercise: sets, reps, last done, best range of motion, avg tempo, score
//   daily     reps per exercise per day, and active minutes per day
//   rom       per exercise: range of motion of the main joint, set by set
//   jumps     every trustworthy (quality "ok") jump, with its height
//
// What counts as exercise and reps comes only from Claude's analyses: the raw log has no
// labels. Sets that were never analysed are listed with an "Analyze" button instead.
//
// Routes (this PC's viewer only): GET /stats/data, POST /stats/analyze?set=<key>#<rec>.

const { splitSets, normalizeResult } = require('./feedback');

const MIN_FRAMES = 20, MIN_SECONDS = 3;

function createStats({ motionLog, feedback }) {
  const cache = new Map();                   // key → { version, sets }

  // The sets of one session, from the log (cached until the session file changes).
  async function sessionSets(key) {
    const version = motionLog.version(key);
    const hit = cache.get(key);
    if (hit && hit.version === version) return hit.sets;
    let s;
    try { s = await motionLog.readSession(key); } catch { return []; }
    const [, day] = key.split('/');
    const sets = [];
    for (const { part, recording, rows } of splitSets(s.rows)) {
      const t0 = rows[0].elapsed_s ?? 0, t1 = rows[rows.length - 1].elapsed_s ?? 0;
      const seconds = t1 - t0;
      if (rows.length < MIN_FRAMES || seconds < MIN_SECONDS) continue;     // a glance at the camera, not a set
      const time = String(rows[0].time || '').slice(0, 8);
      const jumps = (s.jumps || []).filter((j) => (Number(j.recording) || 1) === recording && j.quality === 'ok'
        && j.takeoff_s >= t0 - 1 && j.land_s <= t1 + 1);
      sets.push({
        id: `${key}#${part}`, key, recording: part, day, time, at: `${day}T${time || '00:00:00'}`,
        seconds: Math.round(seconds), frames: rows.length,
        jumps: jumps.length, bestJumpCm: jumps.length ? Math.max(...jumps.map((j) => Number(j.height_airtime_cm) || 0)) : null,
        jumpList: jumps.map((j) => ({ cm: Number(j.height_airtime_cm), feet: Number(j.feet_peak_cm) })),
      });
    }
    cache.set(key, { version, sets });
    return sets;
  }

  async function data(user = motionLog.user) {
    const keys = motionLog.userKeys(user);
    const analyses = feedback.loadAnalyses(user);
    const sets = [];
    for (const key of keys) sets.push(...(await sessionSets(key)));
    // A set can hold several exercises (curls, then squats, … with no long pause in
    // between); each one is an "item" and is counted on its own everywhere below.
    for (const s of sets) {
      const a = analyses[s.id];
      if (!a) { s.analysis = null; continue; }
      const r = normalizeResult(a);
      s.analysis = {
        items: r.exercises.map((e) => ({
          exercise: e.exercise, reps: e.reps, side: e.side, mainJoint: e.main_joint, startS: e.start_s, endS: e.end_s,
          romMin: e.rom_min_deg, romMax: e.rom_max_deg, secPerRep: e.sec_per_rep, score: e.form_score,
        })),
        bestJumpCm: r.best_jump_cm, text: a.text || '', at: a.analyzedAt,
      };
    }
    sets.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const items = sets.flatMap((s) => (s.analysis?.items || []).map((it) => ({ ...it, set: s })));
    const days = [...new Set(sets.map((s) => s.day))].sort();
    const allJumps = sets.flatMap((s) => s.jumpList.map((j) => ({ at: s.at, day: s.day, setId: s.id, cm: j.cm, feet: j.feet })));

    // per exercise, most-done first (this order also fixes each exercise's colour)
    const ex = new Map();
    for (const a of items) {
      const e = ex.get(a.exercise) || { name: a.exercise, sets: 0, reps: 0, last: null, tempos: [], scores: [], romBest: null, joint: null };
      e.sets++; e.reps += a.reps || 0; e.last = a.set.day;
      if (a.secPerRep) e.tempos.push(a.secPerRep);
      if (a.score) e.scores.push(a.score);
      if (a.romMin != null && a.romMax != null) {
        const range = a.romMax - a.romMin;
        if (e.romBest == null || range > e.romBest) e.romBest = Math.round(range);
        e.joint = e.joint || a.mainJoint;
      }
      ex.set(a.exercise, e);
    }
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((p, q) => p + q, 0) / xs.length) * 10) / 10 : null);
    const exercises = [...ex.values()]
      .sort((a, b) => b.sets - a.sets || b.reps - a.reps || a.name.localeCompare(b.name))
      .map((e) => ({ name: e.name, sets: e.sets, reps: e.reps, last: e.last, bestRangeDeg: e.romBest, joint: e.joint, avgSecPerRep: avg(e.tempos), avgScore: avg(e.scores) }));

    const daily = days.map((day) => {
      const ds = sets.filter((s) => s.day === day);
      const reps = {};
      for (const a of items) if (a.set.day === day) reps[a.exercise] = (reps[a.exercise] || 0) + (a.reps || 0);
      return { day, minutes: Math.round(ds.reduce((p, s) => p + s.seconds, 0) / 6) / 10, sets: ds.length, reps };
    });

    const rom = {};
    for (const a of items) {
      if (a.romMin == null || a.romMax == null) continue;
      (rom[a.exercise] ||= []).push({ at: a.set.at, setId: a.set.id, min: a.romMin, max: a.romMax, range: Math.round(a.romMax - a.romMin), joint: a.mainJoint, reps: a.reps });
    }

    const totals = {
      days: days.length, sessions: keys.length, sets: sets.length, analyzed: sets.filter((s) => s.analysis).length,
      reps: items.reduce((p, a) => p + (a.reps || 0), 0),
      minutes: Math.round(sets.reduce((p, s) => p + s.seconds, 0) / 60),
      bestJumpCm: allJumps.length ? Math.round(Math.max(...allJumps.map((j) => j.cm)) * 10) / 10 : null,
      jumps: allJumps.length,
    };
    return {
      user, totals, exercises, daily, rom, jumps: allJumps,
      sets: sets.slice().reverse().map(({ jumpList, ...s }) => s),
    };
  }

  // GET /stats/data, POST /stats/analyze?set=…
  async function route(req, res, url, sendJson, owner, publish, username = owner) {
    try {
      if (url.pathname === '/stats/data' && req.method === 'GET') return sendJson(res, { ...await data(owner), user: username });
      if (url.pathname === '/stats/analyze' && req.method === 'POST') {
        const id = url.searchParams.get('set') || '';
        const m = id.match(/^([A-Za-z0-9_.-]+\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.xlsx)#(\d+(?:\.\d+)?)$/);
        if (!m || m[1].split('/')[0] !== owner) return sendJson(res, { ok: false, error: 'Unknown set.' }, 400);
        const r = await feedback.analyze(await feedback.buildSet(m[1], m[2]), publish);
        return sendJson(res, { ok: true, ...r });
      }
      return sendJson(res, { error: 'not found' }, 404);
    } catch (e) {
      return sendJson(res, { ok: false, error: e.message }, e.code === 429 ? 429 : 200);
    }
  }

  return { route, data };
}

module.exports = { createStats };
