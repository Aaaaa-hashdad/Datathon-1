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

function createMcp() {
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
  ];

  // ---------- /mcp: JSON-RPC 2.0 over Streamable HTTP ----------
  function handleRpc(msg) {
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
        try { return reply(tool.run(msg.params?.arguments || {})); }
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
    const replies = msgs.filter((m) => m && m.id !== undefined && m.method).map(handleRpc);
    if (!replies.length) { res.writeHead(202); return res.end(); }     // only notifications / responses
    return json(res, 200, Array.isArray(body) ? replies : replies[0]);
  }

  return { stateRoute, mcpRoute };
}

module.exports = { createMcp };
