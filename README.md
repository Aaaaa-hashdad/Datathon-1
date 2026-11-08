<p align="center">
  <img src="ui/assets/reveille-head.png" alt="RevGym Reveille logo" width="110">
</p>

<h1 align="center">RevGym</h1>

<p align="center">
  <strong>Move with purpose.</strong><br>
  Turn everyday exercise into measurable progress.
</p>

---

## What is RevGym?

You finish a set—but how consistent were your reps? Did your range of motion change? What could you improve next time?

**RevGym connects a phone camera, computer-vision tracking, and workout analysis to help answer those questions.**

Built for **TAMU Datathon 2026**, RevGym captures movement measurements from real exercise sessions, turns those measurements into feedback, and lets users explore their workout history through personal statistics, downloadable data, and leaderboards.

Your phone captures the movement. Your computer brings the results together.

## The experience

### A welcome screen with a little personality

RevGym opens with a rotating, transparent maroon dumbbell, a clean white background, and three ways to enter:

- **Sign Up** — create a profile.
- **Log In** — return to your account.
- **Guest Log In** — enter the judge guest flow without completing registration.

The animation includes a pause control and respects reduced-motion preferences.

### Record your movement

Use a camera on your computer or connect your phone through the app’s QR flow.

MediaPipe estimates body landmarks, and the tracking pipeline derives measurements such as joint angles, body positions, and movement over time. Camera placement, lighting, visibility, and calibration affect the results.

### Get feedback from your set

Request feedback after collecting a set. The analysis pipeline uses recorded measurements to identify exercise segments and report observations about:

- Repetitions.
- Range of motion.
- Tempo.
- Consistency across repetitions.
- Left/right movement differences when the measurements support comparison.
- Jump measurements that pass the application’s quality checks.

The current integrated feedback flow uses **Claude Code**, installed and authenticated on the computer running RevGym.

### Explore your progress

| Screen | What you can do |
|---|---|
| **Record** | Choose a camera source, capture movement, and request feedback. |
| **Personal Statistics** | Review active days, sets, analyzed reps, recorded movement time, range-of-motion trends, and available jump measurements. |
| **Leaderboard** | Compare published, analyzed sets by exercise and period. |
| **Data** | Browse session workbooks, filter by recording date, and download original measurements. |
| **Settings** | Manage the judge guest-number counter. |

Recorded sets and analyzed sets are separate: a recording can exist before its exercise and rep results have been analyzed.

## How it works

```text
Phone or computer camera
           │
           ▼
MediaPipe body tracking
           │
           ▼
Joint angles, positions, timestamps and quality signals
           │
           ▼
Session workbooks
           │
           ▼
Requested workout analysis
           │
           ├── Coaching feedback
           ├── Personal statistics
           └── Published workout leaderboard
```

The application combines three main components:

- **Frontend:** the welcome page, authentication forms, recording interface, statistics, data archive, and settings.
- **Phone-camera service:** camera streaming, browser-based tracking integration, motion logging, analysis requests, and workout reports.
- **Python backend:** accounts, sessions, profiles, guest access, and persisted leaderboard results.

The Electron launcher starts the local services and opens the application.

## Tech stack

| Layer | Technologies |
|---|---|
| Interface | HTML, CSS, JavaScript |
| Desktop launcher | Electron |
| Camera and tracking | MediaPipe, WebRTC, HTTPS, JPEG fallback |
| Local camera service | Node.js |
| API | FastAPI, Uvicorn |
| Database access | SQLAlchemy |
| Database | SQLite locally; optional Supabase PostgreSQL |
| Session exports | ExcelJS and `.xlsx` workbooks |
| Requested feedback | Claude Code CLI |
| Optional workbook storage | Supabase Storage |

## Run RevGym locally

### Prerequisites

- Git.
- Node.js 22 LTS recommended, with npm.
- Python 3.11 or newer, with virtual-environment support.
- A desktop environment capable of running Electron.
- A camera-equipped phone or computer.

For generated workout feedback, also install and authenticate
[Claude Code](https://code.claude.com/docs/en/setup) in the same environment that launches RevGym. The `claude` command must be available there.

### 1. Clone the integrated branch

```bash
git clone --branch Working-End-to-End https://github.com/Aaaaa-hashdad/Datathon-1.git
cd Datathon-1
```

If the repository is already cloned, switch to the branch and update it after saving your local work.

### 2. Install dependencies

**Linux, macOS, or WSL:**

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
npm --prefix phone-cam install
```

**Windows PowerShell:**

```powershell
py -3 -m venv backend/.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
npm --prefix phone-cam install
```

### 3. Start the application

From the repository root:

```bash
npm start
```

The Electron window should open automatically. The launcher starts or reuses the Python backend and starts the phone-camera service.

The web interface is available at:

**http://localhost:8000/ui/**

Keep the launching terminal open. Avoid starting another copy of the camera server on the same ports.

### Local addresses

| Service | Default address |
|---|---|
| RevGym web interface | `http://localhost:8000/ui/` |
| Backend API documentation | `http://localhost:8000/docs` |
| Phone-camera service | `http://localhost:8080/` |
| Phone camera page | `https://<computer-LAN-IP>:8443/phone` |

## Connect your phone

1. Connect your phone and computer to the same Wi-Fi network.
2. Start RevGym and sign in or use Guest Log In.
3. On the Record screen, choose **My phone**.
4. Follow the QR/pairing instructions.
5. Open the phone camera page, allow camera access, and start streaming.
6. Place the phone somewhere stable with your body clearly visible.

The phone camera uses HTTPS. Local development uses a self-signed certificate, so the browser may display a warning when opening your own server.

For clearer measurements:

- Use good lighting.
- Keep the relevant joints visible.
- Start approximately 6–10 feet from the camera and adjust for framing.
- Follow the application’s standing-still/calibration instructions.
- Record one set at a time.

Some campus and guest Wi-Fi networks prevent devices from communicating. A shared personal hotspot may work better.

## Accounts and guest access

Registered users have profiles and saved results associated with their accounts.

Guest Log In uses sequential judge accounts such as **Judge1**, **Judge2**, and **Judge3**. The Settings screen can reset the counter.

**Resetting the judge number does not delete existing data.** Guest access should not be treated as an automatically erased or anonymous session.

## Your movement becomes a dataset

RevGym’s dataset comes from captured movement measurements. The pose-estimation model is pretrained; the session records are collected through the application.

A session workbook contains:

| Sheet | Contents |
|---|---|
| **Summary** | Session details, sample counts, recording information, calibration details, and field explanations. |
| **Motion** | Timestamped body positions, joint angles, tracking status, model information, and recording identifiers. |
| **Jumps** | Detected jump timing, estimated heights, supporting measurements, and quality indicators. |

Examples of recorded fields include:

- Recording number and elapsed time.
- Body-joint coordinates.
- Raw and smoothed elbow, shoulder, hip, and knee angles.
- Calibration and floor-relative measurements when available.
- Tracking visibility/status information.
- The user-selected exercise, stored separately from the inferred exercise.
- Jump airtime and quality measurements.

Missing measurements remain blank rather than being treated as zero. Coordinate and angle conventions are documented inside the workbook.

Analysis results are saved separately in `analyses.json`. The integrated analysis schema uses **form scores from 1–10**.

### Local storage

When launched through Electron, motion logs are stored beneath the operating system’s Videos directory:

```text
phone-cam/
└── motion-logs/
    └── <user>/
        ├── analyses.json
        └── <YYYY-MM-DD>/
            └── <HH-MM>.xlsx
```

The standalone camera service can use a different location through `MOTION_LOG_DIR`.

Session workbooks contain derived measurements rather than camera footage.

### Sharing a dataset

Before publishing collected sessions, obtain participant consent, anonymize identifying fields, and document:

- Collection dates and setting.
- Camera placement and calibration.
- Participant and session counts.
- Exercises performed.
- Missing or excluded recordings.
- Field definitions, processing steps, and limitations.

Keep real observations clearly separated from synthetic test inputs and sample UI data. Generated session files are not automatically committed to this repository.

## Optional Supabase configuration

RevGym can run locally with SQLite and local workbook storage.

For cloud persistence:

1. Copy `backend/.env.example` to `backend/.env`.
2. Set `DATABASE_URL` to the PostgreSQL connection string.
3. Copy `phone-cam/.env.example` to `phone-cam/.env`.
4. Set the storage configuration if workbook uploads are desired.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Backend database connection; blank uses local SQLite. |
| `SUPABASE_URL` | Supabase project URL for workbook storage. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side storage credential. |
| `SUPABASE_BUCKET` | Workbook bucket; defaults to `motion-logs`. |
| `FEEDBACK_MODEL` | Claude Code model selector; defaults to `sonnet`. |

Database persistence and workbook storage are configured separately. Analysis JSON is stored locally in the current implementation.

**Never commit `.env` files or service-role credentials.**

When feedback is requested, a compact subset of movement measurements is passed to Claude Code for analysis. Include this processing in participant consent and data-handling decisions.

## Leaderboards

The workout leaderboard uses each person’s best published, analyzed set for the selected exercise and period.

Entries are ordered by:

1. Form score, highest first.
2. Rep count, highest first.
3. Username for otherwise equal entries.

Use **Publish my saved sets** to publish available analyzed results.

These rankings reflect the application’s estimates and captured sessions; they are not a validated comparison of overall fitness.

## Repository layout

```text
Datathon-1/
├── backend/
│   ├── app/                  # API, accounts, database and leaderboard
│   │   └── static/           # Welcome and authentication pages
│   ├── tests/                # Backend tests
│   ├── requirements.txt
│   └── run.py                # Standalone backend launcher
├── phone-cam/
│   ├── public/               # Tracking, camera and report interfaces
│   ├── models/               # Bundled MediaPipe models
│   ├── test/                 # JavaScript analysis tests
│   ├── server.js             # Camera service and integration routes
│   ├── main.js               # Electron launcher
│   ├── motionlog.js           # Session workbook generation
│   ├── feedback.js            # Requested workout analysis
│   └── stats.js               # Personal statistics
├── ui/                       # Main application interface
├── Images/                   # Project artwork
├── package.json              # Root application launcher
├── DATA_APPLICATION.md
└── PROJECT.md
```

## Tests

Run backend tests from `backend/`:

```bash
cd backend
source .venv/bin/activate
python -m pytest
```

On Windows, activate `.venv\Scripts\Activate.ps1` instead.

Run the JavaScript analysis tests from the repository root:

```bash
node --test phone-cam/test/analysis.test.mjs
```

Automated tests do not replace real-camera testing or manual review of generated feedback.

## Troubleshooting

| Issue | What to check |
|---|---|
| Missing Python module | Install `backend/requirements.txt` using the backend virtual environment. |
| Electron reports `libnspr4.so` missing | On Ubuntu/WSL, install `libnspr4` and `libnss3`. |
| Electron reports `libasound.so.2` missing | Install `libasound2t64` on newer Ubuntu releases, or `libasound2` on older releases. |
| Electron cannot open a window in WSL | Check that GUI support such as WSLg is available. |
| Phone page times out | Check shared Wi-Fi, firewall access, and the computer’s reachable LAN IP. WSL may require port forwarding. |
| Camera does not start | Check HTTPS and browser camera permissions. |
| Feedback cannot run | Check that Claude Code is installed, authenticated, and available in the app’s environment. |
| Statistics show zero reps | Record a usable set and analyze it; rep totals depend on saved analysis. |
| Leaderboard is empty | Analyze a set, publish saved results, and check the exercise/period filters. |

## Current limitations

RevGym is a hackathon prototype.

- Joint angles and positions are estimates affected by viewpoint, occlusion, lighting, frame rate, and calibration.
- Tracking may miss or misinterpret movement.
- Generated feedback can misidentify exercises or repetitions and should be reviewed.
- Jump measurements require reliable tracking and calibration; only quality-approved measurements should be interpreted.
- Some development/demo paths still contain sample data.
- Form scores are experimental and are not medical advice or a substitute for a qualified coach.

The goal is to make movement easier to inspect, understand, and improve—with the original measurements available for review.

---

<p align="center">
  <strong>RevGym — Move with purpose.</strong><br>
  Built for TAMU Datathon 2026.
</p>