// Shares the live tracking with the app's MCP server, so Claude can ask about it.
// Sends the brain's state ~5x a second and a camera snapshot ~once a second to
// /state on this same server (it only accepts them from this computer).

import { createRoomLock, ROOM_JOINTS } from '/roomlock.js';

const $ = (id) => document.getElementById(id);

// Room lock: floor-fixed coordinates in cm, feet contact and jumps (see roomlock.js).
// Updated on EVERY tracked frame; each frame is also queued for the motion log, so the
// log has the full frame rate (~30/s), not just the 5/s live state.
const room = createRoomLock();
window.roomLock = room;
let roomNow = { locked: false };
let frameQueue = [], jumpQueue = [];
const FRAME_QUEUE_MAX = 300;          // ~10 s at 30 fps if the server is slow

const heightIn = $('roomHeight');
try { heightIn.value = localStorage.getItem('roomHeight') || ''; } catch {}
room.setHeight(heightIn.value);
heightIn.onchange = () => {
  room.setHeight(heightIn.value);
  try { localStorage.setItem('roomHeight', heightIn.value); } catch {}
  room.relock();                      // a new height changes the scale: lock again
};
$('roomRelock').onclick = () => room.relock();

// Phone motion sensors (gravity → true vertical, rotation → "the phone moved").
let sensorBusy = false;           // never more than one request in flight (a busy page must not pile them up)
setInterval(() => {
  if (sensorBusy || document.hidden) return;
  sensorBusy = true;
  fetch('/sensor').then((r) => r.json()).then((s) => room.setSensor(s)).catch(() => {})
    .finally(() => { sensorBusy = false; });
}, 200);

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const rnd = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r1(v)])) : null);

// MediaPipe pose landmark ids. Left/right = the person's own side.
const JOINTS = ROOM_JOINTS;
function rawJoints(pose) {
  const lm = pose?.landmarks, W = pose?.worldLandmarks;
  if (!lm || !W) return null;
  const out = {};
  for (const [name, i] of Object.entries(JOINTS)) {
    const p = W[i], vis = lm[i]?.visibility ?? 0;
    out[name] = p && vis >= 0.5 ? [r1(p.x * 100), r1(-p.y * 100), r1(p.z * 100), Math.round(vis * 100) / 100] : null;
  }
  return out;
}

window.addEventListener('tracking', (e) => {
  const tr = e.detail;
  roomNow = room.update(tr);
  const c = $('stage');
  if (c?.width) room.draw(c.getContext('2d'), c.width, c.height, roomNow);
  const el = $('bodyBoxState');
  if (el) el.textContent = room.describe(roomNow);
  jumpQueue.push(...(roomNow.newJumps || []));
  if (!share.checked || window.camSource?.paused || !tr.pose) return;   // not during test-set evaluation
  const L = roomNow.lock;
  frameQueue.push({
    t: Date.now(),
    predicted: !!tr.pose.predicted,
    model: tr.model || null,
    joints: rawJoints(tr.pose),
    angles: rnd(tr.pose.angles),
    raw_angles: rnd(tr.pose.rawAngles),
    room: roomNow.locked ? roomNow.joints : null,
    lock: L ? L.n : null,
    foot_cm: roomNow.foot_cm ?? null, feet: roomNow.feet ?? null, dist: roomNow.dist ?? null,
  });
  if (frameQueue.length > FRAME_QUEUE_MAX) frameQueue.splice(0, frameQueue.length - FRAME_QUEUE_MAX);
});
const share = $('mcpShare');
const cmd = `claude mcp add --transport http phone-cam ${location.origin}/mcp`;
$('mcpCmd').textContent = cmd;
$('mcpCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(cmd); $('mcpCopy').textContent = 'Copied'; }
  catch { $('mcpCopy').textContent = 'Select & copy'; }
  setTimeout(() => { $('mcpCopy').textContent = 'Copy'; }, 1500);
};
try { share.checked = localStorage.getItem('mcpShare') !== 'off'; } catch {}

// ---- one-click connect (only inside the Electron app, which can edit Claude's settings) ----
const native = window.phoneCamNative;
const connBtn = $('claudeConnect'), discBtn = $('claudeDisconnect'), connInfo = $('claudeConn');

function describe(st) {
  const line = (name, s) => {
    if (s.error) return `${name}: ⚠️ ${s.error}`;
    if (!s.installed) return `${name}: not installed`;
    return `${name}: ${s.connected ? '✅ connected' : 'not connected'}`;
  };
  return `${line('Claude Code', st.claudeCode)} · ${line('Claude Desktop', st.claudeDesktop)}`;
}
async function refreshConn() {
  if (!native?.claudeStatus) {
    connBtn.disabled = true;
    connInfo.textContent = 'One-click connect works in the Phone Camera app. In a browser, use the manual setup below.';
    return;
  }
  const st = await native.claudeStatus();
  connInfo.textContent = describe(st);
  const any = st.claudeCode.connected || st.claudeDesktop.connected;
  discBtn.hidden = !any;
  connBtn.textContent = any ? 'Reconnect to Claude' : 'Connect to Claude';
  connBtn.disabled = !st.claudeCode.installed && !st.claudeDesktop.installed;
  if (connBtn.disabled) connInfo.textContent = 'No Claude app found on this computer (Claude Code or Claude Desktop).';
}
connBtn.onclick = async () => {
  connBtn.disabled = true;
  connInfo.textContent = 'Connecting…';
  try {
    const r = await native.claudeConnect();
    const msg = (name, x) => (x.ok ? `${name} ✅` : x.missing ? null : `${name} ⚠️ ${x.error}`);
    const parts = [msg('Claude Code', r.claudeCode), msg('Claude Desktop', r.claudeDesktop)].filter(Boolean);
    await refreshConn();
    connInfo.textContent = `${parts.join(' · ')}${r.claudeDesktop.restartNeeded ? ' · restart Claude Desktop to load it' : ''}. `
      + 'In Claude Code, start a new session to see the phone-cam tools.';
  } catch (e) {
    connInfo.textContent = 'Connect failed: ' + e.message;
  } finally { connBtn.disabled = false; }
};
discBtn.onclick = async () => {
  discBtn.disabled = true;
  try { await native.claudeDisconnect(); } finally { discBtn.disabled = false; }
  await refreshConn();
};
refreshConn();
share.onchange = () => { try { localStorage.setItem('mcpShare', share.checked ? 'on' : 'off'); } catch {} };

let lastSent = 0, lastSnap = 0, sending = false, lastTool = null;

window.addEventListener('brain', (e) => {
  if (!share.checked || window.camSource?.paused) return;     // not during test-set evaluation
  const now = performance.now();
  if (now - lastSent < 200 || sending) return;
  lastSent = now;
  const s = e.detail, tr = window.tracking || {};
  const fpsText = $('trackFps')?.textContent || '';
  const state = {
    present: s.present, view: tr.view, source: tr.source, parts: tr.parts,
    headline: s.headline, posture: s.posture ?? null, facts: s.facts ?? null,
    sections: s.sections, counters: s.counters, activities: s.activities, motions: s.motions,
    angles: tr.pose ? rnd(tr.pose.angles) : null,
    fps: Number.parseFloat(fpsText) || null,
    events: (s.events || []).slice(0, 40).map((ev) => ({ wall: ev.t, text: ev.text })),
    // Raw body joints for the motion log: 3D position in cm (origin = between the hips,
    // y = up, z negative = closer to the camera) + visibility. null = not seen well.
    joints: rawJoints(tr.pose),
    // Room-locked joints [X, Y] in cm from the floor point between the feet (see roomlock.js).
    room: roomNow.locked ? roomNow.joints : null,
    foot_cm: roomNow.foot_cm ?? null, feet: roomNow.feet ?? null,
    room_lock: roomNow.lock && (({ u, r, f0, oR, s0, ratio0, cU, cR, sensorUp, seg0, ...rest }) => rest)(roomNow.lock),
    predicted: !!tr.pose?.predicted,
    // Every tracked frame since the last post (the motion log keeps all of them) + finished jumps.
    frames: frameQueue.splice(0),
    jumps: jumpQueue.splice(0),
    // What the user said they're doing (exercise-coach session), a claim to be checked.
    selected_exercise: $('workout-stop') && !$('workout-stop').disabled ? $('workout-exercise')?.value || null : null,
  };
  sending = true;
  fetch('/state', { method: 'POST', body: JSON.stringify(state) })
    .then((res) => res.json()).then((j) => { lastTool = j.lastToolCall; })
    .catch(() => {})
    .finally(() => { sending = false; });

  if (now - lastSnap > 1000) {
    lastSnap = now;
    const src = $('stage');
    if (!src.width) return;
    const scale = Math.min(1, 960 / src.width);
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    c.toBlob((b) => { if (b) fetch('/state/snapshot', { method: 'POST', body: b }).catch(() => {}); }, 'image/jpeg', 0.75);
  }
});

setInterval(() => {
  const st = $('mcpStatus');
  if (!share.checked) { st.textContent = 'Not sharing: Claude sees nothing.'; return; }
  if (!lastTool) { st.textContent = 'Sharing. Claude hasn\'t asked anything yet.'; return; }
  const ago = Math.round((Date.now() - lastTool.t) / 1000);
  st.textContent = `Claude last used ${lastTool.tool} ${ago < 2 ? 'just now' : ago + ' s ago'}.`;
}, 1000);
