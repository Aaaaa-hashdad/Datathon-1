/* =====================================================================
   RevGym — MOCK DATA
   ---------------------------------------------------------------------
   Everything the prototype shows comes from this one object.
   Nothing in here is real: names, scores and counts are invented.

   To connect a real backend, leave this file alone and change the
   functions in the `Api` section at the top of app.js so they call
   your server instead of reading REVGYM_MOCK. The shapes below are the
   shapes the screens expect back.

   Dates are stored relative to "now" (dayOffset / daysAgo / minutesAgo)
   so the demo always looks current. A real API would return ISO dates.
   ===================================================================== */

window.REVGYM_MOCK = (function () {
  'use strict';

  /* ---------- Signed-in user ---------- */
  const currentUser = {
    id: 'u_me',
    name: 'Jordan Alvarez',
    initials: 'JA',
    classYear: "'27",
    major: 'Kinesiology',
    homeGym: 'rec',
    joined: '2025-08-25',
    streakDays: 12,
    longestStreak: 21,
    totalSessions: 86,
    avgFormScore: 82,
    weeklyGoal: 4,          // sessions per week
  };

  /* ---------- Exercises and which form metrics each one is scored on ---------- */
  const exercises = [
    { id: 'squat',    name: 'Back Squat',     short: 'Squat',     group: 'lower', metrics: ['depth', 'backAngle', 'kneeTracking', 'barPath', 'tempo'] },
    { id: 'bench',    name: 'Bench Press',    short: 'Bench',     group: 'press', metrics: ['rangeOfMotion', 'barPath', 'elbowPath', 'lockout', 'tempo'] },
    { id: 'deadlift', name: 'Deadlift',       short: 'Deadlift',  group: 'lower', metrics: ['hipHinge', 'backAngle', 'barPath', 'lockout', 'tempo'] },
    { id: 'ohp',      name: 'Overhead Press', short: 'OHP',       group: 'press', metrics: ['barPath', 'backAngle', 'lockout', 'elbowPath', 'tempo'] },
    { id: 'pullup',   name: 'Pull-up',        short: 'Pull-up',   group: 'pull',  metrics: ['rangeOfMotion', 'bodySwing', 'lockout', 'tempo'] },
    { id: 'curl',     name: 'Barbell Curl',   short: 'Curl',      group: 'pull',  metrics: ['rangeOfMotion', 'elbowPath', 'bodySwing', 'tempo'] },
    { id: 'rdl',      name: 'Romanian Deadlift', short: 'RDL',    group: 'lower', metrics: ['hipHinge', 'backAngle', 'kneeTracking', 'barPath', 'tempo'] },
    { id: 'row',      name: 'Barbell Row',    short: 'Row',       group: 'pull',  metrics: ['backAngle', 'barPath', 'elbowPath', 'bodySwing', 'tempo'] },
    { id: 'lunge',    name: 'Walking Lunge',  short: 'Lunge',     group: 'lower', metrics: ['depth', 'kneeTracking', 'backAngle', 'tempo'] },
  ];

  /* ---------- Metric labels, per-rep flag text, and default coaching ---------- */
  const metrics = {
    depth:         { label: 'Depth',           flag: 'Above parallel' },
    backAngle:     { label: 'Back angle',      flag: 'Chest dropped' },
    kneeTracking:  { label: 'Knee tracking',   flag: 'Knees caved in' },
    barPath:       { label: 'Bar path',        flag: 'Bar drifted forward' },
    tempo:         { label: 'Tempo',           flag: 'Rushed the descent' },
    lockout:       { label: 'Lockout',         flag: 'Soft lockout' },
    elbowPath:     { label: 'Elbow path',      flag: 'Elbows flared' },
    rangeOfMotion: { label: 'Range of motion', flag: 'Partial rep' },
    bodySwing:     { label: 'Body control',    flag: 'Used momentum' },
    hipHinge:      { label: 'Hip hinge',       flag: 'Hips rose early' },
  };

  // Default tip per metric. `tipsByExercise` below overrides where the advice differs.
  const tips = {
    depth:         { title: 'Hit depth on every rep', why: 'Your hip crease stayed above your knee on several reps, so the glutes and adductors did less of the work.', cue: '"Sit between your heels."', drill: 'Pause squats: 3 × 5 with a 2-second hold at the bottom,.' },
    backAngle:     { title: 'Keep your torso angle steady', why: 'Your chest dropped as the set went on, which shifts load onto the lower back.', cue: '"Proud chest, brace before you move."', drill: 'Tempo reps at 3 seconds down. Film from the side.' },
    kneeTracking:  { title: 'Push your knees out over your toes', why: 'Your knees drifted inward coming out of the bottom (valgus), mostly on the last reps.', cue: '"Spread the floor."', drill: 'Banded goblet squats: 2 × 10 with a mini-band above the knees.' },
    barPath:       { title: 'Keep the bar over mid-foot', why: 'The bar drifted forward of mid-foot, which costs leverage and tips you forward.', cue: '"Bar stays over the laces."', drill: 'Film side-on and trace the bar. Aim for a near-vertical line.' },
    tempo:         { title: 'Control the way down', why: 'Your lowering phase was under a second on most reps, so you lost tension at the bottom.', cue: '"Two down, one up."', drill: 'Count out loud on your next set: 2 seconds down, a slight pause, then drive.' },
    lockout:       { title: 'Finish every rep', why: 'You started the next rep before reaching full extension.', cue: '"Squeeze at the top."', drill: 'Add a 1-second hold at lockout on your last set.' },
    elbowPath:     { title: 'Keep your elbows on track', why: 'Your elbows flared or drifted away from the ideal path, which loads the shoulder.', cue: '"Elbows at 45°, bend the bar."', drill: 'Light paused reps focusing only on elbow position.' },
    rangeOfMotion: { title: 'Use the full range', why: 'Some reps stopped short of the full range, so they count for less.', cue: '"All the way down, all the way up."', drill: 'Slow down and own every inch of the rep.' },
    bodySwing:     { title: 'Stop swinging', why: 'Momentum from your hips did part of the work on the later reps.', cue: '"Glutes tight, ribs down."', drill: 'Do strict reps with your back against a wall or post.' },
    hipHinge:      { title: 'Lead with the hips', why: 'Your hips rose before the bar left the floor, turning it into a stiff-leg pull.', cue: '"Push the floor away, chest and hips rise together."', drill: 'Paused deadlifts 1 inch off the floor: 3 × 3.' },
  };

  const tipsByExercise = {
    bench:    { rangeOfMotion: { title: 'Touch your chest', why: 'The bar stopped 1–2 inches above your chest on several reps.', cue: '"Bar to the nipple line."', drill: 'Spoto press: pause 1 inch off the chest, 3 × 5.' },
                barPath:       { title: 'Let the bar travel in a slight J', why: 'You pressed straight up instead of back over your shoulders.', cue: '"Press back toward the rack."', drill: 'Film from the side with a light set and check the curve.' } },
    ohp:      { backAngle:     { title: 'Stop leaning back', why: 'You leaned back more than 15° to get the bar past your face.', cue: '"Squeeze your glutes, ribs down."', drill: 'Seated dumbbell press to learn the vertical path.' } },
    pullup:   { rangeOfMotion: { title: 'Chin over the bar', why: 'Your chin stayed below the bar on the last reps.', cue: '"Pull your chest to the bar."', drill: 'Slow negatives: 3 × 3 at 5 seconds each.' },
                lockout:       { title: 'Start from a dead hang', why: 'You started each rep with bent elbows.', cue: '"Long arms at the bottom."', drill: 'Scap pull-ups: 2 × 8 before your working sets.' } },
    curl:     { elbowPath:     { title: 'Pin your elbows', why: 'Your elbows drifted forward, turning the curl into a front raise.', cue: '"Elbows glued to your ribs."', drill: 'Wall curls: back and elbows touching the wall.' } },
    deadlift: { barPath:       { title: 'Drag the bar up your legs', why: 'The bar moved away from your shins as it passed your knees.', cue: '"Shave your legs with the bar."', drill: 'Engage your lats before the pull: "squeeze oranges in your armpits".' } },
  };

  /* ---------- Gyms and workout types used by the planner ---------- */
  const locations = [
    { id: 'rec',   name: 'Student Rec Center', short: 'the Rec' },
    { id: 'polo',  name: 'Polo Road Rec Center', short: 'Polo Road' },
    { id: 'other', name: 'Off-campus / other', short: 'Off-campus' },
  ];

  const focuses = [
    { id: 'legs',  name: 'Legs',        color: 'c1' },
    { id: 'push',  name: 'Push',        color: 'c2' },
    { id: 'pull',  name: 'Pull',        color: 'c3' },
    { id: 'upper', name: 'Upper body',  color: 'c4' },
    { id: 'full',  name: 'Full body',   color: 'c5' },
    { id: 'cardio',name: 'Cardio',      color: 'c6' },
    { id: 'core',  name: 'Core',        color: 'c4' },
  ];

  /* ---------- App-wide stats (Stats tab header) ---------- */
  const appStats = {
    activeUsers: 2847,      activeUsersDelta: 6.2,   // % vs last week
    sessionsThisWeek: 9412, sessionsDelta: 3.8,
    avgFormScore: 81,       avgFormDelta: 1.4,       // points vs last week
    formChecksToday: 1283,
    peakHours: { gym: 'Student Rec Center', hours: ['6a','8a','10a','12p','2p','4p','6p','8p','10p'], load: [22, 35, 40, 58, 52, 86, 100, 74, 31] },
  };

  /* ---------- Other students on the leaderboards ---------- */
  const users = [
    ['u01','Maya Chen',"'26",'Biomedical Sci.'], ['u02','Diego Ramirez',"'27",'Mech. Engineering'],
    ['u03','Avery Thompson',"'25",'Kinesiology'], ['u04','Sam Okafor',"'28",'Computer Sci.'],
    ['u05','Priya Nair',"'26",'Nutrition'],       ['u06','Caleb Brooks',"'27",'Ag. Business'],
    ['u07','Lena Fischer',"'26",'Psychology'],    ['u08','Marcus Hill',"'25",'Construction Sci.'],
    ['u09','Sofia Delgado',"'28",'Biology'],      ['u10','Ethan Park',"'27",'Finance'],
    ['u11','Hannah Wright',"'26",'Animal Sci.'],  ['u12','Isaiah Moore',"'27",'Sport Mgmt.'],
    ['u13','Olivia Nguyen',"'28",'Chem. Engineering'], ['u14','Tyler Bennett',"'26",'Petroleum Eng.'],
    ['u15','Grace Kim',"'27",'Architecture'],     ['u16','Noah Patel',"'25",'Economics'],
    ['u17','Zoe Martinez',"'28",'Communication'], ['u18','Ryan Foster',"'26",'Aerospace Eng.'],
    ['u19','Emma Lawson',"'27",'Nursing'],        ['u20','Jalen Carter',"'26",'Kinesiology'],
    ['u21','Ana Torres',"'28",'Ind. Engineering'],['u22','Luke Sullivan',"'25",'History'],
  ].map(([id, name, classYear, major]) => ({ id, name, classYear, major, initials: name.split(' ').map(p => p[0]).join('') }));

  /* ---------- Leaderboards ----------
     A real API would return these lists directly. Here they are built
     once from a seeded random generator so the numbers stay stable.   */
  function seeded(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

  const periods = ['week', 'month', 'all'];
  const participants = { week: 1203, month: 2216, all: 4871 };

  const formLeaderboards = {};   // formLeaderboards[exerciseId][period] = [{ userId, score, reps, change }]
  for (const ex of exercises) {
    formLeaderboards[ex.id] = {};
    for (const p of periods) {
      const rnd = seeded(hash(ex.id + p));
      const top = p === 'all' ? 99 : p === 'month' ? 97 : 96;
      const rows = users.map(u => ({ userId: u.id, score: Math.round(top - rnd() * 22), reps: 3 + Math.floor(rnd() * 10), change: Math.round((rnd() - 0.45) * 6) }));
      // The signed-in user sits mid-table so "your rank" is visible.
      const myBase = { squat: 88, bench: 84, deadlift: 86, ohp: 79, pullup: 90, curl: 92, rdl: 83, row: 80, lunge: 85 }[ex.id];
      rows.push({ userId: 'u_me', score: myBase + (p === 'all' ? 3 : p === 'month' ? 1 : 0), reps: 5, change: 2 });
      rows.sort((a, b) => b.score - a.score);
      formLeaderboards[ex.id][p] = rows;
    }
  }

  /* ---------- Consistency points ----------
     Day n of an unbroken streak earns min(max, start + step * (n - 1)) points: 1, 3, 5, 7, 9, 9, 9...
     Miss a day and the streak ends: the next gym day is worth 1 point again. Points already earned are kept.
     A real backend would store one row per user per day and compute this; the demo builds it from attendance. */
  const pointsRule = { start: 1, step: 2, max: 9 };
  const dayPoints = (n) => Math.min(pointsRule.max, pointsRule.start + pointsRule.step * (n - 1));
  const HISTORY_DAYS = 150;                                    // "all time" in this demo
  const WINDOW_DAYS = { week: 7, month: 30, all: HISTORY_DAYS };

  // Days (counting back from today = 0) the signed-in user went to the gym. The last 35 days are hand-set; older ones are generated.
  const trainedDaysAgo = (() => {
    const recent = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 18, 19, 21, 23, 24, 26, 28, 29, 31, 33];
    const rnd = seeded(hash('me-history')); const older = [];
    for (let d = 36; d < HISTORY_DAYS; d++) if (rnd() < 0.55) older.push(d);
    return recent.concat(older);
  })();

  function attendanceFor(userId) {                              // array of booleans, index = days ago
    const att = new Array(HISTORY_DAYS).fill(false);
    if (userId === 'u_me') { trainedDaysAgo.forEach((d) => { att[d] = true; }); return att; }
    const rnd = seeded(hash('att' + userId));
    const pStart = 0.28 + rnd() * 0.3, pStay = 0.6 + rnd() * 0.35;
    let prev = rnd() < 0.5;
    for (let ago = HISTORY_DAYS - 1; ago >= 0; ago--) { prev = rnd() < (prev ? pStay : pStart); att[ago] = prev; }
    return att;
  }
  function scoreAttendance(att) {                               // oldest day first
    const daily = new Array(HISTORY_DAYS).fill(0); let run = 0, best = 0;
    for (let ago = HISTORY_DAYS - 1; ago >= 0; ago--) {
      if (att[ago]) { run++; daily[ago] = dayPoints(run); best = Math.max(best, run); }
      else if (ago !== 0) run = 0;                              // today only breaks the streak once it is over
    }
    return { daily, streak: run, bestStreak: best };
  }

  const consistencyLeaderboard = {}; // [period] = [{ userId, points, streak, bestStreak, activeDays, nextDayPoints }]
  const scored = {};
  users.map((u) => u.id).concat('u_me').forEach((id) => { const att = attendanceFor(id); scored[id] = { att, ...scoreAttendance(att) }; });
  for (const p of periods) {
    const w = WINDOW_DAYS[p];
    const rows = Object.keys(scored).map((userId) => {
      const sc = scored[userId];
      return { userId, points: sc.daily.slice(0, w).reduce((x, y) => x + y, 0), streak: sc.streak, bestStreak: sc.bestStreak,
               activeDays: sc.att.slice(0, w).filter(Boolean).length, nextDayPoints: dayPoints(sc.streak + 1) };
    });
    rows.sort((x, y) => y.points - x.points || y.streak - x.streak);
    consistencyLeaderboard[p] = rows;
  }

  /* ---------- Planner: this user's scheduled sessions ----------
     weekOffset 0 = the current week, dayIndex 0 = Monday.            */
  const plannedSessions = [
    { id: 's1', weekOffset: 0, dayIndex: 0, time: '17:00', duration: 75, location: 'rec',  focus: 'legs',  notes: 'Squat 5×5, RDL, lunges', done: true },
    { id: 's2', weekOffset: 0, dayIndex: 1, time: '07:00', duration: 60, location: 'polo', focus: 'push',  notes: 'Bench + OHP. Film bench for form check.', done: true },
    { id: 's3', weekOffset: 0, dayIndex: 3, time: '18:30', duration: 60, location: 'rec',  focus: 'pull',  notes: 'Pull-ups, rows, curls', done: true },
    { id: 's4', weekOffset: 0, dayIndex: 5, time: '17:00', duration: 75, location: 'rec',  focus: 'legs',  notes: 'Leg day. Deadlift top set.', done: false },
    { id: 's5', weekOffset: 0, dayIndex: 6, time: '10:00', duration: 40, location: 'polo', focus: 'cardio',notes: 'Easy 5k on the track', done: false },
    { id: 's6', weekOffset: 1, dayIndex: 0, time: '07:00', duration: 60, location: 'polo', focus: 'push',  notes: '', done: false },
    { id: 's7', weekOffset: 1, dayIndex: 2, time: '17:30', duration: 75, location: 'rec',  focus: 'legs',  notes: '', done: false },
    { id: 's8', weekOffset: 1, dayIndex: 4, time: '16:00', duration: 60, location: 'rec',  focus: 'pull',  notes: '', done: false },
  ];

  /* ---------- Notifications inbox ---------- */
  const notifications = [
    { id: 'n1', type: 'reminder',    minutesAgo: 25,    read: false, title: 'Leg day at 5:00 PM at the Rec', body: 'Leaves in about 4 hours. Deadlift top set is on the plan.', link: 'plan' },
    { id: 'n2', type: 'leaderboard', minutesAgo: 140,   read: false, title: 'You moved up to #9 on Pull-up form', body: 'A 90 form score passed Ethan P. this week.', link: 'stats' },
    { id: 'n3', type: 'streak',      minutesAgo: 1260,  read: false, title: 'Your 12-day streak is safe', body: 'Thursday’s pull session counted. Next check-in is due by Sunday night.', link: 'profile' },
    { id: 'n4', type: 'pr',          minutesAgo: 2880,  read: true,  title: 'New best: Bench form 84', body: 'Up 5 points from last month. Bar path improved the most.', link: 'profile' },
    { id: 'n5', type: 'leaderboard', minutesAgo: 4300,  read: true,  title: 'Maya C. took #1 on Squat form', body: 'You’re 6 points out of the top 10.', link: 'stats' },
    { id: 'n6', type: 'reminder',    minutesAgo: 5800,  read: true,  title: 'Push day at 7:00 AM at Polo Road', body: 'Polo Road opens at 6:00 AM on weekdays.', link: 'plan' },
    { id: 'n7', type: 'streak',      minutesAgo: 10200, read: true,  title: 'Streak at risk', body: 'You haven’t logged a session in 2 days. Get one in before 11:59 PM to keep your streak.', link: 'plan' },
    { id: 'n8', type: 'recap',       minutesAgo: 9000,  read: true,  title: 'Weekly recap: 4 of 4 sessions', body: 'You hit your goal. Average form score 81, up 2.', link: 'profile' },
  ];

  const notificationSettings = {
    sessionReminders: true,
    reminderLeadMinutes: 30,
    dailyNudge: true,
    dailyNudgeTime: '15:00',     // nudge if nothing is planned that day
    streakWarnings: true,
    streakWarningTime: '20:00',
    leaderboardAlerts: true,
    weeklyRecap: true,
    quietStart: '23:00',
    quietEnd: '07:00',
    browserNotifications: false,
  };

  /* ---------- Profile: history, trend ---------- */
  const history = [
    { id: 'h1', daysAgo: 2,  exercise: 'pullup',   score: 90, reps: 8 },
    { id: 'h2', daysAgo: 2,  exercise: 'row',      score: 78, reps: 8 },
    { id: 'h3', daysAgo: 4,  exercise: 'bench',    score: 84, reps: 5 },
    { id: 'h4', daysAgo: 4,  exercise: 'ohp',      score: 76, reps: 6 },
    { id: 'h5', daysAgo: 5,  exercise: 'squat',    score: 86, reps: 5 },
    { id: 'h6', daysAgo: 5,  exercise: 'rdl',      score: 81, reps: 8 },
    { id: 'h7', daysAgo: 8,  exercise: 'deadlift', score: 83, reps: 3 },
    { id: 'h8', daysAgo: 9,  exercise: 'curl',     score: 92, reps: 10 },
  ];


  // Weekly average form score, oldest first (12 weeks).
  const formTrend = {
    all:      [72, 74, 73, 76, 75, 78, 77, 79, 80, 79, 81, 82],
    squat:    [70, 73, 72, 75, 77, 78, 76, 80, 82, 81, 84, 86],
    bench:    [74, 75, 73, 76, 78, 77, 79, 79, 81, 80, 83, 84],
    deadlift: [68, 70, 72, 71, 74, 76, 78, 77, 80, 81, 82, 83],
    pullup:   [80, 81, 83, 82, 84, 85, 85, 87, 86, 88, 89, 90],
  };

  // Days in the last 35 the user trained (0 = today). Drives the streak heatmap.

  return {
    currentUser, exercises, metrics, tips, tipsByExercise, locations, focuses,
    appStats, users, participants, formLeaderboards, consistencyLeaderboard, pointsRule,
    plannedSessions, notifications, notificationSettings,
    history, formTrend, trainedDaysAgo,
  };
})();
