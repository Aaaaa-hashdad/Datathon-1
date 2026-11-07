from datetime import datetime, timedelta, timezone

NOW = datetime.now(timezone.utc)
LAST_MONTH = (NOW - timedelta(days=30)).isoformat()


def board(client, user=None, **params):
    params.setdefault("period", "all_time")
    res = client.get("/leaderboard", params=params, headers=user.headers if user else None)
    assert res.status_code == 200, res.text
    return res.json()


def test_scan_is_scored(client, make_user, scan):
    maya = make_user("maya")
    good = scan(maya, scores=(94, 92, 90, 88, 79, 74))
    assert good["user_id"] == maya.id
    assert good["form_score"] == 86.2
    assert good["qualified"] is True
    assert good["points"] == 86
    assert [r["index"] for r in good["reps"]] == [1, 2, 3, 4, 5, 6]

    sloppy = scan(maya, scores=(70, 75))
    assert sloppy["qualified"] is False
    assert sloppy["points"] == 0


def test_scan_needs_login_and_valid_data(client, make_user):
    maya = make_user("maya")
    good = {"exercise": "squat", "weight_lb": 100, "reps": [{"form_score": 90}]}
    assert client.post("/scans", json=good).status_code == 401
    assert client.post("/scans", json=good, headers={"Authorization": "Bearer nope"}).status_code == 401
    for bad in (
        {**good, "exercise": "jumping_jacks"},
        {**good, "reps": []},
        {**good, "reps": [{"form_score": 120}]},
    ):
        assert client.post("/scans", json=bad, headers=maya.headers).status_code == 422


def test_all_lifts_sums_only_qualified_points(client, make_user, scan):
    a, b, c = make_user("alice"), make_user("bob"), make_user("cara")
    scan(a, scores=(90,))
    scan(a, exercise="squat", scores=(85,))
    scan(b, scores=(95,))
    scan(b, scores=(50,))
    scan(c, scores=(70,))

    data = board(client, exercise="all")
    assert data["metric"] == "points"
    assert data["total_ranked"] == 2
    assert [(e["username"], e["value"], e["rank"]) for e in data["entries"]] == [
        ("alice", 175, 1),
        ("bob", 95, 2),
    ]


def test_ties_share_rank_and_me_comes_from_login(client, make_user, scan):
    a, b, c, d = (make_user(n) for n in ("alice", "bob", "cara", "dev"))
    scan(a, scores=(100,))
    scan(b, scores=(90,))
    scan(c, scores=(90,))
    scan(d, scores=(80,))

    data = board(client, d)
    assert [e["rank"] for e in data["entries"]] == [1, 2, 2, 4]
    assert data["me"]["entry"]["rank"] == 4
    assert data["me"]["next_up"]["rank"] == 2
    assert data["me"]["gap_to_next"] == 10

    assert board(client, a)["me"]["next_up"] is None
    assert board(client)["me"] is None  # public view has no "me"


def test_single_lift_uses_best_qualifying_set(client, make_user, scan):
    a, b, c = make_user("alice"), make_user("bob"), make_user("cara")
    scan(a, weight=225, scores=(90, 90))
    scan(a, weight=315, scores=(60, 60))
    scan(a, weight=185, scores=(95,) * 8)
    scan(b, weight=225, scores=(85, 85, 85))
    scan(c, weight=405, scores=(95,), exercise="squat")

    data = board(client, exercise="bench_press")
    assert data["metric"] == "weight_lb"
    assert [(e["username"], e["weight_lb"], e["reps"], e["rank"]) for e in data["entries"]] == [
        ("bob", 225, 3, 1),
        ("alice", 225, 2, 2),
    ]


def test_week_period_excludes_older_sets(client, make_user, scan):
    a, b = make_user("alice"), make_user("bob")
    scan(a, scores=(90,), recorded_at=LAST_MONTH)
    scan(b, scores=(85,))
    assert [e["username"] for e in board(client, period="week")["entries"]] == ["bob"]
    assert [e["username"] for e in board(client)["entries"]] == ["alice", "bob"]


def test_limit_still_finds_me(client, make_user, scan):
    users = [make_user(f"user{i}") for i in range(5)]
    for i, u in enumerate(users):
        scan(u, scores=(80 + i,))
    newbie = make_user("newbie")

    data = board(client, users[0], limit=2)
    assert len(data["entries"]) == 2
    assert data["total_ranked"] == 5
    assert data["me"]["entry"]["rank"] == 5
    assert board(client, newbie)["me"] is None


def test_my_scan_history_is_private(client, make_user, scan):
    maya, bob = make_user("maya"), make_user("bob")
    scan(maya, exercise="squat", recorded_at=LAST_MONTH)
    scan(maya, exercise="bench_press")
    scan(bob, exercise="deadlift")

    history = client.get("/me/scans", headers=maya.headers).json()
    assert [s["exercise"] for s in history] == ["bench_press", "squat"]
    assert len(client.get("/me/scans", params={"exercise": "squat"}, headers=maya.headers).json()) == 1
    assert client.get("/me/scans").status_code == 401
