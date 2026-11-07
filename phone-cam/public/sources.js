// Video sources for the tracker, plus recording.
//
//  - Phone:  WebRTC video from the phone (30 fps). Until it connects, the tracker uses the
//            phone's JPEG pictures instead.
//  - Screen: capture a window or screen, e.g. a YouTube video, to test the tracker on it.
//  - File:   play a video file from disk through the tracker.
//
// The tracker asks window.camSource which <video> to read (or to use pictures).
// Recording saves the annotated canvas as a video, plus a JSON file with per-frame
// tracking data (landmarks, angles, what the brain said): reusable as training data.

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rtcVideo = $('rtcVideo'), screenVideo = $('screenVideo'), fileVideo = $('fileVideo');
const ready = (v) => v.readyState >= 2 && v.videoWidth > 0;
const native = window.phoneCamNative;          // only inside the Electron app

let mode = 'phone';
let rtcPc = null, rtcLive = false, rtcFps = 0, lastOfferId = '';

let paused = false;          // the test-set evaluator takes over the tracker while it runs

window.camSource = {
  pause(on) { paused = !!on; },
  get paused() { return paused; },
  // The raw (un-annotated) video of the current source, for recording test clips.
  rawStream() {
    if (mode === 'phone') return rtcLive ? rtcVideo.srcObject : null;
    if (mode === 'screen') return screenVideo.srcObject;
    if (mode === 'file') return fileVideo.src ? fileVideo.captureStream() : null;
    return null;
  },
  activeVideo() {
    if (paused) return null;
    if (mode === 'phone') return rtcLive && ready(rtcVideo) ? rtcVideo : null;
    if (mode === 'screen') return ready(screenVideo) ? screenVideo : null;
    if (mode === 'file') return ready(fileVideo) ? fileVideo : null;
    return null;
  },
  wantsPictures: () => !paused && mode === 'phone' && !rtcLive,
  label: () => (mode === 'phone' ? (rtcLive ? 'phone (WebRTC video)' : 'phone (pictures)') : mode === 'screen' ? 'screen capture' : 'video file'),
  get mode() { return mode; },
  get rtcLive() { return rtcLive; },
  get rtcFps() { return rtcFps; },
};

// ---------------- WebRTC receiver ----------------
function iceComplete(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
    setTimeout(resolve, ms);
  });
}

async function answerOffer(offer) {
  if (rtcPc) { try { rtcPc.close(); } catch {} }
  rtcLive = false;
  const pc = rtcPc = new RTCPeerConnection({ iceServers: [] });
  pc.ontrack = (e) => {
    try { e.receiver.playoutDelayHint = 0; } catch {}       // lowest latency, we don't need smoothness
    rtcVideo.srcObject = e.streams[0] || new MediaStream([e.track]);
    rtcVideo.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc !== rtcPc) return;
    rtcLive = pc.connectionState === 'connected';
    updateInfo();
  };
  await pc.setRemoteDescription({ type: offer.type, sdp: offer.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await iceComplete(pc, 2000);
  await fetch('/rtc/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: offer.id, type: pc.localDescription.type, sdp: pc.localDescription.sdp }),
  });
}

(async function rtcLoop() {
  for (;;) {
    let r;
    try { r = await fetch(`/rtc/offer?after=${encodeURIComponent(lastOfferId)}`); } catch { await sleep(2000); continue; }
    if (r.status !== 200) continue;
    const offer = await r.json();
    lastOfferId = offer.id;
    try { await answerOffer(offer); } catch (e) { console.warn('WebRTC answer failed', e); }
  }
})();

setInterval(async () => {
  if (!rtcPc || !rtcLive) { rtcFps = 0; return; }
  const stats = await rtcPc.getStats();
  for (const s of stats.values()) if (s.type === 'inbound-rtp' && s.kind === 'video') rtcFps = s.framesPerSecond || 0;
  updateInfo();
}, 1000);

// ---------------- source switching ----------------
function updateInfo() {
  const info = $('srcInfo');
  if (mode === 'phone') {
    info.textContent = rtcLive
      ? `Phone video over WebRTC · ${Math.round(rtcFps)} fps`
      : 'Phone pictures (WebRTC video not connected yet)';
  } else if (mode === 'screen') {
    info.textContent = ready(screenVideo) ? `Capturing ${screenVideo.videoWidth}x${screenVideo.videoHeight}` : 'Pick a window or screen…';
  } else {
    info.textContent = fileVideo.src ? `${fileName || 'video file'}${fileVideo.paused ? ' (paused)' : ''}` : 'Choose a video file…';
  }
  document.querySelectorAll('[data-src]').forEach((b) => b.classList.toggle('on', b.dataset.src === mode));
  $('fileCtl').hidden = mode !== 'file' || !fileVideo.src;
}

async function setMode(next) {
  if (next === 'screen') {
    if (!(await startScreen())) return;      // cancelled: stay where we were
  }
  if (next === 'file' && !fileVideo.src) { $('fileInput').click(); return; }  // mode switches once a file loads
  if (mode === 'screen' && next !== 'screen') stopScreen();
  if (mode === 'file' && next !== 'file') fileVideo.pause();
  mode = next;
  if (mode === 'file') fileVideo.play().catch(() => {});
  window.brain?.reset();
  updateInfo();
}
document.querySelectorAll('[data-src]').forEach((b) => { b.onclick = () => setMode(b.dataset.src); });

// --- screen / window capture ---
function stopScreen() {
  screenVideo.srcObject?.getTracks().forEach((t) => t.stop());
  screenVideo.srcObject = null;
}

async function startScreen() {
  stopScreen();
  let stream;
  try {
    if (native?.screenSources) {
      // Electron has no built-in picker: show our own list of windows and screens.
      const id = await pickSource();
      if (!id) return false;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 30, maxWidth: 1920, maxHeight: 1080 } },
      });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    }
  } catch (e) {
    $('srcInfo').textContent = `Screen capture failed: ${e.message}`;
    return false;
  }
  screenVideo.srcObject = stream;
  await screenVideo.play().catch(() => {});
  stream.getVideoTracks()[0].addEventListener('ended', () => { if (mode === 'screen') setMode('phone'); });
  return true;
}

function pickSource() {
  return new Promise(async (resolve) => {
    const picker = $('picker'), list = $('pickerList');
    list.innerHTML = '<div class="muted">Loading windows…</div>';
    picker.hidden = false;
    const done = (id) => { picker.hidden = true; resolve(id); };
    $('pickerCancel').onclick = () => done(null);
    const sources = await native.screenSources();
    list.innerHTML = '';
    for (const s of sources) {
      const b = document.createElement('button');
      b.className = 'pick';
      b.innerHTML = `<img alt="" src="${s.thumb}"><span></span>`;
      b.querySelector('span').textContent = s.name;
      b.onclick = () => done(s.id);
      list.appendChild(b);
    }
    if (!sources.length) list.innerHTML = '<div class="muted">No windows found.</div>';
  });
}

// --- video file ---
let fileName = '';
$('fileInput').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (fileVideo.src) URL.revokeObjectURL(fileVideo.src);
  fileName = f.name;
  fileVideo.src = URL.createObjectURL(f);
  fileVideo.playbackRate = Number($('fileSpeed').value);
  setMode('file');
};
$('filePlay').onclick = () => { fileVideo.paused ? fileVideo.play() : fileVideo.pause(); };
$('fileRestart').onclick = () => { fileVideo.currentTime = 0; fileVideo.play(); };
$('fileOpen').onclick = () => $('fileInput').click();
$('fileSpeed').onchange = () => { fileVideo.playbackRate = Number($('fileSpeed').value); };
fileVideo.addEventListener('play', () => { $('filePlay').textContent = 'Pause'; updateInfo(); });
fileVideo.addEventListener('pause', () => { $('filePlay').textContent = 'Play'; updateInfo(); });

// ---------------- recording ----------------
let rec = null, recChunks = [], recFrames = [], recStart = 0, recEventsFrom = 0, recTimer = null;

function pickMime() {
  for (const m of ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    if (window.MediaRecorder?.isTypeSupported(m)) return m;
  }
  return '';
}
const r4 = (n) => Math.round(n * 10000) / 10000;

function onBrain(e) {
  const s = e.detail, tr = window.tracking;
  if (!tr) return;
  recFrames.push({
    t: Math.round(performance.now() - recStart),
    source: tr.source, view: tr.view,
    headline: s.headline, posture: s.posture ?? null, activities: s.activities, motions: s.motions,
    angles: tr.pose ? Object.fromEntries(Object.entries(tr.pose.angles).map(([k, v]) => [k, v == null ? null : Math.round(v * 10) / 10])) : null,
    pose: tr.pose ? {
      predicted: !!tr.pose.predicted,
      landmarks: tr.pose.landmarks.map((p) => [r4(p.x), r4(p.y), r4(p.z), r4(p.visibility)]),
      world: tr.pose.worldLandmarks.map((p) => [r4(p.x), r4(p.y), r4(p.z)]),
    } : null,
    hands: tr.hands.map((h) => ({
      label: h.handedness, predicted: !!h.predicted,
      landmarks: h.landmarks.map((p) => [r4(p.x), r4(p.y), r4(p.z)]),
    })),
  });
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function startRec() {
  const canvas = $('stage');
  if (!canvas.width) { toast('Nothing to record yet: start a video source first.'); return; }
  const mime = pickMime();
  rec = new MediaRecorder(canvas.captureStream(30), { ...(mime && { mimeType: mime }), videoBitsPerSecond: 8_000_000 });
  recChunks = []; recFrames = []; recStart = performance.now();
  recEventsFrom = window.brain?.events?.length ? window.brain.events[0].t : 0;
  rec.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  rec.onstop = saveRec;
  rec.start(1000);
  window.addEventListener('brain', onBrain);
  $('recBtn').classList.add('on');
  $('recBtn').textContent = '■ Stop';
  recTimer = setInterval(() => {
    const s = Math.floor((performance.now() - recStart) / 1000);
    $('recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ${recFrames.length} frames`;
  }, 500);
}

function stopRec() {
  window.removeEventListener('brain', onBrain);
  clearInterval(recTimer);
  $('recBtn').classList.remove('on');
  $('recBtn').textContent = '● Record';
  $('recTime').textContent = 'Saving…';
  rec.stop();
}

function saveRec() {
  const mime = rec.mimeType || 'video/webm';
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const base = `phone-cam-${stamp()}`;
  download(new Blob(recChunks, { type: mime }), `${base}.${ext}`);
  const events = (window.brain?.events || []).filter((e) => e.t >= recEventsFrom).reverse();
  const durationMs = Math.round(performance.now() - recStart);
  const data = {
    recordedAt: new Date().toISOString(), durationMs, frameCount: recFrames.length,
    notes: {
      landmarks: 'pose: 33 MediaPipe pose points [x, y, z, visibility], x/y normalised to the frame',
      world: '33 points in metres, origin between the hips, y pointing down',
      hands: '21 MediaPipe hand points [x, y, z] per hand',
      t: 'milliseconds since recording started',
    },
    events, frames: recFrames,
  };
  setTimeout(() => download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${base}.json`), 300);
  rec = null;
  $('recTime').textContent = native ? '' : `Saved ${base}.${ext} + .json to Downloads`;
}

$('recBtn').onclick = () => (rec ? stopRec() : startRec());

// ---------------- toasts (Electron tells us where files were saved) ----------------
let toastTimer = null;
function toast(msg, onClick) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.onclick = onClick || null;
  el.style.cursor = onClick ? 'pointer' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
native?.onSaved?.((p) => toast(`Saved ${p.split(/[\\/]/).pop()} (click to show)`, () => native.showFile(p)));

updateInfo();
