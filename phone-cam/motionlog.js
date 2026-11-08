// Motion log: saves everything the tracker captures as Excel files, one per workout
// session, organised   <user>/<YYYY-MM-DD>/<HH-MM>.xlsx   (HH-MM = session start).
//
// A session keeps growing while someone is in view. It closes after SESSION_GAP_MIN
// minutes with nobody tracked (or when the user or the day changes); the next
// movement starts a new file.
//
// The file is RAW DATA ONLY: no posture labels, gestures or rep guesses. Deciding
// what the person was doing is the interpreter's (Claude's) job, even when the user
// picked an exercise (that pick is stored as a claim, `selected_exercise`).
//
// Sheets:
//   Summary  user, day, start/end, duration, samples, how to read the columns
//   Motion   one row per tracked video frame (~30 per second): 3D position of 17 body
//            points (cm, origin between the hips, y up, z negative = toward the camera),
//            the same points in the room lock (cm from the floor), feet contact,
//            8 joint angles smoothed + raw (degrees, 180 = straight). Blank = not seen well.
//   Jumps    one row per jump: air time, height from air time, feet peak, hip rise.
//
// Claude reads these through the MCP tools list_motion_logs / read_motion_log (mcp.js),
// using listLogs() and readSession() below.
//
// Storage: always written locally (MOTION_LOG_DIR); also uploaded to a private
// Supabase Storage bucket when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
// (phone-cam/.env or the environment). Files are re-uploaded (upsert) every minute
// while a session is open, and once more when it closes.

const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');
const ExcelJS = require('exceljs');

const SESSION_GAP_MIN = Number(process.env.SESSION_GAP_MIN || 15);
const FLUSH_MS = 60_000;
// Nobody logged for this long inside one session = the next sample starts a new recording
// (a black row separates them in the Excel file, and the `recording` column counts them).
const RECORDING_GAP_S = Number(process.env.RECORDING_GAP_S || 10);
const FETCH_TIMEOUT_MS = 30_000;   // a stalled request must never block later uploads
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ANGLES = ['L elbow', 'R elbow', 'L shoulder', 'R shoulder', 'L hip', 'R hip', 'L knee', 'R knee'];
// How to read the Motion sheet (also sent to Claude with the data).
const GUIDE = [
  'Raw data only: nothing here says what exercise was done; work that out from the movement.',
  'Positions: cm from the point between the hips; x = right on screen, y = up, z negative = closer to the camera. L/R = the person’s own left/right.',
  'Angles: inside joint angle in degrees, 180 = straight. Elbow: upper arm vs forearm. Shoulder: upper arm vs torso (0 = arm by the side). Hip: torso vs thigh. Knee: thigh vs shin.',
  'Rows: one per tracked video frame (about 30 per second), so elapsed_s has millisecond resolution.',
  'Room ("<joint> room X/Y", cm): where the body is in the ROOM, fixed to the floor, so jumps and steps show up (the hip-centred x/y/z do not move when the whole body jumps). Y = height above the floor (0 = floor; standing hip height is in Summary). X = sideways from the floor point between the feet at the lock (+ = right in the picture). "lock" = lock number (blank = not locked yet). "dist" = distance from the camera relative to the lock (1.2 = 20% farther). Locked once when the person stood straight and still; dropped when the phone moved.',
  'foot_cm = height of the lowest heel/toe point above the floor; feet = ground/air (air = both feet above 6 cm). Room columns and foot_cm use the raw (unsmoothed) points.',
  'Jumps sheet: each jump measured two independent ways: height_airtime = g*t^2/8 from the time in the air, feet_peak = highest foot_cm in the flight. Close agreement = trustworthy measurement.',
  'Angles: "<joint> angle" is smoothed (steadier, peaks slightly flattened); "<joint> raw angle" is straight from the model (use it for the exact top/bottom of a rep).',
  'recording = number of the recording inside this session. A solid black row in the Excel file (and a jump in elapsed_s) marks where a new recording starts after a pause; treat data across it as separate.',
  'Blank = that joint was not seen clearly. tracking "predicted (gap)" = a short tracking gap filled in by prediction.',
  'selected_exercise = what the user said they were doing. A claim: check it against the movement.',
];
const JOINTS = ['nose', 'L shoulder', 'R shoulder', 'L elbow', 'R elbow', 'L wrist', 'R wrist',
  'L hip', 'R hip', 'L knee', 'R knee', 'L ankle', 'R ankle', 'L heel', 'R heel', 'L toe', 'R toe'];
const JUMP_COLS = [['n', 'Jump', 6], ['recording', 'Recording', 10], ['takeoff_s', 'Takeoff (elapsed s)', 18], ['land_s', 'Landing (elapsed s)', 18],
  ['airtime_s', 'Air time (s)', 12], ['height_airtime_cm', 'Height from air time (cm)', 24], ['feet_peak_cm', 'Feet peak (cm)', 15],
  ['hip_rise_cm', 'Hip rise vs standing (cm)', 24], ['agree_cm', 'Difference (cm)', 15], ['fps', 'Frames/s in flight', 18], ['lock', 'Lock', 6], ['quality', 'Quality', 40]];
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

// Minimal .env reader (KEY=value lines), so secrets can live in phone-cam/.env.
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      // Like dotenv: a variable already in the environment wins, even if empty (empty = off).
      if (m && !Object.prototype.hasOwnProperty.call(process.env, m[1])) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}-${pad(d.getMinutes())}`;
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const safeUser = (u) => String(u || '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40) || 'guest';
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

function supabaseClient() {
  // Accept the project URL with or without an API path (people often paste .../rest/v1/).
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/(rest|storage|auth)\/v1(\/.*)?$/, '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
  const bucket = process.env.SUPABASE_BUCKET || 'motion-logs';
  if (!url || !key) return null;
  // New secret keys (sb_secret_...) go only in `apikey`; legacy service_role JWTs also in Authorization.
  const headers = { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }) };
  const base = `${url}/storage/v1`;
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  let bucketReady = null;
  async function ensureBucket() {
    bucketReady ??= fetch(`${base}/bucket`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, public: false }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).then(async (r) => {
      const body = await r.text();
      if (!r.ok && r.status !== 409 && !/already exists|duplicate/i.test(body)) throw new Error(`create bucket: ${r.status} ${body.slice(0, 200)}`);
    }).catch((e) => { bucketReady = null; throw e; });
    return bucketReady;
  }
  return {
    bucket, url,
    async upload(p, buf) {
      await ensureBucket();
      const r = await fetch(`${base}/object/${bucket}/${enc(p)}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': XLSX, 'x-upsert': 'true' }, body: buf, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`upload ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    },
    async list(prefix) {
      const r = await fetch(`${base}/object/list/${bucket}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`list: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return (await r.json()).map((o) => ({ name: o.name, folder: o.id == null, size: o.metadata?.size ?? null, updated: o.updated_at ?? null }));
    },
    async download(p) {
      const r = await fetch(`${base}/object/${bucket}/${enc(p)}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`download: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

function createMotionLog({ dir }) {
  loadEnv(path.join(__dirname, '.env'));
  fs.mkdirSync(dir, { recursive: true });
  const supa = supabaseClient();
  const userFile = path.join(dir, 'user.txt');
  let user = safeUser(process.env.MOTION_USER || (fs.existsSync(userFile) ? fs.readFileSync(userFile, 'utf8') : 'guest'));
  let session = null;
  let saving = Promise.resolve();
  const status = { lastSaved: null, lastUpload: null, error: null, closed: [], pendingUploads: [] };
  const retry = new Set();     // closed sessions whose last upload failed
  const recent = new Map();    // key -> recently closed session (rows still in memory)

  function accountKey(username) {
    // Preserve the existing folder where possible. Windows aliases case variants
    // and trailing dots, and guest recordings do not belong to a RevGym account.
    const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
    const invalid = !/^[A-Za-z0-9_.]{2,32}$/.test(username) || username.endsWith('.')
      || reserved.test(username) || username.toLowerCase() === 'guest';
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const alias = entries.some((entry) => entry.name.toLowerCase() === username.toLowerCase()
      && (entry.name !== username || !entry.isDirectory()));
    if (!invalid && !alias) return username;
    return `account-${createHash('sha256').update(username).digest('hex').slice(0, 32)}`;
  }

  function newSession(t) {
    const d = new Date(t);
    session = {
      user, day: dayOf(d), start: t, last: t, key: `${user}/${dayOf(d)}/${hhmm(d)}.xlsx`,
      rows: [], breaks: [], recording: 1, lastRow: t, selected: new Set(), locks: new Map(), jumps: [], dirty: true,
    };
  }

  // ---- input: a live sample from the viewer (same object the MCP server gets) ----
  function addSample(s) {
    const t = s.t || Date.now();
    // Newer viewers send every tracked frame in `frames`; older ones only the live sample.
    const batched = Array.isArray(s.frames);
    const frames = batched ? s.frames : [{ t, predicted: s.predicted, joints: s.joints, angles: s.angles }];
    const firstFrame = frames[0]?.t || t;
    if (session && (t - session.last > SESSION_GAP_MIN * 60_000 || session.user !== user || session.day !== dayOf(new Date(firstFrame)))) close();
    if ((!s.present && !(batched && frames.length)) || (!session && !frames.length)) return;
    if (!session) newSession(firstFrame);
    session.last = t;                       // someone is here, keep the session open
    if (s.room_lock) session.locks.set(s.room_lock.n, s.room_lock);
    if (s.selected_exercise) session.selected.add(s.selected_exercise);
    for (const f of frames) addRow(f, s.selected_exercise);
    for (const j of s.jumps || []) {
      if (session.jumps.some((x) => x.takeoff_t === j.takeoff_t)) continue;
      session.jumps.push({ ...j, recording: session.recording,
        takeoff_s: r3((j.takeoff_t - session.start) / 1000), land_s: r3((j.land_t - session.start) / 1000) });
      session.dirty = true;
    }
  }

  function addRow(f, selected) {
    const t = f.t || Date.now(), J = f.joints, a = f.angles || {}, ra = f.raw_angles || {};
    if (!J || !Object.values(J).some(Boolean)) return;          // no body joints: nothing to log
    if (session.rows.length && t <= session.lastRow) return;    // duplicate / out of order
    // A pause since the last logged frame: this is a new recording inside the same file.
    if (session.rows.length && t - session.lastRow > RECORDING_GAP_S * 1000) { session.recording++; session.breaks.push(session.rows.length); }
    session.lastRow = t;
    const row = {
      time: clock(t), recording: session.recording, elapsed_s: r3((t - session.start) / 1000),
      selected_exercise: selected || '',
      tracking: f.predicted ? 'predicted (gap)' : 'measured',
      model: f.model || '',
      joints_seen: Object.values(J).filter(Boolean).length,
    };
    for (const k of JOINTS) {
      const p = J[k];
      row[`${k} x`] = p ? p[0] : null; row[`${k} y`] = p ? p[1] : null; row[`${k} z`] = p ? p[2] : null;
    }
    row.lock = f.lock ?? null; row.dist = f.dist ?? null; row.foot_cm = f.foot_cm ?? null; row.feet = f.feet ?? null;
    for (const k of JOINTS) { const p = f.room?.[k]; row[`${k} room X`] = p ? p[0] : null; row[`${k} room Y`] = p ? p[1] : null; }
    for (const k of ANGLES) row[`${k} angle`] = a[k] == null ? null : Math.round(a[k]);
    for (const k of ANGLES) row[`${k} raw angle`] = ra[k] == null ? null : Math.round(ra[k]);
    session.rows.push(row);
    session.dirty = true;
  }

  async function workbook(s) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Phone Camera';
    wb.created = new Date(s.start);
    const sheet = (name, cols, rows, breaks) => {
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = cols.map(([key, header, width]) => ({ key, header, width: width || Math.max(10, header.length + 2) }));
      ws.getRow(1).font = { bold: true };
      if (!breaks) ws.addRows(rows);
      else rows.forEach((r, i) => {
        if (breaks.includes(i)) {   // solid black separator row between recordings
          const b = ws.addRow({ time: `Recording ${r.recording} starts` });
          for (let c = 1; c <= cols.length; c++) { const cell = b.getCell(c); cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } }; cell.font = { color: { argb: 'FFFFFFFF' }, bold: true }; }
        }
        ws.addRow(r);
      });
      return ws;
    };
    sheet('Summary', [['field', 'Field', 26], ['value', 'Value', 90]], [
      { field: 'User', value: s.user },
      { field: 'Day', value: s.day },
      { field: 'Session start', value: clock(s.start) },
      { field: 'Session end (last movement)', value: clock(s.last) },
      { field: 'Duration (min)', value: r1((s.last - s.start) / 60000) },
      { field: 'Motion samples', value: s.rows.length },
      { field: 'Recordings in this file', value: s.recording },
      { field: 'Exercise selected by user', value: [...s.selected].join(', ') || '(none)' },
      ...[...s.locks.values()].map((c) => ({ field: `Room lock #${c.n}`, value: `at ${clock(c.at)}: vertical from ${c.vertical}; scale from ${c.scale}; standing hip height ${c.hipCm} cm`
        + `${c.estHeightCm ? `; body height about ${c.estHeightCm} cm` : ''}${c.tiltDeg != null ? `; phone tilt ${c.tiltDeg}°` : '; no phone sensor (camera assumed still)'}; picture roll ${c.rollDeg}°; leg ${c.legCm} cm` })),
      ...(s.locks.size ? [] : [{ field: 'Room lock', value: 'not locked (nobody stood straight and still with the whole body and feet in view)' }]),
      { field: 'Jumps measured', value: s.jumps.length },
      ...GUIDE.map((value, i) => ({ field: i ? '' : 'How to read Motion', value })),
      { field: 'Session rule', value: `New session after ${SESSION_GAP_MIN} min with nobody in view` },
    ]);
    sheet('Motion', [
      ['time', 'Time', 10], ['recording', 'Recording', 10], ['elapsed_s', 'Elapsed (s)'], ['selected_exercise', 'Selected exercise', 16],
      ['tracking', 'Tracking', 14], ['model', 'Model', 22], ['joints_seen', 'Joints seen'],
      ...JOINTS.flatMap((k) => ['x', 'y', 'z'].map((c) => [`${k} ${c}`, `${k} ${c}`, 10])),
      ['lock', 'lock', 6], ['dist', 'dist', 7], ['foot_cm', 'foot_cm', 9], ['feet', 'feet', 8],
      ...JOINTS.flatMap((k) => ['X', 'Y'].map((c) => [`${k} room ${c}`, `${k} room ${c}`, 12])),
      ...ANGLES.map((k) => [`${k} angle`, `${k} angle (°)`, 12]),
      ...ANGLES.map((k) => [`${k} raw angle`, `${k} raw angle (°)`, 14]),
    ], s.rows, s.breaks);
    sheet('Jumps', JUMP_COLS, s.jumps);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // Write the session's file locally and to Supabase. Serialised so saves never overlap.
  function save(s) {
    if (!s || !s.dirty) return saving;
    s.dirty = false;
    saving = saving.then(async () => {
      try {
        const buf = await workbook(s);
        const local = path.join(dir, ...s.key.split('/'));
        // Excel locks a file it has open; then skip the local copy but still upload.
        let localErr = null;
        try {
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, buf);
        } catch (e) { localErr = `local copy not updated (${e.code || e.message}): close it in Excel`; }
        status.lastSaved = { key: s.key, t: Date.now(), bytes: buf.length, rows: s.rows.length, localError: localErr };
        if (supa) {
          await supa.upload(s.key, buf);
          status.lastUpload = { key: s.key, t: Date.now() };
        }
        status.error = null;
        retry.delete(s);
        status.pendingUploads = [...retry].map((x) => x.key);
      } catch (e) {
        s.dirty = true;                       // try again on the next flush
        if (s !== session) retry.add(s);      // closed sessions are retried until they upload
        // "fetch failed" alone hides the reason (no internet, DNS, timeout...)
        status.error = `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`;
        status.pendingUploads = [...retry].map((x) => x.key);
        console.error('[motionlog]', status.error);
      }
    });
    return saving;
  }

  function close() {
    if (!session) return saving;
    const s = session;
    session = null;
    recent.set(s.key, s);
    while (recent.size > 10) recent.delete(recent.keys().next().value);
    status.closed.unshift(s.key);
    status.closed.length = Math.min(status.closed.length, 10);
    s.dirty = true;
    return save(s);
  }

  const timer = setInterval(() => {
    if (session && Date.now() - session.last > SESSION_GAP_MIN * 60_000) close();
    else save(session);
    for (const s of retry) save(s);
  }, FLUSH_MS);
  timer.unref?.();

  function setUser(u) {
    const next = safeUser(u);
    if (next !== user) { close(); user = next; }
    try { fs.writeFileSync(userFile, user); } catch {}
    return user;
  }

  // ---- reading logs back (for Claude's MCP tools) ----
  const COLS = ['time', 'recording', 'elapsed_s', 'selected_exercise', 'tracking', 'model', 'joints_seen',
    ...JOINTS.flatMap((k) => ['x', 'y', 'z'].map((c) => `${k} ${c}`)), 'lock', 'dist', 'foot_cm', 'feet',
    ...JOINTS.flatMap((k) => ['X', 'Y'].map((c) => `${k} room ${c}`)), ...ANGLES.map((k) => `${k} angle`), ...ANGLES.map((k) => `${k} raw angle`)];

  // Folders/files under a prefix ('' = users, 'user' = days, 'user/day' = session files).
  async function listLogs(prefix = '') {
    const items = supa ? await supa.list(prefix).catch(() => listLocal(prefix)) : await listLocal(prefix);
    return { items, current: session && { key: session.key, rows: session.rows.length } };
  }

  // A session's rows + facts, from memory (open or recent) or its Excel file (local, then Supabase).
  async function readSession(key) {
    const s = key === 'current' || key === session?.key ? session : recent.get(key);
    if (s) return { key: s.key, user: s.user, day: s.day, start: clock(s.start), end: clock(s.last), selected: [...s.selected], rows: s.rows, open: s === session,
      jumps: s.jumps, locks: [...s.locks.values()].map((c) => `Room lock #${c.n} at ${clock(c.at)}: vertical from ${c.vertical}; scale from ${c.scale}; standing hip height ${c.hipCm} cm${c.tiltDeg != null ? `; phone tilt ${c.tiltDeg}°` : '; no phone sensor'}`) };
    const k = cleanKey(key);
    if (!k || !k.endsWith('.xlsx')) throw new Error(key === 'current' ? 'No session is being recorded right now.' : 'path must look like user/YYYY-MM-DD/HH-MM.xlsx');
    const buf = await readWorkbook(k);
    if (!buf) throw new Error(`No log at ${k}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Motion');
    if (!ws) throw new Error('That file has no Motion sheet');
    const head = ws.getRow(1).values.slice(1).map((h) => String(h).replace(/ \(°\)$/, '').replace(/^Time$/, 'time')
      .replace(/^Recording$/, 'recording').replace(/^Elapsed \(s\)$/, 'elapsed_s').replace(/^Selected exercise$/, 'selected_exercise').replace(/^Tracking$/, 'tracking').replace(/^Model$/, 'model').replace(/^Joints seen$/, 'joints_seen'));
    const rows = [];
    ws.eachRow((r, i) => { if (i > 1 && !/^Recording \d+ starts$/.test(String(r.getCell(1).value ?? ''))) { const v = r.values.slice(1); rows.push(Object.fromEntries(head.map((h, j) => [h, v[j] ?? null]))); } });
    const sum = Object.fromEntries((wb.getWorksheet('Summary')?.getSheetValues() || []).slice(2).map((r) => [r?.[1], r?.[2]]));
    const jumps = [];
    const js = wb.getWorksheet('Jumps');
    if (js) {
      const byHeader = Object.fromEntries(JUMP_COLS.map(([key, header]) => [header, key]));
      const jh = js.getRow(1).values.slice(1).map((h) => byHeader[String(h)] || String(h));
      js.eachRow((r, i) => { if (i > 1) { const v = r.values.slice(1); jumps.push(Object.fromEntries(jh.map((h, j) => [h, v[j] ?? null]))); } });
    }
    const locks = Object.entries(sum).filter(([f]) => /^Room lock #/.test(String(f))).map(([f, v]) => `${f} ${v}`);
    const [user, day, file] = k.split('/');
    return { key: k, user, day, start: sum['Session start'] || file.replace('.xlsx', '').replace('-', ':'), end: sum['Session end (last movement)'] || '',
      selected: String(sum['Exercise selected by user'] || '').split(', ').filter((x) => x && x !== '(none)'), rows, open: false, jumps, locks };
  }

  // ---- HTTP: /motionlog/* (this computer only) ----
  const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const okOrigin = (req) => !req.headers.origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.origin);
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
  });
  const cleanKey = (p) => {
    const parts = String(p || '').split('/').filter(Boolean);
    if (!parts.length || parts.some((x) => x === '..' || !/^[A-Za-z0-9_.-]+$/.test(x))) return null;
    return parts.join('/');
  };

  async function listLocal(prefix) {
    const d = path.join(dir, ...prefix.split('/').filter(Boolean));
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.name.endsWith('.xlsx'))
      .map((e) => ({ name: e.name, folder: e.isDirectory(), size: e.isDirectory() ? null : fs.statSync(path.join(d, e.name)).size }));
  }

  async function readWorkbook(key) {
    if (key === session?.key) return workbook(session);
    const local = path.join(dir, ...key.split('/'));
    if (fs.existsSync(local)) return fs.promises.readFile(local);
    if (recent.has(key)) return workbook(recent.get(key));
    return supa ? supa.download(key) : null;
  }

  async function route(req, res, url) {
    if (!isLocal(req) || !okOrigin(req)) return json(res, 403, { error: 'local only' });
    try {
      if (url.pathname === '/motionlog/status') {
        return json(res, 200, {
          user, storage: supa ? `supabase:${supa.bucket}` : 'local only', localDir: dir, sessionGapMin: SESSION_GAP_MIN,
          session: session && { key: session.key, rows: session.rows.length,
            startedAt: session.start, lastMovement: session.last },
          ...status,
        });
      }
      if (url.pathname === '/motionlog/user' && req.method === 'POST') return json(res, 200, { user: setUser((await readJson(req)).user) });
      if (url.pathname === '/motionlog/flush' && req.method === 'POST') {
        const end = (await readJson(req)).end;        // {"end": true} also closes the session
        if (session) session.dirty = true;
        for (const s of retry) save(s);
        await (end ? close() : save(session));
        return json(res, 200, { ok: !status.error, error: status.error, lastSaved: status.lastSaved, lastUpload: status.lastUpload });
      }
      if (url.pathname === '/motionlog/list') {
        const prefix = url.searchParams.get('prefix') || '';
        if (prefix && !cleanKey(prefix)) return json(res, 400, { error: 'bad prefix' });
        const items = supa ? await supa.list(prefix) : await listLocal(prefix);
        return json(res, 200, { prefix, source: supa ? 'supabase' : 'local', items });
      }
      if (url.pathname === '/motionlog/file') {
        const key = cleanKey(url.searchParams.get('path'));
        if (!key || !key.endsWith('.xlsx')) return json(res, 400, { error: 'path must be user/day/session.xlsx' });
        const buf = await readWorkbook(key);
        if (!buf) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${key.replace(/\//g, '_')}"` });
        return res.end(buf);
      }
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
    return json(res, 404, { error: 'not found' });
  }

  // The session being recorded, else the most recently closed one still in memory (null if none).
  function latestKey(owner = user) { return userKeys(owner).at(-1) ?? null; }

  // Session keys of one user that exist locally (plus the open session), oldest first.
  function userKeys(u = user) {
    const keys = new Set();
    const root = path.join(dir, safeUser(u));
    try {
      for (const day of fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
        for (const f of fs.readdirSync(path.join(root, day)).filter((x) => /^\d{2}-\d{2}\.xlsx$/.test(x)).sort()) keys.add(`${safeUser(u)}/${day}/${f}`);
      }
    } catch {}
    for (const k of recent.keys()) if (k.startsWith(`${safeUser(u)}/`)) keys.add(k);
    if (session && session.user === safeUser(u)) keys.add(session.key);
    return [...keys].sort();
  }

  async function dataKeys(owner, day) {
    const keys = new Set(userKeys(owner).filter((key) => !day || key.split('/')[1] === day));
    if (supa) {
      const days = day ? [day] : (await supa.list(owner).catch(() => []))
        .filter((item) => item.folder && /^\d{4}-\d{2}-\d{2}$/.test(item.name)).map((item) => item.name);
      for (const date of days) {
        const prefix = `${owner}/${date}`;
        const files = await supa.list(prefix).catch(() => []);
        for (const file of files) if (!file.folder && /^\d{2}-\d{2}\.xlsx$/.test(file.name)) keys.add(`${prefix}/${file.name}`);
      }
    }
    return [...keys].sort().reverse();
  }
  // When a session file last changed (for caching), or 'live' for one still in memory.
  function version(key) {
    if (key === session?.key) return `live:${session.rows.length}:${session.jumps.length}`;
    if (recent.has(key)) return `recent:${recent.get(key).rows.length}`;
    try { return String(fs.statSync(path.join(dir, ...key.split('/'))).mtimeMs); } catch { return 'missing'; }
  }

  return { addSample, route, close, setUser, listLogs, readSession, readWorkbook, latestKey, userKeys, dataKeys, accountKey,
    version, dir, GUIDE, COLS, JOINTS, ANGLES, get user() { return user; } };
}

module.exports = { createMotionLog };
