"""The backend speaking the team's UI data format (ui/mock-data.js shapes), without changing the UI."""

import json
from datetime import date, datetime, timedelta, timezone

from conftest import signup

from app.ui_bridge import LOCAL_TZ, day_points, score_attendance

NOW = datetime.now(timezone.utc)


def days_ago_iso(n: int) -> str:
    # Noon local time n days ago, so it lands on that local day.
    local = datetime.now(LOCAL_TZ).replace(hour=12, minute=0, second=0, microsecond=0) - timedelta(days=n)
    return local.astimezone(timezone.utc).isoformat()


def live(client, user):
    res = client.get("/api/ui/live", headers=user.headers)
    assert res.status_code == 200, res.text
    return res.json()


# ---------- consistency points rule from ui/HANDOFF.md ----------

def test_day_points_ladder():
    assert [day_points(n) for n in range(1, 8)] == [1, 3, 5, 7, 9, 9, 9]


def test_streak_scoring():
    today = date(2026, 11, 7)
    days = {today - timedelta(days=d) for d in (1, 2, 3, 5, 6)}  # gap 4 days ago
    sc = score_attendance(days, today)
    assert sc["streak"] == 3            # yesterday counts; today not over yet
    assert sc["bestStreak"] == 3
    assert sum(sc["daily"].values()) == (1 + 3) + (1 + 3 + 5)  # the climb restarts after the gap
    assert score_attendance(days | {today}, today)["streak"] == 4
    assert score_attendance({today - timedelta(days=2)}, today)["streak"] == 0  # missed yesterday


# ---------- data shapes ----------

def test_new_user_is_on_every_board(client, make_user):
    me = make_user("newbie")
    data = live(client, me)
    for ex in ("squat", "bench", "deadlift", "ohp", "pullup", "curl", "rdl", "row", "lunge"):
        for period in ("week", "month", "all"):
            rows = data["formLeaderboards"][ex][period]
            assert {"userId": "u_me", "score": 0, "reps": 0, "change": 0} in rows
    for period in ("week", "month", "all"):
        assert any(r["userId"] == "u_me" for r in data["consistencyLeaderboard"][period])
    assert len(data["formTrend"]["all"]) == 12
    assert min(data["appStats"]["peakHours"]["load"]) >= 1  # the chart divides by the max
    assert data["currentUser"]["id"] == "u_me" and data["currentUser"]["name"] == "newbie"


def test_real_scans_flow_into_ui_shapes(client, make_user, scan):
    me, maya = make_user("me"), make_user("maya")
    scan(me, exercise="bench_press", weight=185, scores=(80, 90), recorded_at=days_ago_iso(0))
    scan(me, exercise="squat", weight=225, scores=(70,), recorded_at=days_ago_iso(1))
    scan(maya, exercise="bench", weight=135, scores=(95, 95, 95), recorded_at=days_ago_iso(0))  # UI id accepted
    scan(maya, exercise="pullup", weight=0, scores=(88,), recorded_at=days_ago_iso(2))

    data = live(client, me)
    bench = data["formLeaderboards"]["bench"]["week"]
    assert bench[0] == {"userId": f"u{maya.id}", "score": 95, "reps": 3, "change": 0}
    assert bench[1] == {"userId": "u_me", "score": 85, "reps": 2, "change": 0}
    assert data["formLeaderboards"]["pullup"]["all"][0]["userId"] == f"u{maya.id}"
    assert [u["id"] for u in data["users"]] == [f"u{maya.id}"]  # everyone on a board is listed, minus me

    cons = {r["userId"]: r for r in data["consistencyLeaderboard"]["week"]}
    assert cons["u_me"]["points"] == 1 + 3 and cons["u_me"]["streak"] == 2 and cons["u_me"]["nextDayPoints"] == 5
    assert cons[f"u{maya.id}"]["activeDays"] == 2

    hist = data["history"]
    assert [h["exercise"] for h in hist] == ["bench", "squat"]  # UI ids, newest first
    assert hist[0]["weight"] == 185 and hist[0]["unit"] == "lb"
    pbs = {p["exercise"]: p for p in data["personalBests"]}
    assert pbs["bench"]["weight"] == 185 and pbs["bench"]["bestForm"] == 85
    assert data["formTrend"]["all"][-1] == 78       # this week's average: (85 + 70) / 2 rounded
    assert data["currentUser"]["streakDays"] == 2 and data["currentUser"]["totalSessions"] == 2
    assert data["trainedDaysAgo"] == [0, 1]
    assert data["appStats"]["sessionsThisWeek"] == 4


def test_api_function_shapes(client, make_user, scan):
    me, maya = make_user("me"), make_user("maya")
    scan(maya, exercise="squat", scores=(92,))
    form = client.get("/api/ui/form-leaderboard", params={"exercise": "squat", "period": "week"}, headers=me.headers).json()
    assert form["entries"][0]["user"]["name"] == "maya" and form["entries"][0]["rank"] == 1
    assert form["me"]["isMe"] and form["me"]["user"]["name"] == "me (you)" and form["total"] == 2
    cons = client.get("/api/ui/consistency-leaderboard", params={"period": "month"}, headers=me.headers).json()
    assert cons["rule"] == {"start": 1, "step": 2, "max": 9} and cons["me"]["isMe"]
    client.cookies.clear()  # signing up also set the /ui/ cookie on this test client
    assert client.get("/api/ui/live").status_code == 401


def test_profile_shows_in_ui(client, make_user):
    me = make_user("jordan")
    assert client.patch("/me/profile", headers=me.headers, json={
        "display_name": "Jordan Alvarez", "grad_year": 2028, "major": "Biology", "home_gym": "polo", "weekly_goal": 5,
    }).status_code == 200
    data = live(client, me)
    u = data["currentUser"]
    assert (u["name"], u["initials"], u["classYear"], u["major"], u["homeGym"], u["weeklyGoal"]) == \
        ("Jordan Alvarez", "JA", "'28", "Biology", "polo", 5)
    assert client.patch("/me/profile", headers=me.headers, json={"home_gym": "mars"}).status_code == 422


def test_ui_never_gets_private_profile_fields(client, make_user, scan):
    me, maya = make_user("me"), make_user("maya")
    scan(maya, exercise="squat", scores=(90,))
    text = client.get("/api/ui/live", headers=me.headers).text
    for private in ("weight_lb", "height_in", "gender", "birth_date", "2005-04-12", "prefer_not_to_say"):
        assert private not in text
    users = client.get("/api/ui/live", headers=me.headers).json()["users"]
    assert users[0]["classYear"] == "'27" and users[0]["major"] == "Kinesiology"  # from sign-up


# ---------- serving the unchanged UI ----------

def test_ui_needs_login_then_serves_the_ui(client):
    page = client.get("/ui/")
    assert "Log in" in page.text and 'id="app"' not in page.text  # our login page first

    client.post("/auth/register", json=signup("maya"))  # sets the cookie
    page = client.get("/ui/")
    assert page.text.startswith("<!doctype html>") and '<div id="app"></div>' in page.text
    assert client.get("/ui/app.js").text == "console.log('ui');"
    assert client.get("/ui/assets/logo.png").content == b"png"


def test_mock_data_js_is_original_plus_live_data(client, make_user, scan):
    assert "Object.assign" not in client.get("/ui/mock-data.js").text  # logged out: just the team's file

    client.post("/auth/register", json=signup("maya"))
    js = client.get("/ui/mock-data.js").text
    original, _, overlay = js.partition("Object.assign(window.REVGYM_MOCK, ")
    assert original.startswith("window.REVGYM_MOCK = { exercises: [{ id: 'squat' }]")  # untouched
    data = json.loads(overlay.rstrip().removesuffix(");"))
    assert data["currentUser"]["name"] == "maya"
    assert "exercises" not in data  # the team's catalog is kept as they wrote it


def test_login_page_uses_the_team_logo(client):
    page = client.get("/ui/").text
    assert 'src="/ui/assets/reveille-logo.png"' in page
    # A small Log in button opens the (initially hidden) log in box.
    assert 'id="open-login"' in page and 'id="login-card"' in page and 'role="dialog"' in page
    assert 'id="open-signup"' in page and 'href="/static/auth-cube.css"' in page


def test_ui_logout(client):
    assert client.get("/ui/whoami").status_code == 401
    assert "Log out" in client.get("/ui/logout").text  # the page loads either way

    client.post("/auth/register", json=signup("maya"))
    assert client.get("/ui/whoami").json() == {"username": "maya"}

    # Another website can't log you out.
    assert client.post("/ui/logout", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/ui/logout", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.get("/ui/whoami").status_code == 200

    # RevGym's own page can.
    res = client.post("/ui/logout", headers={"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"})
    assert res.status_code == 204
    assert client.get("/ui/whoami").status_code == 401
    assert 'id="app"' not in client.get("/ui/").text  # back to the log in page


def test_ui_logout_ends_the_session_server_side(client):
    client.post("/auth/register", json=signup("maya"))
    token = client.cookies.get("revgym_session")
    client.post("/ui/logout")
    client.cookies.set("revgym_session", token)  # replaying the old cookie doesn't work
    assert client.get("/ui/whoami").status_code == 401


def test_ui_static_cant_escape_the_folder(client):
    client.post("/auth/register", json=signup("maya"))
    for path in ("/ui/../.env", "/ui/..%2F.env", "/ui/%2e%2e/%2e%2e/app/config.py"):
        assert client.get(path).status_code == 404


def test_cookie_cant_be_used_to_change_things(client, make_user):
    client.post("/auth/register", json=signup("maya"))  # cookie only, no header
    assert client.post("/scans", json={"exercise": "squat", "weight_lb": 1, "reps": [{"form_score": 90}]}).status_code == 401
    assert client.patch("/me/profile", json={"major": "x"}).status_code == 401
