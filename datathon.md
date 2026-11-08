# Datathon: Phone Camera body tracker (context to continue)

Last updated: 2026-11-07, night (side-on room lock, side-on left/right fix, hybrid model for speed). Paste or point Claude at this file to pick up where we left off.

**Status in one line:** the full loop works live. The camera produces raw body positions and angles, which go to Excel locally and in Supabase, and Claude interprets them correctly (exercise, reps, side, tempo, form). See "Progress log" below.

## What it is

An Electron desktop app, `phone-cam/`, that:

1. Streams a **phone camera** to the PC: WebRTC video at 30 fps, falling back to JPEG pictures.
2. Tracks the **body only** with MediaPipe Holistic, running locally and offline (hands and face permanently off).
3. A rule-based **"brain"** describes posture, arms, legs, head, movement, reps and an event timeline for the live panel. It is **not** used for the logged data.
4. Has a **test set + evaluator** to measure accuracy with numbers instead of judging screenshots.
5. Exposes everything to **Claude via MCP** (7 tools), with a one-click "Connect to Claude" button.
6. **Room lock:** a coordinate system fixed to the room, in cm above the floor, made once in a 2 s still stand. It measures jumps, steps and squat depth, and each jump's height two independent ways (`public/roomlock.js`).
7. **Claude as interpreter:** every session is logged as raw positions and angles to Excel (local + Supabase). Claude reads the logs through MCP (`list_motion_logs`, `read_motion_log`) and works out for itself what was done, checking it against what the user selected. The live auto-coach was removed on purpose: the app records, Claude interprets.

Everything lives in `C:\Users\Arnav\Desktop\Datathon\phone-cam`. It was originally built inside `projects\TamuHack` by mistake and moved here. Datathon work stays in this folder.

## Run it

```bash
cd C:\Users\Arnav\Desktop\Datathon\phone-cam
npm install          # only on a fresh clone
npm start            # Electron app (server + viewer window)
npm run server       # server only, open http://localhost:8080/ in a browser
```

- **Phone:** scan the QR code in the app, or open `https://<pc-lan-ip>:8443/phone`. Accept the certificate warning, then tap **Start streaming**. The badge turns green ("WebRTC video") when real video connects.
- **Ports:** 8080 (HTTP, viewer, API, MCP) and 8443 (HTTPS, phone page; the camera needs HTTPS). Override with `HTTP_PORT` / `HTTPS_PORT`.
- **Test-set folder:** `TESTSET_DIR` (default `phone-cam/testset`; in the app `Videos\phone-cam\testset`).
- **Recordings** save to `Videos\phone-cam` (app) or Downloads (browser).
- **Hackathon Wi-Fi:** often blocks device-to-device traffic. Use a phone hotspot if the phone can't reach the PC.

## Files

| File | What it does |
|---|---|
| `main.js` | Electron shell: starts the server, opens the window, screen picker, auto-saves recordings, Claude connect IPC, flag so WebRTC uses real LAN IPs |
| `preload.js` | Bridge to the page: `screenSources`, `onSaved`, `showFile`, `claudeStatus/Connect/Disconnect` |
| `server.js` | HTTP + HTTPS server (no framework): static files, `/frame`, `/next.jpg` long-poll, `/stream.mjpg`, `/latest.jpg`, `/status`, `/info`, `/qr.svg`, WebRTC signalling `/rtc/offer` and `/rtc/answer`, test set `/testset/*`, MCP `/mcp` and `/state*`. Self-signed cert via `selfsigned`. |
| `motionlog.js` | Motion log: **every tracked frame (~30/s)**, sent in batches as `frames` with each `/state` post. Columns: 17 points (13 joints + heels + toes) as hip-centred x/y/z, the same points in the room lock (`<joint> room X/Y`, cm), `lock`, `dist`, `foot_cm`, `feet` (ground/air), 8 smoothed angles + 8 `raw angle` columns. A **Jumps** sheet lists every jump (air time, height from air time, feet peak, hip rise, difference, fps, quality). `elapsed_s` is in ms resolution. Older notes on this row follow. Originally: every live sample (~5/s, from `/state`) goes into an Excel file per session, `<user>/<YYYY-MM-DD>/<HH-MM>.xlsx`. A new session starts after 15 min with nobody in view (`SESSION_GAP_MIN`), or when the user or the day changes. **Raw data only** (the interpreter, Claude, decides what the person did, even when the user picked an exercise). Sheets: Summary (with a guide to the columns and the exercise the user selected), Motion (3D positions of 13 body joints in cm, origin between the hips, y up, z negative = toward the camera, plus 8 joint angles; blank = joint not seen clearly; `selected_exercise` is the user's claim; `tracking` = measured or predicted gap). No posture, gesture or event columns. The viewer sends `joints` from `mcp-bridge.js`. Failed uploads are queued and retried every minute. MCP tools: `list_motion_logs {user?, day?}` and `read_motion_log {path='current'|user/day/HH-MM.xlsx, from_s, to_s, columns=angles|positions|all, max_rows≤600}`, which return a CSV plus the column guide. `.env` loading follows dotenv: an env var that's already set wins, even if empty. Always written locally (`MOTION_LOG_DIR`; in the app `Videos\phone-cam\motion-logs`) and, when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are in `phone-cam/.env`, upserted every minute to the private Supabase Storage bucket `motion-logs` (created automatically). Routes (local only): `GET /motionlog/status`, `POST /motionlog/user {user}`, `POST /motionlog/flush {end?}`, `GET /motionlog/list?prefix=`, `GET /motionlog/file?path=`. Upload verified against the real Supabase project. |
| `mcp.js` | MCP server (Streamable HTTP, JSON replies, async tool calls). Local-only plus Origin check. Keeps 3 min of state history and calls `onState` for the motion log. 7 tools: `get_current_state`, `get_recent_activity`, `get_timeline`, `get_joint_angle_history`, `get_snapshot`, `list_motion_logs`, `read_motion_log`. |
| `mcp-stdio-bridge.js` | stdio↔HTTP bridge so Claude Desktop can use the server. Runs with the app's own exe (`ELECTRON_RUN_AS_NODE=1`). |
| `connect-claude.js` | Registers or removes `phone-cam` in Claude Code (`claude mcp add --scope user`, else `~/.claude.json`) and Claude Desktop (`claude_desktop_config.json`). Backs up to `*.bak-phonecam`. Test with `PHONECAM_TEST_HOME`. |
| `public/phone.html` | Phone page: camera, WebRTC sender with picture fallback (2 uploads in flight), flip/quality. **Motion sensors**: low-pass gravity + max rotation rate, POSTed to `/sensor` 5×/s while streaming (iPhone permission asked on the Start tap). `server.js` keeps the latest; only localhost can `GET /sensor`. |
| `public/viewer.html` | PC viewer UI: canvas, sidebar (video source, Claude MCP, brain, tracking toggles, angles, speeds), Record, Test set panel |
| `public/sources.js` | Video sources (phone WebRTC receiver / screen / video file), recorder (annotated MP4 + per-frame JSON), `window.camSource` |
| `public/tracker.js` | MediaPipe pipelines, ghost-body checks, left/right consistency, smoothing, gap bridging, drawing, `window.phoneCamTracker` API |
| `public/brain-core.js` | The brain (pure logic, no DOM): describes everything, structured `facts`, events, counters |
| `public/brain.js` | Connects the brain to the UI: caption on the video, side panel, timeline |
| `public/eval.js` | Test-set panel: label form, raw test-clip recording, clip list, evaluation and reports |
| `public/roomlock.js` | **Room lock** (replaces the body box). Locks once when the person stands straight and still for 2 s, whole body and feet in view. It fixes: true vertical (phone gravity sensor if it agrees with the body within 15°, else the body's own axis), the floor (lowest heel/toe), the scale (from the height entered in the viewer, eye height ≈ 0.936 × height, else MediaPipe limb lengths) and the phone's direction. It is **not** redone during movement, so jumps can't drag the floor along. Dropped when the phone moves (sensor: >2° or >25°/s), the video size changes, on **Re-lock room**, or after 60 s with nobody in view when there is no sensor. Depth: k = live / locked px-per-cm from limb sizes (0.4 s median). The floor line follows perspective (level-camera model, refined by "floor anchors" where the person stands still at a new depth). Uses the **raw** (unsmoothed) points. Jumps: both feet > 6 cm, back down within 1.2 s. height_airtime = g·t²/8 (corrected for the 6 cm threshold) vs feet peak; quality `ok` or `doubtful: …` (hips barely rose / depth changed mid-flight / the two disagree). |
| `public/bodybox.js` (removed) | Body box: a fixed coordinate frame on the floor, sized to the person. Origin = floor point between the feet. X in arm lengths (shoulder to wrist, longer arm; the box is X −1..+1). Y in leg lengths (hip to ankle, longer leg; 0 = floor, about 1 = standing hips). **Calibrates automatically** after 2 s standing straight and still with shoulders, hips, knees, ankles and one whole arm visible. Resets after 10 s with nobody in view. Uses a live px-per-cm scale (largest image/world ratio over visible segments). Drawn on the video as a dashed box with floor and hip-height lines. Needs a still camera. Logged as `<joint> box X/Y` + `calib` columns; Claude reads it with `read_motion_log columns:"box"`. Synthetic test: standing hips Y 1.00, deep squat 0.49, 25 cm jump 1.28, 40 cm sidestep X 0.75. |
| `public/mcp-bridge.js` | Sends live state (5/s) and snapshots (1/s) to `/state`, including raw `joints` (cm), `box` coordinates, `box_calib` and `selected_exercise` (only while an exercise-coach session runs). Runs the body box every frame and draws it. Connect-to-Claude button. **Logging needs "Share live tracking with Claude" ticked.** |
| `.env` / `.env.example` | `SUPABASE_URL` (a `/rest/v1/` suffix is stripped automatically), `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_...`), `SUPABASE_BUCKET=motion-logs`, `MOTION_USER`, `SESSION_GAP_MIN`. `.env` is gitignored; the user filled it in. |
| `models/` | `holistic_landmarker.task` (default), `pose_landmarker_heavy/full.task`, `hand_landmarker.task`, all bundled for offline use |

## Progress log

### 2026-11-07 (day 1)
1. **Pushed** the first phone-cam version to `backend` (merged with the teammates' RevGym UI and exercise code; commit `30d0760`).
2. **Claude coach** (headless `claude -p` after each set) was built, tested live, then **removed** at the user's request: "the app records, Claude interprets".
3. **Curl counting** changed from fixed 60°/145° lines to range of motion (real curls read about 103–138°).
4. **Motion log → Excel → Supabase:** one `.xlsx` per session, `<user>/<day>/<HH-MM>.xlsx`, new file after 15 min idle, upload retried on network drops. The first real upload failed because the URL ended in `/rest/v1/` (now stripped).
5. **Raw data only:** posture, gestures, events and rep guesses were removed from the file. It now holds 3D positions of 13 joints, 8 joint angles, the user's selected exercise (as a claim) and body-box coordinates.
6. **Hands and face permanently off** (still Holistic for body accuracy).
7. **Body box** with automatic calibration.
8. **Live tests, interpreted by Claude from the raw file alone:**
   - `guest/2026-11-07/17-38.xlsx`, 0–40 s: *seated, side-on (right side to camera), leaning forward, right arm bent about 90° in front like using a desk or computer, a forward reach at about 21 s, no exercise.* **User confirmed correct.**
   - Same file, 617–638 s: *standing, 4–5 right-arm bicep curls (left arm probably too), elbow about 57–70° at the top to 151–169° at the bottom, tempo speeding up (lift 1.4 s → 0.8–1.1 s), elbow drifting forward and up about 15 cm at the top, then a 5 s hold at about 91°. The body box calibrated at 634.8 s during the hold.* **User confirmed "exactly correct".**
   - Lesson: **stand still for 2 s before a set** so the box calibrates before the exercise, not after.
9. **Recording separator + upload hardening (confirmed working by user):** a pause of more than 10 s (`RECORDING_GAP_S`) inside a session starts a new recording: black row "Recording N starts" in the Motion sheet plus a `recording` column (also in MCP output). Supabase requests now time out after 30 s so a stalled upload can't block later ones.
10. **Not committed yet:** everything after step 1 is local only (the user said "not yet").

### 2026-11-07 (day 1, late): precision + room lock
11. **Room lock** replaces the body box (`public/roomlock.js`, see Files). Viewer has a "Your height (cm)" box (optional, makes the cm exact) and a **Re-lock room** button.
12. **Phone sensors → PC** (`/sensor`): gravity for true vertical, rotation for "the phone moved".
13. **Every frame logged** (~30/s instead of 5/s), with raw angles next to smoothed, heels/toes added, ms timestamps, and a Jumps sheet. `read_motion_log` has new column sets `room` and `raw_angles` (`box` = `room`, for old files) and always lists jumps in the range, even when rows are thinned out.
14. **Synthetic test** (175 cm person, camera rolled 4°, 30 fps, ±0.6 px noise; script at `C:\Users\Arnav\AppData\Local\Temp\claude\df4bcd3058e4ae04\5869c35f-cdd6-4760-97ee-ef12e311e214\scratchpad\roomlock-test.mjs`): true 30/15/45/25 cm jumps measured as 30.0/14.9/45.0/24.9 cm from air time, feet peak within 1 cm, standing hips 91–92 cm (true 92), still right after walking back to 1.3× distance. A sudden "teleport" step back is flagged `doubtful`. The phone-moved check drops the lock. End to end in the browser pipeline → server → Excel → MCP: 30 and 20 cm jumps read back as 30.6 and 20.0 cm.
15. **Not tested on a real phone yet**: sensor sign/orientation on real devices (the PC checks the sign against the body, but landscape and front-camera handling are unverified), real MediaPipe foot noise, and Excel size for long sessions at 30 rows/s (~27k rows per 15 min).
16. Test server (`datathon-phone-cam-test`) now runs with `SUPABASE_URL=` (upload off), `MOTION_USER=test` and `MOTION_LOG_DIR` in the scratch folder, so it can't touch real data.

### 2026-11-07 (day 1, night): fixes from the first real room-lock session
Real session `guest/2026-11-07/18-50.xlsx`: 7 slow one-arm curls side-on (elbow ~150° → 85–89°, deepest 76°, ~2.4 s per rep, upper arm still), then ~13 s standing. Three bugs showed up:
17. **Room lock never locked side-on.** It required both shoulders, hips, knees and ankles. Fixed: one visible side per body part is enough, the standing check uses whichever knee/hip angles are visible (> 158°), and the lock records `view: side-on | facing`. Synthetic side-on test (far side hidden, knee reading 168°): 30/15/45/25 cm jumps → 30.0/14.9/44.9/25.1 cm, standing hips 91 cm (true 92).
18. **Whole-body left/right swap side-on** (11.7–16.5 s: the near arm became "left"). The old continuity check needs both sides visible, so it couldn't help. New `sideOnSwap` in `tracker.js`: side-on, facing right in the picture means the person's right side is nearer (facing left → left). If the model's nearer side (world z of shoulder + hip) disagrees, the labels are swapped back. On the real log it flags exactly 11.52–16.52 s and the 19.49–19.59 s blip, and nothing else in 405 side-on rows (script at scratchpad `sideon-check.js`).
19. **Only ~11 fps.** Measured: Holistic itself takes ~80 ms a frame with a body in view; our code is ~1 ms; the separate accurate model takes ~33 ms. But the separate model lost seated and side-on people on the test set (posture answered 68/504 vs Holistic 477/504). New **Auto = hybrid**: the accurate separate model every frame, and Holistic for 2 s whenever it finds nobody. Test clips: standing/lunge and side-on sitting with hand on forehead ~24–25 fps on the fast model; the seated side-on clip it loses runs on Holistic (~12 fps, same as before). The active model shows next to the fps. Also: face blendshapes turned off (unused), the body-outline mask check runs every 6th frame for an already-confirmed person, and `out.timing` / `window.trackTiming` give per-frame ms (model / ours / listeners).
20. Still unverified on the real phone: whether the fast model keeps a standing side-on person (if not, Auto falls back to Holistic and stays ~12 fps), and the phone sensor in real use.

### 2026-11-07 (day 1, late night): second real room-lock session
Session `guest/2026-11-07/19-04.xlsx` (side-on, ~13 fps, room locked side-on at 9.3 s, no phone sensor): 6 right-arm curls (5.3–16.1 s, elbow ~170° → 77–88°), still stand, then ~5 jumps 22.4–28.5 s (two of ~18–20 cm by air time/feet rise, three small hops ~5–10 cm), then stepped ~20 cm sideways and stood still.
21. **The floor drifted** ~19 cm in 20 s (standing still read foot_cm 19, so "air" never ended and most jumps were swallowed). Cause: the size-based depth factor drifted (0.98 → 0.90) while the person barely moved; the old estimator took the largest 3 segment ratios (biased upward) and the level-camera floor model amplifies a few % of error into cm. Also floor anchors could never fire side-on (they needed both knee angles) or once the feet already read "air".
   Fixes in `roomlock.js`: (a) depth from each segment against its own size at the lock (`seg0`, `kFrame`); (b) depth frozen only during a real flight (feet AND hips up), never on feet-only "lifts" (stepping back looks like that until the depth catches up); (c) **floor re-set on every still stand** (feet steady 0.8 s, visible knees > 155°): you can't hover, so the feet are on the floor; corrections over 25 cm are refused (standing on something). A low step you stand still on becomes the floor.
   Synthetic drift test (side-on, 13 fps, model limb sizes shrinking 3–12%): standing feet read ~0 cm at the end (was the 19 cm drift), 8/20/18 cm jumps found (10.5/25.5/23.6 by air time: at 13 fps air time over-reads a few cm). All earlier scenarios still pass (30/15/45/25 cm within ~0.6 cm at 30 fps).
22. **No phone sensor arrived**: static pages were served with no cache header, so the phone likely kept the old phone.html. Our .html/.js are now `Cache-Control: no-cache`. Reload the phone page once.
23. A **`model` column** is logged per frame (fast body model vs Holistic), so the next log shows why the fps is what it is.

### Next steps
- **Real jump test:** phone on a stand, enter your height, stand still 2 s (wait for "Room locked"), then jump onto/over something of known height and compare with the Jumps sheet.
- Use 2D (image) angles when side-on, to fix the knee depth bias (known issue 1).
- Test squats plus a second exercise in one session, standing still first so the room lock covers the sets.
- Commit and push to `backend` when the user says so.
- Layer 3: train an exercise recognizer on the logged sessions (raw angles/positions + Claude's or the user's labels).
- Optional: a login/user picker (for now `MOTION_USER` or `POST /motionlog/user`); remove body-based wave/clap/nod from the brain if unwanted.

## Pipeline and key decisions

- **Body only (permanent):** hands and face are locked off (`BODY_ONLY` in `tracker.js`). No hand or face landmarks are output, drawn, described, logged or sent to Claude, and the Hands/Face checkboxes are gone. Auto still uses **Holistic** for the body. Its internal hand and face results are used only inside `tracker.js` to reject false bodies and keep left/right straight. Waving, clapping and nodding are still inferred from body points (wrists and head); remove them in `brain-core.js` if unwanted. Speed rows are now L/R wrist and L/R ankle. The test-set evaluator compares body setups only (Holistic, accurate, fast).
  - Why: on the test set, Holistic scored **87% vs 57%** on the shared fields (posture/facing/head), because the separate body model loses seated and side-on people.
  - Holistic finds no hands without a body, so the standalone hand model is the close-up fallback.
- **Ghost-body rejection** (`isRealPerson`):
  - Hand covering more than 7% of the frame → close-up → no body.
  - Face landmarks inside a hand box → palm mistaken for a face (only for *new* bodies; a confirmed person can touch their face).
  - 3D proportions: shoulder width vs torso, or vs head when the hips are out of view.
  - Body-outline mask must cover the torso.
  - Only the **shoulders** are required, so head-and-shoulders close-ups are allowed.
  - Hidden hands still run every 3rd frame purely as a guard.
- **Stability:**
  - A new person needs 3 good frames in a row (1 if seen within the last second); a confirmed person survives 4 soft misses.
  - Gaps up to 0.3 s are bridged with a predicted, faded pose.
  - One-Euro smoothing.
  - MediaPipe timestamps are kept strictly increasing (live clock and evaluator clock are merged).
- **Left/right consistency:**
  - Tracker: the whole-body swap is checked against the face mesh (shoulders must match the cheek direction) and continuity (limbs can't teleport).
  - Brain: each hand gets a persistent identity (followed by position) with weighted votes and hysteresis. It says "Hand" when unsure, and memory scales with the frame rate.
  - Left/right always means the **person's own** side. Frames are never mirrored.
- **Brain output:**
  - Text sections (In view, Body, Arms, Legs, Head, Face, Hands, Movement).
  - A headline drawn on the video.
  - Events.
  - Counters: squats, curls, jumping jacks, jumps, claps.
  - Curls are counted by range of motion: the elbow closes 30° from its most-open angle in the last 3 s (ending below 125°), then opens 22°, with the upper arm within 60° of the side. The old fixed 60°/145° lines missed real curls (about 103–138° on camera) and could get stuck. Tested on simulated angle traces only.
  - `facts`: canonical values for scoring: posture, facing, head turn/pitch, hands {zone, gesture}, activities, expressions.
- **Motion:**
  - Per-part rates: raising/lowering arms, bending knees, turning head, hands/feet direction in m/s, toward/away from the camera.
  - A motion must appear on 2 frames in a row.
  - Gestures are ignored while a hand moves fast or is predicted, and must hold for 0.5 s.
  - Jumps only count while standing with feet visible.

## Test set and evaluation

- **Labels per clip:** posture, facing, head turn/pitch, each hand's zone and gesture, activities (unticked = must not be detected), squat/jump counts, notes.
- **Hand-zone vocabulary:** face, head, overhead, chest, waist, hip, lap, down, not visible.
- **Evaluation:** steps through each clip frame by frame (10/15/30 fps sampling), compares setups (all on / body only / body + hands / Holistic body only / fast body), and saves a report to `testset/reports/`.
- **Current set:** 6 clips made from still photos, in the scratch folder `C:\Users\Arnav\AppData\Local\Temp\claude\02a2f7282f6b633c\052f888a-4b69-414b-b7c7-7b186dc7f631\scratchpad\testset`, not the app's folder. **Too small to trust: record 20–30 real clips.**

## Known issues / open items

1. **Knees read as "slightly bent" (~150°) when standing straight.** A depth bias in the 3D knee angle. Planned fix: also use thigh and shin direction to decide straight vs bent.
2. **Holistic head turn is weak on small faces** (51% vs 94% for the separate model). Planned fix: use the face-mesh yaw only when the face is large enough, otherwise nose and ears.
3. **Phantom arms in extreme close-ups:** the model invents an out-of-frame arm. Planned fix: cross-check with the standalone hand model, and mark arm positions "uncertain" when a detected hand is far from both wrists. Best fix: step back so both shoulders and elbows are in frame.
4. **Noisy timeline at low fps / small people:** nodding, shaking, waving and palm flips are too sensitive. Planned "event quality layer":
   - minimum duration and size per event,
   - fps-aware windows,
   - mutually exclusive events,
   - a quality gate.
5. **Gestures from rules are brittle:** "pinch" when typing or holding a dumbbell. Option: MediaPipe Gesture Recognizer (trainable).
6. **Screen capture of a whole browser window:** the person is small, and YouTube can capture black (hardware acceleration). Idea: a crop-to-video option.
7. **Not yet verified in the real Electron app:** the screen picker, auto-save, Connect to Claude against real configs, and live phone tests of the newest changes.

## The "brain": where we are and next steps

- **Done:** layer 1 "eyes" (MediaPipe), layer 2 "describer" (rules, live panel only), the raw motion log, and the MCP tools for Claude:
  - live: `get_current_state`, `get_recent_activity(seconds)`, `get_timeline(limit)`, `get_joint_angle_history(joint, seconds)`, `get_snapshot`
  - recorded: `list_motion_logs(user?, day?)`, `read_motion_log(path, from_s, to_s, columns=angles|positions|box|all, max_rows)`
- **Next options discussed:**
  - **Layer 3, Recognizer:** our own trained model (GRU or 1D-CNN on landmark sequences) for activities and reps. Training data comes from the Record JSON or test clips. This is the datathon "we trained a model" piece.
  - **Layer 4, Reasoner (done, verified live):** Claude reads the motion logs via MCP. Two live sessions were interpreted correctly (see Progress log). Synthetic test: a 30 s recording (8 right curls while seated, user selected "squat"). From raw angles alone, Claude answered "8 right-arm curls, seated, does not match squat" with evidence. The per-set auto-coach (`coach.js`) was removed at the user's request.
- **Still needs deciding:** the app's purpose drives the brain. Options: fitness coach, physical therapy / rehab, gesture control, safety/monitoring, or general activity narration.

## Connect Claude manually (if the button isn't used)

```bash
claude mcp add --transport http --scope user phone-cam http://localhost:8080/mcp
```

Claude Desktop config entry, if Node is installed:

```json
"phone-cam": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:8080/mcp"] }
```

## Git

Repo `github.com/Aaaaa-hashdad/Datathon-1`, branch `backend` (shared with teammates; other branches: `Login` (RevGym FastAPI + Supabase backend), `front-end`, `backend2`). Last push: `30d0760`. Everything since then is **uncommitted**. Always `git pull --no-rebase --no-edit origin backend` before pushing; teammates push too.

`phone-cam/.gitignore` excludes `certs/`, `node_modules/`, `testset/`, `motion-logs/` and `.env`. The models (about 60 MB total, each under 100 MB) are included so the app works offline.

## Dev notes for Claude

- To test without disturbing the user's running app, use the launch config `datathon-phone-cam-test` in `projects\TamuHack\.claude\launch.json`: ports 8090/8453, with `TESTSET_DIR` set to the scratch test set.
- `window.phoneCamTracker`: `process(src, w, h, clock)`, `reset()`, `switchPipeline(choice)`, `setOpts({...})`, plus getters `pipeline`, `opts` and `ready`.
- `window.camSource`: `pause()`, `rawStream()`, `activeVideo()`, `wantsPictures()`, `mode`.
- `window.brain` / `window.brainState`: brain instance and latest output (`facts`, `sections`, `events`, `counters`).
- **The test server reads the real `phone-cam/.env`, so it uploads to the real Supabase.** Untick "Share live tracking" in the test page, or start it with `SUPABASE_URL=` set to empty (an empty value now means off). Clean up any test folders in the bucket afterwards (only `guest/` is real data).
- Real logs live in `C:\Users\Arnav\Videos\phone-cam\motion-logs\guest\2026-11-07\` and in Supabase Storage `motion-logs/guest/2026-11-07/`.
- Prefer reading logs through the phone-cam MCP tools (`read_motion_log path:"current"`), the same way the demo will.
- The user prefers general fixes over per-screenshot patches, and decisions measured with the test set.
