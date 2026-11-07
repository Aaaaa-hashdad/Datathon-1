// Shares the live tracking with the app's MCP server, so Claude can ask about it.
// Sends the brain's state ~5x a second and a camera snapshot ~once a second to
// /state on this same server (it only accepts them from this computer).

const $ = (id) => document.getElementById(id);
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

const r = (n) => (n == null ? null : Math.round(n * 10) / 10);
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
    angles: tr.pose ? Object.fromEntries(Object.entries(tr.pose.angles || {}).map(([k, v]) => [k, r(v)])) : null,
    fps: Number.parseFloat(fpsText) || null,
    events: (s.events || []).slice(0, 40).map((ev) => ({ wall: ev.t, text: ev.text })),
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
