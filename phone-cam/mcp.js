// MCP (Model Context Protocol) server for Phone Camera.
//
// Lets Claude (Claude Code, Claude Desktop, ...) look at what the tracker and brain see:
// what the person is doing right now, a summary of the last N seconds, the event
// timeline, joint-angle history and the current camera frame.
//
// How data gets here: the viewer page (where tracking runs) POSTs its live brain state
// to /state a few times a second and a JPEG snapshot to /state/snapshot about once a
// second. This file keeps a rolling history and answers MCP tool calls from it.
//
// Transport: MCP "Streamable HTTP" at POST /mcp, answering with plain JSON (no streaming
// needed). Connect with:  claude mcp add --transport http phone-cam http://localhost:8080/mcp
//
// Privacy: everything here (including camera snapshots) is only served to this computer.

const HISTORY_SECONDS = 180;

function createMcp({ onState, motionLog } = {}) {
  const history = [];          // [{ t (ms), ...state }]
  let snapshot = null;         // { t, jpeg: Buffer }
  let lastToolCall = null;     // { t, tool }

  const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  // Block web pages on other sites from talking to us (DNS rebinding protection).
  const okOrigin = (req) => !req.headers.origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.origin);

  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('too big')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  // ---------- /state: the viewer pushes live data here ----------
  async function stateRoute(req, res, url) {
    if (!isLocal(req) || !okOrigin(req)) return json(res, 403, { error: 'local only' });
    try {
      if (url.pathname === '/state' && req.method === 'POST') {
        const s = JSON.parse((await readBody(req, 2e6)).toString('utf8'));
        s.t = Date.now();
        try { onState?.(s); } catch (e) { console.error('[state hook]', e.message); }
        delete s.frames;            // per-frame data is for the motion log; keep live history light
        history.push(s);
        while (history.length && history[0].t < s.t - HISTORY_SECONDS * 1000) history.shift();
        return json(res, 200, { ok: true, lastToolCall });
      }
      if (url.pathname === '/state/snapshot' && req.method === 'POST') {
        snapshot = { t: Date.now(), jpeg: await readBody(req, 5e6) };
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/state/mcp') return json(res, 200, { lastToolCall, samples: history.length });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    return json(res, 404, { error: 'not found' });
  }

  // ---------- tool helpers ----------
  const latest = () => history[history.length - 1] || null;
  const age = (t) => Math.round((Date.now() - t) / 1000);
  const noData = 'No live tracking data. Open the Phone Camera app (or http://localhost:8080/) and start a video source: the phone, a screen capture or a video file.';
  const staleNote = (s) => (age(s.t) > 5 ? `\nNote: this is ${age(s.t)} s old; tracking may be paused or the viewer closed.` : '');
  const r1 = (n) => Math.round(n * 10) / 10;

  function currentState() {
    const s = latest();
    if (!s) return text(noData);
    const lines = [`Now (${new Date(s.t).toLocaleTimeString()}): ${s.headline || 'nothing'}`];
    for (const sec of s.sections || []) lines.push(`${sec.title}: ${sec.items.join('; ')}`);
    const counts = Object.entries(s.counters || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
    if (counts.length) lines.push(`Counters: ${counts.join(', ')}`);
    if (s.angles) lines.push(`Joint angles (deg): ${Object.entries(s.angles).filter(([, v]) => v != null).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`);
    lines.push(`Video source: ${s.source || '?'} · tracking ${s.fps ? s.fps + ' fps' : ''} · parts: ${s.parts ? Object.entries(s.parts).filter(([, v]) => v).map(([k]) => k).join('+') : '?'}`);
    return text(lines.join('\n') + staleNote(s), { facts: s.facts || null });
  }

  function recentActivity({ seconds = 30 } = {}) {
    seconds = Math.max(2, Math.min(HISTORY_SECONDS, Number(seconds) || 30));
    const now = Date.now();
    const win = history.filter((h) => h.t >= now - seconds * 1000);
    if (!win.length) return text(history.length ? `No data in the last ${seconds} s.${staleNote(latest())}` : noData);
    const span = (win[win.length - 1].t - win[0].t) / 1000 || 1;
    const per = span / win.length;                                   // seconds per sample

    // posture as a timeline of segments
    const segs = [];
    for (const h of win) {
      const p = h.facts?.posture || (h.present ? 'unknown' : 'nobody in view');
      const last = segs[segs.length - 1];
      if (last && last.p === p) last.to = h.t; else segs.push({ p, from: h.t, to: h.t });
    }
    const merged = segs.filter((g) => (g.to - g.from) / 1000 >= 0.5 || segs.length === 1);
    const timeline = merged.map((g) => `${Math.round((g.from - now) / 1000)}s → ${g.p} (${r1((g.to - g.from) / 1000 + per)} s)`);

    const tally = (get) => {
      const c = {};
      for (const h of win) for (const k of get(h) || []) c[k] = (c[k] || 0) + 1;
      return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${r1(n * per)} s)`);
    };
    const activities = tally((h) => h.facts?.activities);
    const motions = tally((h) => (h.motions || []).map((m) => m.replace(/ \(\d.*\)$/, '')));
    const expressions = tally((h) => h.facts?.expressions);
    const handInfo = (side) => tally((h) => {
      const x = h.facts?.hands?.[side];
      return x ? [`${x.zone}${x.gesture && x.gesture !== 'other' ? ', ' + x.gesture : ''}`] : [];
    });

    // joint angles: min / average / max
    const angleStats = {};
    for (const h of win) for (const [k, v] of Object.entries(h.angles || {})) {
      if (v == null) continue;
      const a = (angleStats[k] ??= { min: v, max: v, sum: 0, n: 0 });
      a.min = Math.min(a.min, v); a.max = Math.max(a.max, v); a.sum += v; a.n++;
    }
    const angles = Object.entries(angleStats).map(([k, a]) => `${k} ${Math.round(a.min)}–${Math.round(a.max)} (avg ${Math.round(a.sum / a.n)})`);

    const c0 = win[0].counters || {}, c1 = win[win.length - 1].counters || {};
    const countDelta = Object.keys(c1).map((k) => [k, (c1[k] || 0) - (c0[k] || 0)]).filter(([, d]) => d > 0).map(([k, d]) => `${k} +${d}`);
    const events = (win[win.length - 1].events || []).filter((e) => e.wall >= now - seconds * 1000).reverse()
      .map((e) => `${Math.round((e.wall - now) / 1000)}s ${e.text}`);

    const out = [
      `Last ${seconds} s (${win.length} samples):`,
      `Posture timeline: ${timeline.join(' · ')}`,
      `Activities: ${activities.join(', ') || 'none detected'}`,
      `Movements: ${motions.slice(0, 10).join(', ') || 'mostly still'}`,
      `Left hand: ${handInfo('left').slice(0, 4).join(', ') || 'not seen'}`,
      `Right hand: ${handInfo('right').slice(0, 4).join(', ') || 'not seen'}`,
      `Expressions: ${expressions.join(', ') || 'none / face not tracked'}`,
      `Joint angle ranges (deg): ${angles.join(', ') || 'no body'}`,
      `Counts in this window: ${countDelta.join(', ') || 'none'}`,
      `Events: ${events.join(' | ') || 'none'}`,
      `Now: ${win[win.length - 1].headline}`,
    ];
    return text(out.join('\n') + staleNote(latest()));
  }

  function timeline({ limit = 20 } = {}) {
    const s = latest();
    if (!s) return text(noData);
    const ev = (s.events || []).slice(0, Math.max(1, Math.min(40, Number(limit) || 20)));
    if (!ev.length) return text('No events yet.');
    return text(ev.map((e) => `${new Date(e.wall).toLocaleTimeString()}  ${e.text}`).join('\n'));
  }

  function angleHistory({ joint, seconds = 20 } = {}) {
    const now = Date.now();
    seconds = Math.max(2, Math.min(HISTORY_SECONDS, Number(seconds) || 20));
    const win = history.filter((h) => h.t >= now - seconds * 1000);
    if (!win.length) return text(noData);
    const names = [...new Set(win.flatMap((h) => Object.keys(h.angles || {})))];
    if (!joint || !names.includes(joint)) return text(`Pick a joint: ${names.join(', ') || '(none tracked)'}`, null, !!joint);
    // about 2 samples per second is plenty to see reps and trends
    const step = Math.max(1, Math.round(win.length / (seconds * 2)));
    const pts = win.filter((_, i) => i % step === 0)
      .map((h) => `${r1((h.t - now) / 1000)}s: ${h.angles?.[joint] == null ? '—' : Math.round(h.angles[joint])}`);
    return text(`${joint} angle (degrees) over the last ${seconds} s, oldest first:\n${pts.join('\n')}`);
  }

  function getSnapshot() {
    if (!snapshot) return text('No camera frame yet. Open the viewer and start a video source.', null, true);
    return {
      content: [
        { type: 'image', data: snapshot.jpeg.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: `Camera frame with the tracking overlay, ${age(snapshot.t)} s old.${latest() ? ' Brain says: ' + latest().headline : ''}` },
      ],
    };
  }

  // ---------- recorded motion logs (Excel files per user / day / session) ----------
  const NL = String.fromCharCode(10);
  async function listMotionLogs({ user, day } = {}) {
    if (!motionLog) return text('Motion logging is off.', null, true);
    const prefix = [user, user && day].filter(Boolean).join('/');
    const { items, current } = await motionLog.listLogs(prefix);
    const what = !user ? 'Users' : !day ? `Days for ${user}` : `Sessions for ${user} on ${day} (file name = start time HH-MM)`;
    const lines = items.map((i) => `- ${i.name}${i.folder ? '/' : i.size ? `  (${Math.round(i.size / 1024)} KB)` : ''}`);
    return text([
      `${what}:`, ...(lines.length ? lines : ['(none)']),
      '',
      current ? `Recording now: ${current.key} (${current.rows} samples). Read it with path "current".` : 'Nothing is being recorded right now.',
      !user ? 'Next: list_motion_logs with user, then with user + day, then read_motion_log with path "user/day/HH-MM.xlsx".' : '',
    ].join(NL).trim());
  }

  const ANGLE_COLS = ['L elbow', 'R elbow', 'L shoulder', 'R shoulder', 'L hip', 'R hip', 'L knee', 'R knee'].map((k) => `${k} angle`);
  async function readMotionLog({ path: p = 'current', from_s, to_s, columns = 'angles', max_rows = 200 } = {}) {
    if (!motionLog) return text('Motion logging is off.', null, true);
    const s = await motionLog.readSession(p);
    let rows = s.rows.filter((r) => (from_s == null || r.elapsed_s >= from_s) && (to_s == null || r.elapsed_s <= to_s));
    const total = rows.length;
    const cap = Math.max(10, Math.min(600, Number(max_rows) || 200));
    const step = Math.ceil(total / cap) || 1;
    if (step > 1) rows = rows.filter((_, i) => i % step === 0);
    const pos = motionLog.JOINTS.flatMap((k) => ['x', 'y', 'z'].map((c) => `${k} ${c}`));
    // Room-locked columns (older files have "box" columns instead; blank columns are dropped below).
    const room = ['lock', 'dist', 'foot_cm', 'feet', ...motionLog.JOINTS.flatMap((k) => ['X', 'Y'].map((c) => `${k} room ${c}`)),
      'calib', ...motionLog.JOINTS.flatMap((k) => ['X', 'Y'].map((c) => `${k} box ${c}`))];
    const raw = ANGLE_COLS.map((c) => c.replace(/ angle$/, ' raw angle'));
    const pick = { positions: pos, room, box: room, raw_angles: raw, all: [...pos, ...room, ...ANGLE_COLS, ...raw] }[columns] || [...ANGLE_COLS, 'foot_cm', 'feet'];
    const cols = ['recording', 'elapsed_s', 'selected_exercise', 'tracking', 'model', ...pick];
    const used = cols.filter((c) => c === 'elapsed_s' || rows.some((r) => r[c] != null && r[c] !== ''));   // drop all-blank columns
    const csv = [used.join(','), ...rows.map((r) => used.map((c) => (r[c] == null ? '' : String(r[c]).includes(',') ? `"${r[c]}"` : r[c])).join(','))];
    const span = rows.length ? `${rows[0].elapsed_s}–${rows[rows.length - 1].elapsed_s} s` : 'no samples';
    const rate = s.rows.length > 1 ? (s.rows.length - 1) / Math.max(0.001, s.rows[s.rows.length - 1].elapsed_s - s.rows[0].elapsed_s) : null;
    // Jumps are measured on every frame, so list them in full even when rows are thinned out.
    const jumps = (s.jumps || []).filter((j) => (from_s == null || j.land_s >= from_s) && (to_s == null || j.takeoff_s <= to_s));
    const jcols = ['n', 'recording', 'takeoff_s', 'land_s', 'airtime_s', 'height_airtime_cm', 'feet_peak_cm', 'hip_rise_cm', 'agree_cm', 'fps', 'quality'];
    return text([
      `Motion log ${s.key}${s.open ? ' (still recording)' : ''}: user ${s.user}, ${s.day} ${s.start}–${s.end}, ${s.rows.length} samples${rate ? ` (~${Math.round(rate)} per second on average, pauses included)` : ''}.`,
      `User-selected exercise: ${s.selected.join(', ') || 'none'} (a claim; check it against the movement).`,
      ...(s.locks || []),
      `Showing ${rows.length} of ${total} samples in ${span}${step > 1 ? `, every ${step}th sample (zoom in with from_s/to_s for full frame rate)` : ''}; columns: ${columns}. All-blank columns are left out.`,
      ...motionLog.GUIDE.map((g) => `Note: ${g}`),
      '', `Jumps in this range: ${jumps.length}`,
      ...(jumps.length ? [jcols.join(','), ...jumps.map((j) => jcols.map((c) => j[c] ?? '').join(','))] : []),
      '', ...csv,
    ].join(NL));
  }

  function text(t, structured, isError) {
    return { content: [{ type: 'text', text: t }], ...(structured && { structuredContent: structured }), ...(isError && { isError: true }) };
  }

  const TOOLS = [
    {
      name: 'get_current_state',
      description: 'What the person in front of the camera is doing right now: posture, facing, each arm and leg, head direction, each hand (location, gesture), face expression, movement, rep counters and joint angles.',
      inputSchema: { type: 'object', properties: {} },
      run: currentState,
    },
    {
      name: 'get_recent_activity',
      description: 'Summary of the last N seconds: posture timeline, activities and how long they lasted, movements, hand positions/gestures, expressions, joint-angle ranges, reps counted and events. Use this to answer "what did I just do?" or to judge exercise form over a set.',
      inputSchema: { type: 'object', properties: { seconds: { type: 'number', description: 'How far back to look (2-180, default 30)' } } },
      run: recentActivity,
    },
    {
      name: 'get_timeline',
      description: 'The event timeline, newest first: posture changes, reps, jumps, gestures, waves, etc.',
      inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max events (default 20)' } } },
      run: timeline,
    },
    {
      name: 'get_joint_angle_history',
      description: 'One joint angle over time (about 2 samples per second), e.g. to count reps or check depth/range of motion. Joints: L/R elbow, shoulder, hip, knee.',
      inputSchema: {
        type: 'object',
        properties: {
          joint: { type: 'string', description: 'e.g. "R knee", "L elbow"' },
          seconds: { type: 'number', description: 'How far back (default 20)' },
        },
        required: ['joint'],
      },
      run: angleHistory,
    },
    {
      name: 'get_snapshot',
      description: 'The current camera frame (JPEG) with the skeleton overlay, so you can look at the scene yourself.',
      inputSchema: { type: 'object', properties: {} },
      run: getSnapshot,
    },
    {
      name: 'list_motion_logs',
      description: 'Browse the recorded motion logs (one Excel file per workout session, stored per user and day, also in Supabase). No arguments = users; with user = days; with user + day = session files.',
      inputSchema: { type: 'object', properties: {
        user: { type: 'string', description: 'User folder name' },
        day: { type: 'string', description: 'YYYY-MM-DD' },
      } },
      run: listMotionLogs,
    },
    {
      name: 'read_motion_log',
      description: 'Read a recorded session’s raw movement data as CSV: one row per video frame (~30 per second) with joint angles, 3D joint positions and room-locked positions (cm above the floor), plus every measured jump (air time, height). It contains NO labels: work out yourself what the person did (which exercise, how many reps, range of motion, tempo, left vs right, pauses, jump heights), and check the user-selected exercise against the movement. Tip: start with columns "angles" for the whole session, then zoom in with from_s/to_s and "room" or "raw_angles".',
      inputSchema: { type: 'object', properties: {
        path: { type: 'string', description: '"current" (default, the session being recorded) or user/YYYY-MM-DD/HH-MM.xlsx from list_motion_logs' },
        from_s: { type: 'number', description: 'Start, seconds since the session began' },
        to_s: { type: 'number', description: 'End, seconds since the session began' },
        columns: { type: 'string', enum: ['angles', 'raw_angles', 'positions', 'room', 'box', 'all'], description: 'angles (default): 8 smoothed joint angles + feet contact; raw_angles: the same angles unsmoothed (exact peaks); positions: body shape, x/y/z of 17 points in cm from the hips; room: where the body is in the room, X/Y in cm from the floor point between the feet, plus foot_cm, feet (ground/air) and dist: use it for jumps, steps, squat depth ("box" = same, for older files); all: everything' },
        max_rows: { type: 'number', description: 'Max rows to return, evenly sampled (default 200, max 600)' },
      } },
      run: readMotionLog,
    },
  ];

  // ---------- /mcp: JSON-RPC 2.0 over Streamable HTTP ----------
  async function handleRpc(msg) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'phone-cam', title: 'Phone Camera body tracker', version: '0.3.0' },
          instructions: 'Live body, hand and face tracking of a person in front of a phone camera. '
            + 'Use get_current_state for "what am I doing", get_recent_activity for summaries and exercise '
            + 'analysis, get_joint_angle_history for reps/range of motion, and get_snapshot to see the frame. '
            + 'Recorded workouts: list_motion_logs, then read_motion_log (raw angles/positions, no labels: you interpret them). '
            + 'Left/right always mean the person\'s own left/right.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
        lastToolCall = { t: Date.now(), tool: tool.name };
        try { return reply(await tool.run(msg.params?.arguments || {})); }
        catch (e) { return reply(text(`Tool failed: ${e.message}`, null, true)); }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  async function mcpRoute(req, res) {
    if (!isLocal(req) || !okOrigin(req)) return json(res, 403, { error: 'local only' });
    if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST, DELETE' }); return res.end(); }  // no server-initiated stream
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body;
    try { body = JSON.parse((await readBody(req, 1e6)).toString('utf8')); }
    catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const msgs = Array.isArray(body) ? body : [body];
    const replies = await Promise.all(msgs.filter((m) => m && m.id !== undefined && m.method).map(handleRpc));
    if (!replies.length) { res.writeHead(202); return res.end(); }     // only notifications / responses
    return json(res, 200, Array.isArray(body) ? replies : replies[0]);
  }

  return { stateRoute, mcpRoute };
}

module.exports = { createMcp };
