// Test set + evaluator.
//
// A test set is a folder of short clips, each labelled with what really happens in it
// (posture, where each hand is, gestures, head direction, activities). The evaluator
// steps through every clip frame by frame, runs the tracker + brain on each frame and
// scores the brain's structured `facts` against the labels, for one or more model
// pipelines, so changes are judged by numbers across all clips, not by one screenshot.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- label vocabulary (must match brain-core.js facts) ----------
const V = {
  posture: ['', 'standing', 'sitting', 'squatting', 'lying', 'kneeling', 'lunge', 'one leg'],
  facing: ['', 'toward', 'side', 'away'],
  turn: ['', 'straight', 'left', 'right'],
  pitch: ['', 'level', 'down', 'up'],
  zone: ['', 'not visible', 'face', 'head', 'overhead', 'chest', 'waist', 'hip', 'lap', 'down'],
  gesture: ['', 'open', 'fist', 'pointing', 'thumbs_up', 'thumbs_down', 'peace', 'ok', 'pinch', 'rock', 'shaka', 'other'],
};
// Setups to compare: which parts are on, and which model runs them.
const CONFIGS = [
  // Body only (hands and face are permanently off in the tracker).
  { id: 'holbody', label: 'Body · Holistic', pipe: 'holistic', opts: { body: true, hands: false, face: false }, on: true },
  { id: 'body', label: 'Body · accurate body model', pipe: 'heavy', opts: { body: true, hands: false, face: false }, on: true },
  { id: 'bodyfast', label: 'Body · fast body model', pipe: 'full', opts: { body: true, hands: false, face: false } },
];
const CFG = Object.fromEntries(CONFIGS.map((c) => [c.id, c]));
const ACTIVITIES = ['waving', 'clapping', 'jumping', 'walking', 'stepping', 'nodding', 'shaking_head', 'squats', 'curls', 'jumping_jacks'];
const ZONE_HELP = 'face = touching the face · head = beside the head · overhead · chest · waist · hip = hand on hip · lap = low in front (lap/desk) · down = hanging by the side';

// ---------- panel ----------
const panel = $('testsetPanel');
panel.innerHTML = `
  <div class="tsBox">
    <div class="tsHead"><h2>Test set</h2><span class="muted" id="tsDir"></span><span class="spacer"></span><button id="tsClose">Close</button></div>
    <div class="tsCols">
      <div class="tsCol">
        <h3>1 · Labels: what really happens in the clip</h3>
        <small>Leave a field blank to not score it. Label the whole clip, so keep each clip to one situation (5–15 s).</small>
        <div class="tsForm">
          ${sel('posture', 'Posture')}${sel('facing', 'Facing the camera')}
          ${sel('turn', 'Head turned')}${sel('pitch', 'Head up/down')}
          ${sel('zone', 'Left hand is', 'lzone')}${sel('gesture', 'Left hand shape', 'lgest')}
          ${sel('zone', 'Right hand is', 'rzone')}${sel('gesture', 'Right hand shape', 'rgest')}
        </div>
        <small class="muted">${ZONE_HELP}. Left/right = the person's own.</small>
        <div class="tsActs"><b>Activities happening</b> (anything unticked must NOT be detected):<br>
          ${ACTIVITIES.map((a) => `<label><input type="checkbox" value="${a}"> ${a.replace('_', ' ')}</label>`).join('')}
        </div>
        <div class="tsForm">
          <label>Squat reps <input type="number" id="ts-c-squats" min="0" placeholder="–"></label>
          <label>Jumps <input type="number" id="ts-c-jumps" min="0" placeholder="–"></label>
        </div>
        <label class="tsNotes">Notes <input id="ts-notes" placeholder="e.g. sitting on couch, typing, left hand on chin"></label>

        <h3>2 · Add a clip</h3>
        <div class="tsRow">
          <button id="tsRec">● Record test clip</button><span id="tsRecInfo" class="muted"></span>
        </div>
        <small class="muted">Records the raw video (no skeleton drawn on it) from the current source:
          phone video, screen capture or video file. Saved with the labels above.
          You can also drop your own video files into the folder and label them below.</small>
      </div>

      <div class="tsCol">
        <h3>3 · Clips</h3>
        <div id="tsList" class="tsList"></div>
        <div class="tsRow">
          <button id="tsLoadLabels">Load labels into form</button>
          <button id="tsSaveLabels">Save form as labels</button>
          <button id="tsRefresh">Refresh</button>
        </div>

        <h3>4 · Evaluate</h3>
        <div class="tsRow">
          ${CONFIGS.map((c) => `<label title="${c.pipe}"><input type="checkbox" class="tsPipe" value="${c.id}"${c.on ? ' checked' : ''}> ${c.label}</label>`).join('')}
        </div>
        <div class="tsRow">
          <label>Sample <select id="tsFps"><option value="10">10 fps</option><option value="15" selected>15 fps</option><option value="30">30 fps</option></select></label>
          <button id="tsRun">Run evaluation</button><span id="tsProgress" class="muted"></span>
        </div>
        <div id="tsReport"></div>
      </div>
    </div>
  </div>`;

function sel(kind, label, id = kind) {
  return `<label>${label}<select id="ts-${id}">${V[kind].map((v) => `<option value="${v}">${v || '— not scored —'}</option>`).join('')}</select></label>`;
}

$('tsOpen').onclick = () => { panel.hidden = false; refresh(); };
$('tsClose').onclick = () => { panel.hidden = true; };

// ---------- form <-> labels ----------
function readForm() {
  const g = (id) => $(`ts-${id}`).value || null;
  const n = (id) => ($(`ts-${id}`).value === '' ? null : Number($(`ts-${id}`).value));
  return {
    posture: g('posture'), facing: g('facing'),
    head: { turn: g('turn'), pitch: g('pitch') },
    hands: { left: { zone: g('lzone'), gesture: g('lgest') }, right: { zone: g('rzone'), gesture: g('rgest') } },
    activities: [...panel.querySelectorAll('.tsActs input:checked')].map((c) => c.value),
    counts: { squats: n('c-squats'), jumps: n('c-jumps') },
    notes: $('ts-notes').value,
    labelledAt: new Date().toISOString(),
  };
}
function fillForm(L) {
  const s = (id, v) => { $(`ts-${id}`).value = v ?? ''; };
  s('posture', L?.posture); s('facing', L?.facing); s('turn', L?.head?.turn); s('pitch', L?.head?.pitch);
  s('lzone', L?.hands?.left?.zone); s('lgest', L?.hands?.left?.gesture);
  s('rzone', L?.hands?.right?.zone); s('rgest', L?.hands?.right?.gesture);
  panel.querySelectorAll('.tsActs input').forEach((c) => { c.checked = !!L?.activities?.includes(c.value); });
  s('c-squats', L?.counts?.squats); s('c-jumps', L?.counts?.jumps); s('notes', L?.notes);
}

// ---------- clip list ----------
let clips = [], selected = null;
async function refresh() {
  try {
    const r = await (await fetch('/testset/list')).json();
    clips = r.clips;
    $('tsDir').textContent = r.dir;
  } catch (e) { $('tsList').textContent = 'Could not list clips: ' + e.message; return; }
  $('tsList').innerHTML = clips.length ? clips.map((c) => `
    <div class="tsClip${c.name === selected ? ' on' : ''}" data-name="${esc(c.name)}">
      <span>${c.labels ? '✅' : '⚠️'}</span><b>${esc(c.name)}</b>
      <small class="muted">${(c.size / 1e6).toFixed(1)} MB${c.labels?.notes ? ' · ' + esc(c.labels.notes) : c.labels ? '' : ' · not labelled'}</small>
    </div>`).join('') : '<div class="muted">No clips yet. Record one, or put videos in the folder above.</div>';
  $('tsList').querySelectorAll('.tsClip').forEach((el) => {
    el.onclick = () => { selected = el.dataset.name; refresh(); };
    el.ondblclick = () => { selected = el.dataset.name; fillForm(clips.find((c) => c.name === selected)?.labels); };
  });
}
$('tsRefresh').onclick = refresh;
$('tsLoadLabels').onclick = () => { const c = clips.find((x) => x.name === selected); if (c) fillForm(c.labels); };
$('tsSaveLabels').onclick = async () => {
  if (!selected) return alert('Select a clip first.');
  await fetch(`/testset/labels?name=${encodeURIComponent(selected)}`, { method: 'POST', body: JSON.stringify(readForm()) });
  refresh();
};

// ---------- recording raw test clips ----------
let rec = null, recChunks = [], recT0 = 0, recTimer = null;
function pickMime() {
  for (const m of ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    if (window.MediaRecorder?.isTypeSupported(m)) return m;
  }
  return '';
}
$('tsRec').onclick = () => {
  if (rec) { rec.stop(); return; }
  const stream = window.camSource?.rawStream();
  if (!stream) {
    $('tsRecInfo').textContent = 'Needs a video source: phone over WebRTC, screen capture, or a video file.';
    return;
  }
  const labels = readForm();
  const mime = pickMime();
  rec = new MediaRecorder(new MediaStream(stream.getVideoTracks()), { ...(mime && { mimeType: mime }), videoBitsPerSecond: 6_000_000 });
  recChunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  rec.onstop = async () => {
    clearInterval(recTimer);
    $('tsRec').textContent = '● Record test clip';
    $('tsRec').classList.remove('on');
    const type = rec.mimeType || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const slug = [labels.posture, ...labels.activities].filter(Boolean).join('-').replace(/[^\w-]/g, '') || 'clip';
    const name = `clip-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${slug}.${ext}`;
    $('tsRecInfo').textContent = 'Saving…';
    rec = null;
    await fetch(`/testset/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: new Blob(recChunks, { type }) });
    await fetch(`/testset/labels?name=${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(labels) });
    $('tsRecInfo').textContent = `Saved ${name}`;
    selected = name;
    refresh();
  };
  rec.start(1000);
  recT0 = performance.now();
  $('tsRec').textContent = '■ Stop';
  $('tsRec').classList.add('on');
  recTimer = setInterval(() => { $('tsRecInfo').textContent = `Recording ${Math.floor((performance.now() - recT0) / 1000)} s…`; }, 500);
};

// ---------- evaluation ----------
const blank = (() => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').fillRect(0, 0, 64, 64); return c; })();
let clock = 0;   // monotonic clock for MediaPipe across clips (ms)

function loadVideo(name) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.style.cssText = 'width:2px;height:2px';
    $('srcVideos').appendChild(v);
    v.onloadeddata = async () => {
      // Browser-recorded videos often don't store their length ("Infinity") until you
      // seek to the end once. Do that, then come back.
      if (!isFinite(v.duration)) {
        await new Promise((r) => { v.ondurationchange = () => { if (isFinite(v.duration)) r(); }; v.currentTime = 1e9; setTimeout(r, 3000); });
        v.ondurationchange = null;
        await seek(v, 0);
      }
      resolve(v);
    };
    v.onerror = () => reject(new Error(`can't load ${name}`));
    v.src = `/testset/video/${encodeURIComponent(name)}`;
  });
}
function seek(v, t) {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2) return resolve();
    const done = () => { v.removeEventListener('seeked', done); resolve(); };
    v.addEventListener('seeked', done);
    v.currentTime = t;
    setTimeout(done, 2000);
  });
}

// One clip: per-frame facts from tracker + brain.
async function runClip(clip, fps) {
  const v = await loadVideo(clip.name);
  const T = window.phoneCamTracker;
  window.brain.reset();
  T.reset();
  clock += 2000;
  for (let i = 0; i < 3; i++) { clock += 100; T.process(blank, 64, 64, clock); }   // flush tracking
  window.brain.reset();
  const frames = [];
  const dur = isFinite(v.duration) ? v.duration : 0;
  const t0 = clock + 1000;
  const steps = Math.max(1, Math.floor(dur * fps));     // a one-frame clip still gets scored
  for (let i = 0; i < steps; i++) {
    const t = i / fps;
    await seek(v, t);
    clock = t0 + t * 1000;
    T.process(v, v.videoWidth, v.videoHeight, clock);     // brain updates via the 'tracking' event
    const s = window.brainState;
    frames.push({ t, facts: s?.facts || null, counters: { ...s?.counters } });
    $('tsProgress').textContent = `${clip.name}: ${Math.round((t / dur) * 100)}%`;
  }
  v.remove();
  return frames;
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);

// Compare per-frame facts to the clip's labels.
function score(labels, frames, cfg) {
  const fields = {};          // name -> { right, answered, total }
  const add = (name, expected, got) => {
    if (!expected) return;
    const f = (fields[name] ??= { right: 0, answered: 0, total: 0, wrongAs: {} });
    f.total++;
    if (got != null && got !== 'unknown') f.answered++;
    if (got === expected) f.right++;
    else { const k = got ?? 'nothing'; f.wrongAs[k] = (f.wrongAs[k] || 0) + 1; }
  };
  const n = frames.length;
  const actFrames = {};
  for (const { facts: F } of frames) {
    add('posture', labels.posture, F?.posture);
    add('facing', labels.facing, F?.facing);
    add('head turn', labels.head?.turn, F?.head?.turn);
    add('head up/down', labels.head?.pitch, F?.head?.pitch);
    for (const side of ['left', 'right']) {
      if (!cfg.opts.hands) break;                    // hands off: nothing to score
      const L = labels.hands?.[side], H = F?.hands?.[side];
      add(`${side} hand where`, L?.zone, H ? H.zone : 'not visible');
      add(`${side} hand shape`, L?.gesture, H?.gesture ?? null);
    }
    for (const a of F?.activities || []) actFrames[a] = (actFrames[a] || 0) + 1;
  }
  // Activities: "happening" if seen in >= 15% of frames, or counted by a rep counter.
  const last = frames[frames.length - 1]?.counters || {};
  const detected = new Set(Object.entries(actFrames).filter(([, c]) => c >= n * 0.15).map(([a]) => a));
  if (last.squats > 0) detected.add('squats');
  if ((last['L curls'] || 0) + (last['R curls'] || 0) > 0) detected.add('curls');
  if (last['jumping jacks'] > 0) detected.add('jumping_jacks');
  if (last.jumps > 0) detected.add('jumping');
  const want = new Set(labels.activities || []);
  const activities = {
    found: [...want].filter((a) => detected.has(a)),
    missed: [...want].filter((a) => !detected.has(a)),
    falseAlarms: [...detected].filter((a) => !want.has(a)),
  };
  const counts = {};
  if (labels.counts?.squats != null) counts.squats = { expected: labels.counts.squats, got: last.squats || 0 };
  if (labels.counts?.jumps != null) counts.jumps = { expected: labels.counts.jumps, got: last.jumps || 0 };
  return { frames: n, fields, activities, counts };
}

function summarize(results) {
  // results: [{ clip, pipeline, score }]
  const by = {};
  for (const r of results) {
    const P = (by[r.pipeline] ??= { fields: {}, found: 0, wanted: 0, falseAlarms: 0, countErr: 0, counts: 0 });
    for (const [k, f] of Object.entries(r.score.fields)) {
      const A = (P.fields[k] ??= { right: 0, answered: 0, total: 0 });
      A.right += f.right; A.answered += f.answered; A.total += f.total;
    }
    P.found += r.score.activities.found.length;
    P.wanted += r.score.activities.found.length + r.score.activities.missed.length;
    P.falseAlarms += r.score.activities.falseAlarms.length;
    for (const c of Object.values(r.score.counts)) { P.counts++; P.countErr += Math.abs(c.got - c.expected); }
  }
  for (const P of Object.values(by)) {
    let right = 0, total = 0;
    for (const f of Object.values(P.fields)) { right += f.right; total += f.total; }
    P.overall = pct(right, total);
  }
  return by;
}

function renderReport(results, summary, pipes) {
  const fieldNames = [...new Set(Object.values(summary).flatMap((P) => Object.keys(P.fields)))];
  const NAMES = Object.fromEntries(CONFIGS.map((c) => [c.id, c.label]));
  // "Shared" overall: only fields every compared setup can answer, so they're comparable.
  const shared = fieldNames.filter((k) => pipes.every((p) => summary[p]?.fields[k]));
  const sharedPct = (p) => {
    let r = 0, t = 0;
    for (const k of shared) { r += summary[p].fields[k].right; t += summary[p].fields[k].total; }
    return pct(r, t);
  };
  const cell = (f) => (f ? `<b>${pct(f.right, f.total)}%</b> <small class="muted">answered ${pct(f.answered, f.total)}%</small>` : '–');
  let html = `<h3>Results</h3><table class="tsTable"><tr><th>Field (frame accuracy)</th>${pipes.map((p) => `<th>${NAMES[p]}</th>`).join('')}</tr>`;
  html += `<tr class="tsOverall"><td>Overall, shared fields<br><small class="muted">${esc(shared.join(', ') || 'none')}</small></td>${pipes.map((p) => `<td><b>${sharedPct(p) ?? '–'}%</b></td>`).join('')}</tr>`;
  html += `<tr><td>Overall, everything it answers</td>${pipes.map((p) => `<td>${summary[p]?.overall ?? '–'}%</td>`).join('')}</tr>`;
  for (const k of fieldNames) html += `<tr><td>${esc(k)}</td>${pipes.map((p) => `<td>${summary[p]?.fields[k] ? cell(summary[p].fields[k]) : '<small class="muted">not tracked</small>'}</td>`).join('')}</tr>`;
  html += `<tr><td>Activities found</td>${pipes.map((p) => `<td>${summary[p].found}/${summary[p].wanted}</td>`).join('')}</tr>`;
  html += `<tr><td>False alarms</td>${pipes.map((p) => `<td>${summary[p].falseAlarms}</td>`).join('')}</tr>`;
  if (Object.values(summary).some((P) => P.counts)) {
    html += `<tr><td>Rep count error</td>${pipes.map((p) => `<td>${summary[p].counts ? (summary[p].countErr / summary[p].counts).toFixed(1) + ' avg' : '–'}</td>`).join('')}</tr>`;
  }
  html += '</table><h3>Per clip</h3>';
  for (const name of [...new Set(results.map((r) => r.clip))]) {
    html += `<details><summary>${esc(name)}</summary><table class="tsTable"><tr><th>Field</th>${pipes.map((p) => `<th>${NAMES[p]}</th>`).join('')}</tr>`;
    const rs = pipes.map((p) => results.find((r) => r.clip === name && r.pipeline === p));
    const names = [...new Set(rs.flatMap((r) => Object.keys(r?.score.fields || {})))];
    for (const k of names) {
      html += `<tr><td>${esc(k)}</td>${rs.map((r) => {
        const f = r?.score.fields[k];
        if (!f) return '<td>–</td>';
        const top = Object.entries(f.wrongAs).sort((a, b) => b[1] - a[1])[0];
        return `<td>${pct(f.right, f.total)}%${top && f.right < f.total ? ` <small class="muted">mostly said "${esc(top[0])}"</small>` : ''}</td>`;
      }).join('')}</tr>`;
    }
    html += `<tr><td>Activities</td>${rs.map((r) => {
      const a = r?.score.activities;
      if (!a) return '<td>–</td>';
      const bits = [];
      if (a.found.length) bits.push(`✅ ${a.found.join(', ')}`);
      if (a.missed.length) bits.push(`❌ missed ${a.missed.join(', ')}`);
      if (a.falseAlarms.length) bits.push(`⚠️ false ${a.falseAlarms.join(', ')}`);
      return `<td>${bits.join('<br>') || '—'}</td>`;
    }).join('')}</tr></table></details>`;
  }
  $('tsReport').innerHTML = html;
}

$('tsRun').onclick = async () => {
  const pipes = [...panel.querySelectorAll('.tsPipe:checked')].map((c) => c.value);
  const fps = Number($('tsFps').value);
  await refresh();
  const todo = clips.filter((c) => c.labels);
  if (!todo.length) { $('tsProgress').textContent = 'No labelled clips yet.'; return; }
  if (!pipes.length) { $('tsProgress').textContent = 'Pick at least one model.'; return; }
  const T = window.phoneCamTracker;
  const startPipe = T.pipeline;
  const startOpts = T.opts;
  $('tsRun').disabled = true;
  window.camSource.pause(true);
  const results = [];
  const t0 = performance.now();
  try {
    for (const p of pipes) {
      const cfg = CFG[p];
      $('tsProgress').textContent = `Loading ${cfg.label}…`;
      T.setOpts(cfg.opts);
      if (T.pipeline !== cfg.pipe) await T.switchPipeline(cfg.pipe);
      for (const clip of todo) {
        const frames = await runClip(clip, fps);
        results.push({ clip: clip.name, pipeline: p, score: score(clip.labels, frames, cfg) });
      }
    }
    const summary = summarize(results);
    renderReport(results, summary, pipes);
    const report = {
      ranAt: new Date().toISOString(), sampleFps: fps, setups: pipes.map((p) => CFG[p]),
      seconds: Math.round((performance.now() - t0) / 1000),
      clips: todo.map((c) => ({ name: c.name, labels: c.labels })),
      summary, results,
    };
    const r = await (await fetch('/testset/report', { method: 'POST', body: JSON.stringify(report) })).json();
    $('tsProgress').textContent = `Done in ${report.seconds} s · report saved: ${r.saved || r.error}`;
    window.lastEvalReport = report;
  } catch (e) {
    console.error(e);
    $('tsProgress').textContent = 'Evaluation failed: ' + e.message;
  } finally {
    T.setOpts(startOpts);
    if (T.pipeline !== startPipe) await T.switchPipeline(startPipe);
    window.brain.reset();
    window.camSource.pause(false);
    $('tsRun').disabled = false;
  }
};
