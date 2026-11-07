# Datathon: Phone Camera body tracker (context to continue)

Last updated: 2026-11-07. Paste or point Claude at this file to pick up where we left off.

## What it is

An Electron desktop app, `phone-cam/`, that:

1. Streams a **phone camera** to the PC: WebRTC video at 30 fps, falling back to JPEG pictures.
2. Tracks **body, hands and face** with MediaPipe, running locally and offline.
3. A rule-based **"brain"** describes in detail what the person is doing: posture, arms, legs, head, hand positions and gestures, expressions, movement, reps and an event timeline.
4. Has a **test set + evaluator** to measure accuracy with numbers instead of judging screenshots.
5. Exposes everything to **Claude via MCP** (5 tools), with a one-click "Connect to Claude" button.

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
| `mcp.js` | MCP server (Streamable HTTP, JSON replies). Local-only plus Origin check. Keeps 3 min of state history. |
| `mcp-stdio-bridge.js` | stdio↔HTTP bridge so Claude Desktop can use the server. Runs with the app's own exe (`ELECTRON_RUN_AS_NODE=1`). |
| `connect-claude.js` | Registers or removes `phone-cam` in Claude Code (`claude mcp add --scope user`, else `~/.claude.json`) and Claude Desktop (`claude_desktop_config.json`). Backs up to `*.bak-phonecam`. Test with `PHONECAM_TEST_HOME`. |
| `public/phone.html` | Phone page: camera, WebRTC sender with picture fallback (2 uploads in flight), flip/quality |
| `public/viewer.html` | PC viewer UI: canvas, sidebar (video source, Claude MCP, brain, tracking toggles, angles, speeds), Record, Test set panel |
| `public/sources.js` | Video sources (phone WebRTC receiver / screen / video file), recorder (annotated MP4 + per-frame JSON), `window.camSource` |
| `public/tracker.js` | MediaPipe pipelines, ghost-body checks, left/right consistency, smoothing, gap bridging, drawing, `window.phoneCamTracker` API |
| `public/brain-core.js` | The brain (pure logic, no DOM): describes everything, structured `facts`, events, counters |
| `public/brain.js` | Connects the brain to the UI: caption on the video, side panel, timeline |
| `public/eval.js` | Test-set panel: label form, raw test-clip recording, clip list, evaluation and reports |
| `public/mcp-bridge.js` | Sends live state (5/s) and snapshots (1/s) to `/state`; Connect-to-Claude button |
| `models/` | `holistic_landmarker.task` (default), `pose_landmarker_heavy/full.task`, `hand_landmarker.task`, all bundled for offline use |

## Pipeline and key decisions

- **Model:** Auto = **Holistic** always (body + both hands + face in one model). The Body / Hands / Face checkboxes only choose what's shown and described. The menu can force "Separate accurate/fast" for comparison.
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

- **Done:** layer 1 "eyes" (MediaPipe), layer 2 "describer" (rules), and the MCP tools for Claude:
  - `get_current_state`
  - `get_recent_activity(seconds)`
  - `get_timeline(limit)`
  - `get_joint_angle_history(joint, seconds)`
  - `get_snapshot`
- **Next options discussed:**
  - **Layer 3, Recognizer:** our own trained model (GRU or 1D-CNN on landmark sequences) for activities and reps. Training data comes from the Record JSON or test clips. This is the datathon "we trained a model" piece.
  - **Layer 4, Reasoner:** Claude, via MCP (done) or the API, for coaching, insight and conversation.
- **Still needs deciding:** the app's purpose drives the brain. Options: fitness coach, physical therapy / rehab, gesture control, safety/monitoring, or general activity narration.

## Connect Claude manually (if the button isn't used)

```bash
claude mcp add --transport http --scope user phone-cam http://localhost:8080/mcp
```

Claude Desktop config entry, if Node is installed:

```json
"phone-cam": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:8080/mcp"] }
```

## Git (not pushed yet)

The target is `github.com/Aaaaa-hashdad/Datathon-1`, branch `backend`, which was empty when checked.

```bash
cd C:\Users\Arnav\Desktop\Datathon
git init
git checkout -b backend
git remote add origin https://github.com/Aaaaa-hashdad/Datathon-1.git
git add .
git commit -m "Phone camera body tracker: MediaPipe Holistic, brain, test set, MCP"
git push -u origin backend
```

`phone-cam/.gitignore` excludes `certs/`, `node_modules/` and `testset/`. The models (about 60 MB total, each under 100 MB) are included so the app works offline.

## Dev notes for Claude

- To test without disturbing the user's running app, use the launch config `datathon-phone-cam-test` in `projects\TamuHack\.claude\launch.json`: ports 8090/8453, with `TESTSET_DIR` set to the scratch test set.
- `window.phoneCamTracker`: `process(src, w, h, clock)`, `reset()`, `switchPipeline(choice)`, `setOpts({...})`, plus getters `pipeline`, `opts` and `ready`.
- `window.camSource`: `pause()`, `rawStream()`, `activeVideo()`, `wantsPictures()`, `mode`.
- `window.brain` / `window.brainState`: brain instance and latest output (`facts`, `sections`, `events`, `counters`).
- The user prefers general fixes over per-screenshot patches, and decisions measured with the test set.
