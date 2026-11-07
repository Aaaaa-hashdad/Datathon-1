// Body + hand tracking with MediaPipe, run on each frame the phone sends.
// Everything (JS, WASM, models) is served locally, so this works offline.
//
// Latest results are on window.tracking and fired as a 'tracking' event on window,
// so other code can react to movement without touching this file.

import { FilesetResolver, PoseLandmarker, HandLandmarker } from '/mp/vision_bundle.mjs';

// ---------- pose skeleton, grouped by body part ----------
// MediaPipe "left" = the person's left.
const PARTS = {
  head:     { color: '#ffd54f', edges: [[0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10]] },
  torso:    { color: '#eeeeee', edges: [[11,12],[11,23],[12,24],[23,24]] },
  leftArm:  { color: '#4fc3f7', edges: [[11,13],[13,15],[15,17],[15,19],[15,21],[17,19]] },
  rightArm: { color: '#f06292', edges: [[12,14],[14,16],[16,18],[16,20],[16,22],[18,20]] },
  leftLeg:  { color: '#81c784', edges: [[23,25],[25,27],[27,29],[29,31],[27,31]] },
  rightLeg: { color: '#ffb74d', edges: [[24,26],[26,28],[28,30],[30,32],[28,32]] },
};
const POINT_PART = {};
for (const [name, p] of Object.entries(PARTS)) for (const e of p.edges) for (const i of e) POINT_PART[i] ??= name;

// Joint angles: [label, a, vertex, c]
const JOINTS = [
  ['L elbow', 11, 13, 15], ['R elbow', 12, 14, 16],
  ['L shoulder', 13, 11, 23], ['R shoulder', 14, 12, 24],
  ['L hip', 11, 23, 25], ['R hip', 12, 24, 26],
  ['L knee', 23, 25, 27], ['R knee', 24, 26, 28],
];

// Points whose speed we report (m/s, hip-centred so walking doesn't count as limb motion).
const MOVERS = { 'Head': 0, 'L hand': 15, 'R hand': 16, 'L foot': 27, 'R foot': 28 };

const VIS = 0.5;        // landmark visibility to trust it (solid lines, angles)
const VIS_FAINT = 0.2;  // below VIS but above this: drawn dashed so limbs don't just vanish
const MASK_MIN = 0.5;   // body-outline coverage needed at the torso to count as a real person
const CONFIRM_FRAMES = 3; // a new person must show up this many frames in a row

const POSE_MODELS = {
  heavy: '/models/pose_landmarker_heavy.task',  // most accurate, best for legs / far away
  full: '/models/pose_landmarker_full.task',    // faster
};

// ---------- One Euro filter: smooths jitter when still, stays responsive when moving ----------
class OneEuro {
  constructor(minCutoff = 1.0, beta = 6, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 });
  }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    this.t = t;
    return this.x;
  }
}

// One filter per landmark coordinate; reset whenever the person is lost.
function makeSmoother() {
  let f = null;
  return {
    reset() { f = null; },
    apply(points, t) {
      f ??= points.map(() => ({ x: new OneEuro(), y: new OneEuro(), z: new OneEuro() }));
      return points.map((p, i) => ({
        ...p,
        x: f[i].x.filter(p.x, t), y: f[i].y.filter(p.y, t), z: f[i].z.filter(p.z, t),
      }));
    },
  };
}
const smoothLm = makeSmoother(), smoothWorld = makeSmoother();

// ---------- setup ----------
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const opts = { body: true, hands: true, video: true };
for (const k of Object.keys(opts)) {
  const el = document.getElementById('opt-' + k);
  if (el) { el.checked = opts[k]; el.onchange = () => { opts[k] = el.checked; }; }
}
const setText = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };

setText('trackState', 'Loading MediaPipe…');
const vision = await FilesetResolver.forVisionTasks('/mp/wasm');

async function create(Task, model, extra) {
  let lastErr;
  for (const delegate of ['GPU', 'CPU']) {
    try {
      const t = await Task.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model, delegate },
        runningMode: 'VIDEO',
        ...extra,
      });
      return { task: t, delegate };
    } catch (e) { lastErr = e; console.warn(`${model} on ${delegate} failed`, e); }
  }
  throw lastErr;
}

const createPose = (which) => create(PoseLandmarker, POSE_MODELS[which], {
  numPoses: 1,
  minPoseDetectionConfidence: 0.6,
  minPosePresenceConfidence: 0.6,
  minTrackingConfidence: 0.6,
  outputSegmentationMasks: true,   // used to reject "people" that aren't there
});

const modelSel = document.getElementById('opt-model');
let pose, hands;
try {
  [pose, hands] = await Promise.all([
    createPose(modelSel?.value || 'heavy'),
    create(HandLandmarker, '/models/hand_landmarker.task', {
      numHands: 2, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5,
    }),
  ]);
  setText('trackState', `Tracker ready (${pose.delegate})`);
} catch (e) {
  setText('trackState', 'MediaPipe failed to load: ' + e.message);
  throw e;
}

if (modelSel) modelSel.onchange = async () => {
  const old = pose;
  pose = null;                       // frames skip body tracking while the new model loads
  setText('trackState', 'Switching model…');
  try { pose = await createPose(modelSel.value); old.task.close(); }
  catch (e) { pose = old; console.warn(e); }
  smoothLm.reset(); smoothWorld.reset();
  setText('trackState', `Tracker ready (${pose.delegate})`);
};

// ---------- math ----------
function angle3(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y, a.z - b.z], v2 = [c.x - b.x, c.y - b.y, c.z - b.z];
  const dot = v1[0]*v2[0] + v1[1]*v2[1] + v1[2]*v2[2];
  const n = Math.hypot(...v1) * Math.hypot(...v2);
  return n ? Math.acos(Math.min(1, Math.max(-1, dot / n))) * 180 / Math.PI : NaN;
}

// Rough head direction from nose vs ears (image space).
function headPose(lm, w, h) {
  const [nose, lEar, rEar] = [lm[0], lm[7], lm[8]];
  if (Math.min(nose.visibility, lEar.visibility, rEar.visibility) < VIS) return null;
  const P = (p) => ({ x: p.x * w, y: p.y * h });
  const n = P(nose), l = P(lEar), r = P(rEar);
  const mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  const earDist = Math.hypot(l.x - r.x, l.y - r.y) || 1;
  const yaw = (n.x - mid.x) / earDist;          // + = toward image right
  const pitch = (n.y - mid.y) / earDist;        // + = nose below ear line
  const roll = Math.atan2(l.y - r.y, l.x - r.x) * 180 / Math.PI;
  return {
    turn: yaw > 0.25 ? 'image-right' : yaw < -0.25 ? 'image-left' : 'center',
    nod: pitch < -0.05 ? 'up' : pitch > 0.45 ? 'down' : 'level',
    tilt: Math.round(((roll + 540) % 360) - 180),
    yaw, pitch,
  };
}

// Count extended fingers: tip farther from the wrist than its middle joint.
function fingersUp(hl) {
  const d = (i) => Math.hypot(hl[i].x - hl[0].x, hl[i].y - hl[0].y);
  let n = 0;
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) if (d(tip) > d(pip) * 1.1) n++;
  // thumb: tip farther from the pinky base than the thumb's IP joint
  const dp = (i) => Math.hypot(hl[i].x - hl[17].x, hl[i].y - hl[17].y);
  if (dp(4) > dp(3) * 1.1) n++;
  return n;
}

// Is this a real person? MediaPipe will happily fit a skeleton to furniture, so check
// that its body-outline mask actually covers the torso, and that the torso is visible.
function isRealPerson(lm, mask) {
  const torso = [11, 12, 23, 24];
  const vis = torso.reduce((s, i) => s + lm[i].visibility, 0) / torso.length;
  if (vis < 0.6) return { ok: false, why: 'torso not visible' };
  if (!mask) return { ok: true };
  const data = mask.getAsFloat32Array();
  const at = (x, y) => {
    const px = Math.min(mask.width - 1, Math.max(0, Math.round(x * mask.width)));
    const py = Math.min(mask.height - 1, Math.max(0, Math.round(y * mask.height)));
    return data[py * mask.width + px];
  };
  const mid = (a, b, t = 0.5) => ({ x: lm[a].x + (lm[b].x - lm[a].x) * t, y: lm[a].y + (lm[b].y - lm[a].y) * t });
  // sample along the torso: shoulder centre, chest, belly, hip centre
  const sh = mid(11, 12), hp = mid(23, 24);
  const samples = [0.1, 0.35, 0.6, 0.85].map((t) => at(sh.x + (hp.x - sh.x) * t, sh.y + (hp.y - sh.y) * t));
  const cover = samples.reduce((s, v) => s + v, 0) / samples.length;
  return cover >= MASK_MIN ? { ok: true, cover, vis } : { ok: false, why: 'no body under skeleton', cover, vis };
}

// ---------- drawing ----------
function drawPose(lm, w, h) {
  const lw = Math.max(2, w / 250);
  ctx.lineCap = 'round';
  for (const p of Object.values(PARTS)) {
    ctx.strokeStyle = p.color;
    ctx.lineWidth = lw;
    for (const [a, b] of p.edges) {
      const v = Math.min(lm[a].visibility, lm[b].visibility);
      if (v < VIS_FAINT) continue;
      const faint = v < VIS;            // uncertain (e.g. partly hidden leg): dashed + see-through
      ctx.globalAlpha = faint ? 0.55 : 1;
      ctx.setLineDash(faint ? [lw * 2, lw * 2] : []);
      ctx.beginPath();
      ctx.moveTo(lm[a].x * w, lm[a].y * h);
      ctx.lineTo(lm[b].x * w, lm[b].y * h);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  for (let i = 0; i < lm.length; i++) {
    if (lm[i].visibility < VIS_FAINT || !POINT_PART[i]) continue;
    ctx.globalAlpha = lm[i].visibility < VIS ? 0.55 : 1;
    ctx.fillStyle = PARTS[POINT_PART[i]].color;
    ctx.beginPath();
    ctx.arc(lm[i].x * w, lm[i].y * h, lw * 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawAngleLabels(lm, angles, w, h) {
  const fs = Math.max(12, w / 60);
  ctx.font = `bold ${fs}px system-ui`;
  ctx.textBaseline = 'middle';
  for (const [label, , v] of JOINTS) {
    const a = angles[label];
    if (a == null) continue;
    const x = lm[v].x * w + 8, y = lm[v].y * h;
    const t = `${Math.round(a)}°`;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(x - 3, y - fs * 0.7, ctx.measureText(t).width + 6, fs * 1.4);
    ctx.fillStyle = '#fff';
    ctx.fillText(t, x, y);
  }
}

function drawHand(hl, w, h) {
  const lw = Math.max(2, w / 350);
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = lw;
  for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(hl[start].x * w, hl[start].y * h);
    ctx.lineTo(hl[end].x * w, hl[end].y * h);
    ctx.stroke();
  }
  ctx.fillStyle = '#ba68c8';
  for (const p of hl) { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, lw * 1.4, 0, Math.PI * 2); ctx.fill(); }
}

// ---------- per-frame ----------
const speed = {};               // smoothed m/s per mover
let prevWorld = null, prevT = 0;
let seenFrames = 0, lastReject = null;
let procCount = 0, procT0 = performance.now();

function processFrame(bmp) {
  const t = performance.now();
  const w = bmp.width, h = bmp.height;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (opts.video) ctx.drawImage(bmp, 0, 0);

  const out = { t: Date.now(), width: w, height: h, pose: null, hands: [] };

  if (opts.body && pose) {
    const r = pose.task.detectForVideo(bmp, t);
    const rawLm = r.landmarks?.[0], rawWorld = r.worldLandmarks?.[0];
    const check = rawLm ? isRealPerson(rawLm, r.segmentationMasks?.[0]) : { ok: false, why: 'nobody' };
    r.segmentationMasks?.forEach((m) => m.close());
    seenFrames = check.ok ? seenFrames + 1 : 0;
    lastReject = check.ok ? null : check.why;
    out.check = check;

    if (check.ok && seenFrames >= CONFIRM_FRAMES) {
      const lm = smoothLm.apply(rawLm, t), world = smoothWorld.apply(rawWorld, t);
      const angles = {};
      for (const [label, a, b, c] of JOINTS) {
        angles[label] = Math.min(lm[a].visibility, lm[b].visibility, lm[c].visibility) >= VIS
          ? angle3(world[a], world[b], world[c]) : null;
      }
      if (prevWorld && t > prevT) {
        const dt = (t - prevT) / 1000;
        for (const [name, i] of Object.entries(MOVERS)) {
          const v = lm[i].visibility >= VIS
            ? Math.hypot(world[i].x - prevWorld[i].x, world[i].y - prevWorld[i].y, world[i].z - prevWorld[i].z) / dt
            : 0;
          speed[name] = (speed[name] ?? v) * 0.7 + v * 0.3;   // exponential smoothing
        }
      }
      prevWorld = world; prevT = t;
      drawPose(lm, w, h);
      drawAngleLabels(lm, angles, w, h);
      out.pose = { landmarks: lm, worldLandmarks: world, angles, head: headPose(lm, w, h), speed: { ...speed } };
    } else if (!check.ok) {
      prevWorld = null;
      smoothLm.reset(); smoothWorld.reset();
    }
  }

  if (opts.hands) {
    const r = hands.task.detectForVideo(bmp, t);
    (r.landmarks || []).forEach((hl, i) => {
      drawHand(hl, w, h);
      out.hands.push({
        landmarks: hl,
        // MediaPipe assumes a mirrored selfie image; with the back camera this label is swapped.
        handedness: r.handedness?.[i]?.[0]?.categoryName,
        fingersUp: fingersUp(hl),
      });
    });
  }

  procCount++;
  const el = (performance.now() - procT0) / 1000;
  if (el > 1) { setText('trackFps', `${(procCount / el).toFixed(1)} fps tracked`); procCount = 0; procT0 = performance.now(); }

  window.tracking = out;
  window.dispatchEvent(new CustomEvent('tracking', { detail: out }));
  renderPanel(out);
}

// ---------- side panel ----------
function renderPanel(out) {
  const p = out.pose;
  document.getElementById('angles').innerHTML = JOINTS.map(([label]) => {
    const a = p?.angles?.[label];
    return `<tr><td>${label}</td><td>${a == null ? '—' : Math.round(a) + '°'}</td></tr>`;
  }).join('');

  document.getElementById('motion').innerHTML = Object.keys(MOVERS).map((name) => {
    const v = p?.speed?.[name] ?? 0;
    const pct = Math.min(100, (v / 2) * 100);   // 2 m/s = full bar
    return `<div class="bar"><span>${name}</span><div><i style="width:${pct}%"></i></div><b>${v.toFixed(2)}</b></div>`;
  }).join('');

  const hd = p?.head;
  setText('head', hd ? `Facing ${hd.turn} · nod ${hd.nod} · tilt ${hd.tilt}°` : 'Head not visible');
  setText('handsInfo', out.hands.length
    ? out.hands.map((x) => `${x.handedness ?? 'Hand'}: ${x.fingersUp} finger${x.fingersUp === 1 ? '' : 's'} up`).join(' · ')
    : 'No hands');
  setText('bodyState', p ? 'Body tracked'
    : lastReject && lastReject !== 'nobody' ? `No person (ignored a false match: ${lastReject})`
    : 'No body detected');
}

// ---------- frame loop: fetch each new frame once ----------
let after = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (;;) {
  let res;
  try { res = await fetch(`/next.jpg?after=${after}`); } catch { await sleep(1000); continue; }
  if (res.status !== 200) continue;            // 204 = timed out waiting, ask again
  after = Number(res.headers.get('X-Frame'));
  try {
    const bmp = await createImageBitmap(await res.blob());
    processFrame(bmp);
    bmp.close();
  } catch (e) { console.warn('frame failed', e); }
}
