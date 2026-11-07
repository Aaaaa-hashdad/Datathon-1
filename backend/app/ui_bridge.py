"""Real data in the exact shapes the team's UI (ui/app.js + ui/mock-data.js) expects.

The UI is NOT changed. It reads everything from `window.REVGYM_MOCK`. The server
serves the team's own mock-data.js and then overwrites the data parts of it with
`build_live(...)`, so the UI shows real accounts, scans and leaderboards. The
static catalog (exercise list, metric labels, coaching tips, gyms, workout types)
stays exactly as the team wrote it.

UI rules this module keeps (from reading ui/app.js):
- The signed-in user is "u_me"; other users are "u<id>". Every user id on a
  leaderboard must appear in `users`.
- You always appear on every leaderboard (the screens read `me.rank` and
  `me.streak` unconditionally), so a user with no data is listed at the bottom.
- Periods are "week" (last 7 days), "month" (last 30) and "all".
- `formTrend.all` always has 12 numbers (the chart needs at least 2).
- `peakHours.load` must not be all zeros (the chart divides by its max).
- Consistency points (ui/HANDOFF.md): day n of a streak earns min(9, 1 + 2(n-1));
  a missed day restarts the climb; today doesn't break a streak until it's over.
"""

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import ScanSet, User

LOCAL_TZ = ZoneInfo("America/Chicago")  # College Station: gym days roll over at local midnight
PERIOD_DAYS = {"week": 7, "month": 30}
PERIODS = ("week", "month", "all")
POINTS_RULE = {"start": 1, "step": 2, "max": 9}
TREND_WEEKS = 12

# Backend exercise ids -> the UI's ids (the rest are the same in both).
TO_UI = {"bench_press": "bench", "bicep_curl": "curl", "shoulder_press": "ohp"}
UI_EXERCISES = ["squat", "bench", "deadlift", "ohp", "pullup", "curl", "rdl", "row", "lunge"]
PEAK_HOURS = ["6a", "8a", "10a", "12p", "2p", "4p", "6p", "8p", "10p"]  # same labels as the UI


def ui_exercise(backend_id: str) -> str:
    return TO_UI.get(backend_id, backend_id)


def day_points(n: int) -> int:
    return min(POINTS_RULE["max"], POINTS_RULE["start"] + POINTS_RULE["step"] * (n - 1))


def local_date(dt_utc_naive: datetime) -> date:
    return dt_utc_naive.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ).date()


def initials(name: str) -> str:
    parts = [p for p in name.replace("_", " ").replace(".", " ").split() if p]
    return ("".join(p[0] for p in parts[:2]) or name[:2]).upper()


def score_attendance(days: set[date], today: date) -> dict:
    """Points per day, current streak and best streak for a set of gym days."""
    daily: dict[date, int] = {}
    if not days:
        return {"daily": daily, "streak": 0, "bestStreak": 0}
    run = best = 0
    d = min(days)
    while d <= today:
        if d in days:
            run += 1
            daily[d] = day_points(run)
            best = max(best, run)
        elif d != today:  # today only breaks the streak once it's over
            run = 0
        d += timedelta(days=1)
    return {"daily": daily, "streak": run, "bestStreak": best}


class _Data:
    """Everything needed, loaded in two queries."""

    def __init__(self, db: Session, now: datetime):
        self.now = now
        self.today = now.astimezone(LOCAL_TZ).date()
        self.users = {u.id: u for u in db.scalars(select(User))}
        self.scans = list(db.scalars(select(ScanSet).order_by(ScanSet.recorded_at)))
        # A "gym day" = a local day with at least one scanned set.
        self.gym_days: dict[int, set[date]] = defaultdict(set)
        for s in self.scans:
            self.gym_days[s.user_id].add(local_date(s.recorded_at))

    def days_ago(self, dt_utc_naive: datetime) -> int:
        return (self.today - local_date(dt_utc_naive)).days

    def in_window(self, dt_utc_naive: datetime, days: int | None, offset: int = 0) -> bool:
        """Within the last `days` local days, shifted back `offset` days. None = all time."""
        ago = self.days_ago(dt_utc_naive)
        return days is None or offset <= ago < offset + days


def _uid(user_id: int, me_id: int) -> str:
    return "u_me" if user_id == me_id else f"u{user_id}"


def _profile(u: User) -> dict:
    name = u.display_name or u.username
    # Only what the UI shows to everyone: name, "Class of '27", major. Weight, height,
    # gender and date of birth are private and never sent to the UI.
    class_year = f"'{u.grad_year % 100:02d}" if u.grad_year else ""
    return {"name": name, "initials": initials(name), "classYear": class_year, "major": u.major or ""}


def build_live(db: Session, me: User, now: datetime | None = None) -> dict:
    d = _Data(db, now or datetime.now(timezone.utc))
    me_id = me.id

    # ---------- Form score leaderboards: best form per user per lift ----------
    form_boards: dict[str, dict[str, list]] = {}
    participants = {}
    for period in PERIODS:
        days = PERIOD_DAYS.get(period)
        active = {s.user_id for s in d.scans if d.in_window(s.recorded_at, days)}
        participants[period] = max(len(active | {me_id}), 1)

    for ex in UI_EXERCISES:
        form_boards[ex] = {}
        ex_scans = [s for s in d.scans if ui_exercise(s.exercise) == ex]
        for period in PERIODS:
            days = PERIOD_DAYS.get(period)

            def best(offset: int) -> dict[int, ScanSet]:
                out: dict[int, ScanSet] = {}
                for s in ex_scans:
                    if d.in_window(s.recorded_at, days, offset):
                        cur = out.get(s.user_id)
                        if cur is None or (s.form_score, s.rep_count) > (cur.form_score, cur.rep_count):
                            out[s.user_id] = s
                return out

            now_best = best(0)
            prev_best = best(days) if days else {}
            rows = [{
                "userId": _uid(uid, me_id),
                "score": round(s.form_score),
                "reps": s.rep_count,
                "change": round(s.form_score - prev_best[uid].form_score) if uid in prev_best else 0,
            } for uid, s in now_best.items()]
            rows.sort(key=lambda r: (-r["score"], -r["reps"]))
            if me_id not in now_best:
                rows.append({"userId": "u_me", "score": 0, "reps": 0, "change": 0})
            form_boards[ex][period] = rows

    # ---------- Consistency (streak points) leaderboards ----------
    scored = {uid: score_attendance(d.gym_days.get(uid, set()), d.today) for uid in d.users}
    consistency = {}
    for period in PERIODS:
        days = PERIOD_DAYS.get(period)
        rows = []
        for uid, sc in scored.items():
            in_win = [day for day in sc["daily"] if days is None or (d.today - day).days < days]
            if not in_win and uid != me_id:
                continue
            rows.append({
                "userId": _uid(uid, me_id),
                "points": sum(sc["daily"][day] for day in in_win),
                "streak": sc["streak"],
                "bestStreak": sc["bestStreak"],
                "activeDays": len(in_win),
                "nextDayPoints": day_points(sc["streak"] + 1),
            })
        rows.sort(key=lambda r: (-r["points"], -r["streak"]))
        consistency[period] = rows

    # ---------- Everyone who appears, except me ----------
    shown = {r["userId"] for b in form_boards.values() for rows in b.values() for r in rows}
    shown |= {r["userId"] for rows in consistency.values() for r in rows}
    users = [{"id": f"u{u.id}", **_profile(u)} for u in d.users.values()
             if u.id != me_id and f"u{u.id}" in shown]

    # ---------- Me ----------
    my_scans = [s for s in d.scans if s.user_id == me_id]
    mine = scored.get(me_id, {"streak": 0, "bestStreak": 0})
    current_user = {
        "id": "u_me",
        **_profile(me),
        "homeGym": me.home_gym or "rec",
        "joined": local_date(me.created_at).isoformat(),
        "streakDays": mine["streak"],
        "longestStreak": mine["bestStreak"],
        "totalSessions": len(d.gym_days.get(me_id, set())),
        "avgFormScore": round(sum(s.form_score for s in my_scans) / len(my_scans)) if my_scans else 0,
        "weeklyGoal": me.weekly_goal or 4,
    }

    history = [{
        "id": f"h{s.id}",
        "daysAgo": d.days_ago(s.recorded_at),
        "exercise": ui_exercise(s.exercise),
        "score": round(s.form_score),
        "reps": s.rep_count,
        "weight": round(s.weight_lb),
        "unit": "lb" if s.weight_lb else "BW",
    } for s in sorted(my_scans, key=lambda s: s.recorded_at, reverse=True)[:20]]

    personal_bests = []
    for ex in UI_EXERCISES:
        sets = [s for s in my_scans if ui_exercise(s.exercise) == ex]
        if not sets:
            continue
        top = max(sets, key=lambda s: (s.weight_lb, s.rep_count))
        personal_bests.append({
            "exercise": ex,
            "weight": round(top.weight_lb),
            "unit": "lb" if top.weight_lb else "BW",
            "reps": top.rep_count,
            "bestForm": round(max(s.form_score for s in sets)),
            "daysAgo": d.days_ago(top.recorded_at),
        })

    # ---------- Weekly form trend (12 weeks, oldest first, weeks start Monday) ----------
    this_monday = d.today - timedelta(days=d.today.weekday())
    week_starts = [this_monday - timedelta(weeks=TREND_WEEKS - 1 - i) for i in range(TREND_WEEKS)]

    def trend(sets: list[ScanSet]) -> list[int] | None:
        buckets: dict[date, list[float]] = defaultdict(list)
        for s in sets:
            ld = local_date(s.recorded_at)
            buckets[ld - timedelta(days=ld.weekday())].append(s.form_score)
        avgs = [round(sum(buckets[w]) / len(buckets[w])) if buckets[w] else None for w in week_starts]
        known = [v for v in avgs if v is not None]
        if not known:
            return None
        out, last = [], known[0]
        for v in avgs:  # weeks without data repeat the last known value
            last = v if v is not None else last
            out.append(last)
        return out

    form_trend = {"all": trend(my_scans) or [0] * TREND_WEEKS}
    for ex in UI_EXERCISES:
        t = trend([s for s in my_scans if ui_exercise(s.exercise) == ex])
        if t:
            form_trend[ex] = t

    trained_days_ago = sorted((d.today - day).days for day in d.gym_days.get(me_id, set()))

    return {
        "currentUser": current_user,
        "users": users,
        "participants": participants,
        "formLeaderboards": form_boards,
        "consistencyLeaderboard": consistency,
        "pointsRule": dict(POINTS_RULE),
        "appStats": _app_stats(d),
        "history": history,
        "personalBests": personal_bests,
        "formTrend": form_trend,
        "trainedDaysAgo": trained_days_ago,
        # Planner and inbox start empty for real accounts; the UI keeps what you add in the browser.
        "plannedSessions": [],
        "notifications": [],
    }


def _app_stats(d: _Data) -> dict:
    def window(offset: int):
        scans = [s for s in d.scans if d.in_window(s.recorded_at, 7, offset)]
        users = {uid for uid, days in d.gym_days.items() if any(offset <= (d.today - x).days < offset + 7 for x in days)}
        avg = sum(s.form_score for s in scans) / len(scans) if scans else 0.0
        return scans, users, avg

    scans, users, avg = window(0)
    p_scans, p_users, p_avg = window(7)
    pct = lambda cur, prev: round((cur - prev) / prev * 100, 1) if prev else 0.0  # noqa: E731

    load = [0] * len(PEAK_HOURS)
    for s in scans:  # when people lifted over the last 7 days, in 2-hour slots from 5 AM
        hour = s.recorded_at.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ).hour
        slot = (hour - 5) // 2
        if 0 <= slot < len(load):
            load[slot] += 1
    top = max(load)
    load = [max(1, round(v / top * 100)) if top else 1 for v in load]

    return {
        "activeUsers": len(users), "activeUsersDelta": pct(len(users), len(p_users)),
        "sessionsThisWeek": len(scans), "sessionsDelta": pct(len(scans), len(p_scans)),
        "avgFormScore": round(avg), "avgFormDelta": round(avg - p_avg, 1) if p_scans and scans else 0.0,
        "formChecksToday": sum(1 for s in d.scans if d.days_ago(s.recorded_at) == 0),
        "peakHours": {"gym": "Student Rec Center", "hours": PEAK_HOURS, "load": load},
    }


# ---------- The same data in the shapes of the UI's Api functions ----------
# For when the team swaps app.js's Api bodies for fetch() calls.

def form_leaderboard(live: dict, exercise_id: str, period: str) -> dict:
    users = {u["id"]: u for u in live["users"]}
    me_user = {**{k: live["currentUser"][k] for k in ("initials", "classYear", "major")},
               "id": "u_me", "name": live["currentUser"]["name"] + " (you)"}
    entries = [{"rank": i + 1, "user": me_user if r["userId"] == "u_me" else users[r["userId"]],
                "score": r["score"], "reps": r["reps"], "change": r["change"], "isMe": r["userId"] == "u_me"}
               for i, r in enumerate(live["formLeaderboards"][exercise_id][period])]
    return {"entries": entries, "me": next(e for e in entries if e["isMe"]), "total": live["participants"][period]}


def consistency_leaderboard(live: dict, period: str) -> dict:
    users = {u["id"]: u for u in live["users"]}
    me_user = {**{k: live["currentUser"][k] for k in ("initials", "classYear", "major")},
               "id": "u_me", "name": live["currentUser"]["name"] + " (you)"}
    entries = [{"rank": i + 1, "user": me_user if r["userId"] == "u_me" else users[r["userId"]],
                **{k: r[k] for k in ("points", "streak", "bestStreak", "activeDays", "nextDayPoints")},
                "isMe": r["userId"] == "u_me"}
               for i, r in enumerate(live["consistencyLeaderboard"][period])]
    return {"entries": entries, "me": next(e for e in entries if e["isMe"]),
            "total": live["participants"][period], "rule": live["pointsRule"]}
