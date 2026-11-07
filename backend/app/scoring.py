"""Rules that turn a scanned set into a form score and leaderboard points."""

from enum import Enum

# A set must average at least this form score to count on any leaderboard.
QUALIFYING_FORM_SCORE = 80.0


class Exercise(str, Enum):
    BENCH_PRESS = "bench_press"
    SQUAT = "squat"
    BICEP_CURL = "bicep_curl"
    SHOULDER_PRESS = "shoulder_press"
    DEADLIFT = "deadlift"
    LUNGE = "lunge"


def set_form_score(rep_scores: list[float]) -> float:
    """Average of the per-rep form scores, rounded to one decimal."""
    if not rep_scores:
        raise ValueError("a set needs at least one rep")
    return round(sum(rep_scores) / len(rep_scores), 1)


def qualifies(form_score: float) -> bool:
    return form_score >= QUALIFYING_FORM_SCORE


def set_points(form_score: float) -> int:
    """Points a set adds to the all-lifts board: its rounded form score if it qualifies."""
    # Round half up (Python's round() would turn 84.5 into 84).
    return int(form_score + 0.5) if qualifies(form_score) else 0
