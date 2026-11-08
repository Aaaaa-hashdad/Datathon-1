// The "brain": turns raw tracking (from tracker.js) into a detailed description of
// what the person is doing. Pure logic, no DOM, so it can be tested on its own and
// later swapped for / combined with a trained model.
//
// Body geometry uses MediaPipe *world* landmarks (metres, origin at the hips, y down),
// measured in the person's own body frame, so "their left" and "forward" are right
// whichever way they face the camera. Hands use image coordinates scaled by hand size.

const V = 0.5;               // landmark visibility needed to trust a point
const HISTORY_MS = 3000;     // how much motion history to keep
const RATE_MS = 400;         // window for "what is moving right now"

// Pose landmark ids
const NOSE = 0, L_EAR = 7, R_EAR = 8;
const SIDE = {
  left:  { sh: 11, el: 13, wr: 15, hip: 23, knee: 25, ank: 27, A: 'L' },
  right: { sh: 12, el: 14, wr: 16, hip: 24, knee: 26, ank: 28, A: 'R' },
};

// ---------- vector helpers ----------
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const norm = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };
const mid = (a, b) => mul(add(a, b), 0.5);
const dist = (a, b) => len(sub(a, b));
const deg = (r) => r * 180 / Math.PI;
const UP = { x: 0, y: -1, z: 0 };
const flat = (a) => ({ x: a.x, y: 0, z: a.z });
const angle3 = (a, b, c) => {
  const v1 = sub(a, b), v2 = sub(c, b);
  return deg(Math.acos(Math.max(-1, Math.min(1, dot(v1, v2) / ((len(v1) * len(v2)) || 1)))));
};
const r0 = (n) => Math.round(n);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Count direction reversals larger than `thr` in a series (hysteresis, so jitter is ignored).
function swings(vals, thr) {
  if (vals.length < 3) return 0;
  let n = 0, dir = 0, ext = vals[0];
  for (const v of vals) {
    if (dir === 0) { if (v - ext > thr) { dir = 1; ext = v; } else if (ext - v > thr) { dir = -1; ext = v; } }
    else if (dir === 1) { if (v > ext) ext = v; else if (ext - v > thr) { n++; dir = -1; ext = v; } }
    else { if (v < ext) ext = v; else if (v - ext > thr) { n++; dir = 1; ext = v; } }
  }
  return n;
}
const range = (vals) => vals.length ? Math.max(...vals) - Math.min(...vals) : 0;

// Describe a velocity {up, fwd, left} (any units) by its dominant directions.
function dirWords(v, { fwdWord = 'forward', backWord = 'back', leftWord = 'to their left', rightWord = 'to their right' } = {}) {
  const mag = Math.hypot(v.up, v.fwd ?? 0, v.left);
  const parts = [];
  if (Math.abs(v.up) > mag * 0.5) parts.push(v.up > 0 ? 'up' : 'down');
  if (v.fwd != null && Math.abs(v.fwd) > mag * 0.5) parts.push(v.fwd > 0 ? fwdWord : backWord);
  if (Math.abs(v.left) > mag * 0.5) parts.push(v.left > 0 ? leftWord : rightWord);
  return parts.join(' and ');
}

// ---------- hands ----------
const FINGERS = { index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };

function readHand(hl, w, h, hw) {
  const P = hl.map((p) => ({ x: p.x * w, y: p.y * h, z: p.z * w }));
  const size = Math.hypot(P[9].x - P[0].x, P[9].y - P[0].y) || 1;     // wrist -> middle knuckle (px)
  const ext = {};
  for (const [name, [mcp, pip, , tip]] of Object.entries(FINGERS)) {
    ext[name] = angle3(P[mcp], P[pip], P[tip]) > 150 && dist(P[tip], P[0]) > dist(P[pip], P[0]);
  }
  ext.thumb = angle3(P[2], P[3], P[4]) > 140 && dist(P[4], P[5]) > dist(P[2], P[5]);
  const up = ['thumb', 'index', 'middle', 'ring', 'pinky'].filter((k) => ext[k]);
  const curled = ['thumb', 'index', 'middle', 'ring', 'pinky'].filter((k) => !ext[k]);
  const nFingers = ['index', 'middle', 'ring', 'pinky'].filter((f) => ext[f]).length;
  const pinchGap = dist(P[4], P[8]) / size;

  // which way the fingers point (wrist -> middle knuckle), in screen terms
  const ov = { x: P[9].x - P[0].x, y: P[9].y - P[0].y };
  const orient = deg(Math.atan2(-ov.y, ov.x));      // 90 = fingers up
  const pointing = Math.abs(ov.y) > Math.abs(ov.x) ? (ov.y < 0 ? 'up' : 'down') : (ov.x < 0 ? 'to screen-left' : 'to screen-right');

  // Palm vs back, and which hand it is, from the hand's own shape:
  //  - curled fingertips move toward the palm, so if they're closer to the camera than
  //    their knuckles, the palm faces the camera (needs >= 2 curled fingers);
  //  - the knuckle line (wrist -> index knuckle vs wrist -> pinky knuckle) winds one way for
  //    "right hand, palm to camera" and the other way for "left hand, palm to camera".
  // Knowing one of (palm side, which hand) gives the other.
  const a = sub(P[5], P[0]), b = sub(P[17], P[0]);
  const crossZ = a.x * b.y - a.y * b.x;
  let palmToCam = null;
  const curledF = ['index', 'middle', 'ring', 'pinky'].filter((f) => !ext[f]);
  if (hw && curledF.length >= 2) {
    const dz = curledF.reduce((s, f) => s + (hw[FINGERS[f][3]].z - hw[FINGERS[f][0]].z), 0) / curledF.length;
    if (Math.abs(dz) > 0.005) palmToCam = dz < 0;        // metres; - = tips closer to camera
  }
  // Only trust the winding when the hand isn't edge-on to the camera.
  const flatEnough = Math.abs(crossZ) > 0.25 * size * size;
  let geomSide = null;
  if (palmToCam != null && flatEnough) geomSide = palmToCam === (crossZ < 0) ? 'right' : 'left';

  // fingers spread apart vs held together (only meaningful with most fingers out)
  let spread = null;
  if (nFingers >= 3) {
    const di = sub(P[8], P[5]), dp = sub(P[20], P[17]);
    const ang = deg(Math.acos(Math.max(-1, Math.min(1, (di.x * dp.x + di.y * dp.y) / ((Math.hypot(di.x, di.y) * Math.hypot(dp.x, dp.y)) || 1)))));
    spread = ang > 30 ? 'fingers spread apart' : 'fingers held together';
  }

  let gesture;
  if (pinchGap < 0.3 && ext.middle && ext.ring && ext.pinky) gesture = 'OK sign';
  // A real pinch holds the index out from the palm to meet the thumb; in a fist the thumb
  // just rests on an index finger that's folded into the palm.
  else if (pinchGap < 0.25 && nFingers <= 1 && dist(P[8], P[0]) > dist(P[5], P[0]) * 1.15) gesture = 'pinching (thumb and index touching)';
  else if (up.length === 5) gesture = 'open palm';
  else if (nFingers === 0 && ext.thumb) {
    const dy = (P[4].y - P[2].y) / size;
    gesture = dy < -0.4 ? 'thumbs up' : dy > 0.4 ? 'thumbs down' : 'thumb out';
  } else if (nFingers === 0) gesture = 'fist';
  else if (ext.index && nFingers === 1) {
    const v = sub(P[8], P[5]);
    const l2 = Math.hypot(v.x, v.y) / size;
    const dir = l2 < 0.35 ? 'at the camera'
      : Math.abs(v.y) > Math.abs(v.x) ? (v.y < 0 ? 'up' : 'down') : (v.x < 0 ? 'to screen-left' : 'to screen-right');
    gesture = `pointing ${dir}`;
  } else if (ext.index && ext.middle && nFingers === 2) gesture = 'peace sign (two fingers)';
  else if (ext.index && ext.pinky && !ext.middle && !ext.ring) gesture = 'rock sign';
  else if (ext.thumb && ext.pinky && nFingers === 1) gesture = 'call-me / shaka';
  else gesture = `${up.length} finger${up.length === 1 ? '' : 's'} out`;

  const cx = P.reduce((s, p) => s + p.x, 0) / P.length, cy = P.reduce((s, p) => s + p.y, 0) / P.length;
  return {
    side: 'hand', geomSide, palmToCam, crossZ, flatEnough,
    gesture, extended: up, curled, count: up.length, pointing, orient, palm: null, spread, pinchGap, size, cx, cy, wrist: hl[0],
  };
}

// ---------- face (Holistic) ----------
// Head direction from the face mesh: a vector toward the person's left (cheek to cheek)
// and one pointing up the face (chin to forehead); their cross product points out of
// the face. Axes: x right, y down, z away from the camera.
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
function faceReading(face, w, h) {
  const F = face.landmarks;
  const P = (i) => ({ x: F[i].x * w, y: F[i].y * h, z: F[i].z * w });
  const L = norm(sub(P(454), P(234)));     // toward the person's left
  const U = norm(sub(P(10), P(152)));      // chin -> forehead
  const fwd = norm({ x: L.y * U.z - L.z * U.y, y: L.z * U.x - L.x * U.z, z: L.x * U.y - L.y * U.x });
  return {
    fwd,
    pitch: deg(Math.asin(clamp1(-fwd.y))),  // + = looking up
    roll: deg(Math.asin(clamp1(L.y))),      // + = tilted toward the left shoulder
    bs: face.blendshapes || {},
    landmarks: F,
  };
}
function expressions(fr, head) {
  if (!fr) return [];
  const b = fr.bs, avg = (x, y) => ((b[x] || 0) + (b[y] || 0)) / 2, out = [];
  if (avg('mouthSmileLeft', 'mouthSmileRight') > 0.5) out.push('smiling');
  if ((b.jawOpen || 0) > 0.35) out.push('mouth open');
  // eyelids look closed when someone simply looks down, so skip that case
  if (avg('eyeBlinkLeft', 'eyeBlinkRight') > 0.6 && !(head && head.pitchDeg < -20)) out.push('eyes closed');
  if ((b.browInnerUp || 0) > 0.6) out.push('eyebrows raised');
  // a big smile pulls the brows down too, so only call it a frown without one
  if (avg('browDownLeft', 'browDownRight') > 0.6 && !out.includes('smiling')) out.push('frowning');
  return out;
}

// Canonical labels: the same small vocabulary the test-set labels use.
function gestureKey(g) {
  if (!g) return null;
  if (g === 'open palm') return 'open';
  if (g === 'fist') return 'fist';
  if (g.startsWith('thumbs up')) return 'thumbs_up';
  if (g.startsWith('thumbs down')) return 'thumbs_down';
  if (g.startsWith('pointing')) return 'pointing';
  if (g.startsWith('peace')) return 'peace';
  if (g === 'OK sign') return 'ok';
  if (g.startsWith('pinching')) return 'pinch';
  if (g === 'rock sign') return 'rock';
  if (g.startsWith('call-me')) return 'shaka';
  return 'other';
}
function activityKeys(texts) {
  const keys = new Set();
  for (const a of texts) {
    if (a.startsWith('waving')) keys.add('waving');
    else if (a.startsWith('clapping')) keys.add('clapping');
    else if (a.startsWith('nodding')) keys.add('nodding');
    else if (a.startsWith('shaking head')) keys.add('shaking_head');
    else if (a.startsWith('stepping')) keys.add('stepping');
    else if (a.startsWith('moving toward screen')) keys.add('walking');
    else if (a.startsWith('jumping')) keys.add('jumping');
  }
  return [...keys];
}

// Once we've decided which hand it is, fill in palm direction where the curl didn't tell us.
function setSide(hd, side) {
  hd.side = side || 'hand';
  let p = hd.palmToCam;
  if (p == null && hd.flatEnough && (side === 'left' || side === 'right')) p = side === 'right' ? hd.crossZ < 0 : hd.crossZ > 0;
  hd.palm = p == null ? null : p ? 'palm toward the camera' : 'back of the hand toward the camera';
  return hd;
}
const isNamedGesture = (g) => !/fingers? out$/.test(g) && g !== 'thumb out';

// ---------- the brain ----------
export function createBrain() {
  const hist = [];                    // per-frame body features for motion analysis
  const handHist = { left: [], right: [], hand: [] };
  const events = [];                  // { t, text }
  const counters = { squats: 0, 'L curls': 0, 'R curls': 0, 'jumping jacks': 0, jumps: 0, claps: 0 };
  const phase = { squat: 'up', L: 'down', R: 'down', jack: 'closed', clap: 'apart' };
  let squatDepth = 180;
  // Curls: range-of-motion detector per arm (see "curls" below).
  const newCurl = () => ({ samples: [], phase: 'down', lo: 180, hi: 0, since: 0 });
  const curl = { L: newCurl(), R: newCurl() };
  const active = {};                  // ongoing activities -> true
  const stable = { posture: null, gestures: {}, palm: {}, open: {}, view: null };
  const recentPosture = [];
  const recentGest = { left: [], right: [], hand: [] };
  const recentPalm = { left: [], right: [], hand: [] };
  const recentView = [];
  let lastJumpT = 0;
  const lastHands = [];               // hands whose side we know, for open-hand frames
  let lastUpdateT = null, frameGap = 66;  // ms between updates (smoothed)
  const prevMotion = { body: new Set(), hands: new Set() };
  // Keep only motions also seen on the previous frame (ignoring the "(1.2 m/s)" part).
  function confirmMotions(kind, texts) {
    const key = (x) => x.replace(/ \(\d.*\)$/, '');
    const keep = texts.filter((x) => prevMotion[kind].has(key(x)) || x.startsWith('waving'));
    prevMotion[kind] = new Set(texts.map(key));
    return keep;
  }

  const log = (t, text) => {
    events.unshift({ t, text });
    if (events.length > 40) events.pop();
  };

  function reset() {
    hist.length = 0; events.length = 0; recentPosture.length = 0; recentView.length = 0;
    for (const k of Object.keys(handHist)) handHist[k].length = 0;
    for (const k of Object.keys(counters)) counters[k] = 0;
    Object.assign(phase, { squat: 'up', L: 'down', R: 'down', jack: 'closed', clap: 'apart' });
    curl.L = newCurl(); curl.R = newCurl();
    for (const k of Object.keys(active)) delete active[k];
    Object.assign(stable, { posture: null, gestures: {}, palm: {}, open: {}, view: null });
    prevMotion.body = new Set(); prevMotion.hands = new Set();
    lastHands.length = 0;
  }

  // Majority label over the last `ms`, only if it holds >= 70% of frames.
  function majority(list, t, ms) {
    while (list.length && list[0].t < t - ms) list.shift();
    const c = {};
    for (const x of list) c[x.label] = (c[x.label] || 0) + 1;
    const [best, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0] || [];
    return n >= list.length * 0.7 ? best : null;
  }

  const setActive = (t, key, on, startText) => {
    if (on && !active[key]) log(t, startText);
    if (on) active[key] = true; else delete active[key];
  };

  // ---------------- hands: motion + events (used in every mode) ----------------
  function handMotion(t, hd) {
    const H = handHist[hd.side];
    H.push({ t, cx: hd.cx, cy: hd.cy, size: hd.size, orient: hd.orient, count: hd.count });
    while (H.length && H[0].t < t - HISTORY_MS) H.shift();
    const name = hd.side === 'hand' ? 'hand' : `${hd.side} hand`;
    const motions = [];

    // movement over the last RATE_MS, in hand-sizes per second (so distance doesn't matter)
    const then = H.find((f) => f.t >= t - RATE_MS);
    if (then && t - then.t > 150) {
      const dt = (t - then.t) / 1000;
      const vx = (hd.cx - then.cx) / hd.size / dt, vy = (hd.cy - then.cy) / hd.size / dt;
      const grow = Math.log(hd.size / then.size) / dt;   // + = getting bigger = coming closer
      // fast-moving hands blur: their finger shapes (gestures) aren't trustworthy
      hd.fast = Math.hypot(vx, vy) > 3 || Math.abs(grow) > 1.5;
      if (Math.hypot(vx, vy) > 1.2) {
        motions.push(`${name} moving ${dirWords({ up: -vy, left: -vx }, { leftWord: 'to screen-left', rightWord: 'to screen-right' })}`);
      }
      if (Math.abs(grow) > 0.6) motions.push(`${name} moving ${grow > 0 ? 'toward' : 'away from'} the camera`);
      let dO = hd.orient - then.orient;
      dO = ((dO + 540) % 360) - 180;
      if (Math.abs(dO / dt) > 120) motions.push(`${name} rotating ${dO > 0 ? 'counter-clockwise' : 'clockwise'}`);
    }

    // waving: side-to-side swings of the whole hand
    const fr = H.filter((f) => f.t >= t - 1500);
    const xs = fr.map((f) => f.cx / hd.size);
    const waving = fr.length >= 6 && swings(xs, 0.35) >= 2 && range(xs) > 0.9;
    setActive(t, `hwave-${hd.side}`, waving, `Waving the ${name}`);
    if (waving) motions.unshift(`waving the ${name}`);

    // Shape-based events below need a sharp, real (not predicted) hand.
    if (hd.predicted || hd.fast) return motions;

    // opening / closing the hand
    const openState = hd.count >= 4 ? 'open' : hd.count <= 1 ? 'closed' : null;
    if (openState) {
      if (stable.open[hd.side] && stable.open[hd.side] !== openState) {
        log(t, openState === 'open' ? `Opened the ${name}` : `Closed the ${name} into a fist`);
      }
      stable.open[hd.side] = openState;
    }

    // palm flips
    if (hd.palm) {
      recentPalm[hd.side].push({ t, label: hd.palm });
      const m = majority(recentPalm[hd.side], t, 400);
      if (m && m !== stable.palm[hd.side]) {
        if (stable.palm[hd.side]) log(t, `Turned the ${name}: ${m}`);
        stable.palm[hd.side] = m;
      }
    }
    return motions;
  }

  function gestureEvents(t, hands) {
    for (const key of ['left', 'right', 'hand']) {
      const hd = hands.find((x) => x.side === key);
      if (hd && (hd.predicted || hd.fast)) continue;      // blurred / predicted: keep the last gesture
      const g = hd?.gesture ?? 'none';
      recentGest[key].push({ t, label: g });
      // a gesture must hold for half a second before it counts
      const m = majority(recentGest[key], t, 500);
      if (m && m !== stable.gestures[key]) {
        if (m !== 'none' && isNamedGesture(m) && m !== 'fist' && m !== 'open palm') {
          log(t, `${cap(m)}${key !== 'hand' ? ` (${key} hand)` : ''}`);
        }
        stable.gestures[key] = m;
      }
    }
  }

  function handLines(hd) {
    const who = hd.side === 'hand' ? 'Hand' : `${cap(hd.side)} hand`;
    return [
      `${who}: ${hd.gesture}`,
      [hd.palm, `fingers pointing ${hd.pointing}`, hd.spread].filter(Boolean).join(', '),
      `Out: ${hd.extended.join(', ') || 'none'} · curled: ${hd.curled.join(', ') || 'none'}`,
    ];
  }

  function viewEvent(t, view) {
    recentView.push({ t, label: view });
    const m = majority(recentView, t, 700);
    if (m && m !== stable.view) {
      if (stable.view) {
        log(t, m === 'body' ? 'Body came into view'
          : m === 'hands' ? 'Close-up: only hands in view'
          : 'Nobody in view');
      }
      stable.view = m;
    }
  }

  // =====================================================================
  function update(tr) {
    const t = tr.t ?? Date.now();
    const w = tr.width, h = tr.height;
    const out = { t, present: false, view: tr.view, headline: '', sections: [], counters: { ...counters }, events, activities: [], motions: [] };

    const pose = tr.pose;
    const lm = pose?.landmarks, W = pose?.worldLandmarks, A = pose?.angles || {};
    const ok = (...ids) => !!lm && ids.every((i) => lm[i] && lm[i].visibility >= V);

    // ---------------- hands: name them (person's actual left/right) ----------------
    // Each hand gets a stable identity that follows it from frame to frame by position.
    // Every frame adds evidence about its side (strongest first):
    //   Holistic's label (found from the body's own wrist) or the nearest body wrist: 2
    //   the hand's own shape (see readHand): 1
    // The side is only named once the evidence is clear, and only changes when the
    // evidence clearly points the other way for several frames. Until then: "hand".
    const SWITCH = 3;
    // A hand is "the same hand" if seen again within a few frames; scale with the frame
    // rate so slow tracking (a few fps) doesn't forget every hand between frames.
    if (lastUpdateT != null && t > lastUpdateT) frameGap = frameGap * 0.8 + (t - lastUpdateT) * 0.2;
    lastUpdateT = t;
    const KEEP_MS = Math.max(800, frameGap * 4);
    const usedTracks = new Set();
    const hands = (tr.hands || []).map((raw) => {
      const hd = readHand(raw.landmarks, w, h, raw.worldLandmarks);
      hd.predicted = !!raw.predicted;
      let poseSide = null;
      if (lm && !raw.sideKnown) {
        let bestD = Infinity;
        for (const [s, ids] of Object.entries(SIDE)) {
          if (!ok(ids.wr)) continue;
          const d = Math.hypot((raw.landmarks[0].x - lm[ids.wr].x) * w, (raw.landmarks[0].y - lm[ids.wr].y) * h);
          if (d < bestD && d < 0.15 * Math.max(w, h)) { bestD = d; poseSide = s; }
        }
      }
      let track = lastHands.find((x) => !usedTracks.has(x) && t - x.t < KEEP_MS && Math.hypot(x.cx - hd.cx, x.cy - hd.cy) < x.size * 2);
      if (!track) { track = { votes: 0, side: null }; lastHands.push(track); }
      usedTracks.add(track);
      Object.assign(track, { t, cx: hd.cx, cy: hd.cy, size: hd.size });
      const strong = raw.sideKnown ? raw.side : poseSide;
      const vote = strong || hd.geomSide || (track.side ? null : raw.side);   // MediaPipe's own label only to start
      const weight = strong ? 2 : 1;
      if (vote && !hd.predicted) track.votes = Math.max(-8, Math.min(8, track.votes + (vote === 'right' ? weight : -weight)));
      if (!track.side && Math.abs(track.votes) >= SWITCH) track.side = track.votes > 0 ? 'right' : 'left';
      else if (track.side === 'right' && track.votes <= -SWITCH) track.side = 'left';
      else if (track.side === 'left' && track.votes >= SWITCH) track.side = 'right';
      hd.track = track;
      return setSide(hd, track.side || 'hand');
    });
    while (lastHands.length > 4 || (lastHands.length && t - lastHands[0].t > KEEP_MS)) lastHands.shift();
    // two hands can't both be "left": the one with weaker evidence goes back to "hand"
    if (hands.length === 2 && hands[0].side !== 'hand' && hands[0].side === hands[1].side) {
      const weaker = Math.abs(hands[0].track.votes) >= Math.abs(hands[1].track.votes) ? hands[1] : hands[0];
      setSide(weaker, 'hand');
    }

    const handMotions = confirmMotions('hands', hands.flatMap((hd) => handMotion(t, hd)));
    gestureEvents(t, hands);
    viewEvent(t, tr.view || (pose ? 'body' : hands.length ? 'hands' : 'none'));

    // =================== no body: close-up / hands-only mode ===================
    if (!pose) {
      hist.length = 0;
      if (!hands.length) {
        out.headline = 'No one in view';
        if (tr.bodyRejected) out.sections.push({ title: 'Note', items: [`Ignored a false body match (${tr.bodyRejected})`] });
        return out;
      }
      out.present = true;
      const main = hands.map((hd) => {
        const who = hd.side === 'hand' ? 'hand' : `${hd.side} hand`;
        return `${who}: ${hd.gesture}${hd.palm ? `, ${hd.palm.replace(' toward the camera', ' facing camera')}` : ''}`;
      });
      const what = hands.length === 2 ? 'both hands' : 'one hand';
      const lead = tr.closeup ? `Close-up on ${what}` : `Only ${what} recognised (body not detected)`;
      out.headline = cap(`${lead}. ${main.join('; ')}` + (handMotions.length ? `; ${handMotions.slice(0, 2).join(', ')}` : ''));
      out.sections.push({ title: 'In view', items: [
        tr.closeup ? `Close-up: only ${what === 'one hand' ? 'a hand' : 'two hands'} fit in the frame`
          : `${cap(what)}; body not detected${tr.bodyRejected ? ` (ignored a false match: ${tr.bodyRejected})` : ''}`,
      ] });
      for (const hd of hands) out.sections.push({ title: hd.side === 'hand' ? 'Hand' : `${cap(hd.side)} hand`, items: [cap(hd.gesture), ...handLines(hd).slice(1)] });
      if (hands.length === 2) {
        const gap = Math.hypot(hands[0].cx - hands[1].cx, hands[0].cy - hands[1].cy) / ((hands[0].size + hands[1].size) / 2);
        out.sections.push({ title: 'Both hands', items: [gap < 1.8 ? 'Hands close together' : `Hands ${gap.toFixed(1)} hand-lengths apart`] });
      }
      out.sections.push({ title: 'Movement', items: handMotions.length ? handMotions.map(cap) : ['Hands holding still'] });
      out.motions = handMotions;
      const hf0 = (side) => { const x = hands.find((k) => k.side === side); return x ? { zone: 'unknown', gesture: gestureKey(x.gesture) } : null; };
      out.facts = {
        posture: 'unknown', facing: 'unknown', head: null, expressions: [],
        hands: { left: hf0('left'), right: hf0('right') },
        activities: activityKeys(handMotions),
        closeup: !!tr.closeup,
      };
      return out;
    }

    // =================== body mode ===================
    out.present = true;

    // ---------------- what is actually in view ----------------
    const regions = {
      head: ok(NOSE) || ok(L_EAR) || ok(R_EAR),
      torso: ok(11, 12, 23, 24),
      'left arm': ok(11, 13, 15), 'right arm': ok(12, 14, 16),
      'left leg': ok(23, 25, 27), 'right leg': ok(24, 26, 28),
    };
    const seen = Object.keys(regions).filter((k) => regions[k]);
    const missing = Object.keys(regions).filter((k) => !regions[k]);
    const legsSeen = regions['left leg'] || regions['right leg'];
    const viewLabel = seen.length === 6 ? 'full body' : legsSeen ? 'most of the body' : regions.torso ? 'upper body' : 'part of the body';

    // ---------------- body frame ----------------
    const hasShoulders = ok(11, 12), hasHips = ok(23, 24);
    const shMid = hasShoulders ? mid(W[11], W[12]) : null;
    const hipMid = hasHips ? mid(W[23], W[24]) : { x: 0, y: 0, z: 0 };
    const leftVec = hasShoulders ? norm(flat(sub(W[11], W[12]))) : hasHips ? norm(flat(sub(W[23], W[24]))) : { x: 1, y: 0, z: 0 };
    let fwdVec = null;
    if (ok(NOSE) && shMid) {
      let f = flat(sub(W[NOSE], shMid));
      f = sub(f, mul(leftVec, dot(f, leftVec)));
      if (len(f) > 0.02) fwdVec = norm(f);
    }
    const face = tr.face ? faceReading(tr.face, w, h) : null;
    if (face && hasShoulders) {
      // Body forward = perpendicular to the shoulders, on the side the face points to
      // (a head can't turn more than ~90° from the chest). Better than the nose guess.
      let perp = norm({ x: leftVec.z, y: 0, z: -leftVec.x });
      if (dot(perp, flat(face.fwd)) < 0) perp = mul(perp, -1);
      fwdVec = perp;
    }
    if (!fwdVec) fwdVec = norm({ x: leftVec.z, y: 0, z: -leftVec.x });
    const facing = !hasShoulders ? 'unknown'
      : (len(flat(sub(W[11], W[12]))) < 0.18 ? 'side-on to the camera'
        : fwdVec.z < -0.3 ? 'facing the camera' : fwdVec.z > 0.3 ? 'facing away from the camera' : 'turned partly sideways');
    const bodyDir = (p) => ({ up: -p.y, fwd: dot(p, fwdVec), left: dot(p, leftVec) });

    // ---------------- torso ----------------
    let torso = null;
    if (shMid && hasHips) {
      const tv = norm(sub(shMid, hipMid));
      torso = {
        fromVertical: deg(Math.acos(Math.max(-1, Math.min(1, dot(tv, UP))))),
        side: deg(Math.asin(Math.max(-1, Math.min(1, dot(tv, leftVec))))),
        fwd: deg(Math.asin(Math.max(-1, Math.min(1, dot(tv, fwdVec))))),
      };
    }

    // ---------------- legs & posture ----------------
    const legs = {};
    for (const [s, ids] of Object.entries(SIDE)) {
      if (!ok(ids.hip, ids.knee)) { legs[s] = null; continue; }
      legs[s] = {
        knee: A[`${ids.A} knee`] ?? (ok(ids.ank) ? angle3(W[ids.hip], W[ids.knee], W[ids.ank]) : null),
        hip: A[`${ids.A} hip`],
        ankle: ok(ids.ank) ? W[ids.ank] : null,
        kneeP: W[ids.knee], hipP: W[ids.hip],
      };
    }
    const L = legs.left, R = legs.right;
    const bothLegs = L && R && L.knee != null && R.knee != null;
    const feet = L?.ankle && R?.ankle;
    const footSpreadSide = feet ? Math.abs(dot(sub(L.ankle, R.ankle), leftVec)) : 0;
    const footSpreadFwd = feet ? Math.abs(dot(sub(L.ankle, R.ankle), fwdVec)) : 0;
    const footHeightDiff = feet ? (L.ankle.y - R.ankle.y) : 0;
    const shoulderWidth = hasShoulders ? len(flat(sub(W[11], W[12]))) : 0.35;

    // thigh angle from straight down, for every leg whose hip and knee are visible
    const thighs = ['left', 'right'].filter((s) => legs[s]).map((s) => {
      const tv = norm(sub(legs[s].kneeP, legs[s].hipP));
      return deg(Math.acos(Math.max(-1, Math.min(1, tv.y))));
    });
    let posture;
    if (torso && torso.fromVertical > 60) posture = 'lying down';
    else if (bothLegs) {
      const kL = L.knee, kR = R.knee, kAvg = (kL + kR) / 2;
      const kneelL = L.ankle && Math.abs(L.kneeP.y - L.ankle.y) < 0.12 && kL < 130;
      const kneelR = R.ankle && Math.abs(R.kneeP.y - R.ankle.y) < 0.12 && kR < 130;
      if (kneelL && kneelR) posture = 'kneeling on both knees';
      else if (kneelL || kneelR) posture = `kneeling on their ${kneelL ? 'left' : 'right'} knee`;
      else if (feet && Math.abs(footHeightDiff) > 0.2) {
        posture = `standing on their ${footHeightDiff > 0 ? 'left' : 'right'} leg, ${footHeightDiff > 0 ? 'right' : 'left'} leg raised`;
      } else if ((kL < 125) !== (kR < 125) && Math.max(kL, kR) > 140 && (footSpreadFwd > 0.45 || footSpreadSide > 0.6)) {
        posture = `in a lunge, ${kL < kR ? 'left' : 'right'} knee bent ${r0(Math.min(kL, kR))}°`;
      } else if (kAvg < 125) {
        posture = torso && torso.fwd > 20 ? `squatting (knees ${r0(kAvg)}°)` : `sitting (knees ${r0(kAvg)}°)`;
      } else if (kAvg < 155) posture = `standing with knees slightly bent (${r0(kAvg)}°)`;
      else if (torso && torso.fwd > 35) posture = `standing, bent forward ${r0(torso.fwd)}° at the hips`;
      else posture = footSpreadSide > shoulderWidth * 1.8 ? 'standing with a wide stance' : 'standing upright';
    } else if (thighs.length && torso && torso.fromVertical < 60) {
      // Only part of the legs in view: the thighs still tell sitting from standing.
      const th = thighs.reduce((a, b) => a + b, 0) / thighs.length;
      posture = th > 55 ? `sitting (thigh ${r0(th)}° from vertical)`
        : th < 30 ? 'standing (lower legs out of view)'
        : `${viewLabel} in view, thighs angled ${r0(th)}°`;
    } else if (torso) {
      posture = `${viewLabel} in view, torso ${torso.fromVertical < 15 ? 'upright' : `tilted ${r0(torso.fromVertical)}°`}`;
    } else {
      posture = `only part of the body in view (${seen.join(', ') || 'unclear'})`;
    }

    // ---------------- arms ----------------
    const arms = {};
    for (const [s, ids] of Object.entries(SIDE)) {
      if (!ok(ids.sh, ids.el, ids.wr)) {
        arms[s] = ok(ids.sh, ids.el) ? { desc: 'upper arm visible, forearm out of view', tag: 'partial', partial: true } : null;
        continue;
      }
      const sh = W[ids.sh], el = W[ids.el], wr = W[ids.wr];
      const elbow = A[`${ids.A} elbow`] ?? angle3(sh, el, wr);
      const shAng = A[`${ids.A} shoulder`] ?? (ok(ids.hip) ? angle3(el, sh, W[ids.hip]) : null);
      const v = sub(wr, sh);
      const outward = dot(v, leftVec) * (s === 'left' ? 1 : -1);
      const fwd = dot(v, fwdVec);
      const nearHip = ok(ids.hip) && dist(wr, W[ids.hip]) < 0.17;
      const nearFace = ok(NOSE) && dist(wr, W[NOSE]) < 0.2;
      const overhead = ok(NOSE) ? wr.y < W[NOSE].y - 0.05 : wr.y < sh.y - 0.3;
      const level = Math.abs(wr.y - sh.y) < 0.13;
      const straight = elbow > 150;

      let desc, tag;
      if (overhead) { desc = straight ? 'raised straight overhead' : `raised above the head, elbow bent ${r0(elbow)}°`; tag = 'overhead'; }
      else if (nearFace) { desc = 'hand up at the face'; tag = 'face'; }
      else if (nearHip && elbow < 140) { desc = 'hand on hip'; tag = 'hip'; }
      else if (level && straight) {
        desc = fwd > outward ? 'stretched straight forward' : 'stretched straight out to the side';
        tag = fwd > outward ? 'forward' : 'side';
      } else if (elbow < 70 && wr.y < el.y) { desc = `curled up, elbow bent ${r0(elbow)}°`; tag = 'curl'; }
      else if (shAng != null && shAng < 30 && straight) { desc = 'relaxed down by the side'; tag = 'down'; }
      else if (shAng != null && shAng < 35) { desc = `down, elbow bent ${r0(elbow)}°`; tag = 'down-bent'; }
      else {
        const where = fwd > Math.abs(outward) ? 'in front' : 'out to the side';
        desc = `raised ${r0(shAng ?? 0)}° ${where}, elbow ${straight ? 'straight' : `bent ${r0(elbow)}°`}`;
        tag = 'raised';
      }
      arms[s] = { desc, tag, elbow, shAng, wr, el, sh, straight };
    }

    const armPatterns = [];
    if (arms.left?.wr && arms.right?.wr) {
      const tl = arms.left.tag, trg = arms.right.tag;
      if (tl === 'overhead' && trg === 'overhead') armPatterns.push('both arms overhead');
      if (tl === 'side' && trg === 'side') armPatterns.push('arms out in a T-pose');
      if (tl === 'forward' && trg === 'forward') armPatterns.push('both arms reaching forward');
      if (tl === 'hip' && trg === 'hip') armPatterns.push('hands on hips');
      const handGap = dist(arms.left.wr, arms.right.wr);
      // Crossed: each wrist has passed the body's midline toward the other side, at chest
      // to waist height. Checked first: crossed arms also bring the wrists close together.
      const crossed = shMid && dot(sub(arms.left.wr, shMid), leftVec) < 0.02 && dot(sub(arms.right.wr, shMid), leftVec) > -0.02
          && arms.left.wr.y > shMid.y - 0.05 && arms.right.wr.y > shMid.y - 0.05 && arms.left.wr.y < hipMid.y && arms.right.wr.y < hipMid.y
          && arms.left.elbow < 120 && arms.right.elbow < 120;
      if (crossed) armPatterns.push('arms crossed');
      else if (handGap < 0.15) armPatterns.push(arms.left.wr.y < (ok(NOSE) ? W[NOSE].y : -0.6) ? 'hands together above the head' : 'hands together in front');
    }

    // ---------------- head ----------------
    let head = null;
    if (face) {
      // Face mesh: real 3D head direction, measured against the body's own forward.
      const ff = norm(flat(face.fwd));
      const yawDeg = deg(Math.atan2(dot(ff, leftVec), dot(ff, fwdVec)));
      head = {
        yaw: yawDeg / 45, pitch: -face.pitch / 60, tilt: face.roll / 20, fromFace: true,  // same units as the ear-based estimate
        yawDeg, pitchDeg: face.pitch, rollDeg: face.roll,
        turn: yawDeg > 20 ? 'turned to their left' : yawDeg < -20 ? 'turned to their right' : 'facing straight ahead',
        nod: face.pitch > 15 ? 'chin up (looking up)' : face.pitch < -15 ? 'chin down (looking down)' : 'head level',
        tiltTxt: face.roll > 15 ? 'tilted toward the left shoulder' : face.roll < -15 ? 'tilted toward the right shoulder' : null,
      };
    } else if (ok(NOSE, L_EAR, R_EAR)) {
      const earMid = mid(W[L_EAR], W[R_EAR]);
      const earDist = dist(W[L_EAR], W[R_EAR]) || 0.15;
      const nv = sub(W[NOSE], earMid);
      const yaw = dot(nv, leftVec) / earDist, pitch = nv.y / earDist, tilt = (W[L_EAR].y - W[R_EAR].y) / earDist;
      head = {
        yaw, pitch, tilt,
        turn: yaw > 0.35 ? 'turned to their left' : yaw < -0.35 ? 'turned to their right' : 'facing straight ahead',
        nod: pitch < -0.3 ? 'chin up (looking up)' : pitch > 0.55 ? 'chin down (looking down)' : 'head level',
        tiltTxt: tilt > 0.35 ? 'tilted toward the left shoulder' : tilt < -0.35 ? 'tilted toward the right shoulder' : null,
      };
    }

    // ---------------- motion history ----------------
    const imgTorso = ok(11, 12, 23, 24) ? Math.hypot(((lm[11].x + lm[12].x) - (lm[23].x + lm[24].x)) / 2 * w,
      ((lm[11].y + lm[12].y) - (lm[23].y + lm[24].y)) / 2 * h) : null;
    const frame = {
      t,
      wrL: arms.left?.wr, wrR: arms.right?.wr, elL: arms.left?.el, elR: arms.right?.el,
      handGap: arms.left?.wr && arms.right?.wr ? dist(arms.left.wr, arms.right.wr) : null,
      headYaw: head?.yaw, headPitch: head?.pitch,
      footDiff: feet ? footHeightDiff : null,
      imgHipY: ok(23, 24) ? (lm[23].y + lm[24].y) / 2 * h : null,
      imgHipX: ok(23, 24) ? (lm[23].x + lm[24].x) / 2 * w : null,
      imgTorso,
      leftVec,
      // joint angles and body-frame positions for "what is moving"
      shL: arms.left?.shAng, shR: arms.right?.shAng, elbL: arms.left?.elbow, elbR: arms.right?.elbow,
      kneeAvg: bothLegs ? (L.knee + R.knee) / 2 : null,
      torsoFwd: torso?.fwd,
      pts: {
        'left hand': ok(15) ? bodyDir(W[15]) : null, 'right hand': ok(16) ? bodyDir(W[16]) : null,
        'left foot': ok(27) ? bodyDir(W[27]) : null, 'right foot': ok(28) ? bodyDir(W[28]) : null,
      },
    };
    hist.push(frame);
    while (hist.length && hist[0].t < t - HISTORY_MS) hist.shift();
    const since = (ms) => hist.filter((f) => f.t >= t - ms);
    const then = hist.find((f) => f.t >= t - RATE_MS);
    const dt = then && t - then.t > 150 ? (t - then.t) / 1000 : null;
    const rate = (key) => (dt && frame[key] != null && then[key] != null ? (frame[key] - then[key]) / dt : 0);

    const activities = [];

    // waving: wrist above elbow, swinging side to side
    for (const [s, k, ek] of [['left', 'wrL', 'elL'], ['right', 'wrR', 'elR']]) {
      const fr = since(1500).filter((f) => f[k] && f[ek] && f[k].y < f[ek].y);
      const xs = fr.map((f) => dot(sub(f[k], f[ek]), f.leftVec));
      const waving = fr.length >= 6 && swings(xs, 0.05) >= 2 && range(xs) > 0.1;
      setActive(t, `wave-${s}`, waving, `Started waving the ${s} hand`);
      if (waving) activities.push(`waving the ${s} hand`);
    }

    // clapping
    {
      const gaps = since(2000).map((f) => f.handGap).filter((g) => g != null);
      const g = frame.handGap;
      if (g != null) {
        if (phase.clap === 'apart' && g < 0.1) phase.clap = 'together';
        else if (phase.clap === 'together' && g > 0.2) { phase.clap = 'apart'; counters.claps++; }
      }
      const clapping = gaps.length >= 6 && swings(gaps, 0.08) >= 3 && Math.min(...gaps) < 0.12;
      setActive(t, 'clap', clapping, 'Started clapping');
      if (clapping) activities.push('clapping');
    }

    // head nodding / shaking
    {
      const fr = since(1500);
      const pitches = fr.map((f) => f.headPitch).filter((v) => v != null);
      const yaws = fr.map((f) => f.headYaw).filter((v) => v != null);
      const nodding = pitches.length >= 6 && swings(pitches, 0.12) >= 2;
      const shaking = yaws.length >= 6 && swings(yaws, 0.2) >= 2;
      setActive(t, 'nod', nodding, 'Nodding (yes)');
      setActive(t, 'shake', shaking, 'Shaking head (no)');
      if (nodding) activities.push('nodding yes');
      if (shaking) activities.push('shaking head no');
    }

    // stepping in place
    {
      const diffs = since(2000).map((f) => f.footDiff).filter((v) => v != null);
      const marching = diffs.length >= 8 && swings(diffs, 0.07) >= 2 && range(diffs) > 0.12;
      setActive(t, 'march', marching, 'Started stepping / marching');
      if (marching) activities.push('stepping in place');
    }

    // walking across the view
    {
      const fr = since(2000).filter((f) => f.imgHipX != null && f.imgTorso);
      if (fr.length >= 8) {
        const dx = (fr[fr.length - 1].imgHipX - fr[0].imgHipX) / fr[fr.length - 1].imgTorso;
        const walking = Math.abs(dx) > 1.0;
        setActive(t, 'walk', walking, `Walking toward screen-${dx < 0 ? 'left' : 'right'}`);
        if (walking) activities.push(`moving toward screen-${dx < 0 ? 'left' : 'right'}`);
      }
    }

    // jump
    {
      const fr = since(500).filter((f) => f.imgHipY != null && f.imgTorso);
      // only a standing person with feet in view can jump (shifting in a chair can't count)
      if (fr.length >= 3 && t - lastJumpT > 700 && feet && postureKey(posture) === 'standing') {
        const maxY = Math.max(...fr.map((f) => f.imgHipY));
        const rise = (maxY - frame.imgHipY) / (frame.imgTorso || 1);
        if (rise > 0.35) { counters.jumps++; lastJumpT = t; log(t, `Jumped (#${counters.jumps})`); }
      }
      if (t - lastJumpT < 600) activities.push('jumping');
    }

    // squat reps
    if (bothLegs) {
      const kAvg = (L.knee + R.knee) / 2;
      if (phase.squat === 'up' && kAvg < 110) { phase.squat = 'down'; squatDepth = kAvg; }
      else if (phase.squat === 'down') {
        squatDepth = Math.min(squatDepth, kAvg);
        if (kAvg > 155) {
          phase.squat = 'up'; counters.squats++;
          log(t, `Squat rep #${counters.squats} (deepest knee bend ${r0(squatDepth)}°)`);
        }
      }
    }

    // curls: count by range of motion, not fixed angles. Real curls on camera often
    // read ~100° at the top and ~140° at the bottom (foreshortening, holding a weight
    // in front), so fixed 60°/145° lines missed them and could get stuck "up".
    // A rep = the elbow closes CURL_DOWN° from its recent most-open angle (ending
    // below CURL_TOP), then opens CURL_UP° again. Upper arm must stay near the side.
    const CURL_DOWN = 30, CURL_UP = 22, CURL_TOP = 125, CURL_WINDOW = 3000, CURL_STUCK = 5000;
    for (const [s, key] of [['left', 'L'], ['right', 'R']]) {
      const a = arms[s], c = curl[key];
      if (!a || a.partial || a.elbow == null || a.shAng == null || a.shAng > 60) {
        if (c.samples.length && t - c.samples[c.samples.length - 1].t > 1500) curl[key] = newCurl();
        continue;
      }
      c.samples.push({ t, v: a.elbow });
      while (c.samples.length && c.samples[0].t < t - CURL_WINDOW) c.samples.shift();
      if (c.phase === 'down') {
        c.hi = Math.max(...c.samples.map((p) => p.v));
        if (c.hi - a.elbow >= CURL_DOWN && a.elbow < CURL_TOP) { c.phase = 'up'; c.lo = a.elbow; c.since = t; }
      } else {
        c.lo = Math.min(c.lo, a.elbow);
        if (a.elbow - c.lo >= CURL_UP) {
          counters[`${key} curls`]++;
          log(t, `${s === 'left' ? 'Left' : 'Right'} arm curl #${counters[`${key} curls`]} (elbow ${r0(c.lo)}°–${r0(c.hi)}°)`);
          c.phase = 'down'; c.samples = [{ t, v: a.elbow }];
        } else if (t - c.since > CURL_STUCK) {          // held at the top: start over, never get stuck
          c.phase = 'down'; c.samples = [{ t, v: a.elbow }];
        }
      }
    }

    // jumping jacks
    if (arms.left?.wr && arms.right?.wr && feet) {
      const open = arms.left.wr.y < arms.left.sh.y && arms.right.wr.y < arms.right.sh.y && footSpreadSide > shoulderWidth * 1.5;
      const closed = arms.left.wr.y > arms.left.sh.y && arms.right.wr.y > arms.right.sh.y && footSpreadSide < shoulderWidth * 1.2;
      if (phase.jack === 'closed' && open) phase.jack = 'open';
      else if (phase.jack === 'open' && closed) {
        phase.jack = 'closed'; counters['jumping jacks']++;
        log(t, `Jumping jack #${counters['jumping jacks']}`);
      }
    }

    // ---------------- what is moving right now ----------------
    const motions = [];   // [{ text, mag }]
    if (dt) {
      // joints opening / closing (degrees per second)
      for (const [s, shK, elK] of [['left', 'shL', 'elbL'], ['right', 'shR', 'elbR']]) {
        if (activities.some((a) => a.includes(s))) continue;
        const rs = rate(shK), re = rate(elK);
        if (Math.abs(rs) > 70) motions.push({ text: `${rs > 0 ? 'raising' : 'lowering'} the ${s} arm`, mag: Math.abs(rs) });
        if (Math.abs(re) > 110) motions.push({ text: `${re < 0 ? 'bending' : 'straightening'} the ${s} elbow`, mag: Math.abs(re) * 0.8 });
      }
      const rk = rate('kneeAvg');
      if (Math.abs(rk) > 70) motions.push({ text: rk < 0 ? 'bending the knees (going down)' : 'straightening the legs (coming up)', mag: Math.abs(rk) * 1.2 });
      const rt = rate('torsoFwd');
      if (Math.abs(rt) > 45) motions.push({ text: rt > 0 ? 'bending forward' : 'straightening the back', mag: Math.abs(rt) * 1.5 });
      const ry = rate('headYaw');
      if (Math.abs(ry) > 0.9 && !active.shake) motions.push({ text: `turning the head to their ${ry > 0 ? 'left' : 'right'}`, mag: Math.abs(ry) * 50 });
      const rp = rate('headPitch');
      if (Math.abs(rp) > 0.9 && !active.nod) motions.push({ text: rp > 0 ? 'looking down' : 'looking up', mag: Math.abs(rp) * 50 });

      // hands and feet moving through space (m/s, relative to the hips)
      for (const [name, p] of Object.entries(frame.pts)) {
        const q = then.pts?.[name];
        if (!p || !q) continue;
        const side = name.split(' ')[0];
        if (activities.some((a) => a.includes(side) && a.includes('waving')) && name.includes('hand')) continue;
        const v = { up: (p.up - q.up) / dt, fwd: (p.fwd - q.fwd) / dt, left: (p.left - q.left) / dt };
        const sp = Math.hypot(v.up, v.fwd, v.left);
        if (sp > 0.5) motions.push({ text: `${name} moving ${dirWords(v)} (${sp.toFixed(1)} m/s)`, mag: sp * 100 });
      }

      // whole body toward / away from the camera (torso looks bigger / smaller)
      const rTorso = frame.imgTorso && then.imgTorso ? Math.log(frame.imgTorso / then.imgTorso) / dt : 0;
      if (Math.abs(rTorso) > 0.35) motions.push({ text: `moving ${rTorso > 0 ? 'toward' : 'away from'} the camera`, mag: Math.abs(rTorso) * 200 });
    }
    motions.sort((a, b) => b.mag - a.mag);
    // A motion must show up on two frames in a row: one wobbly frame (e.g. right after
    // the tracker locks on) isn't movement.
    const motionTexts = confirmMotions('body', motions.map((m) => m.text));

    // overall activity level
    const sp = Object.values(pose.speed || {});
    const avgSpeed = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : 0;
    const level = avgSpeed < 0.08 && !motions.length ? 'holding still' : avgSpeed < 0.3 ? 'moving slightly'
      : avgSpeed < 0.8 ? 'moving' : 'moving fast';

    // ---------------- stable posture events ----------------
    recentPosture.push({ t, label: postureKey(posture) });
    const sp2 = majority(recentPosture, t, 600);
    if (sp2 && sp2 !== stable.posture) {
      if (stable.posture) log(t, postureChangeText(stable.posture, sp2));
      stable.posture = sp2;
    }

    // ---------------- where each hand is, relative to the body ----------------
    const faceLm = tr.face?.landmarks;
    let faceBox = null;
    if (faceLm) {
      faceBox = { x0: 1, y0: 1, x1: 0, y1: 0 };
      for (const p of faceLm) {
        faceBox.x0 = Math.min(faceBox.x0, p.x); faceBox.y0 = Math.min(faceBox.y0, p.y);
        faceBox.x1 = Math.max(faceBox.x1, p.x); faceBox.y1 = Math.max(faceBox.y1, p.y);
      }
    }
    const isSitting = postureKey(posture) === 'sitting';
    function handWhere(hd, raw) {
      const HL = raw.landmarks;
      // 1) touching the face: the hand point nearest the face lies inside the (padded) face
      if (faceBox) {
        const pad = (faceBox.x1 - faceBox.x0) * 0.25;
        const fcx = (faceBox.x0 + faceBox.x1) / 2, fcy = (faceBox.y0 + faceBox.y1) / 2;
        let hp = null, hd2 = Infinity;
        for (const p of HL) { const d = Math.hypot((p.x - fcx) * w, (p.y - fcy) * h); if (d < hd2) { hd2 = d; hp = p; } }
        if (hp.x > faceBox.x0 - pad && hp.x < faceBox.x1 + pad && hp.y > faceBox.y0 - pad && hp.y < faceBox.y1 + pad) {
          const spots = { chin: 152, mouth: 13, nose: 1, forehead: 10, 'left cheek': 454, 'right cheek': 234 };
          let best = 'face', bd = Infinity;
          for (const [name, i] of Object.entries(spots)) {
            const d = Math.hypot((hp.x - faceLm[i].x) * w, (hp.y - faceLm[i].y) * h);
            if (d < bd) { bd = d; best = name; }
          }
          return { zone: 'face', text: `at the ${best}` };
        }
      } else if (ok(NOSE) && ok(L_EAR, R_EAR)) {
        const earPx = Math.hypot((lm[L_EAR].x - lm[R_EAR].x) * w, (lm[L_EAR].y - lm[R_EAR].y) * h) || 40;
        const near = HL.some((p) => Math.hypot((p.x - lm[NOSE].x) * w, (p.y - lm[NOSE].y) * h) < earPx * 1.1);
        if (near) return { zone: 'face', text: 'at the face' };
      }
      // 2) body zones from the wrist's 3D position (metres, y down)
      const ids = SIDE[hd.side];
      if (ids && ok(ids.wr)) {
        const wr = W[ids.wr];
        const shY = shMid ? shMid.y : (ok(NOSE) ? W[NOSE].y + 0.25 : -0.5);
        const noseY = ok(NOSE) ? W[NOSE].y : shY - 0.25;
        const hipY = hasHips ? hipMid.y : shY + 0.5;
        const fwdAmt = dot(sub(wr, hasHips ? hipMid : (shMid || hipMid)), fwdVec);
        if (ok(ids.hip) && dist(wr, W[ids.hip]) < 0.15 && !isSitting) return { zone: 'hip', text: 'on the hip' };
        if (wr.y < noseY - 0.1) return { zone: 'overhead', text: 'raised above the head' };
        if (wr.y < shY - 0.05) return { zone: 'head', text: 'at head height' };
        if (wr.y < shY + (hipY - shY) * 0.45) return { zone: 'chest', text: 'at chest height' };
        if (isSitting && fwdAmt > 0.1) return { zone: 'lap', text: 'low in front (lap / desk height)' };
        if (wr.y < hipY - 0.05) return { zone: 'waist', text: fwdAmt > 0.15 ? 'at waist height, in front' : 'at waist height' };
        if (fwdAmt > 0.2) return { zone: 'lap', text: 'low, in front of the body' };
        return { zone: 'down', text: 'down by the side' };
      }
      return { zone: 'unknown', text: '' };
    }
    (tr.hands || []).forEach((raw, i) => { if (hands[i]) hands[i].where = handWhere(hands[i], raw); });
    const expr = expressions(face, head);

    // ---------------- compose ----------------
    const named = hands.filter((x) => isNamedGesture(x.gesture));
    const headlineParts = [posture.split(' (')[0].split(',')[0]];
    headlineParts.push(...activities);
    headlineParts.push(...motionTexts.slice(0, 2).map((m) => m.replace(/ \(\d.*m\/s\)$/, '')));
    if (armPatterns.length) headlineParts.push(armPatterns[0]);
    else for (const s of ['left', 'right']) {
      const a = arms[s];
      if (a && ['overhead', 'side', 'forward', 'hip', 'curl'].includes(a.tag)
          && !activities.some((x) => x.includes(s)) && !motionTexts.slice(0, 2).some((x) => x.includes(s))) {
        headlineParts.push(`${s} arm ${a.desc.split(',')[0]}`);
      }
    }
    for (const x of named) headlineParts.push(`${x.gesture}${x.side !== 'hand' ? ` with the ${x.side} hand` : ''}`);
    for (const x of hands) {
      if (x.where && ['face', 'head', 'hip', 'lap'].includes(x.where.zone) && !x.predicted) {
        headlineParts.push(`${x.side === 'hand' ? 'a hand' : `${x.side} hand`} ${x.where.text}`);
      }
    }
    if (expr.length) headlineParts.push(expr.join(', '));
    if (head && head.turn !== 'facing straight ahead' && !motionTexts.slice(0, 2).some((x) => x.includes('head'))) headlineParts.push(`head ${head.turn}`);
    out.headline = cap(headlineParts.join(', '));

    out.sections.push({ title: 'In view', items: [
      cap(viewLabel) + (missing.length ? ` (not visible: ${missing.join(', ')})` : ''),
    ] });

    out.sections.push({ title: 'Body', items: [
      cap(posture),
      cap(facing),
      torso ? `Torso: ${torsoText(torso)}` : null,
    ].filter(Boolean) });

    const armItems = [...armPatterns.map(cap)];
    for (const s of ['left', 'right']) if (arms[s]) armItems.push(`${cap(s)} arm: ${arms[s].desc}`);
    if (armItems.length) out.sections.push({ title: 'Arms', items: armItems });

    if (legsSeen || L || R) {
      out.sections.push({ title: 'Legs', items: [
        L ? `Left leg: ${legText(L)}` : null,
        R ? `Right leg: ${legText(R)}` : null,
        feet ? `Feet ${r0(footSpreadSide * 100)} cm apart side-to-side${footSpreadFwd > 0.25 ? `, ${r0(footSpreadFwd * 100)} cm front-to-back` : ''}` : null,
      ].filter(Boolean) });
    }

    if (head) {
      out.sections.push({ title: 'Head', items: [
        cap(head.turn) + (head.fromFace ? ` (${r0(Math.abs(head.yawDeg))}°)` : ''),
        cap(head.nod) + (head.fromFace ? ` (${r0(head.pitchDeg)}°)` : ''),
        head.tiltTxt && cap(head.tiltTxt),
        head.fromFace ? null : 'Estimated from nose and ears (no face mesh)',
      ].filter(Boolean) });
    }
    if (face) out.sections.push({ title: 'Face', items: expr.length ? expr.map(cap) : ['Neutral expression'] });

    for (const hd of hands) {
      out.sections.push({ title: hd.side === 'hand' ? 'Hand' : `${cap(hd.side)} hand`, items: [
        cap(hd.gesture) + (hd.where?.text ? `, ${hd.where.text}` : ''),
        ...handLines(hd).slice(1),
        hd.predicted ? '(briefly lost: position predicted)' : null,
      ].filter(Boolean) });
    }

    out.sections.push({ title: 'Movement', items: [
      cap(level),
      ...activities.map(cap),
      ...motionTexts.map(cap),
      ...handMotions.map(cap),
    ] });

    out.activities = activities;
    out.motions = [...motionTexts, ...handMotions];
    out.counters = { ...counters };
    out.posture = posture;
    const pk = postureKey(posture);
    const hf = (side) => {
      const x = hands.find((k) => k.side === side && !k.predicted);
      return x ? { zone: x.where?.zone || 'unknown', gesture: gestureKey(x.gesture) } : null;
    };
    out.facts = {
      posture: pk === 'upper' ? 'unknown' : pk,
      facing: facing === 'facing the camera' ? 'toward' : facing === 'facing away from the camera' ? 'away'
        : facing === 'unknown' ? 'unknown' : 'side',
      head: head ? {
        turn: head.turn.includes('left') ? 'left' : head.turn.includes('right') ? 'right' : 'straight',
        pitch: head.nod.includes('up') ? 'up' : head.nod.includes('down') ? 'down' : 'level',
      } : null,
      hands: { left: hf('left'), right: hf('right') },
      activities: activityKeys([...activities, ...handMotions]),
      expressions: expr,
      closeup: false,
    };
    return out;
  }

  return { update, reset, get events() { return events; }, get counters() { return { ...counters }; } };
}

// ---------- text helpers ----------
function postureKey(p) {
  if (p.startsWith('lying')) return 'lying';
  if (p.startsWith('kneeling')) return 'kneeling';
  if (p.startsWith('standing on')) return 'one leg';
  if (p.startsWith('in a lunge')) return 'lunge';
  if (p.startsWith('squatting')) return 'squatting';
  if (p.startsWith('sitting')) return 'sitting';
  if (p.startsWith('standing')) return 'standing';
  return 'upper';
}
function postureChangeText(from, to) {
  const map = {
    standing: from === 'sitting' ? 'Stood up' : 'Now standing',
    sitting: 'Sat down', squatting: 'Went into a squat', lunge: 'Stepped into a lunge',
    kneeling: 'Knelt down', lying: 'Lay down', 'one leg': 'Lifted a leg (balancing)', upper: 'Legs left the frame',
  };
  return map[to] || `Now ${to}`;
}
function torsoText(t) {
  const parts = [];
  if (t.fromVertical < 10) parts.push('upright');
  if (t.fwd > 12) parts.push(`leaning forward ${r0(t.fwd)}°`);
  else if (t.fwd < -12) parts.push(`leaning back ${r0(-t.fwd)}°`);
  if (t.side > 8) parts.push(`leaning to their left ${r0(t.side)}°`);
  else if (t.side < -8) parts.push(`leaning to their right ${r0(-t.side)}°`);
  return parts.join(', ') || `tilted ${r0(t.fromVertical)}° from vertical`;
}
function legText(l) {
  if (l.knee == null) return 'thigh visible, lower leg out of view';
  const k = l.knee;
  const knee = k > 165 ? 'straight' : k > 140 ? `slightly bent (${r0(k)}°)` : k > 100 ? `bent ${r0(k)}°` : `deeply bent ${r0(k)}°`;
  const lifted = l.hipP && l.kneeP && l.kneeP.y < l.hipP.y + 0.15 ? ', thigh near horizontal' : '';
  return `knee ${knee}${lifted}`;
}

export const _test = { swings, readHand, dirWords };
