// Body + hand tracking with MediaPipe, run on each frame the phone sends.
// Everything (JS, WASM, models) is served locally, so this works offline.
//
// Latest results are on window.tracking and fired as a 'tracking' event on window,
// so other code can react to movement without touching this file.

import { FilesetResolver, PoseLandmarker, HandLandmarker, HolisticLandmarker } from '/mp/vision_bundle.mjs';
import { createVideoClock, nextVideoFrame } from './video-frame.mjs';

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
const MOVERS = { 'Head': 0, 'L wrist': 15, 'R wrist': 16, 'L ankle': 27, 'R ankle': 28 };

const VIS = 0.5;        // landmark visibility to trust it (solid lines, angles)
const VIS_FAINT = 0.2;  // below VIS but above this: drawn dashed so limbs don't just vanish
const MASK_MIN = 0.5;   // body-outline coverage needed at the torso to count as a real person
const CONFIRM_FRAMES = 3;
const CLOSEUP_AREA = 0.07;  // a hand covering > 7% of the frame = camera is too close to see a body
const EDGE = 0.02;          // landmarks further than this outside the frame are guesses: hide them // a new person must show up this many frames in a row

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
// Body only: hand and face results are never output, drawn or described (permanently off).
// Holistic still finds hands/face internally; they are used only to reject false bodies
// and keep left/right straight, and never leave this file.
const BODY_ONLY = { hands: false, face: false };
const opts = { body: true, video: true, ...BODY_ONLY };
for (const k of Object.keys(opts)) {
  const el = document.getElementById('opt-' + k);
  if (el) {
    el.checked = opts[k];
    el.onchange = () => { opts[k] = el.checked; Object.assign(opts, BODY_ONLY); if (k !== 'video') autoPipeline(); };
  }
}
function syncBoxes() {
  for (const k of Object.keys(opts)) { const el = document.getElementById('opt-' + k); if (el) el.checked = opts[k]; }
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

// ---------- pipelines ----------
//  holistic: ONE model for body + both hands + face. Hands are found from the body's own
//            wrists, so left/right is right by construction, and the face mesh gives an
//            accurate head direction and expressions.
//  heavy / full: the older setup, a separate body model plus a separate hand model,
//            kept so the two can be compared on the test set.
let pipe = null;              // { kind, choice, holistic? , pose?, hands?, delegate }
let handsTask = null;         // shared hand model for the separate pipelines

async function loadPipeline(choice) {
  if (choice === 'hybrid') {
    const hol = await loadPipeline('holistic');
    const sep = await loadPipeline('heavy');
    return { kind: 'hybrid', choice, holistic: hol.holistic, pose: sep.pose, hands: sep.hands, delegate: sep.delegate };
  }
  if (choice === 'holistic') {
    const h = await create(HolisticLandmarker, '/models/holistic_landmarker.task', {
      minPoseDetectionConfidence: 0.6,
      minPosePresenceConfidence: 0.6,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minHandLandmarksConfidence: 0.5,
      outputFaceBlendshapes: false,         // face output is permanently off: expressions not needed (saves time)
      outputPoseSegmentationMasks: true,    // used to reject "people" that aren't there
    });
    // Holistic finds hands from the body's wrists, so with no body in view (a close-up)
    // it finds no hands either. Keep the standalone hand model as a fallback for that.
    handsTask ||= await create(HandLandmarker, '/models/hand_landmarker.task', {
      numHands: 2, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5,
    });
    return { kind: 'holistic', choice, holistic: h.task, hands: handsTask.task, delegate: h.delegate };
  }
  const [p, hd] = await Promise.all([
    create(PoseLandmarker, POSE_MODELS[choice], {
      numPoses: 1,
      minPoseDetectionConfidence: 0.6,
      minPosePresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
      outputSegmentationMasks: true,
    }),
    handsTask || create(HandLandmarker, '/models/hand_landmarker.task', {
      numHands: 2, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5,
    }),
  ]);
  handsTask = hd;
  return { kind: 'separate', choice, pose: p.task, hands: hd.task, delegate: p.delegate };
}

function closePipeline(pp) {
  if (!pp) return;
  if (pp.holistic) pp.holistic.close();
  if (pp.pose) pp.pose.close();          // the hand model is shared and kept
}

async function switchPipeline(choice) {
  const old = pipe;
  pipe = null;                          // frames are skipped while the new model loads
  setText('trackState', 'Loading model…');
  try {
    const next = await loadPipeline(choice);
    closePipeline(old);
    pipe = next;
  } catch (e) {
    console.warn(e);
    pipe = old;
    setText('trackState', `Could not load ${choice}: ${e.message}`);
    return pipe;
  }
  resetTracking();
  showState();
  return pipe;
}
const PIPE_NAMES = { hybrid: 'Auto: accurate body model, Holistic when needed', holistic: 'Holistic', heavy: 'Separate (accurate)', full: 'Separate (fast)' };
function showState() {
  if (!pipe) return;
  const parts = [opts.body && 'body', opts.hands && 'hands', opts.face && pipe.kind === 'holistic' && 'face'].filter(Boolean);
  const note = opts.face && pipe.kind !== 'holistic' ? ' · face needs Holistic' : '';
  setText('trackState', `Tracking ${parts.join(' + ') || 'nothing'} · ${PIPE_NAMES[pipe.choice]} (${pipe.delegate})${note}`);
}


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

// Bounding box of a hand (normalised coords), grown by `pad` of its size on each side.
function handBox(hl, pad = 0.15) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of hl) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const px = (x1 - x0) * pad, py = (y1 - y0) * pad;
  return { x0: x0 - px, y0: y0 - py, x1: x1 + px, y1: y1 + py, area: (x1 - x0) * (y1 - y0) };
}
const inBox = (p, b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

// Is this a real person? MediaPipe always draws a full 33-point body once it thinks it
// sees someone, and will fit one to furniture, or to a palm it mistook for a face.
// Reject it when:
//   - a hand fills the frame (close-up: no body can be in view),
//   - the "face" sits inside a hand the hand tracker found (a palm, not a face),
//   - the body's proportions are impossible,
//   - the torso isn't visible, or the body-outline mask doesn't cover the torso.
// `hard` failures drop a confirmed person at once; soft ones (which a real person
// can fail for a frame or two) only after several misses in a row.
// `trusted` = this person is already confirmed: then a hand near the face is just a hand
// near a real face (scratching the head, drinking), not a palm mistaken for a face.
const MASK_EVERY = 6;
let maskTick = 0;
function isRealPerson(lm, world, mask, handLms, trusted = false) {
  const boxes = handLms.map((hl) => handBox(hl));
  if (boxes.some((b) => b.area > CLOSEUP_AREA)) return { ok: false, hard: true, why: 'close-up on a hand' };
  const faceIds = [0, 2, 5].filter((i) => lm[i].visibility >= VIS);
  if (!trusted && faceIds.length && boxes.some((b) => faceIds.filter((i) => inBox(lm[i], b)).length >= Math.ceil(faceIds.length / 2))) {
    return { ok: false, hard: true, why: 'the "face" was really a hand' };
  }

  // Shoulders are required; hips are not: head-and-shoulders close-ups are normal.
  const shVis = (lm[11].visibility + lm[12].visibility) / 2;
  const hipVis = (lm[23].visibility + lm[24].visibility) / 2;
  const vis = (shVis + hipVis) / 2;
  if (shVis < 0.6) return { ok: false, why: 'shoulders not visible' };
  const upperOnly = hipVis < 0.5;

  // Proportions in 3D (metres). In the flat image a side-on person's shoulders overlap
  // and look zero-width; the 3D points keep their real width, so this works at any angle.
  if (world) {
    const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const m3 = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
    const shMid = m3(world[11], world[12]), hipMid = m3(world[23], world[24]);
    const shW = d3(world[11], world[12]);
    if (!upperOnly) {
      const torsoLen = d3(shMid, hipMid);
      if (torsoLen < 0.15) return { ok: false, why: 'torso collapsed' };
      const ratio = shW / torsoLen;                 // real people: roughly 0.5 - 1.1
      if (ratio < 0.25) return { ok: false, why: 'body proportions impossible (too thin)' };
      if (ratio > 1.8) return { ok: false, why: 'body proportions impossible (too wide)' };
      if (lm[0].visibility >= VIS && d3(world[0], shMid) / torsoLen > 1.2) {
        return { ok: false, why: 'head too far from shoulders' };
      }
    } else if (lm[0].visibility >= VIS) {
      // hips out of view: compare the shoulders with the head instead
      const headDist = d3(world[0], shMid);       // nose to between the shoulders, ~0.2-0.3 m
      const ratio = shW / (headDist || 1);         // real people: roughly 1 - 2.5
      if (ratio < 0.4 || ratio > 5) return { ok: false, why: 'head and shoulders proportions impossible' };
    }
  }

  // Reading the mask back from the GPU is the slowest step of a frame, so a person who is
  // already confirmed is only re-checked every MASK_EVERY frames; new bodies always are.
  if (!mask || (trusted && maskTick++ % MASK_EVERY !== 0)) return { ok: true, vis, upperOnly };
  const data = mask.getAsFloat32Array();
  const at = (x, y) => {
    const px = Math.min(mask.width - 1, Math.max(0, Math.round(x * mask.width)));
    const py = Math.min(mask.height - 1, Math.max(0, Math.round(y * mask.height)));
    return data[py * mask.width + px];
  };
  const mid = (a, b, t = 0.5) => ({ x: lm[a].x + (lm[b].x - lm[a].x) * t, y: lm[a].y + (lm[b].y - lm[a].y) * t });
  // sample down the torso from the shoulders (only the part that's inside the picture)
  const sh = mid(11, 12), hp = mid(23, 24);
  const pts = (upperOnly ? [0.05, 0.15, 0.25] : [0.1, 0.35, 0.6, 0.85])
    .map((t) => ({ x: sh.x + (hp.x - sh.x) * t, y: sh.y + (hp.y - sh.y) * t }))
    .filter((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
  if (!pts.length) return { ok: true, vis, upperOnly };
  const cover = pts.reduce((s, p) => s + at(p.x, p.y), 0) / pts.length;
  return cover >= MASK_MIN ? { ok: true, cover, vis } : { ok: false, why: 'no body under skeleton', cover, vis };
}

// ---------- drawing ----------
// fade < 1 = predicted (bridging a gap), drawn see-through
function drawPose(lm, w, h, fade = 1) {
  const lw = Math.max(2, w / 250);
  ctx.lineCap = 'round';
  for (const p of Object.values(PARTS)) {
    ctx.strokeStyle = p.color;
    ctx.lineWidth = lw;
    for (const [a, b] of p.edges) {
      const v = Math.min(lm[a].visibility, lm[b].visibility);
      if (v < VIS_FAINT) continue;
      const faint = v < VIS;            // uncertain (e.g. partly hidden leg): dashed + see-through
      ctx.globalAlpha = (faint ? 0.55 : 1) * fade;
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
    ctx.globalAlpha = (lm[i].visibility < VIS ? 0.55 : 1) * fade;
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

function drawHand(hl, w, h, fade = 1) {
  const lw = Math.max(2, w / 350);
  ctx.globalAlpha = fade;
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
  ctx.globalAlpha = 1;
}


// ---------- per-frame ----------
const speed = {};               // smoothed m/s per mover
let prevWorld = null, prevT = 0;
let seenFrames = 0, missFrames = 0, confirmed = false, lastReject = null, lastConfirmedAt = -1e9;
const MAX_MISSES = 4;
const HOLD_MS = 300;            // bridge gaps this long by predicting where the body/hands went
const REACQUIRE_MS = 1000;      // someone seen this recently comes back after 1 good frame
let lastGood = null;            // { t, lm, world, angles, vel }
let lastHands = [];             // [{ t, hand }] from the last real detections
let procCount = 0, procT0 = performance.now();
let shownFirst = false;
let tsOffset = 0, lastMpT = 0;

// src: ImageBitmap (picture mode) or <video> (WebRTC, screen, file).
// clock (ms, optional): the evaluator passes the clip's own time, so motion and timing
// behave the same however fast it steps through a clip.
function processFrame(src, w, h, clock, live = false) {
  const t = live ? clock - performance.timeOrigin : clock ?? performance.now();
  const tAll = performance.now();
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (opts.video) ctx.drawImage(src, 0, 0, w, h);

  const out = { t: clock ?? Date.now(), width: w, height: h, pose: null, hands: [], view: 'none' };
  if (live) out.capturedAt = clock;

  if (!pipe) return null;                       // model is (re)loading
  // MediaPipe needs strictly increasing timestamps. Live frames and the evaluator's
  // clip clock are different clocks, so shift onto one rising timeline while keeping
  // the spacing between frames (its smoothing uses that spacing).
  if (t + tsOffset <= lastMpT) tsOffset = lastMpT + 33 - t;
  const mpT = t + tsOffset;
  lastMpT = mpT;
  const tA = performance.now();
  const det = detect(src, mpT);
  const tB = performance.now();

  // Hands first: the body checks use them.
  if (opts.hands) {
    for (const hd of det.hands) out.hands.push({ ...hd, fingersUp: fingersUp(hd.landmarks), box: handBox(hd.landmarks, 0) });
    // Bridge brief hand drop-outs (fast motion blurs hands): keep a hand we saw
    // < HOLD_MS ago if nothing was found near where it was. Marked `predicted`, so the
    // brain won't read gestures from it.
    const now = out.hands.map((x) => x.box);
    for (const prev of lastHands) {
      if (t - prev.t > HOLD_MS) continue;
      const b = prev.hand.box, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, sz = Math.max(b.x1 - b.x0, b.y1 - b.y0);
      if (!now.some((n) => Math.hypot((n.x0 + n.x1) / 2 - cx, (n.y0 + n.y1) / 2 - cy) < sz * 1.5)) {
        out.hands.push({ ...prev.hand, predicted: true });
      }
    }
    const real = out.hands.filter((x) => !x.predicted);
    lastHands = [
      ...real.map((hand) => ({ t, hand })),
      ...lastHands.filter((p) => t - p.t <= HOLD_MS && out.hands.some((x) => x.predicted && x.landmarks === p.hand.landmarks)),
    ];
  }

  if (opts.body) {
    let rawLm = det.pose?.lm, rawWorld = det.pose?.world;
    // Points the model placed outside the picture are guesses: mark them not visible,
    // so only the parts actually in view get drawn and described.
    if (rawLm) {
      rawLm = rawLm.map((p) => (p.x < -EDGE || p.x > 1 + EDGE || p.y < -EDGE || p.y > 1 + EDGE ? { ...p, visibility: 0 } : p));
      // Keep left and right consistent: the model sometimes swaps them (close-ups, an
      // arm crossing the body). If it did, swap the whole body back, hands included.
      const fix = fixSides(rawLm, rawWorld, det.faceGuard, t, w, h);
      if (fix.swapped) {
        rawLm = fix.lm; rawWorld = fix.world;
        for (const hd of out.hands) if (hd.sideKnown) hd.side = hd.side === 'left' ? 'right' : 'left';
      }
      out.sideFix = fix.why;
    }
    let check = rawLm
      ? isRealPerson(rawLm, rawWorld, det.pose.mask, det.guard, confirmed)
      : { ok: false, why: 'nobody' };

    // Hysteresis: a new person must pass CONFIRM_FRAMES in a row (just 1 if we saw them
    // in the last second); a confirmed person is kept through up to MAX_MISSES soft
    // failures in a row. Hard failures and "nobody detected" drop them straight away.
    if (check.ok) { seenFrames++; missFrames = 0; }
    else if (confirmed && rawLm && !check.hard && missFrames < MAX_MISSES) {
      missFrames++;
      check = { ...check, ok: true, kept: true };
    } else { seenFrames = 0; missFrames = 0; confirmed = false; }
    const need = t - lastConfirmedAt < REACQUIRE_MS ? 1 : CONFIRM_FRAMES;
    if (check.ok && seenFrames >= need) confirmed = true;
    lastReject = check.ok ? null : check.why;
    out.check = check;

    if (check.ok && confirmed) {
      lastConfirmedAt = t;
      const lm = smoothLm.apply(rawLm, t), world = smoothWorld.apply(rawWorld, t);
      const angles = jointAngles(lm, world);
      if (prevWorld && t > prevT) {
        const dt = (t - prevT) / 1000;
        for (const [name, i] of Object.entries(MOVERS)) {
          const v = lm[i].visibility >= VIS
            ? Math.hypot(world[i].x - prevWorld[i].x, world[i].y - prevWorld[i].y, world[i].z - prevWorld[i].z) / dt
            : 0;
          speed[name] = (speed[name] ?? v) * 0.7 + v * 0.3;   // exponential smoothing
        }
      }
      // velocity of every landmark (per ms), smoothed, for bridging gaps
      let vel = lm.map(() => ({ x: 0, y: 0, z: 0 })), wvel = vel;
      if (lastGood && t > lastGood.t && t - lastGood.t < 500) {
        const dt = t - lastGood.t;
        vel = lm.map((p, i) => ({
          x: lastGood.vel[i].x * 0.5 + 0.5 * (p.x - lastGood.lm[i].x) / dt,
          y: lastGood.vel[i].y * 0.5 + 0.5 * (p.y - lastGood.lm[i].y) / dt,
          z: 0,
        }));
        wvel = world.map((p, i) => ({
          x: lastGood.wvel[i].x * 0.5 + 0.5 * (p.x - lastGood.world[i].x) / dt,
          y: lastGood.wvel[i].y * 0.5 + 0.5 * (p.y - lastGood.world[i].y) / dt,
          z: lastGood.wvel[i].z * 0.5 + 0.5 * (p.z - lastGood.world[i].z) / dt,
        }));
      }
      lastGood = { t, lm, world, vel, wvel };
      prevWorld = world; prevT = t;
      drawPose(lm, w, h);
      drawAngleLabels(lm, angles, w, h);
      // raw* = straight from the model, before smoothing: smoothing lags and flattens peaks
      // (top of a jump, end of a rep), so measurements use the raw points.
      out.pose = { landmarks: lm, worldLandmarks: world, angles, head: headPose(lm, w, h), speed: { ...speed },
        rawLandmarks: rawLm, rawWorldLandmarks: rawWorld, rawAngles: jointAngles(rawLm, rawWorld) };
    } else if (lastGood && !check.hard && t - lastGood.t < HOLD_MS) {
      // Lost them for a moment (often motion blur): carry on along their last motion,
      // drawn faded, instead of making the skeleton vanish.
      const dt = Math.min(t - lastGood.t, HOLD_MS);
      const lm = lastGood.lm.map((p, i) => ({ ...p, x: p.x + lastGood.vel[i].x * dt, y: p.y + lastGood.vel[i].y * dt, visibility: p.visibility * 0.9 }));
      const world = lastGood.world.map((p, i) => ({ ...p, x: p.x + lastGood.wvel[i].x * dt, y: p.y + lastGood.wvel[i].y * dt, z: p.z + lastGood.wvel[i].z * dt }));
      drawPose(lm, w, h, 0.4);
      out.pose = { landmarks: lm, worldLandmarks: world, angles: jointAngles(lm, world), head: headPose(lm, w, h), speed: { ...speed }, predicted: true };
    } else if (!check.ok) {
      prevWorld = null; lastGood = null;
      smoothLm.reset(); smoothWorld.reset();
    }
  }

  det.close();

  // Face (Holistic only): drop it if the "face" was really a palm.
  if (opts.body && det.face && !(lastReject && out.check?.hard)) {
    out.face = det.face;
    drawFace(det.face.landmarks, w, h);
  }

  for (const hd of out.hands) drawHand(hd.landmarks, w, h, hd.predicted ? 0.4 : 1);
  out.view = out.pose ? 'body' : out.hands.length ? 'hands' : 'none';
  out.closeup = det.guard.some((hl) => handBox(hl, 0).area > CLOSEUP_AREA);
  out.parts = { body: opts.body, hands: opts.hands, face: opts.face && pipe.kind === 'holistic' };
  out.bodyRejected = lastReject && lastReject !== 'nobody' ? lastReject : null;
  out.source = window.camSource?.label?.() || 'pictures';
  out.pipeline = pipe.choice;

  procCount++;
  const el = (performance.now() - procT0) / 1000;
  if (el > 1) {
    setText('trackFps', `${(procCount / el).toFixed(1)} fps tracked${pipe.kind === 'hybrid' && hybrid.last ? ` · ${hybrid.last}` : ''}`);
    procCount = 0; procT0 = performance.now();
  }
  out.model = pipe.kind === 'hybrid' ? hybrid.last : pipe.choice;

  if (!shownFirst) {
    // first frame from any source: show the canvas, tuck the QR away
    shownFirst = true;
    document.getElementById('stage').style.display = '';
    document.getElementById('placeholder').style.display = 'none';
    window.setQrVisible?.(false);
  }

  const tC = performance.now();
  window.tracking = out;
  window.dispatchEvent(new CustomEvent('tracking', { detail: out }));
  renderPanel(out);
  // Where a frame's time goes (ms): model, our checks + drawing, listeners + side panel.
  const tD = performance.now();
  out.timing = { model: tB - tA, ours: tA - tAll + (tC - tB), after: tD - tC };
  window.trackTiming = out.timing;
  return out;
}

let guardFrame = 0, guardCache = null;

// ---------- keeping left and right consistent ----------
// Pose landmark pairs (left id, right id).
const LR_PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20],
  [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
const swapLR = (arr) => {
  if (!arr) return arr;
  const a = arr.slice();
  for (const [l, r] of LR_PAIRS) { a[l] = arr[r]; a[r] = arr[l]; }
  return a;
};
let sideRef = null;   // where each limb was on the last frame: { t, lm }

// Decide whether the model's left/right labels are swapped this frame.
//  1. Face (most reliable, when the face mesh sees a fairly frontal face): the
//     cheek-to-cheek direction says which side of the picture the person's left is on;
//     the shoulders must agree.
//  2. Side-on geometry: when the person stands side-on, the side nearer the camera
//     follows from which way they face: facing right in the picture → their RIGHT side
//     is nearer (facing left → left). The model's labels say which side it thinks is
//     nearer (world z). If the two disagree, the whole body was labelled the wrong way
//     round. (Continuity can't catch this: the far limbs are hidden, and the model often
//     flips all labels at once while the person stands still.)
//  3. Continuity: limbs move smoothly, so if "left elbow/wrist/knee/ankle" are now
//     where the right ones were a moment ago (and vice versa), the labels flipped.
function sideOnSwap(lm, world, w, h) {
  if (!world) return false;
  const ok = (i) => lm[i].visibility >= 0.3;
  if (![0, 11, 12, 23, 24].every((i) => lm[i] && world[i]) || !ok(0) || !(ok(11) || ok(12))) return false;
  const shX = (lm[11].x + lm[12].x) / 2 * w, shY = (lm[11].y + lm[12].y) / 2 * h, hipY = (lm[23].y + lm[24].y) / 2 * h;
  const torso = Math.abs(hipY - shY);
  if (torso < 20) return false;
  const width = Math.abs(lm[11].x - lm[12].x) * w;
  if (width > 0.35 * torso) return false;                              // not side-on
  const facing = lm[0].x * w - shX;                                    // nose ahead of the shoulders
  if (Math.abs(facing) < 0.15 * torso) return false;                   // can't tell which way they face
  const dz = (world[11].z + world[23].z) - (world[12].z + world[24].z); // < 0: "left" is nearer
  if (Math.abs(dz) < 0.12) return false;                               // model isn't sure which is nearer
  const labelNear = dz < 0 ? 'L' : 'R';
  const trueNear = facing > 0 ? 'R' : 'L';
  return labelNear !== trueNear;
}

function fixSides(lm, world, face, t, w = 1, h = 1) {
  let swap = false, why = null;
  const vis = (i) => lm[i].visibility >= 0.3;
  if (face && vis(11) && vis(12)) {
    const F = face.landmarks;
    const fx = F[454].x - F[234].x, fy = F[454].y - F[234].y, fz = F[454].z - F[234].z;
    const frontal = Math.abs(fx) / (Math.hypot(fx, fy, fz) || 1);
    const sx = lm[11].x - lm[12].x;
    if (frontal > 0.6 && Math.abs(sx) > 0.02 && Math.sign(sx) !== Math.sign(fx)) { swap = true; why = 'face'; }
  }
  if (!why && sideOnSwap(lm, world, w, h)) { swap = true; why = 'side-on'; }
  if (!why && sideRef && t - sideRef.t < 600) {
    let keep = 0, cross = 0, n = 0;
    for (const [l, r] of [[13, 14], [15, 16], [25, 26], [27, 28]]) {
      const P = sideRef.lm;
      if (!(vis(l) && vis(r) && P[l].visibility >= 0.3 && P[r].visibility >= 0.3)) continue;
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      keep += d(lm[l], P[l]) + d(lm[r], P[r]);
      cross += d(lm[l], P[r]) + d(lm[r], P[l]);
      n++;
    }
    if (n && keep > 0.04 * n && cross < keep * 0.5) { swap = true; why = 'continuity'; }
  }
  const outLm = swap ? swapLR(lm) : lm;
  sideRef = { t, lm: outLm };
  return { swapped: swap, why, lm: outLm, world: swap ? swapLR(world) : world };
}

// One call per frame to whichever pipeline is loaded; same output shape for both.
// hands = what's shown and described; guard = hands used only for the ghost checks.
function detect(src, t) {
  if (pipe.kind === 'hybrid') return detectHybrid(src, t);
  if (pipe.kind === 'holistic') return detectHolistic(src, t);
  return detectSeparate(src, t);
}

// Hybrid ("Auto"): the separate accurate body model is ~2.5x faster than Holistic
// (about 33 vs 80 ms a frame, so ~30 instead of ~12 fps), but on the test set it lost
// seated and side-on people that Holistic still found. So: the fast model every frame,
// and when it finds nobody, Holistic for that frame and the next HYBRID_HOLD_MS (models
// are not switched back and forth every frame, which would make the points jump).
const HYBRID_HOLD_MS = 2000;
const hybrid = { holisticUntil: -1e9, last: null };
function detectHybrid(src, t) {
  if (t >= hybrid.holisticUntil) {
    const d = detectSeparate(src, t);
    if (d.pose) { hybrid.last = 'fast body model'; return d; }
    d.close();
  }
  const d = detectHolistic(src, t);
  if (d.pose && t >= hybrid.holisticUntil) hybrid.holisticUntil = t + HYBRID_HOLD_MS;
  hybrid.last = 'Holistic (fast model lost the person)';
  return d;
}

function detectHolistic(src, t) {
  {
    const r = pipe.holistic.detectForVideo(src, t);
    const hands = [];
    for (const [side, L, Wl] of [['left', r.leftHandLandmarks, r.leftHandWorldLandmarks], ['right', r.rightHandLandmarks, r.rightHandWorldLandmarks]]) {
      // attached to the body's own left/right wrist, so the side is known for sure
      if (L?.[0]?.length) hands.push({ landmarks: L[0], worldLandmarks: Wl?.[0], handedness: side, side, sideKnown: true });
    }
    // Side-on, the hidden arm's wrist is often guessed on top of the visible one, and
    // the same physical hand then comes back twice. Keep the one whose wrist is visible.
    const pl = r.poseLandmarks?.[0];
    if (hands.length === 2 && pl) {
      const c = (hl) => { let x = 0, y = 0; for (const p of hl) { x += p.x; y += p.y; } return { x: x / hl.length, y: y / hl.length }; };
      const a = c(hands[0].landmarks), b = c(hands[1].landmarks);
      const size = Math.hypot(hands[0].landmarks[9].x - hands[0].landmarks[0].x, hands[0].landmarks[9].y - hands[0].landmarks[0].y);
      if (Math.hypot(a.x - b.x, a.y - b.y) < size * 0.6) {
        const vis = (side) => pl[side === 'left' ? 15 : 16].visibility;
        hands.splice(vis(hands[0].side) >= vis(hands[1].side) ? 1 : 0, 1);
      }
    }
    // Hands are still used for the ghost-body checks even when hidden.
    const guard = hands.map((x) => x.landmarks);
    if (!r.poseLandmarks?.[0]?.length && opts.hands) {
      // no body: close-up mode, use the standalone hand model
      const hr = pipe.hands.detectForVideo(src, t);
      (hr.landmarks || []).forEach((hl, i) => {
        const label = hr.handedness?.[i]?.[0]?.categoryName;
        hands.push({ landmarks: hl, worldLandmarks: hr.worldLandmarks?.[i], handedness: label, side: label === 'Left' ? 'left' : label === 'Right' ? 'right' : null });
      });
    }
    const face = r.faceLandmarks?.[0]?.length ? {
      landmarks: r.faceLandmarks[0],
      blendshapes: Object.fromEntries((r.faceBlendshapes?.[0]?.categories || []).map((c) => [c.categoryName, c.score])),
    } : null;
    return {
      hands: opts.hands ? hands : [], guard, face: opts.face ? face : null, faceGuard: face,
      pose: r.poseLandmarks?.[0]?.length ? { lm: r.poseLandmarks[0], world: r.poseWorldLandmarks?.[0], mask: r.poseSegmentationMasks?.[0] } : null,
      close: () => r.poseSegmentationMasks?.forEach((m) => m.close()),
    };
  }
}

function detectSeparate(src, t) {
  let hr = null;
  if (opts.hands) hr = pipe.hands.detectForVideo(src, t);
  else if (opts.body && guardFrame++ % 3 === 0) {
    // Hands hidden: still glance for hands every 3rd frame, only so the ghost-body checks
    // (close-up, palm mistaken for a face) keep working. Never shown or described.
    hr = pipe.hands.detectForVideo(src, t);
    guardCache = { t, lms: hr.landmarks || [] };
  }
  const pr = opts.body ? pipe.pose.detectForVideo(src, t) : null;
  const guard = opts.hands ? (hr?.landmarks || []) : (guardCache && t - guardCache.t < 400 ? guardCache.lms : []);
  const hands = (opts.hands ? hr?.landmarks || [] : []).map((hl, i) => {
    const label = hr.handedness?.[i]?.[0]?.categoryName;
    // only a fallback: the brain matches hands to the body's wrists when it can
    return { landmarks: hl, worldLandmarks: hr.worldLandmarks?.[i], handedness: label, side: label === 'Left' ? 'left' : label === 'Right' ? 'right' : null };
  });
  return {
    hands, guard, face: null,
    pose: pr?.landmarks?.[0] ? { lm: pr.landmarks[0], world: pr.worldLandmarks?.[0], mask: pr.segmentationMasks?.[0] } : null,
    close: () => pr?.segmentationMasks?.forEach((m) => m.close()),
  };
}

function drawFace(fl, w, h) {
  const groups = ['FACE_LANDMARKS_FACE_OVAL', 'FACE_LANDMARKS_LIPS', 'FACE_LANDMARKS_LEFT_EYE', 'FACE_LANDMARKS_RIGHT_EYE',
    'FACE_LANDMARKS_LEFT_EYEBROW', 'FACE_LANDMARKS_RIGHT_EYEBROW'];
  ctx.strokeStyle = 'rgba(255, 213, 79, .7)';
  ctx.lineWidth = Math.max(1, w / 600);
  ctx.beginPath();
  for (const g of groups) {
    for (const { start, end } of HolisticLandmarker[g] || []) {
      ctx.moveTo(fl[start].x * w, fl[start].y * h);
      ctx.lineTo(fl[end].x * w, fl[end].y * h);
    }
  }
  ctx.stroke();
}

// Forget everything about the person (between test clips, or after switching model).
function resetTracking() {
  seenFrames = 0; missFrames = 0; confirmed = false; lastReject = null; lastConfirmedAt = -1e9;
  lastGood = null; lastHands = []; prevWorld = null; sideRef = null;
  for (const k of Object.keys(speed)) delete speed[k];
  smoothLm.reset(); smoothWorld.reset();
}

// For the test-set evaluator: process one frame synchronously and get the result.
window.phoneCamTracker = {
  process: (src, w, h, clock) => processFrame(src, w, h, clock),
  reset: resetTracking,
  switchPipeline,
  get pipeline() { return pipe?.choice; },
  get ready() { return !!pipe; },
  get opts() { return { ...opts }; },
  // set toggles without auto-switching the model (the evaluator picks the model itself)
  setOpts(o) { const prev = { ...opts }; Object.assign(opts, o, BODY_ONLY); syncBoxes(); showState(); return prev; },
};

function jointAngles(lm, world) {
  const angles = {};
  for (const [label, a, b, c] of JOINTS) {
    angles[label] = Math.min(lm[a].visibility, lm[b].visibility, lm[c].visibility) >= VIS
      ? angle3(world[a], world[b], world[c]) : null;
  }
  return angles;
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

  setText('bodyState', p ? (p.predicted ? 'Body tracked (bridging a gap)' : 'Body tracked')
    : lastReject && lastReject !== 'nobody' ? `No person (ignored a false match: ${lastReject})`
    : 'No body detected');
}

// ---------- frame loop ----------
// Video sources (WebRTC / screen / file) are processed once per new video frame;
// otherwise we fall back to the phone's JPEG pictures, each fetched once.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Model choice: "auto" = hybrid (see detectHybrid): the accurate separate body model
// every frame (~30 fps), Holistic only while that model loses the person (seated,
// side-on). Holistic alone was ~12 fps. The other models stay in the menu for comparison.
const modelSel = document.getElementById('opt-model');
function wantedChoice() {
  const v = modelSel?.value || 'auto';
  return v === 'auto' ? 'hybrid' : v;
}
function autoPipeline() {
  const c = wantedChoice();
  if (!pipe || pipe.choice !== c) switchPipeline(c);
  else showState();
  resetTracking();
  window.brain?.reset();
}
await switchPipeline(wantedChoice());
if (!pipe) throw new Error('MediaPipe failed to load');
if (modelSel) modelSel.onchange = autoPipeline;

let after = 0;
let lastCapture = -Infinity;
const videoClock = createVideoClock();
function trackLive(src, width, height, capturedAt) {
  if (capturedAt === null || capturedAt <= lastCapture) return;
  lastCapture = capturedAt;
  processFrame(src, width, height, capturedAt, true);
}
for (;;) {
  const v = window.camSource?.activeVideo();
  if (v) {
    const frame = await nextVideoFrame(v);
    if (window.camSource.activeVideo() === v && v.videoWidth) {
      const capturedAt = videoClock(v, frame);
      // File playback can run faster or slower than real time. Its capture clock
      // should follow presentation time so switching back to the phone stays ordered.
      const timestamp = capturedAt !== null && window.camSource.mode === 'file'
        ? performance.timeOrigin + (frame.presentationTime ?? performance.now()) : capturedAt;
      try { trackLive(v, v.videoWidth, v.videoHeight, timestamp); } catch (e) { console.warn('frame failed', e); }
    }
    continue;
  }
  if (window.camSource && !window.camSource.wantsPictures()) { await sleep(100); continue; }
  let res;
  try { res = await fetch(`/next.jpg?after=${after}&wait=500`); } catch { await sleep(1000); continue; }
  if (res.status !== 200) continue;            // 204 = nothing new yet; check sources again
  after = Number(res.headers.get('X-Frame'));
  const capturedAt = Number(res.headers.get('X-Capture-Time')) || Date.now();
  try {
    const bmp = await createImageBitmap(await res.blob());
    try { trackLive(bmp, bmp.width, bmp.height, capturedAt); }
    finally { bmp.close(); }
  } catch (e) { console.warn('frame failed', e); }
}
