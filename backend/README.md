# RevGym

A PC app for checking your lifting form. **The PC is the app**: log in, see the leaderboard, watch your phone's camera live, and start or stop recording. **Your phone is the camera**: scan a QR code once and it links itself.

- **Data:** Supabase Postgres holds accounts, scans and the leaderboard. Videos go to a private Supabase Storage bucket. With no Supabase settings it falls back to a local SQLite file and `backend/uploads/`, which the tests use.
- **Live camera:** the phone streams straight to the PC over your Wi‑Fi with WebRTC. Video never passes through Supabase or any other server. Recordings are made on the phone at full quality and uploaded when you stop.

## 1. Set up Supabase (once)

1. Create a project at [supabase.com](https://supabase.com).
2. Copy `.env.example` to `.env` in this folder and fill in:
   - `DATABASE_URL`: **Project Settings → Database → Connection string → Session pooler**, with your database password filled in.
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: **Project Settings → API**.
3. That's it. On first start RevGym creates its tables, turns on row level security for them, and creates the private `recordings` bucket.

`.env` is in `.gitignore`. The service role key bypasses all of Supabase's security, so it must never go into the web pages or the phone page, and never into git. Only this Python server uses it.

## 2. Run it on your PC

```bash
python -m venv .venv
.venv\Scripts\activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python seed.py                # optional demo accounts + leaderboard data (goes to Supabase if configured)
python run.py
```

`run.py` starts two things:

| | Address | Who uses it |
|---|---|---|
| PC app | http://127.0.0.1:8000 | this PC only |
| Phone camera | https://*your-PC's-Wi‑Fi-IP*:8443/phone | your phone, via the QR code |

Phones only allow live camera access over HTTPS, so on first run `run.py` makes a self-signed certificate for this PC (in `certs/`). The first time, your phone will warn that the connection isn't private. Tap **Advanced → Proceed**. Windows may also ask to let Python through the firewall. Allow it on **Private** networks only.

Demo accounts from `seed.py` use the password in `DEMO_PASSWORD` in that file. API docs: http://127.0.0.1:8000/docs. Tests: `pytest`.

## 3. Use it

1. Log in on the PC and click **Link a phone**. A QR code appears.
2. Scan it with your phone's camera. The RevGym camera page opens, links itself, and turns on the back camera.
3. The PC's **Live camera** panel shows what the phone sees. Pick the lift and click **Start recording**, then **Stop recording**. You can also tap Record on the phone.
4. The video uploads and appears under **Recordings** on the PC, ready to play.

QR codes last 10 minutes, work once, and a new one cancels the old one. The code is in the link's `#` part, which browsers never send to servers or logs. A linked phone can only stream and upload. It can't see your account or the leaderboard, and you can unlink it from the PC anytime.

If the phone can't reach the PC, check that both are on the same Wi‑Fi. Some campus and guest networks block devices from talking to each other. A phone hotspot shared with the PC works.

## How scans become leaderboard data

Pose analysis isn't built yet, so recordings show **Not analyzed yet**. Once it is, it will turn each recording into a scan via `POST /scans`:

```json
{"exercise": "bench_press", "weight_lb": 185,
 "reps": [{"form_score": 94, "angles": {"elbow_tuck": 58}}, {"form_score": 74, "angles": {"elbow_tuck": 72}}]}
```

- **Set form score:** the average of the rep scores. **Qualified** at 80 or higher.
- **Points:** the form score, rounded, or 0 if not qualified.
- **Leaderboard:** `GET /leaderboard?exercise=all|<lift>&period=week|all_time`. All lifts ranks total points. A single lift ranks the best qualifying set by weight, then reps, then form. Ties share a rank. With a login token, `me` shows your own rank and the gap to the next person.

## API overview

| Who | Endpoint | What |
|---|---|---|
| anyone | `POST /auth/register`, `POST /auth/login` | Returns a login token (`Authorization: Bearer …`) |
| PC | `GET /auth/me`, `POST /auth/logout` | |
| PC | `POST /devices/pair-code` | QR code (`qr_svg`) + phone link |
| phone | `POST /devices/pair` | Trades the code for a device token (`X-Device-Token`) |
| PC | `GET /me/devices`, `DELETE /me/devices/{id}` | Linked phones, with live status |
| PC | `POST /me/devices/{id}/live/offer`, `GET …/live/answer`, `POST …/live/command` | Live view setup and record/stop |
| phone | `POST /device/live/poll`, `POST /device/live/answer` | Phone checks in once a second |
| phone | `POST /recordings` | Upload a video (`exercise`, `video`) |
| PC | `GET /me/recordings`, `GET /me/recordings/{id}/play` | List, plus a 15-minute play link |
| PC | `POST /scans`, `GET /me/scans` | Analysed sets |
| anyone | `GET /leaderboard`, `GET /exercises`, `GET /health` | `/health` shows whether Supabase is in use |

## Security notes

- Passwords are hashed with scrypt. Login and phone tokens are stored only as SHA‑256 hashes.
- The PC app listens only on 127.0.0.1. Only the HTTPS phone port is reachable from the network.
- RevGym's tables in Supabase have row level security on with no policies, so Supabase's public REST API can't read them. Only this server, connecting as the database owner, can.
- The Storage bucket is private. Videos are shared only through signed links that expire after 15 minutes, and only for your own recordings.
- Still missing: rate limits on login and pairing.
