# Local changes (uncommitted)

Snapshot of `git status` / `git diff` on 2026-11-07. Branch: `codex/merge-login` (last commit `c618029`).
21 modified files (+1147 / -158 lines) and 11 new files. **Nothing here is committed or pushed.**

Before pushing: `git pull --no-rebase --no-edit origin backend`.

## 1. RevGym backend (`backend/`)

| File | Change |
|---|---|
| `app/config.py` | New `phone_cam_port` setting (from `HTTP_PORT`, default 8080). |
| `app/models.py` | New `WorkoutResult` table: one row per (user, source set), with `recorded_at` and a JSON list of exercises. |
| `app/schemas.py` | `WorkoutExerciseIn` (exercise, reps 1-1000, score 1-10), `WorkoutResultIn`, `WorkoutResultsIn` (up to 50 sets per request). |
| `app/main.py` | New `POST /api/ui/workout-results` (upsert, Postgres or SQLite, same-origin and login required). New `GET /api/ui/workout-leaderboard` (week or all-time, per exercise). `/ui/whoami` now has `include_height` and `no-store`. Logout split into `require_same_origin` plus the handler. Phone-cam port exposed through a `<meta name="phone-cam-port">` tag. |
| `app/leaderboard.py` | New `workout_board()`: best analysed set per person, ranked by score, then reps. |
| `app/static/ui-login.html` | New welcome screen with a 3D "REV GYM" cube, separate **Sign Up** and **Log In** buttons, and a shared account form. |
| `app/static/auth-cube.css` (new) | Styles for the cube welcome screen (580 lines). |
| `tests/test_ui_bridge.py` | Asserts the sign-up button and the cube stylesheet are on the page. |
| `tests/test_workout_leaderboard.py` (new) | Tests for the workout leaderboard. |

## 2. Phone-cam server and Electron shell (`phone-cam/`)

| File | Change |
|---|---|
| `main.js` | Electron now starts the RevGym backend (uvicorn, `REVGYM_PORT`, default 8000), reuses one that is already running, kills it on quit, and opens `http://127.0.0.1:<port>/ui/` instead of the viewer. |
| `server.js` (+259 lines) | Login proxy to RevGym (`/auth/login`, `/auth/register`, `/ui/logout`) and static login assets. New routes: `/form-check` (embedded viewer), `/person-stats`, `/leaderboard-view`, `/data-view`, `/feedback`, `/stats/*`, `/workout-leaderboard` (+ `/publish`), `/workout-data/{list,preview,download}`. Viewers are served only to a signed-in local user. Results are published to RevGym in batches of 50. |
| `motionlog.js` | `accountKey()` makes safe per-user folders (reserved Windows names, case aliases, `guest` → hashed `account-…`). New `readWorkbook`, `latestKey`, `userKeys`, `dataKeys`, `version`. Batched `frames` are handled before the old single-sample path. A session no longer waits on a `present` flag when frames are batched. |
| `mcp.js` | The `onState` hook also receives `req`, so the log can tell who is signed in. |
| `feedback.js` (new) | "Get feedback": runs `claude -p` on the last recorded set and returns coaching text plus a JSON result (all exercises, reps, range of motion, form score). Saves to `<user>/analyses.json`. |
| `stats.js` (new) | Person Statistics data (`/stats/data`, `/stats/analyze`). |
| `public/person-stats.html` (new) | Person Statistics page: KPIs, reps per day, range of motion, jump height, exercise table, set list. |
| `public/workout-reports.html` (new) | RevGym-themed Leaderboard and Data report page. |
| `public/video-frame.mjs` (new) | Shared `nextVideoFrame` and `createVideoClock`. Frames are timed from the video's own media time instead of the wall clock. |

## 3. Tracking and room lock (`phone-cam/public/`)

| File | Change |
|---|---|
| `tracker.js` | Uses the shared video clock. `processFrame(..., live)` records `capturedAt`. New `trackLive()` skips frames that are not newer than the last one. |
| `roomlock.js` | Uses capture time instead of `Date.now()`. Gaps over 200 ms (`MAX_FRAME_GAP_MS`) reset the still-stand, jump and air state. Records `usedHeight` (the real profile height was used). Height range widened to 100-245 cm. |
| `mcp-bridge.js` | Reads the height from the profile (`<meta name="profile-height-cm">`) and sends `capturedAt` times. Always shares tracking when embedded. Hides the room-lock drawing when embedded. `estHeightCm` is sent only when the profile height was not used. |
| `sources.js` | Picture fallback stays on until the WebRTC video actually plays. Stale peer-connection events are ignored. |
| `viewer.html` | Embedded mode (`/form-check`): no header or sidebar, full-size video. Sign out button. Messages to the RevGym parent page for feedback requests and for phone connection and calibration status. |
| `brain.js` | Hides the video caption when embedded. |
| `phone.html` | Full redesign as "RevGym Camera": maroon theme, shutter-style Start button, 480p/720p/1080p pills, status pill, corner guides. The picture fallback sends `X-Capture-Time` and `X-Capture-Stream` headers. |

## 4. RevGym web app (`ui/`)

- `app.js` (+~286 lines):
  - Form Check embeds the phone-cam viewer in an iframe (`/form-check`).
  - New **Set feedback** card with a Get feedback button.
  - Phone link status and QR messages arrive from the embedded page.
  - New screens: **Personal Statistics**, **Leaderboard**, **Data**. They are iframes onto phone-cam pages that report their own height.
  - Sidebar is now Record, Personal Statistics and Leaderboard, plus Sign out. Plan, Statistics, Alerts and Me are removed from the menu, and their code is unused.
- `index.html`: styles for the feedback card.

## 5. Other

- `package.json` (new, root): `npm start` runs `phone-cam`'s start.
- `datathon.md`: updated handoff notes (+55 lines).
- `phone-cam/public/brain.js`, `phone.html`, `roomlock.js`, `sources.js`, `tracker.js`, `viewer.html`: git warns that LF will become CRLF on the next touch, which is harmless but will show as whole-file noise in diffs.

## Not verified

- A full run through the new login flow with the room lock, height and motion log.
- The real-phone jump test (see `datathon.md` → Next steps).
- The new leaderboard and Data screens, and the new welcome page, are not covered in `datathon.md`. I only read their diffs and did not run them.
