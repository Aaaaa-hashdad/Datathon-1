// Connects the brain to the viewer: listens for tracking results, shows the
// description in the side panel and as a caption on the video.
import { createBrain } from '/brain-core.js';

const brain = createBrain();
window.brain = brain;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const canvas = $('stage');
const ctx = canvas.getContext('2d');

let lastPanel = 0;

window.addEventListener('tracking', (e) => {
  const state = brain.update(e.detail);
  window.brainState = state;
  window.dispatchEvent(new CustomEvent('brain', { detail: state }));

  drawCaption(state.headline);

  // The panel doesn't need 30 updates a second; keeps text readable.
  const now = performance.now();
  if (now - lastPanel < 250) return;
  lastPanel = now;
  renderPanel(state);
});

function drawCaption(text) {
  if (!text || !canvas.width) return;
  const w = canvas.width;
  const fs = Math.max(16, Math.round(w / 38));
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  // wrap into at most 2 lines
  const words = text.split(' ');
  const lines = [''];
  for (const word of words) {
    const test = lines[lines.length - 1] ? lines[lines.length - 1] + ' ' + word : word;
    if (ctx.measureText(test).width > w - fs * 2 && lines[lines.length - 1]) {
      if (lines.length === 2) { lines[1] += '…'; break; }
      lines.push(word);
    } else lines[lines.length - 1] = test;
  }
  const pad = fs * 0.6, lh = fs * 1.3;
  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.fillRect(0, 0, w, pad * 2 + lh * lines.length - (lh - fs));
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, fs, pad + i * lh));
}

function renderPanel(s) {
  $('brainHeadline').textContent = s.headline;
  $('brainDetails').innerHTML = s.sections.map((sec) =>
    `<div class="bsec"><b>${esc(sec.title)}</b><ul>${sec.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('');
  const counts = Object.entries(s.counters).filter(([, n]) => n > 0);
  $('brainCounters').innerHTML = counts.length
    ? counts.map(([k, n]) => `<span class="chip">${esc(k)}: <b>${n}</b></span>`).join('')
    : '<span class="muted">No reps or jumps yet</span>';
  $('brainEvents').innerHTML = s.events.slice(0, 12).map((ev) =>
    `<li><time>${new Date(ev.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time> ${esc(ev.text)}</li>`).join('')
    || '<li class="muted">Nothing yet</li>';
}

$('brainReset').onclick = () => { brain.reset(); renderPanel({ ...window.brainState, counters: {}, events: [] }); };
