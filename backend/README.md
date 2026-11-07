# RevGym

A PC app for checking your lifting form. **The PC is the app**: sign up or log in, see the leaderboard, and watch your phone's camera live. **Your phone is the camera**: scan a QR code once and it links itself.

- **Data:** Supabase Postgres holds accounts and profiles, logins, scanned sets and the leaderboard. With no `DATABASE_URL` it falls back to a local SQLite file, which the tests use.
- **Live camera:** the phone streams straight to the PC over your Wi‑Fi with WebRTC. **No video or files are recorded or stored anywhere.**

## 1. Set up Supabase (once)

1. Create a project at [supabase.com](https://supabase.com).
2. Copy `.env.example` to `.env` in this folder and set `DATABASE_URL`: click **Connect** at the top of the project → **Connection string** → Method **Session pooler**, with your database password filled in.
3. That's it. On first start RevGym creates its tables (or adds new columns to existing ones) and turns on row level security for them.

`.env` is in `.gitignore`. It holds your database password, so never put it in git or chat.

## Sign up and log in (stored in Supabase)

**Sign up** asks for a username and password, plus:

| Field | Saved as (`users` table) | Rules |
|---|---|---|
| Graduation year | `grad_year` (e.g. 2027) | shown in the UI as "Class of '27" |
| Major | `major` | 2–80 characters (suggestions offered) |
| Gender | `gender` | `female`, `male`, `nonbinary`, `other` or `prefer_not_to_say` |
| Height | `height_in` (total inches) | entered as feet + inches, 3–8 ft |
| Weight | `weight_lb` | 50–700 lb |
| Date of birth | `birth_date` | at least 13 years old |

All six are required at sign-up. **Log in** needs only the username and password.

- Passwords are stored only as scrypt hashes (`password_hash`). Nobody can read a password from the table.
- **Who sees what:** graduation year and major appear on leaderboards. Weight, height, gender and date of birth are private: they're only ever returned to you (`GET /auth/me`) and never sent to the team's UI or other users.
- Change any of them later with `PATCH /me/profile` (send only the fields you're changing).
- In Supabase: **Table Editor → `users`**. Logins in progress are in `login_sessions` (hashed tokens only). These are RevGym's own tables, so Supabase's **Authentication** tab stays empty.

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
3. The PC's **Live camera** panel shows what the phone sees. Nothing is recorded or stored.

QR codes last 10 minutes, work once, and a new one cancels the old one. The code is in the link's `#` part, which browsers never send to servers or logs. A linked phone can only stream its camera. It can't see your account or the leaderboard, and you can unlink it from the PC anytime.

If the phone can't reach the PC, check that both are on the same Wi‑Fi. Some campus and guest networks block devices from talking to each other. A phone hotspot shared with the PC works.

## The team's UI (`ui/` from the front-end branch)

The backend serves the team's UI **unchanged** at http://127.0.0.1:8000/ui/ with your real data:

```bash
python run.py --ui-dir ../ui
```

(`../ui` is the default, so plain `python run.py` works once the `ui/` folder sits next to `backend/`.)

- `/ui/` asks you to log in first (any RevGym account), which sets a login cookie.
- The UI reads all its data from `window.REVGYM_MOCK`. The server sends the team's own `mock-data.js`, then overwrites the data parts with real values from the database: you, other users, both leaderboards, app stats, history, personal bests, the 12-week trend and gym days. The catalog (lifts, tips, gyms) stays exactly as the team wrote it.
- The backend speaks the UI's ids (`bench`, `curl`, `ohp`, `pullup`, `rdl`, `row` …) and periods (`week` = 7 days, `month` = 30, `all`). Gym days and streaks use College Station time.
- The consistency leaderboard follows the rule in `ui/HANDOFF.md`: day *n* of a streak earns 1, 3, 5, 7, 9, 9… points.
- The UI shows each person's "Class of" (from graduation year) and major from sign-up. Display name, home gym and weekly goal can be set with `PATCH /me/profile`.
- For when the team swaps the UI's `Api` functions for `fetch()`: `GET /api/ui/live`, `/api/ui/form-leaderboard?exercise=&period=` and `/api/ui/consistency-leaderboard?period=` return the exact shapes those functions return.

Limits, because the UI itself isn't changed: the planner, inbox and results from the UI's own Record screen still save only in that browser, and its form scores are simulated. Real scores reach the leaderboards through `POST /scans`.

## How scans become leaderboard data

The computer-vision scan sends each set as JSON to `POST /scans` (logged in):

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
| anyone | `POST /auth/register` | Sign up with the profile fields above; returns a login token (`Authorization: Bearer …`) |
| anyone | `POST /auth/login` | Username + password; returns a login token |
| PC | `GET /auth/me`, `PATCH /me/profile`, `POST /auth/logout` | Your account and profile |
| PC | `POST /devices/pair-code` | QR code (`qr_svg`) + phone link |
| phone | `POST /devices/pair` | Trades the code for a device token (`X-Device-Token`) |
| PC | `GET /me/devices`, `DELETE /me/devices/{id}` | Linked phones, with live status |
| PC | `POST /me/devices/{id}/live/offer`, `GET …/live/answer` | Live view setup |
| phone | `POST /device/live/poll`, `POST /device/live/answer` | Phone checks in once a second |
| PC | `POST /scans`, `GET /me/scans` | Save a scanned set; your set history |
| anyone | `GET /leaderboard`, `GET /exercises`, `GET /health` | `/health` shows whether the database is Supabase (postgresql) |

## Security notes

- Passwords are hashed with scrypt. Login and phone tokens are stored only as SHA‑256 hashes.
- The PC app listens only on 127.0.0.1. Only the HTTPS phone port is reachable from the network.
- RevGym's tables in Supabase have row level security on with no policies, so Supabase's public REST API can't read them. Only this server, connecting as the database owner, can.
- No video or files are ever stored.
- Weight, height, gender and date of birth are only returned to their owner.
- Still missing: rate limits on login and pairing.
