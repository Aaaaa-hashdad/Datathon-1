from datetime import datetime

import pytest

from app.leaderboard import period_start
from app.scoring import qualifies, set_form_score, set_points


def test_form_score_is_average_of_reps():
    assert set_form_score([94, 92, 90, 88, 79, 74]) == 86.2


def test_empty_set_rejected():
    with pytest.raises(ValueError):
        set_form_score([])


def test_qualifying_threshold_is_inclusive():
    assert qualifies(80.0)
    assert not qualifies(79.9)


def test_points_round_half_up_and_zero_when_not_qualified():
    assert set_points(84.5) == 85
    assert set_points(86.2) == 86
    assert set_points(79.9) == 0


def test_week_starts_monday_midnight_utc():
    wednesday = datetime(2026, 11, 4, 15, 30)
    assert period_start("week", wednesday) == datetime(2026, 11, 2, 0, 0)
    assert period_start("all_time", wednesday) is None
