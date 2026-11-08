// Room lock: a coordinate system fixed to the ROOM (not to the body), so jumps, steps
// and squat depth show up as real movement in centimetres.
//
//   origin  floor point between the feet when the lock was made. Stays put afterwards.
//   Y       height above the floor in cm (0 = floor). Hips standing ≈ 90–100 cm.
//   X       sideways in cm (+ = right in the picture), measured at the person's depth.
//   dist    distance factor: 1 = as far from the camera as at the lock, 1.2 = 20% farther.
//
// How the lock is made (automatic, ~2 s): stand straight and still with the whole body,
// feet included, in view, facing the camera or side-on (one side of each body part is
// enough). Then it fixes
//   • true vertical: the phone's gravity sensor when it agrees with the body (within
//     15°), else the standing body's own axis (ankles → shoulders);
//   • the floor: the lowest heel/toe point;
//   • the scale (px per cm): from the person's height if entered (eye height ≈ 0.936 ×
//     height), else from MediaPipe's metric limb lengths;
//   • the camera's direction (phone gravity), to notice when the phone moves.
// It is NOT redone while the person moves, so jumping can't drag the floor along.
// It is dropped when the phone moves (sensor), the video size changes, on "Re-lock",
// or (no phone sensor) after 60 s with nobody in view.
//
// Depth: limb lengths don't change, so their size in the picture (k = each segment's
// live / locked px-per-cm) says how much closer or farther the person is. Frozen during
// flights. The floor line moves with depth (perspective, level-camera model), and is
// RE-SET on every still, straight-legged stand (0.8 s): you can't hover, so then the
// feet are on the floor. This stops depth-estimate errors from piling up (first real
// test: the floor drifted ~19 cm in 20 s without it).
//
// Feet and jumps (from the RAW, unsmoothed points, so peaks aren't flattened):
//   foot_cm = lowest heel/toe height above the floor; feet = 'ground' | 'air'.
//   A jump = both feet above CLEAR_CM, then back down within 1.2 s. Its height is
//   measured two independent ways:
//     height_airtime: h = g·t²/8 from the time in the air (no coordinates needed),
//     feet_peak:      highest foot_cm during the flight (room coordinates).
//   When the two agree the jump is trustworthy; a big gap points at a tracking problem.
//   Each jump gets quality 'ok' or 'doubtful: <why>' (hips didn't rise, depth changed
//   mid-flight, or the two heights disagree).

const G = 981;                    // cm/s²
const CALIB_MS = 2000, VIS = 0.5;
const CLEAR_CM = 6;               // lowest foot point above this = off the floor
const MAX_FLIGHT_S = 1.2;
const MAX_FRAME_GAP_MS = 200;
const NOBODY_RESET_MS = 60000;    // only when there's no phone sensor to say the camera is still
const MOVED_DEG = 2, MOVED_ROT = 25;
const REANCHOR_MS = 800;          // feet this still (and legs straight) = standing on the floor
const K_WINDOW_MS = 400;         // depth estimate = median over this window (limb sizes do not change in a jump)

export const ROOM_JOINTS = { nose: 0, 'L shoulder': 11, 'R shoulder': 12, 'L elbow': 13, 'R elbow': 14, 'L wrist': 15, 'R wrist': 16,
  'L hip': 23, 'R hip': 24, 'L knee': 25, 'R knee': 26, 'L ankle': 27, 'R ankle': 28,
  'L heel': 29, 'R heel': 30, 'L toe': 31, 'R toe': 32 };
const SEGMENTS = [[11, 13], [13, 15], [12, 14], [14, 16], [23, 25], [25, 27], [24, 26], [26, 28], [11, 23], [12, 24], [11, 12], [23, 24]];
const FOOT_PTS = [29, 31, 30, 32];

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 100;          // world, cm
const median = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const degBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.reduce((s, x, i) => s + x * b[i], 0)))) * 180 / Math.PI;
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

export function createRoomLock() {
  let lock = null, still = [], lastSeen = 0, count = 0;
  let kHist = [], k = 1;
  let sensor = null, lastSensorT = 0, movedReads = 0;
  let heightCm = null;
  // Floor correction (px along `u`), reset every time the person stands still: you can't
  // hover, so a still, straight-legged stand puts the feet ON the floor. This absorbs
  // any error in the depth estimate instead of letting it pile up.
  let floorOff = 0, reanchors = 0, lastReanchor = 0, lastHipY = null;
  let footHist = [];                // [{ t, proj }] recent lowest-foot positions, for re-anchoring
  let prev = null;                  // previous measured frame { t, foot }
  let cand = null, air = null;      // takeoff candidate / flight in progress
  let jumpN = 0, lastJump = null;
  let note = null;                  // last reason the lock was dropped, or a flight note

  const seen = (lm, i) => lm?.[i] && lm[i].visibility >= VIS;
  const px = (lm, i, w, h) => [lm[i].x * w, lm[i].y * h];
  // Mean picture position of whichever of `ids` are clearly visible (null if none).
  const avgPx = (lm, ids, w, h) => {
    const v = ids.filter((i) => seen(lm, i));
    if (!v.length) return null;
    return [v.reduce((s, i) => s + lm[i].x * w, 0) / v.length, v.reduce((s, i) => s + lm[i].y * h, 0) / v.length];
  };

  // px per world-cm from the least foreshortened limb segments (foreshortening only shortens).
  function ratio(lm, W, w, h) {
    const r = [];
    for (const [a, b] of SEGMENTS) {
      if (!seen(lm, a) || !seen(lm, b) || !W?.[a] || !W?.[b]) continue;
      const cm = d3(W[a], W[b]);
      if (cm < 8) continue;
      r.push(Math.hypot((lm[a].x - lm[b].x) * w, (lm[a].y - lm[b].y) * h) / cm);
    }
    if (r.length < 3) return null;
    r.sort((a, b) => b - a);
    return median(r.slice(0, 3));
  }
  // Picture-px per world-cm for each visible segment (index into SEGMENTS).
  function segRatios(lm, W, w, h) {
    const out = {};
    SEGMENTS.forEach(([a, b], i) => {
      if (!seen(lm, a) || !seen(lm, b) || !W?.[a] || !W?.[b]) return;
      const cm = d3(W[a], W[b]);
      if (cm >= 8) out[i] = Math.hypot((lm[a].x - lm[b].x) * w, (lm[a].y - lm[b].y) * h) / cm;
    });
    return out;
  }
  // Depth factor k from THIS frame: each segment against its own size at the lock (so
  // mixing different segments can't bias it), then the middle of the upper half
  // (foreshortening only makes a segment look shorter, never longer).
  function kFrame(lm, W, w, h) {
    const r = segRatios(lm, W, w, h);
    const ks = Object.entries(r).filter(([i]) => lock.seg0[i]).map(([i, v]) => v / lock.seg0[i]).sort((a, b) => b - a);
    if (ks.length < 2) return null;
    return median(ks.slice(0, Math.max(1, Math.ceil(ks.length / 2))));
  }
  const limb = (W, lm, ids) => (ids.every((i) => seen(lm, i)) ? d3(W[ids[0]], W[ids[1]]) + d3(W[ids[1]], W[ids[2]]) : null);

  function unlock(why) { lock = null; still = []; floorOff = 0; reanchors = 0; air = null; cand = null; note = why; }

  // ---- phone sensor ----
  function setSensor(s) {
    sensor = s && !s.none && s.up ? s : null;
    if (!sensor || !lock?.sensorUp || sensor.t === lastSensorT) return;
    lastSensorT = sensor.t;
    const moved = degBetween(unit(sensor.up), lock.sensorUp) > MOVED_DEG || sensor.rotMax > MOVED_ROT;
    movedReads = moved ? movedReads + 1 : 0;
    if (movedReads >= 2) unlock('the phone moved');
  }
  const sensorFresh = () => sensor && Date.now() - sensor.t < 1500;

  // ---- making the lock ----
  function tryLock(t, lm, W, w, h, angles) {
    // Works facing the camera AND side-on: each body part needs only one side in view
    // (side-on, the far arm and leg are hidden behind the body).
    const parts = [[11, 12], [23, 24], [25, 26], [27, 28], FOOT_PTS];
    const legAngles = ['L knee', 'R knee', 'L hip', 'R hip'].map((j) => angles?.[j]).filter((a) => a != null);
    const standing = legAngles.length >= 2 && legAngles.every((a) => a > 158);
    const s = ratio(lm, W, w, h);
    if (!parts.every((ids) => ids.some((i) => seen(lm, i))) || !standing || !s) { still = []; return; }
    const hip = avgPx(lm, [23, 24], w, h);
    const legPx = Math.abs(avgPx(lm, [27, 28], w, h)[1] - hip[1]);
    still.push({ t, hip, lm, W, s, seg: segRatios(lm, W, w, h) });
    while (still.length && still[0].t < t - CALIB_MS) still.shift();
    const moved = Math.max(...still.map((p) => Math.hypot(p.hip[0] - hip[0], p.hip[1] - hip[1])));
    if (moved > legPx * 0.05) { still = still.slice(-1); return; }
    if (still[still.length - 1].t - still[0].t < CALIB_MS * 0.9 || still.length < 5) return;

    // True vertical from the body: ankles → shoulders while standing straight.
    const ups = still.map((p) => unit([0, 1].map((c) => (avgPx(p.lm, [11, 12], w, h)[c] - avgPx(p.lm, [27, 28], w, h)[c]))));
    const ub = unit([median(ups.map((v) => v[0])), median(ups.map((v) => v[1]))]);
    let u = ub, vertical = 'body (standing straight)';
    if (sensorFresh() && sensor.upImg) {
      let us = unit(sensor.upImg);
      if (dot(us, ub) < 0) us = us.map((x) => -x);              // phones disagree on the sign
      const off = Math.acos(Math.min(1, dot(us, ub))) * 180 / Math.PI;
      if (off < 15) { u = us; vertical = `phone gravity sensor (body agrees within ${r1(off)}°)`; }
      else vertical = `body (phone sensor disagreed by ${Math.round(off)}°)`;
    }
    const r = [-u[1], u[0]];
    const lowest = (lm2) => Math.min(...FOOT_PTS.filter((i) => seen(lm2, i)).map((i) => dot(px(lm2, i, w, h), u)));
    const f0 = median(still.map((p) => lowest(p.lm)));
    const oR = median(still.map((p) => dot(avgPx(p.lm, FOOT_PTS, w, h), r)));
    const ratio0 = median(still.map((p) => p.s));
    const eyesU = median(still.map((p) => ([2, 5].some((i) => seen(p.lm, i)) ? dot(avgPx(p.lm, [2, 5], w, h), u) : null)));
    const usedHeight = heightCm != null && eyesU != null && eyesU > f0;
    let s0 = ratio0, scale = 'body limb lengths (MediaPipe metric estimate)';
    if (usedHeight) { s0 = (eyesU - f0) / (0.936 * heightCm); scale = 'your height'; }
    const hipU = median(still.map((p) => dot(avgPx(p.lm, [23, 24], w, h), u)));
    const sideOn = still[still.length - 1].lm.filter((_, i) => [11, 12, 23, 24, 25, 26, 27, 28].includes(i)).filter((q) => q.visibility < VIS).length >= 2;
    const c = [w / 2, h / 2];
    lock = {
      n: ++count, at: t, w, h, u, r, f0, oR, s0, ratio0, cU: dot(c, u), cR: dot(c, r),
      vertical, scale, view: sideOn ? 'side-on' : 'facing', sensorUp: sensorFresh() ? unit(sensor.up) : null,
      tiltDeg: sensorFresh() ? sensor.tiltDeg : null, usedHeight,
      estHeightCm: eyesU != null ? Math.round((eyesU - f0) / s0 / 0.936) : null,
      hipCm: r1((hipU - f0) / s0),
      legCm: Math.round(median(still.map((p) => Math.max(limb(p.W, p.lm, [23, 25, 27]) ?? 0, limb(p.W, p.lm, [24, 26, 28]) ?? 0)))),
      rollDeg: r1(Math.atan2(u[0], -u[1]) * 180 / Math.PI),
      // each segment's own px-per-cm at the lock, the baseline for the depth factor
      seg0: Object.fromEntries(SEGMENTS.map((_, i) => [i, median(still.map((p) => p.seg[i] ?? null))]).filter(([, v]) => v != null)),
    };
    floorOff = 0; reanchors = 0; lastReanchor = t;
    kHist = []; k = 1; still = []; note = null; footHist = []; prev = null; air = null; cand = null;
  }

  // Floor line (projection on `u`) at depth factor k: level-camera perspective, plus the
  // correction from the last still stand (floorOff).
  const floorModel = (kk) => lock.cU + (lock.f0 - lock.cU) * kk;
  const floorAt = (kk) => floorModel(kk) + floorOff;

  function toRoom(p) {
    const s = lock.s0 * k;
    return [(dot(p, lock.r) - lock.cR) / s - (lock.oR - lock.cR) / lock.s0, (dot(p, lock.u) - floorAt(k)) / s];
  }

  // ---- per frame ----
  function update(tr) {
    const pose = tr?.pose, t = tr?.capturedAt ?? Date.now(), w = tr?.width, h = tr?.height;
    const lm = pose?.rawLandmarks || pose?.landmarks, W = pose?.rawWorldLandmarks || pose?.worldLandmarks;
    const out = { locked: false, joints: null, foot_cm: null, feet: null, dist: null, lock, newJumps: [], note };
    if (!lm || !W || !w || !h) {
      if (lock && !lock.sensorUp && t - lastSeen > NOBODY_RESET_MS) unlock('nobody in view for 60 s (no phone sensor to confirm the camera stayed still)');
      still = []; prev = null; cand = null; air = null;
      return { ...out, locked: !!lock, lock, note };
    }
    if (lastSeen && t - lastSeen > MAX_FRAME_GAP_MS) still = [];
    lastSeen = t;
    if (prev && t - prev.t > MAX_FRAME_GAP_MS) { prev = null; cand = null; air = null; }
    if (lock && (lock.w !== w || lock.h !== h)) unlock('video size changed');
    if (!lock) { if (!pose.predicted) tryLock(t, lm, W, w, h, pose.angles); }
    if (!lock) return { ...out, note };

    // Depth is frozen during a real flight (feet up AND hips up): nobody changes distance
    // mid-jump, but limbs blur and bend, which would make the size-based estimate (and the
    // floor) wobble. NOT frozen when only the feet look raised: stepping back also lifts
    // the feet in the picture until the depth estimate catches up, and freezing would
    // lock that error in.
    const inFlight = (air || cand) && lastHipY != null && lock.hipCm != null && lastHipY - lock.hipCm > 3;
    if (!pose.predicted && !inFlight) {
      const kf = kFrame(lm, W, w, h);
      if (kf) kHist.push({ t, v: kf });
      while (kHist.length && kHist[0].t < t - K_WINDOW_MS) kHist.shift();
      k = Math.max(0.5, Math.min(2, median(kHist.map((x) => x.v)) ?? k));
    }
    const joints = {};
    for (const [name, i] of Object.entries(ROOM_JOINTS)) {
      if (!seen(lm, i)) { joints[name] = null; continue; }
      const [X, Y] = toRoom(px(lm, i, w, h));
      joints[name] = [r1(X), r1(Y)];
    }
    const feetY = FOOT_PTS.map((i) => (seen(lm, i) ? toRoom(px(lm, i, w, h))[1] : null)).filter((y) => y != null);
    const foot = feetY.length ? Math.min(...feetY) : null;
    const hips = [joints['L hip'], joints['R hip']].filter(Boolean);
    const hipY = hips.length ? hips.reduce((s, p) => s + p[1], 0) / hips.length : null;
    if (!pose.predicted) lastHipY = hipY;
    const newJumps = [];

    if (!pose.predicted && foot != null) {
      const above = foot > CLEAR_CM;
      const cross = (a, b) => a.t + (b.t - a.t) * Math.max(0, Math.min(1, (CLEAR_CM - a.foot) / ((b.foot - a.foot) || 1e-9)));
      if (!air) {
        if (above && prev && prev.foot <= CLEAR_CM) cand = { tTake: cross(prev, { t, foot }), peakFoot: foot, peakHip: hipY, frames: 1, kTake: k };
        else if (above && cand) { air = { ...cand, frames: cand.frames + 1 }; cand = null; }
        else if (!above) cand = null;
        if (air) { air.peakFoot = Math.max(air.peakFoot, foot); if (hipY != null) air.peakHip = Math.max(air.peakHip ?? hipY, hipY); }
      } else {
        air.frames++;
        if (above) {
          air.peakFoot = Math.max(air.peakFoot, foot);
          if (hipY != null) air.peakHip = Math.max(air.peakHip ?? hipY, hipY);
          if ((t - air.tTake) / 1000 > MAX_FLIGHT_S + 0.3) { note = 'feet stayed off the floor > 1.5 s: standing on something, or the floor estimate is off'; air = null; }
        } else {
          const tLand = cross(prev, { t, foot }), tAbove = (tLand - air.tTake) / 1000;
          if (tAbove > 0.05 && tAbove <= MAX_FLIGHT_S) {
            const tFull = Math.sqrt(tAbove ** 2 + 8 * CLEAR_CM / G);       // time above 6 cm → whole flight
            const hAir = G * tFull ** 2 / 8;
            const hipRise = air.peakHip != null && lock.hipCm != null ? air.peakHip - lock.hipCm : null;
            // Sanity checks: in a real jump the hips (≈ centre of mass) rise about as much as
            // the air time says; feet "leaving the floor" without that is usually a depth
            // change the floor line hadn't caught up with yet.
            const doubt = [];
            if (hipRise != null && hipRise < 0.4 * hAir) doubt.push('hips barely rose');
            if (Math.abs(k - air.kTake) / air.kTake > 0.05) doubt.push('moved toward/away from the camera');
            if (Math.abs(hAir - air.peakFoot) > Math.max(5, 0.25 * hAir)) doubt.push('air time and feet peak disagree');
            const j = {
              quality: doubt.length ? `doubtful: ${doubt.join(', ')}` : 'ok',
              n: ++jumpN, lock: lock.n, takeoff_t: Math.round(air.tTake), land_t: Math.round(tLand),
              airtime_s: r3(tFull), height_airtime_cm: r1(hAir), feet_peak_cm: r1(air.peakFoot),
              hip_rise_cm: r1(hipRise),
              agree_cm: r1(Math.abs(hAir - air.peakFoot)),
              flight_frames: air.frames, fps: r1(air.frames / Math.max(tAbove, 1e-3)),
            };
            newJumps.push(j);
            if (j.quality === 'ok') lastJump = j;
          }
          air = null;
        }
      }
      prev = { t, foot };

      // Re-anchor the floor on every still stand: feet steady for REANCHOR_MS with straight
      // legs = feet on the floor, whatever the estimate says (it may have drifted, e.g.
      // after stepping closer). Not during a flight. Corrections over 25 cm are refused
      // (more likely standing on something than drift). Standing still on a low step
      // will move the floor up to it.
      const proj = Math.min(...FOOT_PTS.filter((i) => seen(lm, i)).map((i) => dot(px(lm, i, w, h), lock.u)));
      footHist.push({ t, proj });
      while (footHist.length && footHist[0].t < t - REANCHOR_MS) footHist.shift();
      const s = lock.s0 * k;
      const knees = ['L knee', 'R knee'].map((j) => pose.angles?.[j]).filter((a) => a != null);
      const straight = knees.length > 0 && knees.every((a) => a > 155);
      const steady = footHist.length >= 6 && footHist[footHist.length - 1].t - footHist[0].t > REANCHOR_MS * 0.9
        && Math.max(...footHist.map((f) => f.proj)) - Math.min(...footHist.map((f) => f.proj)) < 1.5 * s;
      if (!air && !cand && steady && straight && t - lastReanchor > 1000) {
        const want = median(footHist.map((f) => f.proj)) - floorModel(k);
        const change = Math.abs(want - floorOff) / s;
        if (change > 1 && change < 25) { floorOff = want; reanchors++; lastReanchor = t; }
      }
    }

    return {
      locked: true, joints, lock, note, newJumps,
      foot_cm: r1(foot), feet: foot == null ? null : air ? 'air' : foot > CLEAR_CM ? 'air' : 'ground',
      dist: r3(1 / k), reanchors, lastJump,
    };
  }

  // Draw the locked floor (at the person's depth), hip height and a ±1 m box.
  function draw(ctx, w, h, now) {
    if (!lock || lock.w !== w || lock.h !== h) return;
    const s = lock.s0 * k, u = lock.u, r = lock.r;
    const at = (Xcm, Ycm) => {
      const pr = lock.cR + (lock.oR - lock.cR) * k + Xcm * s, pu = floorAt(k) + Ycm * s;
      return [r[0] * pr + u[0] * pu, r[1] * pr + u[1] * pu];
    };
    ctx.save();
    ctx.lineWidth = Math.max(1, w / 500);
    ctx.strokeStyle = 'rgba(0, 230, 255, .5)';
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    for (const [a, b] of [[[-100, 0], [-100, 200]], [[100, 0], [100, 200]], [[-100, 200], [100, 200]]]) { ctx.moveTo(...at(...a)); ctx.lineTo(...at(...b)); }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0, 230, 255, .9)';
    ctx.beginPath(); ctx.moveTo(...at(-100, 0)); ctx.lineTo(...at(100, 0));
    if (lock.hipCm) { ctx.moveTo(...at(-100, lock.hipCm)); ctx.lineTo(...at(100, lock.hipCm)); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(0, 230, 255, .95)';
    ctx.font = `${Math.max(11, Math.round(w / 70))}px system-ui, sans-serif`;
    ctx.fillText('floor 0 cm', ...at(-96, 2));
    if (lock.hipCm) ctx.fillText(`standing hips ${Math.round(lock.hipCm)} cm`, ...at(-96, lock.hipCm + 2));
    if (now?.feet === 'air') { ctx.fillStyle = '#ffeb3b'; ctx.fillText(`in the air: feet +${Math.round(now.foot_cm)} cm`, ...at(-96, 210)); }
    else if (lastJump && Date.now() - lastJump.land_t < 4000) {
      ctx.fillStyle = '#ffeb3b';
      ctx.fillText(`jump ${lastJump.height_airtime_cm} cm (air time ${lastJump.airtime_s} s) · feet peak ${lastJump.feet_peak_cm} cm`, ...at(-96, 210));
    }
    ctx.restore();
  }

  function describe(now) {
    if (!lock) {
      const why = note ? `Lock dropped: ${note}. ` : '';
      return `${why}Room lock: stand straight and still for 2 s, whole body and feet in view (phone on a stand).`;
    }
    const L = lock;
    return `Room locked #${L.n} (${L.view}) · vertical: ${L.vertical} · scale: ${L.scale}`
      + `${L.estHeightCm ? ` · height ≈ ${L.estHeightCm} cm` : ''} · standing hips ${Math.round(L.hipCm)} cm`
      + `${L.tiltDeg != null ? ` · phone tilt ${L.tiltDeg}°` : ' · no phone sensor'}`
      + `${now?.dist ? ` · distance ×${now.dist}` : ''}${reanchors ? ` · floor re-set ${reanchors}× on still stands` : ''}`
      + `${lastJump ? ` · last jump ${lastJump.height_airtime_cm} cm / feet ${lastJump.feet_peak_cm} cm` : ''}`;
  }

  return {
    update, draw, setSensor, describe,
    setHeight(cm) { const v = Number(cm); heightCm = v >= 100 && v <= 245 ? v : null; },
    relock() { unlock(null); },
    get lock() { return lock; },
  };
}
