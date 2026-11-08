/* =====================================================================
   RevGym — prototype front end
   ---------------------------------------------------------------------
   File layout
     1. Api            data access. THE ONLY PLACE that touches mock data.
                       Swap each function's body for a fetch() to your
                       backend; keep the return shapes the same.
     2. Helpers        dates, formatting, escaping, icons
     3. UI kit         toast, bottom sheet, score ring, chart
     4. Screens        record (+ results), stats, plan, alerts, profile
     5. Shell          tab bar, hash router, boot
   ===================================================================== */
(function () {
  'use strict';
  const M = window.REVGYM_MOCK;

  // Theme: opens in light mode whatever the system setting is; the sidebar toggle switches and remembers the choice.
  const THEME_KEY = 'revgym-theme';
  let theme = 'light';
  try { theme = localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { /* storage blocked: stay light */ }
  document.documentElement.setAttribute('data-theme', theme);

  /* =================================================================
     1. API  (mock implementation)
     Every function is async so the screens already await them the way
     they would await a real network call.
     ================================================================= */
  const STORE_KEY = 'revgym-proto-v1';
  const local = {
    load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch (e) { return null; } },
    save(state) { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage blocked: keep in memory */ } },
  };
  const copy = (o) => JSON.parse(JSON.stringify(o));

  // Mutable copy of user-owned data. Read-only data (leaderboards etc.) is read straight from M.
  const db = (function initDb() {
    const saved = local.load();
    const base = {
      sessions: M.plannedSessions.map((s) => ({ ...s, date: isoDate(addDays(weekStart(new Date()), s.weekOffset * 7 + s.dayIndex)) })),
      weeklyGoal: M.currentUser.weeklyGoal,
      notifications: M.notifications.map((n) => ({ ...n, time: new Date(Date.now() - n.minutesAgo * 60000).toISOString() })),
      settings: copy(M.notificationSettings),
      results: [],   // form checks recorded in this browser
    };
    if (saved && saved.version === 1) return { ...base, ...saved.data };
    return base;
  })();
  const persist = () => local.save({ version: 1, data: db });
  let pairing = null;   // phone-pairing session (memory only)

  const Api = {
    async getCurrentUser() { return copy(M.currentUser); },
    async getExercises() { return copy(M.exercises); },
    async getLocations() { return copy(M.locations); },
    async getFocuses() { return copy(M.focuses); },
    async getAppStats() { return copy(M.appStats); },

    /** → { entries:[{rank,user,score,reps,change,isMe}], me:{rank,score}, total } */
    async getFormLeaderboard(exerciseId, period) {
      const rows = M.formLeaderboards[exerciseId][period];
      const entries = rows.map((r, i) => ({ rank: i + 1, user: userById(r.userId), score: r.score, reps: r.reps, change: r.change, isMe: r.userId === 'u_me' }));
      const me = entries.find((e) => e.isMe);
      return { entries, me, total: M.participants[period] };
    },
    /** → { entries:[{rank,user,streak,perWeek,sessions,isMe}], me, total } */
    async getConsistencyLeaderboard(period) {
      const rows = M.consistencyLeaderboard[period];
      const entries = rows.map((r, i) => ({ rank: i + 1, user: userById(r.userId), points: r.points, streak: r.streak, bestStreak: r.bestStreak, activeDays: r.activeDays, nextDayPoints: r.nextDayPoints, isMe: r.userId === 'u_me' }));
      // rule: day n of a streak earns min(max, start + step * (n - 1)) points; a missed day resets to day 1.
      return { entries, me: entries.find((e) => e.isMe), total: M.participants[period], rule: copy(M.pointsRule) };
    },

    /** Planned sessions between two ISO dates (inclusive). */
    async listSessions(fromIso, toIso) {
      return copy(db.sessions.filter((s) => s.date >= fromIso && s.date <= toIso).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)));
    },
    async saveSession(session) {
      if (!session.id) session.id = 's' + Date.now().toString(36);
      const i = db.sessions.findIndex((s) => s.id === session.id);
      if (i >= 0) db.sessions[i] = { ...db.sessions[i], ...session }; else db.sessions.push({ done: false, ...session });
      persist(); return copy(session);
    },
    async deleteSession(id) { db.sessions = db.sessions.filter((s) => s.id !== id); persist(); },
    async setSessionDone(id, done) { const s = db.sessions.find((x) => x.id === id); if (s) s.done = done; persist(); },
    async getWeeklyGoal() { return db.weeklyGoal; },
    async setWeeklyGoal(n) { db.weeklyGoal = Math.max(1, Math.min(7, n)); persist(); return db.weeklyGoal; },

    async listNotifications() { return copy(db.notifications).sort((a, b) => b.time.localeCompare(a.time)); },
    async markNotificationRead(id) { const n = db.notifications.find((x) => x.id === id); if (n) n.read = true; persist(); },
    async markAllNotificationsRead() { db.notifications.forEach((n) => (n.read = true)); persist(); },
    async addNotification(n) { db.notifications.push({ id: 'n' + Date.now(), read: false, time: new Date().toISOString(), ...n }); persist(); },
    async getNotificationSettings() { return copy(db.settings); },
    async saveNotificationSettings(patch) { Object.assign(db.settings, patch); persist(); return copy(db.settings); },

    async getHistory() {
      const recorded = db.results.map((r) => ({ id: r.id, date: r.date, exercise: r.exerciseId, score: r.score, reps: r.reps.length, resultId: r.id }));
      const seeded = M.history.map((h) => ({ ...h, date: addDays(new Date(), -h.daysAgo).toISOString() }));
      return copy([...recorded.reverse(), ...seeded]);
    },
    async getFormTrend(key) { return copy(M.formTrend[key] || M.formTrend.all); },
    async getTrainedDays() { return copy(M.trainedDaysAgo); },

    /**
     * Stand-in for the pose-estimation model.
     * Input: { exerciseId, durationSec, repCount, seed? }
     * Output: { id, exerciseId, date, durationSec, score, metrics:[{key,label,score}], reps:[{n,score,down,up,flagKey,flag}], tips:[...], strengths:[...] }
     */
    async analyzeRecording({ exerciseId, durationSec, repCount, seed }) {
      const ex = M.exercises.find((e) => e.id === exerciseId);
      const rnd = seededRandom(seed ?? Date.now());
      // Pick 1–2 weak metrics, the rest score well.
      const keys = ex.metrics.slice();
      const weak = [keys[Math.floor(rnd() * keys.length)]];
      if (rnd() > 0.35) { const k = keys[Math.floor(rnd() * keys.length)]; if (!weak.includes(k)) weak.push(k); }
      const metrics = keys.map((k) => ({ key: k, label: M.metrics[k].label, score: Math.round(weak.includes(k) ? 56 + rnd() * 18 : 82 + rnd() * 15) }));
      const n = Math.max(1, repCount);
      const reps = [];
      for (let i = 0; i < n; i++) {
        const fatigue = (i / Math.max(1, n - 1)) * 9;            // later reps get a little worse
        const score = Math.round(Math.min(98, Math.max(52, 90 - fatigue + (rnd() - 0.5) * 12 - (rnd() < 0.3 ? 10 : 0))));
        const flagKey = score < 80 ? weak[Math.floor(rnd() * weak.length)] : null;
        reps.push({ n: i + 1, score, down: +(1.2 + rnd() * 1.3 - fatigue / 30).toFixed(1), up: +(0.7 + rnd() * 0.6 + fatigue / 40).toFixed(1), flagKey, flag: flagKey ? M.metrics[flagKey].flag : null });
      }
      const repAvg = reps.reduce((s, r) => s + r.score, 0) / reps.length;
      const metAvg = metrics.reduce((s, m) => s + m.score, 0) / metrics.length;
      const score = Math.round(repAvg * 0.5 + metAvg * 0.5);
      const sorted = metrics.slice().sort((a, b) => a.score - b.score);
      const tipsFor = (k) => ({ key: k, score: metrics.find((m) => m.key === k).score, ...((M.tipsByExercise[exerciseId] || {})[k] || M.tips[k]) });
      const tips = sorted.filter((m) => m.score < 80).slice(0, 3).map((m) => tipsFor(m.key));
      if (!tips.length) tips.push(tipsFor(sorted[0].key));
      const strengths = sorted.slice().reverse().filter((m) => m.score >= 85).map((m) => m.label);
      return { id: 'r' + Date.now().toString(36), exerciseId, date: new Date().toISOString(), durationSec, score, metrics, reps, tips, strengths };
    },
    /* ----- Phone as camera (pairing). Mock only: a real backend would create a short-lived code,
       the phone joins it (QR holds https://revgym.app/pair/<code>), the video streams to the laptop
       (e.g. WebRTC), and status changes arrive by websocket or polling. ----- */
    async createPairing() { pairing = { code: 'RV-' + (1000 + Math.floor(Math.random() * 9000)), state: 'waiting', device: null }; return copy({ ...pairing, url: `https://revgym.app/pair/${pairing.code}`, expiresInSec: 300 }); },
    async getPairingStatus() { return copy(pairing || { state: 'idle' }); },
    async endPairing() { pairing = null; },
    /** Phone side. Returns { ok, laptop } or { ok: false, error } */
    async joinPairing(code) {
      const c = String(code).trim().toUpperCase();
      if (!/^RV-[0-9]{4}$/.test(c)) return { ok: false, error: 'That code doesn\u2019t look right. Codes look like RV-1234.' };
      if (pairing && pairing.code === c) { pairing.state = 'connected'; pairing.device = { name: 'Jordan\u2019s iPhone', battery: 87, signal: 'Good' }; }
      return { ok: true, laptop: 'Jordan\u2019s laptop' };
    },
    /** Prototype only: pretend the phone joined. */
    async simulatePhoneJoined() { if (pairing) { pairing.state = 'connected'; pairing.device = { name: 'Jordan\u2019s iPhone', battery: 87, signal: 'Good' }; } return copy(pairing || { state: 'idle' }); },

    async saveResult(result) { db.results.push(result); if (db.results.length > 20) db.results.shift(); persist(); },
    async getResult(id) { return copy(db.results.find((r) => r.id === id) || null); },
  };

  function userById(id) {
    if (id === 'u_me') return { id, name: M.currentUser.name + ' (you)', initials: M.currentUser.initials, classYear: M.currentUser.classYear, major: M.currentUser.major };
    return M.users.find((u) => u.id === id);
  }

  /* =================================================================
     2. HELPERS
     ================================================================= */
  function seededRandom(seed) { let s = (seed >>> 0) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); const dow = (x.getDay() + 6) % 7; return addDays(x, -dow); } // Monday
  function isoDate(d) { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }
  function parseIso(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DOW_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (d) => `${MON[d.getMonth()]} ${d.getDate()}`;
  function fmtTime(hhmm) { const [h, m] = hhmm.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; const h12 = ((h + 11) % 12) + 1; return `${h12}:${String(m).padStart(2, '0')} ${ap}`; }
  function fmtClock(sec) { return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`; }
  function timeAgo(iso) {
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 1) return 'now'; if (mins < 60) return mins + 'm'; if (mins < 1440) return Math.round(mins / 60) + 'h';
    const d = Math.round(mins / 1440); return d < 7 ? d + 'd' : fmtDate(new Date(iso));
  }
  function relDay(iso) { const d = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000); return d === 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? d + ' days ago' : fmtDate(new Date(iso)); }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const band = (score) => (score >= 85 ? 'good' : score >= 72 ? 'warn' : 'bad');
  const exById = (id) => M.exercises.find((e) => e.id === id);
  const locById = (id) => M.locations.find((l) => l.id === id) || M.locations[0];
  const focusById = (id) => M.focuses.find((f) => f.id === id) || M.focuses[0];
  const $ = (sel, root = document) => root.querySelector(sel);

  const ICONS = {
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8M9 17h6"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    left: '<path d="M15 5l-7 7 7 7"/>', right: '<path d="M9 5l7 7-7 7"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 1.6 1 2.6 2 3 0-3 .5-5.5.5-8z"/>',
    pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    flip: '<path d="M4 9a8 8 0 0 1 14-3l2 2M20 15a8 8 0 0 1-14 3l-2-2M20 4v4h-4M4 20v-4h4"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    chart: '<path d="M4 19h16M6 16l4-5 3 3 5-7"/>',
    file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>',
    dumbbell: '<path d="M3 10v4M6 7v10M18 7v10M21 10v4M6 12h12"/>',
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8h.01"/>',
    send: '<path d="M4 12l16-7-6 16-3-6z"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M10.5 18h3"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  };
  /** A decorative QR-style pattern (not scannable). A real build would render the pairing URL with a QR library. */
  function fakeQr(text) {
    const n = 25; let h = 2166136261; for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const rnd = seededRandom(h >>> 0); let d = '';
    const corners = [[0, 0], [n - 7, 0], [0, n - 7]];
    const inFinderZone = (x, y) => corners.some(([fx, fy]) => x >= fx - 1 && x <= fx + 7 && y >= fy - 1 && y <= fy + 7);
    const finderOn = (x, y) => { for (const [fx, fy] of corners) { const dx = x - fx, dy = y - fy; if (dx >= 0 && dx < 7 && dy >= 0 && dy < 7) { const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6; const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4; return edge || core; } } return false; };
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const on = inFinderZone(x, y) ? finderOn(x, y) : rnd() > 0.52; if (on) d += `M${x} ${y}h1v1h-1z`; }
    return `<svg viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges" role="img" aria-label="Sample QR code"><rect x="-1" y="-1" width="${n + 2}" height="${n + 2}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
  }

  /* Logo images (cropped from the supplied RevGym logo). Both live in revgym/assets/. */
  const LOGO_FULL = 'assets/reveille-logo.png';   // dog head + REV GYM wordmark + A&M mark
  const LOGO_HEAD = 'assets/reveille-head.png';   // dog head only

  const icon = (name, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICONS[name]}</svg>`;

  /* =================================================================
     3. UI KIT
     ================================================================= */
  const app = $('#app');
  let toastTimer;
  function toast(title, body = '') {
    $('.toast', app)?.remove();
    const t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status');
    t.innerHTML = `<div><b>${esc(title)}</b>${body ? `<span class="small">${esc(body)}</span>` : ''}</div>`;
    app.appendChild(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200);
  }

  function openSheet(html, onMount) {
    closeSheet();
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="sheet gutter" role="dialog" aria-modal="true">${html}</div>`;
    scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSheet(); });
    app.appendChild(scrim);
    onMount && onMount(scrim.querySelector('.sheet'));
    scrim.querySelector('input, select, button')?.focus({ preventScroll: true });
  }
  function closeSheet() { $('.scrim', app)?.remove(); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  function ring(score, { size = 104, stroke = 10, track = 'rgba(255,255,255,.18)', color = '#fff', label = 'Form' } = {}) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - score / 100);
    return `<div class="ring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg><div class="val num"><div>${score}<small>${label}</small></div></div></div>`;
  }

  /** Line chart with area fill. values: numbers on a 0–100 form scale. */
  function lineChart(values, labels) {
    const W = 340, H = 170, L = 28, R = 12, T = 12, B = 24;
    const lo = Math.max(0, Math.floor((Math.min(...values) - 6) / 10) * 10), hi = 100;
    const x = (i) => L + (i * (W - L - R)) / (values.length - 1);
    const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
    let grid = '';
    for (let v = lo; v <= hi; v += 10) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
    const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const xl = labels.map((l, i) => (i % 3 === 0 || i === labels.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${l}</text>` : '')).join('');
    const last = values.length - 1;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Form score trend, latest ${values[last]}">
      ${grid}${xl}
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(last)}" cy="${y(values[last])}" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
      <text x="${x(last) - 8}" y="${y(values[last]) - 10}" text-anchor="end" style="fill:var(--fg);font-weight:700;font-size:12px">${values[last]}</text>
    </svg>`;
  }

  /* =================================================================
     4. SCREENS
     Each screen: { title, async render(el, params), destroy() }
     ================================================================= */

  /* ---------------- 4a. Record / Form check ---------------- */
  const phoneCamPort = document.querySelector('meta[name="phone-cam-port"]')?.content;
  const phoneCamOrigin = phoneCamPort && ['127.0.0.1', 'localhost'].includes(location.hostname)
    ? new URL(`http://${location.hostname}:${phoneCamPort}`).origin : null;

  const RecordScreen = (() => {
    let el, exerciseId = 'squat', status = 'idle', stream = null, facing = 'environment';
    let camSource = 'device', pair = { state: 'idle' }, phoneLink = null;   // phone-as-camera state
    const cameraSourceKey = 'revgym-camera-source';
    if (phoneCamOrigin) {
      try { if (localStorage.getItem(cameraSourceKey) === 'phone') camSource = 'phone'; } catch {}
    }
    let raf = 0, t0 = 0, elapsed = 0, reps = 0, nextRepAt = 0, tick = 0, countdownTimer = 0;
    let phoneFeedTimer, cameraRequest = 0;
    const REP_SEC = 2.6;
    const idleLabel = () => (matchMedia('(max-width: 700px)').matches ? 'Tap Record to start a set' : 'Click Record or press Space to start');
    const CUES = { good: ['Depth looks good', 'Bar path steady', 'Nice tempo', 'Strong lockout', 'Stay braced'], warn: ['Knees drifting in', 'Slow the descent', 'Chest is dropping', 'Finish the rep'] };

    async function render(root) {
      el = root; status = 'idle';
      const exercises = phoneCamOrigin ? [] : await Api.getExercises();
      if (!phoneCamOrigin) {
        if (camSource === 'phone') pair = await Api.getPairingStatus();
        if (pair.state === 'idle') camSource = 'device';
      }
      el.innerHTML = `
        <div class="rec-wrap">
          <div class="topbar gutter${phoneCamOrigin ? ' rec-camera-status' : ''}">
            ${phoneCamOrigin ? '' : '<h1>Form Check</h1>'}
            <span class="pill neutral" id="camState" role="status">${phoneCamOrigin ? 'Camera off' : 'Demo feed'}</span>
          </div>
          <div class="rec-body gutter-desk">
          <div class="viewfinder" id="vf">
            <video id="video" playsinline muted hidden></video>
            ${phoneCamOrigin ? '' : '<canvas class="pose" id="pose"></canvas>'}
            <div class="vf-grid"></div>
            <div class="vf-corners"><i></i><i></i><i></i><i></i></div>
            ${phoneCamOrigin ? '' : `<div class="vf-top">
              <span class="vf-pill" id="vfStatus">${esc(exById(exerciseId).name)}</span>
              <span class="vf-pill num" id="vfTimer" hidden>00:00</span>
            </div>`}
            <div class="vf-wait" id="vfWait" hidden>${icon('phone')}<b>Waiting for your phone\u2026</b><span>Scan the code on the right, or type it into the app on your phone.</span></div>
            ${phoneCamOrigin ? '' : `<div class="vf-hint" id="vfHint">Stand side-on, 6–10 ft from your camera,<br>with your whole body in frame.</div>
            <div class="vf-stats" id="vfStats" hidden>
              <div class="vf-reps num"><span id="vfReps">0</span><small>reps</small></div>
              <div class="vf-cue" id="vfCue"><span class="lamp"></span><span id="vfCueText">Tracking…</span></div>
            </div>`}
          </div>
          <div class="rec-panel">
          ${phoneCamOrigin ? '' : `<div class="gutter" style="padding-top:12px">
            <div class="lbl-desk">Exercise</div>
            <div class="chips" role="group" aria-label="Exercise" id="exChips">
              ${exercises.map((e) => `<button class="chip" data-ex="${e.id}" aria-pressed="${e.id === exerciseId}">${esc(e.short)}</button>`).join('')}
            </div>
          </div>`}
          <div class="gutter${phoneCamOrigin ? '' : ' only-pc'}" style="padding-top:4px">
            <div class="lbl-desk">Camera</div>
            <div class="seg" id="camSrc" role="group" aria-label="Camera source">
              <button data-src="device" aria-pressed="true">This device</button>
              <button data-src="phone" aria-pressed="false">${icon('phone', 'width="15" height="15" style="vertical-align:-3px"')} My phone</button>
            </div>
          </div>
          <div class="rec-controls gutter">
            <button class="side" id="camBtn" type="button"><span class="icon-btn">${icon('camera')}</span><span id="camBtnLabel">Use camera</span></button>
            <button class="rec-btn" id="recBtn" type="button" aria-label="Start recording"${phoneCamOrigin ? ' disabled' : ''}><span></span></button>
            ${phoneCamOrigin ? '' : `<button class="side" id="sampleBtn" type="button"><span class="icon-btn">${icon('spark')}</span>Sample result</button>`}
          </div>
          <div class="rec-label" id="recLabel">${phoneCamOrigin ? 'Live camera preview' : idleLabel()}</div>
          <section class="card pair${phoneCamOrigin ? '' : ' only-pc'}" id="pairCard" hidden></section>
          ${phoneCamOrigin ? `<section class="card set-feedback" id="feedbackCard" hidden>
            <h2>Set feedback</h2>
            <div id="fbText" aria-live="polite"><p class="small muted">Do one set, rest for 10 seconds, then press Get feedback.</p></div>
            <button class="btn primary" id="fbBtn" type="button">Get feedback</button>
          </section>` : ''}
          ${phoneCamOrigin ? '' : '<div class="gutter only-phone"><section class="card phone-link" id="phoneLink"></section></div>'}
          <section class="card rec-guide">
            <h2>Before you record</h2>
            <ol>
              <li>Set your camera side-on, 6–10 ft away.</li>
              <li>Keep your whole body and the bar in frame.</li>
              <li>Face the light. A bright window behind you hides your joints.</li>
              <li>Record one set at a time.</li>
            </ol>
            ${phoneCamOrigin ? '' : '<p class="small muted">Press <kbd>Space</kbd> to start or stop recording.</p>'}
          </section>
          </div>
          </div>
        </div>`;
      $('#camBtn', el).addEventListener('click', toggleCamera);
      $('#camSrc', el).addEventListener('click', (e) => { const b = e.target.closest('[data-src]'); if (b && b.dataset.src !== camSource) setSource(b.dataset.src); });
      $('#pairCard', el).addEventListener('click', onPairClick);
      if (phoneCamOrigin) {
        window.addEventListener('message', onPhoneCamStatus);
        $('#fbBtn', el).addEventListener('click', requestFeedback);
        if (camSource === 'phone') setSource('phone');
        else paintLiveCamera();
      } else {
        document.addEventListener('keydown', onKey);
        $('#exChips', el).addEventListener('click', (e) => {
          const b = e.target.closest('[data-ex]'); if (!b || status !== 'idle') return;
          exerciseId = b.dataset.ex;
          el.querySelectorAll('[data-ex]').forEach((x) => x.setAttribute('aria-pressed', x === b));
          $('#vfStatus', el).textContent = exById(exerciseId).name;
        });
        $('#recBtn', el).addEventListener('click', () => (status === 'idle' ? startCountdown() : status === 'recording' ? stop() : null));
        $('#phoneLink', el).addEventListener('click', onPhoneLinkClick);
        paintSource(); paintPhoneLink();
        $('#sampleBtn', el).addEventListener('click', () => finish(8, 22, 42));
        loop();
      }
      if (stream) attachStream();
    }

    /* ---- phone as camera: laptop side ---- */
    async function setSource(src) {
      if (status !== 'idle') return;
      camSource = src;
      if (phoneCamOrigin) {
        try { localStorage.setItem(cameraSourceKey, src); } catch {}
        stopStream();
        clearTimeout(phoneFeedTimer);
        $('#phoneFeed', el)?.remove();
        if (src === 'phone') {
          pair = { state: 'loading' };
          const frame = document.createElement('iframe');
          frame.id = 'phoneFeed';
          frame.title = 'Live phone camera with body tracking';
          frame.tabIndex = -1;
          frame.referrerPolicy = 'origin';
          frame.src = phoneCamOrigin + '/form-check';
          $('#vf', el).prepend(frame);
          phoneFeedTimer = setTimeout(() => {
            pair = { state: 'unavailable' };
            paintLiveCamera();
          }, 8000);
        }
        paintLiveCamera();
        return;
      }
      if (src === 'phone') pair = await Api.createPairing(); else { await Api.endPairing(); pair = { state: 'idle' }; }
      paintSource();
    }

    function onPhoneCamStatus(event) {
      const frame = $('#phoneFeed', el);
      if (!frame || event.source !== frame.contentWindow || event.origin !== phoneCamOrigin) return;
      const data = event.data;
      if (data?.type === 'phone-cam-feedback') return showFeedback(data);
      if (data?.type !== 'phone-cam-status' || !Array.isArray(data.phoneUrls)) return;
      clearTimeout(phoneFeedTimer);
      const url = data.phoneUrls.find((item) => typeof item === 'string' && item.startsWith('https://'));
      const state = data.connected ? 'connected' : data.reconnecting ? 'reconnecting' : 'waiting';
      const calibration = data.calibration;
      if (pair.state === state && pair.url === url && pair.calibration === calibration) return;
      pair = { state, url, calibration };
      paintLiveCamera();
    }

    function paintLiveCamera() {
      const phone = camSource === 'phone';
      const connected = phone ? pair.state === 'connected' : !!stream;
      const reconnecting = phone && pair.state === 'reconnecting';
      const statusLabel = {
        loading: 'Starting Phone Cam…', waiting: 'Waiting for your phone…',
        connected: 'Phone connected', reconnecting: 'Reconnecting…', unavailable: 'Phone Cam unavailable',
      };
      const label = phone ? statusLabel[pair.state] : connected ? 'Camera on' : 'Camera off';
      const cameraStatus = $('#camState', el);
      cameraStatus.textContent = label;
      cameraStatus.className = 'pill ' + (connected ? 'good' : phone ? 'warn' : 'neutral');
      el.querySelectorAll('[data-src]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.src === camSource));
      const wait = $('#vfWait', el);
      wait.hidden = connected || reconnecting;
      $('b', wait).textContent = label;
      $('span', wait).textContent = phone
        ? (pair.state === 'unavailable' ? 'Restart the app with npm start and sign in again.' : 'Scan the QR code and tap Start streaming on your phone.')
        : 'Use this device’s camera or choose My phone.';
      $('#camBtn', el).style.visibility = phone ? 'hidden' : '';
      $('#camBtnLabel', el).textContent = stream ? 'Flip camera' : 'Use camera';
      $('#camBtn .icon-btn', el).innerHTML = icon(stream ? 'flip' : 'camera');
      const card = $('#pairCard', el);
      card.hidden = !phone;
      const fbCard = $('#feedbackCard', el);
      if (fbCard) fbCard.hidden = !phone;
      if (!phone) return;
      const qr = pair.url && !connected && !reconnecting
        ? `<div class="qr"><img alt="Scan to open the phone camera" src="${phoneCamOrigin}/qr.svg?url=${encodeURIComponent(pair.url)}"></div><p class="small muted">Use the same Wi-Fi as this PC, then tap <b>Start streaming</b> on your phone.</p>`
        : pair.state === 'waiting' ? '<p class="small muted">Connect this PC and your phone to the same Wi-Fi to get a QR code.</p>' : '';
      const roomStatus = pair.calibration === 'profile' ? 'Room locked using your profile height.'
        : pair.calibration === 'estimated' ? 'Room locked using an estimated scale.'
        : 'Put the phone on a stand and stand still for 2 seconds with your whole body and feet in view.';
      card.innerHTML = `<h2>${connected || reconnecting ? label : 'Connect your phone'}</h2>${qr}
        ${connected ? `<p class="small muted" role="status">${roomStatus}</p>` : ''}
        <button class="btn" data-pair="back" type="button">Back to this device</button>`;
    }
    function paintSource() {
      if (!el || !el.isConnected) return;
      const phone = camSource === 'phone', ok = phone && pair.state === 'connected';
      el.querySelectorAll('[data-src]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.src === camSource));
      $('#pairCard', el).hidden = !phone; $('#vfWait', el).hidden = !(phone && !ok);
      $('#camBtn', el).style.visibility = phone ? 'hidden' : '';
      const cs = $('#camState', el);
      if (phone) { cs.textContent = ok ? 'Phone connected' : 'Waiting for phone'; cs.className = 'pill ' + (ok ? 'good' : 'warn'); $('#pairCard', el).innerHTML = pairHtml(ok); }
      else { cs.textContent = stream ? 'Camera on' : 'Demo feed'; cs.className = 'pill ' + (stream ? 'good' : 'neutral'); }
    }
    function pairHtml(ok) {
      if (ok) return `
        <div class="pair-device"><span class="dev-ic">${icon('phone')}</span><div><b>${esc(pair.device.name)}</b><span class="small muted">Connected \u00b7 Battery ${pair.device.battery}% \u00b7 Signal ${esc(pair.device.signal.toLowerCase())}</span></div><span class="status-dot ok" aria-hidden="true"></span></div>
        <ul class="pair-tips small"><li>Prop the phone side-on, 6\u201310 ft away, in landscape.</li><li>Keep its screen on. Recording starts from this laptop.</li></ul>
        <div class="pair-actions"><button class="btn" data-pair="disconnect" type="button">Disconnect phone</button></div>`;
      return `
        <h2>Connect your phone</h2>
        <div class="pair-top"><div class="qr">${fakeQr(pair.code)}</div>
          <div><div class="pair-code num">${esc(pair.code)}</div><p class="small muted">Code works for 5 minutes. Sample pattern only.</p></div></div>
        <ol class="small"><li>Open RevGym on your phone.</li><li>Go to Record and choose \u201cUse this phone as a camera\u201d.</li><li>Scan this code, or type it in.</li></ol>
        <div class="pair-actions"><span class="status-dot" aria-hidden="true"></span><span class="small">Waiting for your phone\u2026</span><button class="btn" data-pair="cancel" type="button">Cancel</button></div>
        <button class="link-btn" data-pair="sim" type="button">Prototype only: pretend my phone just connected</button>`;
    }
    async function onPairClick(e) {
      const b = e.target.closest('[data-pair]'); if (!b) return;
      if (phoneCamOrigin) return setSource('device');
      if (b.dataset.pair === 'sim') { pair = await Api.simulatePhoneJoined(); paintSource(); toast('Phone connected', `${pair.device.name} is now your camera.`); }
      else { await Api.endPairing(); pair = { state: 'idle' }; camSource = 'device'; paintSource(); if (b.dataset.pair === 'disconnect') toast('Phone disconnected', 'Back to this device\u2019s camera.'); }
    }

    /* ---- phone as camera: phone side (shown only in the phone layout) ---- */
    function paintPhoneLink() {
      const card = $('#phoneLink', el); if (!card) return;
      card.innerHTML = phoneLink ? `
        <div class="pair-device"><span class="dev-ic">${icon('phone')}</span><div><b>Connected to ${esc(phoneLink.laptop)}</b><span class="small muted">This phone is now the camera</span></div><span class="status-dot ok" aria-hidden="true"></span></div>
        <p class="small">Leave this screen open and prop the phone side-on where it can see your whole body. Start and stop recording from your laptop.</p>
        <div class="pair-actions"><button class="btn" data-pl="leave" type="button">Stop being a camera</button></div>` : `
        <h2>Use this phone as a camera</h2>
        <p class="small muted">Film your set with this phone and watch the form report on your laptop.</p>
        <div class="pl-row"><input id="plCode" type="text" inputmode="text" autocapitalize="characters" autocomplete="off" placeholder="RV-1234" maxlength="7" aria-label="Pairing code"><button class="btn primary" data-pl="connect" type="button">Connect</button></div>
        <p class="small" id="plErr" style="color:var(--bad)" hidden></p>
        <p class="small muted">On your laptop, open Record, choose My phone, and enter the code you see there. Or scan its QR code with your phone camera.</p>`;
    }
    async function onPhoneLinkClick(e) {
      const b = e.target.closest('[data-pl]'); if (!b) return;
      if (b.dataset.pl === 'leave') { phoneLink = null; paintPhoneLink(); return; }
      const res = await Api.joinPairing($('#plCode', el).value);
      if (res.ok) { phoneLink = { laptop: res.laptop }; paintPhoneLink(); toast('Connected', `Your phone is now ${res.laptop}\u2019s camera.`); }
      else { const err = $('#plErr', el); err.textContent = res.error; err.hidden = false; }
    }

    function onKey(e) {
      if (e.code !== 'Space' || e.repeat || !el?.isConnected || e.target.closest('input, select, textarea, button, .scrim')) return;
      if (status === 'idle') { e.preventDefault(); startCountdown(); }
      else if (status === 'recording') { e.preventDefault(); stop(); }
    }

    async function toggleCamera() {
      const video = $('#video', el);
      if (stream) { // flip between front and back camera
        facing = facing === 'environment' ? 'user' : 'environment';
        stopStream();
      } else if (!toggleCamera.used) {
        // First use: a PC webcam faces the user; a phone starts on the back camera.
        toggleCamera.used = true;
        facing = matchMedia('(pointer: fine)').matches ? 'user' : 'environment';
      }
      const request = ++cameraRequest;
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
        const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
        if (request !== cameraRequest || !video.isConnected || camSource !== 'device') {
          camera.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = camera;
        attachStream();
      } catch (err) {
        if (request !== cameraRequest || !video.isConnected) return;
        stream = null;
        if (phoneCamOrigin) {
          paintLiveCamera();
          toast('Camera isn’t available here', 'Check camera permissions or choose My phone.');
        } else toast('Camera isn’t available here', 'Showing the demo feed instead. Open the prototype from a local copy in Chrome or Edge to use your webcam.');
      }
    }
    function attachStream() {
      const v = $('#video', el); if (!v) return;
      v.srcObject = stream; v.hidden = false; v.classList.toggle('mirror', facing === 'user'); v.play().catch(() => {});
      if (phoneCamOrigin) return paintLiveCamera();
      $('#camState', el).textContent = 'Camera on'; $('#camState', el).className = 'pill good';
      $('#camBtnLabel', el).textContent = 'Flip camera';
      $('#camBtn .icon-btn', el).innerHTML = icon('flip');
    }
    function stopStream() {
      cameraRequest++;
      stream?.getTracks().forEach((t) => t.stop()); stream = null;
      const video = $('#video', el);
      if (video) { video.srcObject = null; video.hidden = true; }
    }

    function startCountdown() {
      if (camSource === 'phone' && pair.state !== 'connected') { toast('Connect your phone first', 'Scan the code, or choose This device to use this computer\u2019s camera.'); return; }
      status = 'countdown';
      const vf = $('#vf', el);
      const cd = document.createElement('div'); cd.className = 'countdown num'; vf.appendChild(cd);
      $('#vfHint', el).hidden = true;
      $('#recLabel', el).textContent = 'Get in position…';
      let n = 3; cd.textContent = n;
      countdownTimer = setInterval(() => {
        n--; if (n > 0) { cd.textContent = n; return; }
        clearInterval(countdownTimer); cd.remove(); startRecording();
      }, 800);
    }
    function startRecording() {
      status = 'recording'; t0 = performance.now(); reps = 0; nextRepAt = REP_SEC * 1.1;
      $('#recBtn', el).classList.add('on'); $('#recBtn', el).setAttribute('aria-label', 'Stop recording');
      $('#vfTimer', el).hidden = false; $('#vfStats', el).hidden = false;
      const st = $('#vfStatus', el); st.classList.add('rec'); st.textContent = 'REC';
      $('#recLabel', el).textContent = 'Recording ' + exById(exerciseId).name + ' · press Space or click to stop';
      el.querySelectorAll('[data-ex]').forEach((b) => (b.disabled = true));
    }
    function stop() {
      const dur = Math.round(elapsed);
      if (reps < 1) { reset(); toast('No reps detected', 'Record at least one full rep to get a form score.'); return; }
      finish(reps, dur);
    }
    function reset() {
      status = 'idle'; elapsed = 0; reps = 0;
      $('#recBtn', el).classList.remove('on'); $('#recBtn', el).setAttribute('aria-label', 'Start recording');
      $('#vfTimer', el).hidden = true; $('#vfStats', el).hidden = true; $('#vfHint', el).hidden = false;
      const st = $('#vfStatus', el); st.classList.remove('rec'); st.textContent = exById(exerciseId).name;
      $('#recLabel', el).textContent = idleLabel();
      el.querySelectorAll('[data-ex]').forEach((b) => (b.disabled = false));
    }
    async function finish(repCount, durationSec, seed) {
      status = 'results';
      cancelAnimationFrame(raf);
      const result = await Api.analyzeRecording({ exerciseId, durationSec, repCount, seed });
      await Api.saveResult(result);
      ResultsView.show(el, result, { onAgain: () => render(el) });
    }

    /* Demo feed: a stick figure doing the selected lift, plus a fake pose overlay. */
    function loop() {
      const cv = $('#pose', el); if (!cv) return;
      const ctx = cv.getContext('2d');
      const draw = (now) => {
        if (!cv.isConnected) return;
        const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
        if (!stream) drawBackdrop(ctx, w, h);
        if (status === 'recording') {
          elapsed = (now - t0) / 1000;
          $('#vfTimer', el).textContent = fmtClock(elapsed);
          if (elapsed >= nextRepAt) {
            reps++; nextRepAt += REP_SEC;
            $('#vfReps', el).textContent = reps;
            const warn = Math.random() < 0.3 + reps * 0.03;
            const pool = warn ? CUES.warn : CUES.good;
            $('#vfCue', el).classList.toggle('warn', warn);
            $('#vfCueText', el).textContent = pool[Math.floor(Math.random() * pool.length)];
          }
        }
        const speed = status === 'recording' ? (2 * Math.PI) / REP_SEC : (2 * Math.PI) / 3.4;
        const phase = (Math.sin((now / 1000) * speed - Math.PI / 2) + 1) / 2; // 0 = top, 1 = bottom
        drawFigure(ctx, w, h, phase, exById(exerciseId).group, status === 'recording');
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    }
    function drawBackdrop(ctx, w, h) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#2a1414'); g.addColorStop(0.72, '#1a0d0d'); g.addColorStop(0.72, '#3b2a24'); g.addColorStop(1, '#2a1d19');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // rack uprights
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fillRect(w * 0.14, h * 0.18, 10, h * 0.54); ctx.fillRect(w * 0.82, h * 0.18, 10, h * 0.54);
      // gym floor lines
      ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(0, h * 0.72 + i * i * 6); ctx.lineTo(w, h * 0.72 + i * i * 6); ctx.stroke(); }
    }
    function drawFigure(ctx, w, h, p, group, live) {
      const s = Math.min(w * 0.8, h * 0.5) / 260, cx = w * 0.5, floor = h * 0.72;
      const P = (x, y) => [cx + x * s, floor - y * s];
      let J;
      if (group === 'lower') {
        const hipY = 150 - p * 70, hipX = -10 - p * 38, kneeX = 22 + p * 18, kneeY = 80 - p * 18, torsoA = 0.12 + p * 0.55;
        const sh = [hipX + Math.sin(torsoA) * 92, hipY + Math.cos(torsoA) * 92];
        J = { ankle: [0, 6], toe: [26, 2], knee: [kneeX, kneeY], hip: [hipX, hipY], sh, head: [sh[0] + 16, sh[1] + 30], elbow: [sh[0] - 22, sh[1] - 6], hand: [sh[0] - 6, sh[1] + 2], bar: [sh[0] - 12, sh[1] + 4] };
      } else if (group === 'press') {
        const sh = [0, 150], handY = 160 + (1 - p) * 70;
        J = { ankle: [0, 6], toe: [26, 2], knee: [6, 78], hip: [-2, 98], sh, head: [6, 178], elbow: [24, 150 + (1 - p) * 34], hand: [8, handY], bar: [8, handY] };
      } else {
        const sh = [0, 150], handY = 120 + (1 - p) * 34;
        J = { ankle: [0, 6], toe: [26, 2], knee: [6, 78], hip: [-2, 98], sh, head: [6, 178], elbow: [4, 112], hand: [18 + (1 - p) * 10, handY], bar: [18 + (1 - p) * 10, handY] };
      }
      const pt = (k) => P(...J[k]);
      // bones
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const bone = (a, b, col, wdt) => { ctx.strokeStyle = col; ctx.lineWidth = wdt; ctx.beginPath(); ctx.moveTo(...pt(a)); ctx.lineTo(...pt(b)); ctx.stroke(); };
      const body = 'rgba(255,240,235,.85)';
      [['toe', 'ankle'], ['ankle', 'knee'], ['knee', 'hip'], ['hip', 'sh'], ['sh', 'elbow'], ['elbow', 'hand']].forEach(([a, b]) => bone(a, b, body, 14 * s + 2));
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(...pt('head'), 15 * s + 2, 0, Math.PI * 2); ctx.fill();
      // barbell (side view = plate)
      const [bx, by] = pt('bar');
      ctx.fillStyle = '#7a1418'; ctx.beginPath(); ctx.arc(bx, by, 26 * s + 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c9b9b5'; ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
      // pose-tracking overlay
      const accent = live ? '#5ee6a0' : 'rgba(255,255,255,.75)';
      ctx.setLineDash([4, 4]);
      [['ankle', 'knee'], ['knee', 'hip'], ['hip', 'sh'], ['sh', 'elbow'], ['elbow', 'hand']].forEach(([a, b]) => bone(a, b, accent, 2));
      ctx.setLineDash([]);
      ['ankle', 'knee', 'hip', 'sh', 'elbow', 'hand', 'head'].forEach((k) => { ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(...pt(k), 4.5, 0, Math.PI * 2); ctx.fill(); });
      if (group === 'lower') { // knee angle readout
        const [kx, ky] = pt('knee');
        const a1 = Math.atan2(J.hip[1] - J.knee[1], J.hip[0] - J.knee[0]), a2 = Math.atan2(J.ankle[1] - J.knee[1], J.ankle[0] - J.knee[0]);
        const deg = Math.round(Math.abs(((a1 - a2) * 180) / Math.PI) % 360);
        ctx.font = '600 12px Rubik, sans-serif'; ctx.fillStyle = accent; ctx.fillText(Math.min(deg, 360 - deg) + '°', kx + 12, ky + 4);
      }
      // bar path trace
      if (live) { ctx.strokeStyle = 'rgba(94,230,160,.35)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx, floor - 240 * s); ctx.lineTo(bx, floor - 60 * s); ctx.stroke(); }
    }

    // ---- Set feedback (phone camera only): Claude reads your last set from Phone Cam's
    //      motion log. Asked through the embedded Phone Cam page, which answers by message.
    let feedbackId = 0, feedbackTimer;
    function requestFeedback() {
      const frame = $('#phoneFeed', el);
      if (!frame?.contentWindow) return showFeedback({ ok: false, error: 'Connect your phone first.' });
      const id = ++feedbackId;
      $('#fbBtn', el).disabled = true;
      $('#fbText', el).innerHTML = '<p class="small muted">Claude is reading your last set… (about 10–30 seconds)</p>';
      frame.contentWindow.postMessage({ type: 'phone-cam-feedback-request', id }, phoneCamOrigin);
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => showFeedback({ id, ok: false, error: 'No answer from Phone Cam. Try again.' }), 170_000);
    }
    function showFeedback(data) {
      if (data.id != null && data.id !== feedbackId) return;      // an older request
      clearTimeout(feedbackTimer);
      const box = $('#fbText', el), btn = $('#fbBtn', el);
      if (!box || !btn) return;
      btn.disabled = false;
      btn.textContent = 'Get feedback again';
      if (!data.ok) { box.innerHTML = `<p class="small fb-error">${esc(data.error || 'Something went wrong.')}</p>`; return; }
      // Plain text from Claude: "- " lines become a list, other lines paragraphs.
      const lines = String(data.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let html = '', list = [];
      const flush = () => { if (list.length) { html += `<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`; list = []; } };
      for (const l of lines) {
        if (/^[-•*]\s+/.test(l)) list.push(l.replace(/^[-•*]\s+/, ''));
        else { flush(); html += `<p${/^Exercise:/i.test(l) ? ' class="fb-head"' : ''}>${esc(l.replace(/\*\*/g, ''))}</p>`; }
      }
      flush();
      const set = data.set ? `<p class="small muted">Set of ${data.set.seconds} s · ${data.set.frames} frames</p>` : '';
      const retry = data.published === false ? '<p class="small muted">Saved locally. Use Publish my saved sets on the Leaderboard to try again.</p>' : '';
      box.innerHTML = html + set + retry;
    }

    function destroy() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onPhoneCamStatus);
      clearTimeout(phoneFeedTimer);
      clearTimeout(feedbackTimer);
      $('#phoneFeed', el)?.remove();
      cancelAnimationFrame(raf);
      clearInterval(countdownTimer);
      stopStream();
      status = 'idle';
    }
    return { title: 'Record', render, destroy };
  })();

  /* ---------------- 4b. Results (shown inside the Record tab or from Profile) ---------------- */
  const ResultsView = {
    show(el, r, { onAgain, onBack } = {}) {
      const ex = exById(r.exerciseId);
      const verdict = r.score >= 88 ? 'Excellent set' : r.score >= 80 ? `Solid set · ${r.tips.length} thing${r.tips.length > 1 ? 's' : ''} to fix` : r.score >= 70 ? 'Decent · work on the basics below' : 'Needs work · go lighter and fix the flags';
      const d = new Date(r.date);
      el.innerHTML = `
        <div class="topbar gutter">
          <button class="icon-btn" id="resBack" aria-label="Back">${icon('left')}</button>
          <h1>Form Report</h1>
          <span class="pill neutral">${fmtDate(d)}</span>
        </div>
        <div class="screen-inner gutter">
          <div class="res-grid"><div class="res-col">
          <section class="score-hero">
            ${ring(r.score)}
            <div class="meta">
              <span class="ex">${esc(ex.name)}</span>
              <span class="verdict">${esc(verdict)}</span>
              <span class="sub num">${r.reps.length} reps · ${fmtClock(r.durationSec)} · best rep #${r.reps.slice().sort((a, b) => b.score - a.score)[0].n}</span>
            </div>
            <div class="score-mascot"><img class="head-badge" src="${LOGO_HEAD}" alt="Reveille" width="84" height="84"><span>${r.score >= 80 ? 'Reveille approves!' : 'Reveille says: you got this.'}</span></div>
          </section>

          <section class="card">
            <div class="section-h" style="margin-bottom:12px"><h2>Form breakdown</h2><span class="small muted">out of 100</span></div>
            ${r.metrics.map((m) => `<div class="metric"><span class="name">${esc(m.label)}</span><span class="score num">${m.score}</span><div class="bar"><i class="${band(m.score)}" style="width:${m.score}%"></i></div></div>`).join('')}
          </section>

          ${r.strengths.length ? `<section class="card"><div class="section-h" style="margin-bottom:10px"><h2>What went well</h2></div><div class="strengths">${r.strengths.map((s) => `<span class="pill good">${icon('check', 'width="13" height="13"')} ${esc(s)}</span>`).join('')}</div></section>` : ''}
          </div><div class="res-col">
          <div class="section-h"><h2>What to improve</h2></div>
          ${r.tips.map((t) => `
            <section class="card tip ${band(t.score) === 'bad' ? 'bad' : ''}">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3>${esc(t.title)}</h3><span class="pill ${band(t.score)}">${esc(M.metrics[t.key].label)} ${t.score}</span></div>
              <p>${esc(t.why)}</p>
              <dl><dt>Cue</dt><dd>${esc(t.cue)}</dd><dt>Drill</dt><dd>${esc(t.drill)}</dd></dl>
            </section>`).join('')}

          <section class="card">
            <div class="section-h" style="margin-bottom:6px"><h2>Rep by rep</h2><span class="small muted">down / up seconds</span></div>
            <div class="reps-table">
              ${r.reps.map((rep) => `
                <div class="rep-row">
                  <span class="n num">#${rep.n}</span>
                  <div class="info">
                    <div class="bar"><i class="${band(rep.score)}" style="width:${rep.score}%"></i></div>
                    <div class="detail num"><span>${rep.down}s / ${rep.up}s</span>${rep.flag ? `<span class="flag ${band(rep.score) === 'bad' ? 'bad' : ''}">${esc(rep.flag)}</span>` : '<span class="flag good">Clean rep</span>'}</div>
                  </div>
                  <span class="s num">${rep.score}</span>
                </div>`).join('')}
            </div>
          </section>

          </div></div>
          <div class="res-actions">
            <button class="btn" id="resShare">${icon('trophy')} Post to leaderboard</button>
            <button class="btn primary" id="resAgain">${icon('camera')} Record again</button>
          </div>
          <p class="sample-note">Scores are simulated in this prototype</p>
        </div>`;
      el.scrollTop = 0;
      const back = onBack || onAgain;
      $('#resBack', el).addEventListener('click', back);
      $('#resAgain', el).addEventListener('click', onAgain || (() => go('record')));
      $('#resShare', el).addEventListener('click', (e) => { e.currentTarget.disabled = true; e.currentTarget.innerHTML = `${icon('check')} Posted`; toast('Posted to the leaderboard', `${ex.name} · form score ${r.score}`); });
    },
  };

  /* ---------------- 4c. Stats / Leaderboards ---------------- */
  const StatsScreen = (() => {
    const st = { formPeriod: 'week', consPeriod: 'week', exerciseId: 'squat', formAll: false, consAll: false };
    let el;
    async function render(root) {
      el = root;
      const [s, exercises] = await Promise.all([Api.getAppStats(), Api.getExercises()]);
      const peakMax = Math.max(...s.peakHours.load);
      el.innerHTML = `
        <div class="topbar gutter"><h1>Statistics</h1><span class="pill neutral">${icon('dumbbell', 'width="14" height="14"')} All Aggies</span></div>
        <div class="screen-inner gutter">
          <div class="stats-top">
          <div class="tiles">
            <div class="tile"><span class="k">Active users</span><span class="v num">${s.activeUsers.toLocaleString()}</span><span class="d">▲ ${s.activeUsersDelta}% wk</span></div>
            <div class="tile"><span class="k">Sessions this week</span><span class="v num">${s.sessionsThisWeek.toLocaleString()}</span><span class="d">▲ ${s.sessionsDelta}%</span></div>
            <div class="tile"><span class="k">Avg form score</span><span class="v num">${s.avgFormScore}</span><span class="d">▲ ${s.avgFormDelta} pts</span></div>
          </div>
          <section class="card peak">
            <div class="section-h"><h2>Busy times · ${esc(s.peakHours.gym)}</h2><span class="small muted">today</span></div>
            <div class="bars">${s.peakHours.load.map((v) => `<i class="${v === peakMax ? 'hot' : ''}" style="height:${Math.max(6, (v / peakMax) * 100)}%" title="${v}% busy"></i>`).join('')}</div>
            <div class="lbls">${s.peakHours.hours.map((hr) => `<span>${hr}</span>`).join('')}</div>
          </section>

          </div>
          <div class="lb-sets">
            <section class="lb-set" id="setForm" aria-label="Form score leaderboard">
              <div class="lb-set-h"><h2>Form score leaderboard</h2><p>Who has the cleanest technique on each lift</p></div>
              <div class="seg" role="group" aria-label="Form score time period">${periodButtons('form', st.formPeriod)}</div>
              <div class="chips" id="lbEx" role="group" aria-label="Exercise">
                ${exercises.map((e) => `<button class="chip" data-ex="${e.id}" aria-pressed="${e.id === st.exerciseId}">${esc(e.short)}</button>`).join('')}
              </div>
              <div id="lbForm"></div>
            </section>
            <section class="lb-set" id="setCons" aria-label="Consistency leaderboard">
              <div class="lb-set-h"><h2>Consistency leaderboard</h2><p>Points for every day you show up, and more the longer you keep going</p></div>
              <div class="seg" role="group" aria-label="Consistency time period">${periodButtons('cons', st.consPeriod)}</div>
              <div id="lbCons"></div>
            </section>
          </div>
          <p class="sample-note">Sample leaderboard data</p>
        </div>`;
      el.querySelector('.screen-inner').addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.period) {
          const set = b.dataset.set; st[set + 'Period'] = b.dataset.period; st[set + 'All'] = false;
          b.closest('.seg').querySelectorAll('[data-period]').forEach((x) => x.setAttribute('aria-pressed', x === b));
          set === 'form' ? renderForm() : renderCons();
        } else if (b.dataset.ex) {
          st.exerciseId = b.dataset.ex; st.formAll = false;
          el.querySelectorAll('#lbEx [data-ex]').forEach((x) => x.setAttribute('aria-pressed', x === b));
          renderForm();
        } else if (b.dataset.all) {
          const set = b.dataset.all; st[set + 'All'] = !st[set + 'All'];
          set === 'form' ? renderForm() : renderCons();
        }
      });
      renderForm(); renderCons();
    }
    const periodButtons = (set, current) => [['week', 'This week'], ['month', 'This month'], ['all', 'All time']].map(([k, l]) => `<button data-set="${set}" data-period="${k}" aria-pressed="${current === k}">${l}</button>`).join('');

    /** Top 10 (or everyone), always including your own row, plus a Show all / Show top 10 button. */
    function boardRows(entries, showAll, rowHtml, set) {
      const top = showAll ? entries : entries.slice(0, 10);
      const me = entries.find((x) => x.isMe);
      const extra = !showAll && me && me.rank > 10 ? `<div class="lb-gap" aria-hidden="true">\u00b7 \u00b7 \u00b7</div>${rowHtml(me)}` : '';
      const toggle = entries.length > 10 ? `<button class="lb-more" data-all="${set}" type="button">${showAll ? 'Show top 10' : `Show all ${entries.length}`}</button>` : '';
      return `<div class="card board">${top.map(rowHtml).join('')}${extra}</div>${toggle}`;
    }
    async function renderForm() {
      const { entries, me, total } = await Api.getFormLeaderboard(st.exerciseId, st.formPeriod);
      const top10 = entries[9]?.score ?? 0;
      const gap = me.rank <= 10 ? 'You\u2019re in the top 10' : `${top10 - me.score + 1} pts to the top 10`;
      const row = (e) => `
        <div class="lb-row ${e.isMe ? 'me' : ''}">
          <span class="rk num ${e.rank <= 3 ? 'g' + e.rank : ''}">${e.rank}</span>
          <span class="avatar ${e.isMe ? 'me' : ''}">${esc(e.user.initials)}</span>
          <div class="who"><b>${esc(e.user.name)}</b><span>Class of ${esc(e.user.classYear)} \u00b7 ${esc(e.user.major)}</span></div>
          <div class="score num">${e.score}<small>${e.change > 0 ? `<span class="up">\u25b2${e.change}</span>` : e.change < 0 ? `<span class="down">\u25bc${-e.change}</span>` : '\u2013'} \u00b7 ${e.reps} reps</small></div>
        </div>`;
      $('#lbForm', el).innerHTML = `
        <div class="my-rank">
          <span class="rk num">#${me.rank}</span>
          <div class="txt"><b>Your rank \u00b7 ${esc(exById(st.exerciseId).name)}</b>${total.toLocaleString()} lifters \u00b7 ${gap}</div>
          <div class="val num">${me.score}<small>Form score</small></div>
        </div>
        ${boardRows(entries, st.formAll, row, 'form')}`;
    }
    async function renderCons() {
      const { entries, me, total, rule } = await Api.getConsistencyLeaderboard(st.consPeriod);
      const worth = (n) => Math.min(rule.max, rule.start + rule.step * (n - 1));
      const ladderDays = []; for (let n = 1; worth(n) < rule.max; n++) ladderDays.push(n); ladderDays.push(ladderDays.length + 1);
      const nowStep = Math.min(me.streak + 1, ladderDays.length);
      const ladder = `
        <div class="card ladder">
          <div class="ladder-steps" role="list" aria-label="Points per day of a streak">
            ${ladderDays.map((n, i) => `<div class="step ${n === nowStep ? 'now' : ''}" role="listitem"><b class="num">+${worth(n)}</b><span>Day ${n}${i === ladderDays.length - 1 ? '+' : ''}</span></div>`).join('')}
          </div>
          <p class="small muted">Every day in a row is worth more, up to ${rule.max} points a day. Miss a day and the streak ends, so you start again at ${rule.start} point.</p>
        </div>`;
      const row = (e) => `
        <div class="lb-row ${e.isMe ? 'me' : ''}">
          <span class="rk num ${e.rank <= 3 ? 'g' + e.rank : ''}">${e.rank}</span>
          <span class="avatar ${e.isMe ? 'me' : ''}">${esc(e.user.initials)}</span>
          <div class="who"><b>${esc(e.user.name)}</b><span><span class="flame">${icon('flame', 'width="13" height="13" style="vertical-align:-2px"')}</span> ${e.streak}-day streak \u00b7 +${e.nextDayPoints} next</span></div>
          <div class="score num">${e.points.toLocaleString()}<small>points</small></div>
        </div>`;
      $('#lbCons', el).innerHTML = `
        ${ladder}
        <div class="my-rank">
          <span class="rk num">#${me.rank}</span>
          <div class="txt"><b>Your rank \u00b7 Consistency</b>${total.toLocaleString()} Aggies \u00b7 ${me.streak}-day streak \u00b7 next gym day +${me.nextDayPoints}</div>
          <div class="val num">${me.points.toLocaleString()}<small>Points</small></div>
        </div>
        ${boardRows(entries, st.consAll, row, 'cons')}`;
    }
    return { title: 'Statistics', render };
  })();

  /* ---------------- 4d. Calendar / Planner ---------------- */
  const PlanScreen = (() => {
    let el, weekOffset = 0, selectedDay = null;
    async function render(root) {
      el = root;
      const start = addDays(weekStart(new Date()), weekOffset * 7), end = addDays(start, 6);
      const [sessions, goal] = await Promise.all([Api.listSessions(isoDate(start), isoDate(end)), Api.getWeeklyGoal()]);
      const todayIso = isoDate(new Date());
      const done = sessions.filter((s) => s.done).length;
      const planned = sessions.length;
      const minutes = sessions.reduce((a, s) => a + Number(s.duration || 0), 0);
      const pct = Math.min(1, done / goal);
      const r = 30, c = 2 * Math.PI * r;
      const weekLabel = weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week' : (weekOffset > 0 ? `In ${weekOffset} weeks` : `${-weekOffset} weeks ago`);
      const goalMsg = done >= goal ? 'Goal reached. Nice work.' : planned >= goal ? `${goal - done} more to go. You’ve planned enough to hit it.` : `Plan ${goal - planned} more session${goal - planned > 1 ? 's' : ''} to reach your goal.`;

      el.innerHTML = `
        <div class="topbar gutter"><h1>Planner</h1><button class="icon-btn brand" id="addBtn" aria-label="Add session">${icon('plus')}</button></div>
        <div class="screen-inner gutter">
          <div class="plan-head"><div class="plan-nav">
          <div class="week-nav">
            <button class="icon-btn" data-week="-1" aria-label="Previous week">${icon('left')}</button>
            <div class="label">${weekLabel}<small>${fmtDate(start)} – ${fmtDate(end)}</small></div>
            <button class="icon-btn" data-week="1" aria-label="Next week">${icon('right')}</button>
          </div>
          <div class="daystrip" role="group" aria-label="Jump to a day">
            ${DOW.map((d, i) => {
              const dd = addDays(start, i), iso = isoDate(dd); const n = sessions.filter((s) => s.date === iso);
              return `<button class="day ${iso === todayIso ? 'today' : ''}" data-day="${iso}" aria-pressed="${selectedDay === iso}" aria-label="${DOW_LONG[i]} ${fmtDate(dd)}, ${n.length} session${n.length === 1 ? '' : 's'}"><span class="dn">${d.slice(0, 2)}</span><span class="dd num">${dd.getDate()}</span><span class="dots">${n.slice(0, 3).map((s) => `<i class="${s.done ? 'done' : ''}"></i>`).join('')}</span></button>`;
            }).join('')}
          </div>
          </div>
          <section class="card goal">
            <div class="gring"><svg viewBox="0 0 70 70"><circle cx="35" cy="35" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="8"/><circle cx="35" cy="35" r="${r}" fill="none" stroke="${done >= goal ? 'var(--good)' : 'var(--accent)'}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/></svg><span class="val num">${done}/${goal}</span></div>
            <div>
              <h3>Weekly goal</h3>
              <div class="small muted num">${done} done · ${planned} planned · ${Math.round(minutes / 60 * 10) / 10} hrs</div>
              <div class="small">${goalMsg}</div>
              <div class="stepper"><button data-goal="-1" aria-label="Lower goal">−</button><span class="num">${goal} / week</span><button data-goal="1" aria-label="Raise goal">+</button></div>
            </div>
          </section>
          </div>

          <div class="week-cols">${DOW.map((d, i) => {
            const day = addDays(start, i), iso = isoDate(day);
            const list = sessions.filter((s) => s.date === iso);
            return `<div class="day-group ${iso === todayIso ? 'is-today' : ''}" id="g-${iso}">
              <h3>${DOW_LONG[i]} <span class="muted">${fmtDate(day)}${iso === todayIso ? ' · Today' : ''}</span></h3>
              <div class="day-items">${list.length ? list.map(sessionCard).join('') : `<button class="rest" data-add="${iso}"><span>Rest day</span><b>+ Add session</b></button>`}</div>
            </div>`;
          }).join('')}</div>
          <p class="sample-note">Edits are saved in this browser only</p>
        </div>`;

      el.querySelector('.topbar').addEventListener('click', (e) => { if (e.target.closest('#addBtn')) editSession(null, selectedDay || defaultDay(start)); });
      el.querySelector('.screen-inner').addEventListener('click', async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.week) { weekOffset += Number(b.dataset.week); selectedDay = null; render(el); }
        else if (b.dataset.day) { selectedDay = selectedDay === b.dataset.day ? null : b.dataset.day; el.querySelectorAll('[data-day]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.day === selectedDay)); if (selectedDay) jumpTo(selectedDay); }
        else if (b.dataset.goal) { await Api.setWeeklyGoal(goal + Number(b.dataset.goal)); render(el); }
        else if (b.dataset.add) editSession(null, b.dataset.add);
        else if (b.dataset.done) { const on = b.getAttribute('aria-pressed') !== 'true'; await Api.setSessionDone(b.dataset.done, on); if (on) toast('Session logged', 'Your streak is safe for today.'); render(el); }
        else if (b.dataset.edit) { const s = sessions.find((x) => x.id === b.dataset.edit); editSession(s); }
      });
    }
    function defaultDay(start) { const t = isoDate(new Date()); const end = isoDate(addDays(start, 6)); return t >= isoDate(start) && t <= end ? t : isoDate(start); }
    function jumpTo(iso) {
      const g = $('#g-' + iso, el); if (!g) return;
      g.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      g.classList.add('flash'); setTimeout(() => g.classList.remove('flash'), 1100);
    }
    function sessionCard(s) {
      const f = focusById(s.focus), loc = locById(s.location);
      return `<div class="session ${s.done ? 'is-done' : ''}">
        <span class="stripe ${f.color}"></span>
        <button class="body" data-edit="${s.id}" style="border:0;background:none;padding:0;text-align:left" aria-label="Edit ${esc(f.name)} session">
          <span class="t"><span class="num">${fmtTime(s.time)}</span><span class="focus-tag ${f.color}">${esc(f.name)}</span></span>
          <span class="meta"><span>${icon('pin')}${esc(loc.name)}</span><span>${icon('clock')}${s.duration} min</span></span>
          ${s.notes ? `<span class="notes">${esc(s.notes)}</span>` : ''}
        </button>
        <button class="check" data-done="${s.id}" aria-pressed="${!!s.done}" aria-label="${s.done ? 'Mark not done' : 'Mark done'}">${icon('check')}</button>
      </div>`;
    }
    function editSession(s, dayIso) {
      const isNew = !s;
      const start = addDays(weekStart(new Date()), weekOffset * 7);
      const v = s || { date: dayIso, time: '17:00', duration: 60, location: M.currentUser.homeGym, focus: 'legs', notes: '' };
      const days = DOW.map((d, i) => { const dd = addDays(start, i); return { iso: isoDate(dd), label: `${DOW_LONG[i]}, ${fmtDate(dd)}` }; });
      if (!days.some((d) => d.iso === v.date)) days.unshift({ iso: v.date, label: fmtDate(parseIso(v.date)) });
      openSheet(`
        <h2>${isNew ? 'Plan a session' : 'Edit session'}</h2>
        <form id="sessForm" class="gutter" style="display:grid;gap:14px;padding:0">
          <div class="field"><label for="fDay">Day</label><select id="fDay">${days.map((d) => `<option value="${d.iso}" ${d.iso === v.date ? 'selected' : ''}>${d.label}</option>`).join('')}</select></div>
          <div class="row2">
            <div class="field"><label for="fTime">Start time</label><input id="fTime" type="time" value="${v.time}" required></div>
            <div class="field"><label for="fDur">Length</label><select id="fDur">${[30, 45, 60, 75, 90, 120].map((m) => `<option value="${m}" ${Number(v.duration) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></div>
          </div>
          <div class="field"><label for="fLoc">Gym</label><select id="fLoc">${M.locations.map((l) => `<option value="${l.id}" ${l.id === v.location ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
          <div class="field"><span class="lbl" id="fFocusLbl">Workout</span><div class="chip-grid" role="group" aria-labelledby="fFocusLbl" id="fFocus">${M.focuses.map((f) => `<button type="button" class="chip" data-focus="${f.id}" aria-pressed="${f.id === v.focus}">${esc(f.name)}</button>`).join('')}</div></div>
          <div class="field"><label for="fNotes">Notes</label><textarea id="fNotes" placeholder="e.g. Squat 5×5, film the last set">${esc(v.notes)}</textarea></div>
          <div class="sheet-actions">
            ${isNew ? '<button type="button" class="btn" id="fCancel">Cancel</button>' : '<button type="button" class="btn danger" id="fDelete">Delete</button>'}
            <button type="submit" class="btn primary">${isNew ? 'Add to plan' : 'Save changes'}</button>
          </div>
        </form>`, (sheet) => {
        let focus = v.focus;
        sheet.querySelector('#fFocus').addEventListener('click', (e) => { const b = e.target.closest('[data-focus]'); if (!b) return; focus = b.dataset.focus; sheet.querySelectorAll('[data-focus]').forEach((x) => x.setAttribute('aria-pressed', x === b)); });
        sheet.querySelector('#fCancel')?.addEventListener('click', closeSheet);
        const del = sheet.querySelector('#fDelete');
        del?.addEventListener('click', async () => {
          if (!del.classList.contains('confirm')) { del.classList.add('confirm'); del.textContent = 'Click again to delete'; return; }
          await Api.deleteSession(s.id); closeSheet(); toast('Session deleted'); render(el);
        });
        sheet.querySelector('#sessForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const out = { ...(s || {}), date: sheet.querySelector('#fDay').value, time: sheet.querySelector('#fTime').value || '17:00', duration: Number(sheet.querySelector('#fDur').value), location: sheet.querySelector('#fLoc').value, focus, notes: sheet.querySelector('#fNotes').value.trim() };
          await Api.saveSession(out); closeSheet();
          const settings = await Api.getNotificationSettings();
          toast(isNew ? 'Session added' : 'Session updated', settings.sessionReminders ? `Reminder set for ${settings.reminderLeadMinutes} min before ${fmtTime(out.time)}.` : '');
          render(el);
        });
      });
    }
    return { title: 'Plan', render };
  })();

  /* ---------------- 4e. Notifications ---------------- */
  const AlertsScreen = (() => {
    let el, filter = 'all', view = 'inbox';
    const TYPE = { reminder: { icon: 'calendar', name: 'Reminders' }, streak: { icon: 'flame', name: 'Streaks' }, leaderboard: { icon: 'trophy', name: 'Leaderboard' }, pr: { icon: 'up', name: 'Personal best' }, recap: { icon: 'chart', name: 'Recap' }, test: { icon: 'bell', name: 'Test' } };
    const LINK_LABEL = { plan: 'Open planner', stats: 'View leaderboard', profile: 'View profile' };

    async function render(root) {
      el = root;
      el.innerHTML = `
        <div class="topbar gutter"><h1>Alerts</h1><button class="link small" id="markAll" style="background:none;border:0;color:var(--accent);font-weight:600">Mark all read</button></div>
        <div class="screen-inner gutter">
          <div class="seg al-seg" role="group" aria-label="View"><button data-view="inbox" aria-pressed="${view === 'inbox'}">Inbox</button><button data-view="settings" aria-pressed="${view === 'settings'}">Reminder settings</button></div>
          <div class="al-cols" data-show="${view}">
            <div class="al-pane" data-pane="inbox" id="alInbox"></div>
            <div class="al-pane" data-pane="settings" id="alSettings"></div>
          </div>
        </div>`;
      $('#markAll', el).addEventListener('click', async () => { await Api.markAllNotificationsRead(); refreshBadge(); renderInbox(); });
      el.querySelector('.al-seg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-view]'); if (!b) return;
        view = b.dataset.view; $('.al-cols', el).dataset.show = view;
        el.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', x === b));
        el.scrollTop = 0;
      });
      renderInbox(); renderSettings();
    }

    async function upcomingReminders() {
      const settings = await Api.getNotificationSettings();
      const now = new Date();
      const list = await Api.listSessions(isoDate(now), isoDate(addDays(now, 7)));
      return { settings, items: list.filter((s) => !s.done && new Date(`${s.date}T${s.time}`) > now).slice(0, 3) };
    }

    async function renderInbox() {
      const [all, up] = await Promise.all([Api.listNotifications(), upcomingReminders()]);
      const items = all.filter((n) => filter === 'all' || n.type === filter || (filter === 'leaderboard' && n.type === 'pr'));
      const groups = [['Today', (n) => Date.now() - new Date(n.time) < 86400000], ['This week', (n) => Date.now() - new Date(n.time) < 7 * 86400000], ['Earlier', () => true]];
      const used = new Set();
      const html = groups.map(([label, test]) => {
        const g = items.filter((n) => !used.has(n.id) && test(n)); g.forEach((n) => used.add(n.id));
        return g.length ? `<div class="al-group"><div class="section-h"><h2>${label}</h2></div><div class="card list-card">${g.map(notifRow).join('')}</div></div>` : '';
      }).join('');
      $('#alInbox', el).innerHTML = `
        <div class="al-stack">
          ${up.settings.sessionReminders && up.items.length ? `
            <section class="card upcoming">
              <div class="section-h"><h2>Next up</h2><span class="small muted">Reminder ${up.settings.reminderLeadMinutes} min before</span></div>
              ${up.items.map((s) => { const d = parseIso(s.date); const f = focusById(s.focus); const rem = new Date(new Date(`${s.date}T${s.time}`).getTime() - up.settings.reminderLeadMinutes * 60000);
                return `<div class="up-row"><div class="when-box num"><small>${s.date === isoDate(new Date()) ? 'Today' : DOW[(d.getDay() + 6) % 7]}</small>${fmtTime(s.time).replace(' ', '<small>')}</small></div><div class="tx"><b>${esc(f.name)} session</b><span class="muted">${esc(locById(s.location).name)} \u00b7 reminder at ${fmtTime(`${rem.getHours()}:${String(rem.getMinutes()).padStart(2, '0')}`)}</span></div></div>`; }).join('')}
            </section>` : ''}
          <div class="chips" role="group" aria-label="Filter">${[['all', 'All'], ['reminder', 'Reminders'], ['streak', 'Streaks'], ['leaderboard', 'Leaderboard']].map(([k, l]) => `<button class="chip" data-filter="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>
          ${html || '<div class="card muted small" style="text-align:center">Nothing here yet.</div>'}
          <p class="sample-note">Sample notifications</p>
        </div>`;
      $('#alInbox', el).onclick = async (e) => {
        const f = e.target.closest('[data-filter]'); if (f) { filter = f.dataset.filter; renderInbox(); return; }
        const n = e.target.closest('[data-notif]'); if (!n) return;
        await Api.markNotificationRead(n.dataset.notif); refreshBadge();
        if (n.dataset.link) go(n.dataset.link); else renderInbox();
      };
    }
    function notifRow(n) {
      const t = TYPE[n.type] || TYPE.test;
      return `<button class="notif ${n.read ? 'read' : ''}" data-notif="${n.id}" data-link="${n.link || ''}">
        <span class="ic ${n.type}">${icon(t.icon)}</span>
        <span class="tx"><b>${esc(n.title)}</b><span>${esc(n.body)}</span>${n.link ? `<em>${LINK_LABEL[n.link]} \u2192</em>` : ''}</span>
        <span class="when num">${n.read ? '' : '<i class="sr-only">Unread. </i>'}${timeAgo(n.time)}</span>
      </button>`;
    }

    async function renderSettings() {
      const s = await Api.getNotificationSettings();
      const perm = 'Notification' in window ? Notification.permission : 'unsupported';
      const sw = (id, on, label) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} aria-label="${label}"><span></span></label>`;
      const permText = perm === 'unsupported' ? 'This browser doesn’t support notifications.' : perm === 'denied' ? 'Blocked by the browser. Reminders still show here in the app.' : perm === 'granted' ? 'Allowed. Reminders also pop up outside the app.' : 'Off by default. Turning it on asks your browser for permission.';
      $('#alSettings', el).innerHTML = `
        <div class="al-stack">
          <div class="al-group"><div class="section-h"><h2>Reminders</h2></div>
            <section class="card set-card">
              <div class="set-row"><div class="tx"><b>Session reminders</b><span>Before each session in your planner</span></div>${sw('sSession', s.sessionReminders, 'Session reminders')}</div>
              <div class="sub-row" ${s.sessionReminders ? '' : 'hidden'}><span>Remind me</span><select id="sLead">${[15, 30, 60, 120].map((m) => `<option value="${m}" ${s.reminderLeadMinutes === m ? 'selected' : ''}>${m < 60 ? m + ' min' : m / 60 + ' hr'} before</option>`).join('')}</select></div>
              <div class="set-row"><div class="tx"><b>Daily nudge</b><span>When nothing is planned that day</span></div>${sw('sNudge', s.dailyNudge, 'Daily nudge')}</div>
              <div class="sub-row" ${s.dailyNudge ? '' : 'hidden'}><span>Nudge me at</span><input type="time" id="sNudgeTime" value="${s.dailyNudgeTime}"></div>
              <div class="set-row"><div class="tx"><b>Streak warnings</b><span>If you haven\u2019t logged a session yet</span></div>${sw('sStreak', s.streakWarnings, 'Streak warnings')}</div>
              <div class="sub-row" ${s.streakWarnings ? '' : 'hidden'}><span>Warn me at</span><input type="time" id="sStreakTime" value="${s.streakWarningTime}"></div>
            </section>
          </div>
          <div class="al-group"><div class="section-h"><h2>Updates</h2></div>
            <section class="card set-card">
              <div class="set-row"><div class="tx"><b>Leaderboard changes</b><span>When you move up or get passed</span></div>${sw('sLb', s.leaderboardAlerts, 'Leaderboard changes')}</div>
              <div class="set-row"><div class="tx"><b>Weekly recap</b><span>A summary every Sunday evening</span></div>${sw('sRecap', s.weeklyRecap, 'Weekly recap')}</div>
            </section>
          </div>
          <div class="al-group"><div class="section-h"><h2>Quiet hours</h2></div>
            <section class="card set-card">
              <p class="set-note">No reminders between these times.</p>
              <div class="row2"><div class="field"><label for="sQs">From</label><input type="time" id="sQs" value="${s.quietStart}"></div><div class="field"><label for="sQe">Until</label><input type="time" id="sQe" value="${s.quietEnd}"></div></div>
            </section>
          </div>
          <div class="al-group"><div class="section-h"><h2>Outside the app</h2></div>
            <section class="card set-card">
              <div class="set-row"><div class="tx"><b>Browser notifications</b><span id="permText">${permText}</span></div>${sw('sBrowser', s.browserNotifications && perm === 'granted', 'Browser notifications')}</div>
              <button class="btn block" id="testBtn" type="button" style="margin-bottom:14px">${icon('send')} Send a test reminder</button>
            </section>
          </div>
          <p class="sample-note">Settings are saved in this browser only</p>
        </div>`;

      const body = $('#alSettings', el);
      const map = { sSession: 'sessionReminders', sNudge: 'dailyNudge', sStreak: 'streakWarnings', sLb: 'leaderboardAlerts', sRecap: 'weeklyRecap', sLead: 'reminderLeadMinutes', sNudgeTime: 'dailyNudgeTime', sStreakTime: 'streakWarningTime', sQs: 'quietStart', sQe: 'quietEnd' };
      body.onchange = async (e) => {
        const t = e.target;
        if (t.id === 'sBrowser') return toggleBrowser(t);
        const key = map[t.id]; if (!key) return;
        const val = t.type === 'checkbox' ? t.checked : t.id === 'sLead' ? Number(t.value) : t.value;
        await Api.saveNotificationSettings({ [key]: val });
        if (t.type === 'checkbox') { const sub = t.closest('.set-row').nextElementSibling; if (sub?.classList.contains('sub-row')) sub.hidden = !t.checked; }
        toast('Saved'); renderInbox();
      };
      body.onclick = async (e) => {
        if (!e.target.closest('#testBtn')) return;
        const next = (await upcomingReminders()).items[0];
        const title = next ? `${focusById(next.focus).name} day at ${fmtTime(next.time)} at ${locById(next.location).short}` : 'Time to hit the gym';
        const msg = next ? `Starts in ${(await Api.getNotificationSettings()).reminderLeadMinutes} minutes. Bring your lifting belt.` : 'Nothing planned today. A 45-minute session keeps your streak alive.';
        await Api.addNotification({ type: 'reminder', title, body: msg, link: 'plan' });
        refreshBadge(); renderInbox();
        const st = await Api.getNotificationSettings();
        if (st.browserNotifications && 'Notification' in window && Notification.permission === 'granted') {
          try { new Notification('RevGym · ' + title, { body: msg }); } catch (err) { /* some browsers need a service worker */ }
        }
        toast(title, msg + ' (Added to your inbox.)');
      };
    }
    async function toggleBrowser(input) {
      if (!input.checked) { await Api.saveNotificationSettings({ browserNotifications: false }); toast('Browser notifications off'); return; }
      if (!('Notification' in window)) { input.checked = false; toast('Not supported', 'This browser doesn’t support notifications.'); return; }
      let perm = Notification.permission;
      if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; } }
      if (perm !== 'granted') { input.checked = false; $('#permText', el).textContent = 'Your browser didn’t allow notifications here. Reminders still show in the app.'; toast('Notifications not allowed', 'Reminders will still appear in your inbox.'); return; }
      await Api.saveNotificationSettings({ browserNotifications: true });
      $('#permText', el).textContent = 'Allowed. Reminders also pop up outside the app.';
      toast('Browser notifications on');
    }
    return { title: 'Alerts', render };
  })();

  /* ---------------- 4f. Profile ---------------- */
  const ProfileScreen = (() => {
    let el, trendKey = 'all';
    async function render(root) {
      el = root;
      const [u, hist, trained] = await Promise.all([Api.getCurrentUser(), Api.getHistory(), Api.getTrainedDays()]);
      const joined = new Date(u.joined + 'T12:00:00');
      // Heatmap: last 5 full weeks ending this Sunday.
      const ws = weekStart(new Date()); const first = addDays(ws, -28); const today = new Date(); today.setHours(0, 0, 0, 0);
      const cells = []; for (let i = 0; i < 35; i++) { const d = addDays(first, i); const ago = Math.round((today - d) / 86400000); cells.push(`<i class="${trained.includes(ago) ? 'on' : ''} ${ago === 0 ? 'today' : ''}" title="${fmtDate(d)}"></i>`); }

      el.innerHTML = `
        <section class="p-hero gutter">
          <div class="who"><span class="avatar">${esc(u.initials)}</span><div><h2>${esc(u.name)}</h2><span>Class of ${esc(u.classYear)} · ${esc(u.major)}<br>Member since ${MON[joined.getMonth()]} ${joined.getFullYear()}</span></div></div>
          <div class="p-stats num">
            <div><b>${u.streakDays}</b><span>Day streak</span></div>
            <div><b>${u.longestStreak}</b><span>Longest</span></div>
            <div><b>${u.totalSessions}</b><span>Sessions</span></div>
            <div><b>${u.avgFormScore}</b><span>Avg form</span></div>
          </div>
        </section>
        <div class="screen-inner gutter" style="padding-top:20px">
          <div class="prof-grid"><div class="prof-col">
          <section class="card" style="display:grid;gap:8px">
            <div class="section-h"><h2>Last 5 weeks</h2><span class="small muted">${trained.filter((d) => d < 35).length} gym days</span></div>
            <div class="heat-lbl">${DOW.map((d) => `<span>${d[0]}</span>`).join('')}</div>
            <div class="heat">${cells.join('')}</div>
          </section>

          <section class="card chart" style="display:grid;gap:10px">
            <div class="section-h"><h2>Form score trend</h2><span class="small muted">weekly average</span></div>
            <div class="chips" role="group" aria-label="Exercise">${[['all', 'All lifts'], ['squat', 'Squat'], ['bench', 'Bench'], ['deadlift', 'Deadlift'], ['pullup', 'Pull-up']].map(([k, l]) => `<button class="chip" data-trend="${k}" aria-pressed="${trendKey === k}">${l}</button>`).join('')}</div>
            <div id="trend"></div>
          </section>
          </div><div class="prof-col">

          <section class="card">
            <div class="section-h" style="margin-bottom:4px"><h2>Recent form checks</h2><button class="link" id="newRec">+ Record</button></div>
            ${hist.map((h) => `<button class="h-row" data-hist="${h.id}" data-result="${h.resultId || ''}"><div><b>${esc(exById(h.exercise).name)}</b><span>${relDay(h.date)} · ${h.reps} reps</span></div><span class="small muted">Report ›</span><span class="score-badge ${band(h.score)} num">${h.score}</span></button>`).join('')}
          </section>
          </div></div>
          <p class="sample-note">Sample profile · RevGym prototype</p>
          ${phoneCamOrigin ? '<a class="btn" href="/ui/logout">Sign out</a>' : ''}
        </div>`;
      drawTrend();
      el.querySelector('.screen-inner').addEventListener('click', async (e) => {
        const t = e.target.closest('[data-trend]'); if (t) { trendKey = t.dataset.trend; el.querySelectorAll('[data-trend]').forEach((x) => x.setAttribute('aria-pressed', x === t)); drawTrend(); return; }
        if (e.target.closest('#newRec')) { go('record'); return; }
        const h = e.target.closest('[data-hist]'); if (!h) return;
        let result = h.dataset.result ? await Api.getResult(h.dataset.result) : null;
        if (!result) { // older sessions: rebuild a report from the stored score (a real API would return the saved report)
          const item = hist.find((x) => x.id === h.dataset.hist);
          result = await Api.analyzeRecording({ exerciseId: item.exercise, durationSec: item.reps * 3 + 4, repCount: item.reps, seed: [...item.id].reduce((a, c) => a + c.charCodeAt(0), 7) });
          result.date = item.date; result.score = item.score;
        }
        ResultsView.show(el, result, { onAgain: () => go('record'), onBack: () => render(el) });
      });
    }
    async function drawTrend() {
      const vals = await Api.getFormTrend(trendKey);
      const labels = vals.map((_, i) => { const d = addDays(weekStart(new Date()), -(vals.length - 1 - i) * 7); return fmtDate(d); });
      const delta = vals[vals.length - 1] - vals[0];
      $('#trend', el).innerHTML = lineChart(vals, labels) + `<div class="small muted" style="margin-top:4px">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} points over 12 weeks</div>`;
    }
    return { title: 'Me', render };
  })();

  /* =================================================================
     5. SHELL: tab bar + hash router
     ================================================================= */
  // Phone Cam serves the reports and sends their height to the RevGym shell.
  function reportScreen(title, path, heightMessage) {
    let el, onMsg;
    function render(root) {
      el = root;
      const th = document.documentElement.getAttribute('data-theme')
        || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      el.innerHTML = `<div class="screen-inner"><iframe id="reportFrame" title="${title}" referrerpolicy="origin"
        src="${phoneCamOrigin}/${path}?theme=${th}" style="display:block;width:100%;height:80vh;border:0"></iframe></div>`;
      onMsg = (e) => {
        const f = $('#reportFrame', el);
        if (!f || e.source !== f.contentWindow || e.origin !== phoneCamOrigin) return;
        if (e.data?.type === heightMessage) f.style.height = `${Math.max(420, Number(e.data.h) || 0)}px`;
      };
      window.addEventListener('message', onMsg);
    }
    function destroy() { window.removeEventListener('message', onMsg); }
    return { title, render, destroy };
  }
  const PersonStatsScreen = reportScreen('Personal Statistics', 'person-stats', 'person-stats-height');
  const LeaderboardScreen = reportScreen('Leaderboard', 'leaderboard-view', 'workout-report-height');
  const DataScreen = reportScreen('Data', 'data-view', 'workout-report-height');

  // Settings: set the judge number back to 0 (the next Guest Log In becomes Judge1).
  const JudgeSettingsScreen = {
    title: 'Settings',
    render(root) {
      root.innerHTML = `<div class="screen-inner"><div class="topbar gutter"><h1>Settings</h1></div>
        <section class="card" style="display:grid;gap:12px;max-width:560px">
          <h2 style="margin:0">Guest judges</h2>
          <p class="small muted" style="margin:0">Each press of Guest Log In on the welcome page is the next judge: Judge1, Judge2, Judge3, and so on. Reset sets the count back to 0, so the next press is Judge1 again. No data is deleted.</p>
          <button class="btn" id="judgeReset" type="button">Reset judge number to 0</button>
          <p class="small muted" id="judgeMsg" role="status" style="margin:0"></p>
        </section></div>`;
      $('#judgeReset', root).addEventListener('click', async (e) => {
        if (!confirm('Reset the judge number to 0? The next Guest Log In will be Judge1 again.')) return;
        const msg = $('#judgeMsg', root);
        e.currentTarget.disabled = true;
        try {
          const res = await fetch('/auth/guest/reset', { method: 'POST' });
          msg.textContent = res.ok ? 'Done. The next Guest Log In is Judge1.' : 'Could not reset. Try again.';
        } catch { msg.textContent = 'Could not reach RevGym. Is it running?'; }
        e.currentTarget.disabled = false;
      });
    },
    destroy() {},
  };

  // Record (Form Check) and Personal Statistics. Plan, Statistics, Alerts and Me were
  // sample-data screens with nothing behind them, so they're out of the menu and the
  // router; their screen code above is kept, unused, in case they come back.
  const ROUTES = {
    record:  { screen: RecordScreen,  label: 'Record', icon: 'camera' },
    ...(phoneCamOrigin && {
      stats: { screen: PersonStatsScreen, label: 'Personal Statistics', icon: 'chart' },
      leaderboard: { screen: LeaderboardScreen, label: 'Leaderboard', icon: 'trophy' },
      data: { screen: DataScreen, label: 'Data', icon: 'file' },
    }),
    settings: { screen: JudgeSettingsScreen, label: 'Settings', icon: 'gear' },
  };
  const ORDER = Object.keys(ROUTES);
  const screenEl = $('#screen'), tabbar = $('#tabbar');
  let current = null;

  // Sidebar: the logo, the five tabs (CSS puts Record first), and a footer note.
  tabbar.innerHTML = `<div class="side-brand"><img class="logo-head" src="${LOGO_HEAD}" alt="RevGym logo"><div class="brand-text"><b>REV GYM</b><span>Texas A&amp;M</span></div></div>`
    + ORDER.map((k) => `<button class="tab ${k === 'record' ? 'rec-tab' : ''}" data-route="${k}">${icon(ROUTES[k].icon)}<span>${ROUTES[k].label}</span>${k === 'alerts' ? '<span class="dot" id="badge" hidden></span>' : ''}</button>`).join('')
    + `<button class="tab theme-tab" id="themeBtn" type="button"></button>`
    // Sign out used to live on the Me screen; with Me gone it sits in the sidebar.
    + (phoneCamOrigin ? `<a class="tab" href="/ui/logout" style="text-decoration:none">${icon('user')}<span>Sign out</span></a>` : '')
    + (phoneCamOrigin ? '' : `<div class="side-foot">Prototype with sample data.<br>Edits stay in this browser.</div>`);
  const themeBtn = tabbar.querySelector('#themeBtn');
  // The button shows the mode you are in now (sun + "Light mode" or moon + "Dark mode"); clicking it switches.
  const paintThemeBtn = () => {
    const dark = theme === 'dark';
    themeBtn.innerHTML = `${icon(dark ? 'moon' : 'sun')}<span>${dark ? 'Dark mode' : 'Light mode'}</span>`;
    themeBtn.setAttribute('aria-label', dark ? 'Dark mode is on. Switch to light mode' : 'Light mode is on. Switch to dark mode');
    themeBtn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  };
  paintThemeBtn();
  themeBtn.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
    paintThemeBtn();
    if ([PersonStatsScreen, LeaderboardScreen, DataScreen].includes(current)) show(location.hash.slice(1));
  });
  tabbar.addEventListener('click', (e) => { const b = e.target.closest('[data-route]'); if (b) go(b.dataset.route); });

  async function refreshBadge() {
    const b = $('#badge');
    if (!b) return;                  // the Alerts tab (and its badge) is gone
    const n = (await Api.listNotifications()).filter((x) => !x.read).length;
    b.hidden = !n; b.textContent = n;
  }

  function go(name) {
    if (location.hash !== '#' + name) location.hash = name; else show(name);
  }
  async function show(name) {
    if (!ROUTES[name]) name = 'record';
    closeSheet();
    if (name === 'record' && current === RecordScreen && $('#phoneFeed', screenEl)) return;
    current?.destroy?.();
    current = ROUTES[name].screen;
    tabbar.querySelectorAll('[data-route]').forEach((b) => (b.dataset.route === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    screenEl.scrollTop = 0;
    await current.render(screenEl);
  }
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || 'record');
  refreshBadge();
})();
