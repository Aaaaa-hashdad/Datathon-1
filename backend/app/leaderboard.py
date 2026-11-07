"""App-wide leaderboard built from scanned sets.

Two kinds of board:
- "all": every user ranked by total points from sets with form >= 80.
- one lift (e.g. "bench_press"): every user ranked by their best qualifying set
  of that lift, compared by weight, then reps, then form score.

Ties share a rank (1, 2, 2, 4).
"""

from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import ScanSet, User
from .schemas import LeaderboardEntry, LeaderboardOut, MyStanding
from .scoring import Exercise

Period = Literal["week", "all_time"]


def period_start(period: Period, now: datetime) -> datetime | None:
    """Start of the window as naive UTC: Monday 00:00 UTC for "week", None for all time."""
    if period == "all_time":
        return None
    if now.tzinfo is not None:
        now = now.astimezone(timezone.utc).replace(tzinfo=None)
    monday = now - timedelta(days=now.weekday())
    return monday.replace(hour=0, minute=0, second=0, microsecond=0)


def _assign_ranks(rows: list[dict], key) -> list[dict]:
    """rows must already be sorted best-first; equal keys share a rank."""
    prev_key, prev_rank = object(), 0
    for i, row in enumerate(rows):
        k = key(row)
        row["rank"] = prev_rank if k == prev_key else i + 1
        prev_key, prev_rank = k, row["rank"]
    return rows


def _all_lifts_rows(session: Session, since: datetime | None) -> list[dict]:
    total = func.sum(ScanSet.points).label("total")
    stmt = (
        select(User.id, User.username, total)
        .join(ScanSet, ScanSet.user_id == User.id)
        .where(ScanSet.qualified.is_(True))
        .group_by(User.id, User.username)
    )
    if since is not None:
        stmt = stmt.where(ScanSet.recorded_at >= since)
    rows = [
        {"user_id": uid, "username": name, "value": float(pts)}
        for uid, name, pts in session.execute(stmt)
    ]
    rows.sort(key=lambda r: (-r["value"], r["user_id"]))
    return _assign_ranks(rows, key=lambda r: r["value"])


def _single_lift_rows(session: Session, exercise: Exercise, since: datetime | None) -> list[dict]:
    best_first = func.row_number().over(
        partition_by=ScanSet.user_id,
        order_by=(
            ScanSet.weight_lb.desc(),
            ScanSet.rep_count.desc(),
            ScanSet.form_score.desc(),
            ScanSet.recorded_at.asc(),
            ScanSet.id.asc(),
        ),
    )
    inner = select(
        ScanSet.user_id,
        ScanSet.weight_lb,
        ScanSet.rep_count,
        ScanSet.form_score,
        ScanSet.recorded_at,
        best_first.label("rn"),
    ).where(ScanSet.exercise == exercise.value, ScanSet.qualified.is_(True))
    if since is not None:
        inner = inner.where(ScanSet.recorded_at >= since)
    best = inner.subquery()

    stmt = (
        select(best, User.username)
        .join(User, User.id == best.c.user_id)
        .where(best.c.rn == 1)
    )
    rows = [
        {
            "user_id": r.user_id,
            "username": r.username,
            "value": r.weight_lb,
            "weight_lb": r.weight_lb,
            "reps": r.rep_count,
            "form_score": r.form_score,
            "_recorded_at": r.recorded_at,
        }
        for r in session.execute(stmt)
    ]
    rows.sort(
        key=lambda r: (-r["weight_lb"], -r["reps"], -r["form_score"], r["_recorded_at"], r["user_id"])
    )
    return _assign_ranks(rows, key=lambda r: (r["weight_lb"], r["reps"], r["form_score"]))


def _entry(row: dict) -> LeaderboardEntry:
    return LeaderboardEntry(**{k: v for k, v in row.items() if not k.startswith("_")})


def _my_standing(rows: list[dict], user_id: int) -> MyStanding | None:
    idx = next((i for i, r in enumerate(rows) if r["user_id"] == user_id), None)
    if idx is None:
        return None
    mine = rows[idx]
    # The person to catch is the last one ranked strictly above me.
    above = [r for r in rows[:idx] if r["rank"] < mine["rank"]]
    next_up = above[-1] if above else None
    return MyStanding(
        entry=_entry(mine),
        next_up=_entry(next_up) if next_up else None,
        gap_to_next=round(next_up["value"] - mine["value"], 1) if next_up else None,
    )


def build_leaderboard(
    session: Session,
    exercise: Literal["all"] | Exercise,
    period: Period,
    limit: int = 50,
    user_id: int | None = None,
    now: datetime | None = None,
) -> LeaderboardOut:
    since = period_start(period, now or datetime.now(timezone.utc))
    if exercise == "all":
        rows = _all_lifts_rows(session, since)
        metric = "points"
    else:
        rows = _single_lift_rows(session, Exercise(exercise), since)
        metric = "weight_lb"

    return LeaderboardOut(
        exercise=exercise,
        period=period,
        metric=metric,
        total_ranked=len(rows),
        entries=[_entry(r) for r in rows[:limit]],
        me=_my_standing(rows, user_id) if user_id is not None else None,
    )
