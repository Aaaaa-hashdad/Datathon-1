# RevGym — UI prototype (PC + phone): hand-off

Read this first when continuing the work in a new chat or with another model.

## The project
- **RevGym** is a gym app for students at **Texas A&M University – College Station**.
- Core idea: the user presses **Record**, the camera films a set, and the app shows **form statistics and what to improve**.
- Also: app-wide **stats and leaderboards** (best form per exercise, gym consistency), a **weekly planner** for gym sessions, and **notifications/reminders**.
- **Scope of this work: UI only.** PC/laptop is the main design; a phone layout was added later at the user's request (a friend may also be designing a phone UI separately). Peers will write the real app code and backend later.
- The user will share more details later. Don't invent requirements beyond what's here.

## Where things are
- **Live prototype (artifact, private until shared):** https://claude.ai/artifact/TpfgNi9MfBDLrpFUL7ogtA
  - Republish by publishing `revgym/index.html` again with `files: {"mock-data.js": "revgym/mock-data.js", "app.js": "revgym/app.js"}`. From a new chat, pass the URL as `url` (read it first), or the publish creates a separate artifact.
- **Files** (folder `revgym/`):
  | File | What it is |
  |---|---|
  | `index.html` | Page content: `<title>`, Google Fonts link, all CSS, the app shell markup, script tags. **No doctype/html/head/body**, because the artifact host adds those. |
  | `mock-data.js` | `window.REVGYM_MOCK`: every piece of sample data (user, exercises, metrics, tips, gyms, leaderboards, planner sessions, notifications, settings, history, PBs, trend). |
  | `app.js` | The app: `Api` layer, helpers, UI kit, 5 screens, router. |
  | `assets/reveille-logo.png`, `assets/reveille-head.png` | The RevGym logo supplied by the user (Reveille the collie + "REV GYM" + A&M mark). Full logo is the top of the sidebar; the head-only crop is the round icon in the narrow sidebar and in the Form Report banner. Use these, don't redraw her. |
  | `preview.html` | Local test copy = doctype skeleton + `index.html`. **Regenerate it after editing index.html** (see below). |
  | `../.claude/launch.json` | Local server config named `revgym` (python http.server on port 5178, serving `revgym/`). Open `http://localhost:5178/preview.html`. |

  Regenerate preview.html (Git Bash, from the session folder):
  ```bash
  { printf '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'; cat revgym/index.html; printf '\n</body></html>\n'; } > revgym/preview.html
  ```

## Code structure (app.js)
1. **Api**: the ONLY code that reads `REVGYM_MOCK`. All functions are `async`. Peers swap each body for a `fetch()` and keep the return shapes. User-owned data (planner sessions, weekly goal, notifications, settings, recorded results) is kept in a mutable `db` copy and saved to `localStorage` key `revgym-proto-v1` (wrapped in try/catch).
   - Key functions: `getFormLeaderboard(exerciseId, period)`, `getConsistencyLeaderboard(period)`, `listSessions(fromIso, toIso)`, `saveSession`, `deleteSession`, `setSessionDone`, `get/setWeeklyGoal`, `listNotifications`, `markNotificationRead`, `markAllNotificationsRead`, `addNotification`, `get/saveNotificationSettings`, `getHistory`, `getPersonalBests`, `getFormTrend(key)`, `getTrainedDays`, `analyzeRecording({exerciseId, durationSec, repCount, seed})` (fake pose model: returns score, metrics, reps, tips, strengths), `saveResult`, `getResult`.
2. **Logo**: `LOGO_FULL` / `LOGO_HEAD` constants point at the two images in `assets/`. When publishing, include them: `files: {..., "assets/reveille-logo.png": "revgym/assets/reveille-logo.png", "assets/reveille-head.png": "revgym/assets/reveille-head.png"}`.
3. **Helpers**: dates (weeks start Monday), formatting, `esc()` for HTML escaping, inline SVG `icon(name)`.
4. **UI kit**: `toast()`, `openSheet()`/`closeSheet()` (centered dialog), `ring()` score ring, `lineChart()` SVG chart.
5. **Screens**: each is `{ title, render(el), destroy? }` and renders with template strings + event delegation.
6. **Shell**: sidebar (`#tabbar`) + hash router. Routes: `#record`, `#plan`, `#stats`, `#alerts`, `#profile`.

## Design system
- Brand: **Aggie maroon `#500000`** + white. Light and dark themes via CSS tokens on `:root` (dark under `prefers-color-scheme` and `[data-theme="dark"]`). Always use tokens (`--brand`, `--accent`, `--bg`, `--surface`, `--surface-2`, `--fg`, `--muted`, `--line`, `--good/--warn/--bad` + `-soft`, `--c1..c6` workout colors).
- Font: **Rubik** (Google Fonts, weights 400–700; chunky rounded-square letters) for everything: headings, big numbers and body text. Set via `--font-display` / `--font-body`.
- Score colors: ≥85 good (green), 72–84 warn (amber), <72 bad (red) — `band()` in app.js.
- Layout: fixed **left sidebar** (236px: logo image, Record first, then Plan, Statistics, Alerts, Me; footer note) + content capped at ~1180px via the `.gutter` padding trick.
- Responsive: ≤1100px the sidebar becomes a 72px icon rail; ≤820px the columns stack; **≤700px is the PHONE layout** (one CSS block, `@media (max-width: 700px)`, near the end of index.html): bottom tab bar (Plan, Statistics, Record, Alerts, Me), dog-head logo in each top bar, theme toggle floating top-right, single-column screens, horizontal-scroll chips, planner day strip (tap a day to jump to it) + stacked day list, Alerts Inbox/Settings switch, slide-up sheets, "Tap" wording on Record. The day strip and the Inbox/Settings switch are in the markup always but hidden on PC by CSS.
- Theme: opens in **light** regardless of system setting; the sidebar button (floating top-right button on phone) switches to dark and saves the choice in `localStorage` key `revgym-theme`.
- Artifact rules to keep: no `alert/confirm/prompt` (deletes use a "click again to confirm" button), no downloads, camera is blocked inside claude.ai artifacts (falls back to the demo feed), external scripts only from allowed CDNs, fonts only from Google Fonts.

## Screens (current state)
1. **Record / Form Check**: big viewfinder on the left. It shows an animated stick-figure "demo feed" with a pose overlay, or the live webcam after "Use camera" (mirrored; works only outside the artifact, e.g. local preview in Chrome/Edge). Right panel: exercise chips (Squat, Bench, Deadlift, OHP, Pull-up, Curl, RDL, Row, Lunge), Record button (3-2-1 countdown, timer, rep counter every ~2.6 s, live cues), camera button, "Sample result" button, and a "Before you record" checklist. **Space** starts/stops.
   - **Form Report** (after recording): 2 columns. Left: score ring + verdict, form breakdown bars per metric, "What went well". Right: "What to improve" tip cards (why / cue / drill), rep-by-rep list (score, down/up seconds, flag). Buttons: "Post to leaderboard", "Record again". Results are saved to history.
2. **Statistics** (tab was renamed from "Stats"; route is still `#stats`): 3 tiles (active users, sessions this week, avg form score with weekly change) + "Busy times at the Student Rec Center" bar chart. **Two separate leaderboards, side by side** (stacked on phones), each with its own This week / This month / All time switch and its own "Your rank" card: the **Form score leaderboard** (plus exercise chips; ranks by form score, shows reps and change) and the **Consistency leaderboard**, which is **points-based**: a small ladder card (Day 1 +1, Day 2 +3, Day 3 +5, Day 4 +7, Day 5+ +9, highlighting where you are), your rank card (points, current streak, what your next gym day is worth) and the ranked list (points, streak, next-day value). Each shows the top 10 plus your own row, with a "Show all" button.
3. **Plan**: week navigation (‹ This week ›) + weekly goal ring with −/+ stepper. Below that, **one roomy row per day** (Mon–Sun): day name and date on the left, session cards on the right (today outlined). Session cards show time, workout tag (Legs/Push/Pull/Upper/Full body/Cardio/Core), gym (Student Rec Center / Polo Road Rec Center / Off-campus), length, notes, and a done check. Empty days show "Rest day + Add session". The add/edit dialog has day, time, length, gym, workout chips, notes, and delete with confirm.
4. **Alerts**: left column: a "Next up" card (next 3 planned sessions with the reminder time), filter chips, and the inbox grouped Today / This week / Earlier (unread rows have a gray background and bolder title; clicking marks read and jumps to the linked screen); "Mark all read". Right column: settings in four labelled cards: **Reminders** (session reminders + lead time, daily nudge time, streak warning time), **Updates** (leaderboard changes, weekly recap), **Quiet hours**, **Outside the app** (browser notifications toggle that asks permission, "Send a test reminder"). On phones an Inbox / Reminder settings switch shows one at a time. Unread count badge on the sidebar.
5. **Me (Profile)**: maroon banner (name, class, major, home gym, streak / longest / sessions / avg form). Two columns: left has the 5-week gym-day heatmap and the form-score trend chart (All lifts / Squat / Bench / Deadlift / Pull-up). Right has personal bests (weight + best form score) and recent form checks (click opens the report).

Sample user: **Jordan Alvarez**, Class of '27, Kinesiology. All people and numbers are invented and marked as sample data in the UI.

## Testing done
Checked in the browser at 1366×768 and 1000×700 (light mode): all 5 screens, a full recording → report, adding a session (notes are HTML-escaped), settings changes; no console errors. Dark mode was checked in an earlier version.

## Ideas not started (only if the user asks)
- Exercise-specific stick-figure animation (currently 3 generic motions: lower body / press / pull).
- A real "Post to leaderboard" flow, editable profile, gym check-in.
- Hooking up a real pose model (replace `Api.analyzeRecording`).

## Phone as camera (UI only; the real link is being coded by a peer)
The user wants to film with their phone and run RevGym from the laptop. The prototype only has the interface and fake connection states.
- **Laptop (Record screen, PC layout):** "Camera" switch: *This device* / *My phone*. Choosing *My phone* shows a pairing card (QR pattern + code like `RV-4553`, 3 steps, "Waiting for your phone…", Cancel) and a dimmed "Waiting for your phone…" overlay on the viewfinder. The top-right pill shows *Waiting for phone* → *Phone connected*. Once connected the card shows the device name, battery and signal, tips, and *Disconnect phone*. Record is blocked until connected (toast: "Connect your phone first"). A small link, "Prototype only: pretend my phone just connected", simulates the join; remove it when the real link exists.
- **Phone (Record screen, phone layout):** a card "Use this phone as a camera" with a code field + Connect (bad format shows an error), then a connected state ("Connected to Jordan's laptop… start recording from your laptop") with *Stop being a camera*.
- **Api stubs to replace** (top of app.js): `createPairing()` → `{ code, url, expiresInSec, state }`, `getPairingStatus()` → `{ state: 'idle'|'waiting'|'connected', code, device: { name, battery, signal } }`, `joinPairing(code)` (phone side) → `{ ok, laptop }` or `{ ok:false, error }`, `endPairing()`, `simulatePhoneJoined()` (delete). The laptop UI currently refreshes only on its own actions: a real build should push status changes (websocket) or poll `getPairingStatus()` and call the screen's repaint.
- `fakeQr(text)` draws a decorative, non-scannable pattern; swap it for a real QR of `url`. The live video itself (e.g. WebRTC from the phone) is not built: the viewfinder still shows the demo figure when "connected".

## Consistency points rule (the rule the user asked for)
- Day *n* of an unbroken streak earns `min(9, 1 + 2*(n-1))` points: **1, 3, 5, 7, 9, 9, 9...** (max 9 per day).
- Missing a day ends the streak; the next gym day is worth 1 point again and the climb restarts. Points already earned are kept (they are not wiped).
- The leaderboard ranks by total points in the chosen window (This week = last 7 days, This month = last 30, All time = whole season). Ties go to the longer current streak.
- Today does not break a streak until the day is over, so a streak shows as active before you have trained today.
- In the prototype the rule lives in `mock-data.js` (`pointsRule`, `dayPoints`, `attendanceFor`, `scoreAttendance`), which builds each person's points from a made-up 150-day attendance history. A real backend should store one row per user per gym day and compute points server-side. `Api.getConsistencyLeaderboard(period)` returns `{ entries: [{ rank, user, points, streak, bestStreak, activeDays, nextDayPoints, isMe }], me, total, rule }`.
- Open questions for the team: what counts as a "gym day" (a logged session, a form check, a check-in?), and the time zone for the day rollover.
