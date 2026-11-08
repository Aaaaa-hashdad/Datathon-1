from datetime import datetime, timedelta, timezone


def test_workout_leaderboard_uses_best_set_and_replaces_reanalysis(client, make_user):
    anna = make_user("anna").token
    brian = make_user("brian").token
    now = datetime.now(timezone.utc)

    def publish(token, items, source="2026-11-07/18-30.xlsx#1", recorded_at=now):
        client.cookies.clear()
        client.cookies.set("revgym_session", token)
        return client.post("/api/ui/workout-results", json={"sets": [{
            "source": source, "recorded_at": recorded_at.isoformat(), "exercises": items,
        }]})

    def item(score, reps=6, exercise="squat"):
        return {"exercise": exercise, "score": score, "reps": reps}

    assert publish(anna, [item(9), item(8, 10, "bicep curl")]).status_code == 204
    assert publish(brian, [item(8)]).status_code == 204
    assert publish(brian, [item(10)], "2026-10-01/18-30.xlsx#1", now - timedelta(days=14)).status_code == 204

    def standings(period="week"):
        response = client.get("/api/ui/workout-leaderboard", params={"period": period, "exercise": "squat"})
        assert response.status_code == 200
        return [(r["username"], r["score"], r["rank"], r["is_me"]) for r in response.json()["entries"]]

    assert standings() == [("anna", 9, 1, False), ("brian", 8, 2, True)]
    assert standings("all_time") == [("brian", 10, 1, True), ("anna", 9, 2, False)]
    assert publish(anna, [item(7)]).status_code == 204
    assert standings() == [("brian", 8, 1, False), ("anna", 7, 2, True)]
    assert publish(anna, []).status_code == 204
    assert standings() == [("brian", 8, 1, False)]

    cara = make_user("cara").token
    assert publish(cara, [item(7)]).status_code == 204
    assert publish(anna, [item(8)]).status_code == 204
    assert standings() == [("anna", 8, 1, True), ("brian", 8, 2, False), ("cara", 7, 3, False)]


def test_workout_leaderboard_requires_login_and_blocks_cross_site_writes(client, make_user):
    body = {"sets": [{"source": "2026-11-07/18-30.xlsx#1", "recorded_at": "2026-11-07T18:30:00Z", "exercises": []}]}
    assert client.get("/api/ui/workout-leaderboard").status_code == 401
    assert client.post("/api/ui/workout-results", json=body).status_code == 401
    make_user("anna")
    assert client.post("/api/ui/workout-results", json=body, headers={"Origin": "https://example.org"}).status_code == 403


def test_workout_leaderboard_combines_scores_and_prefers_reanalysis(client, make_user):
    anna = make_user("anna").token
    brian = make_user("brian").token
    saved = {
        "source": "2026-11-07/18-30.xlsx#1", "recorded_at": "2026-11-07T18:30:00Z",
        "exercises": [{"exercise": "bicep curl", "score": 7, "reps": 6}],
    }

    def publish(result, token=anna):
        client.cookies.clear()
        client.cookies.set("revgym_session", token)
        return client.post("/api/ui/workout-results", json={"sets": [result]}).status_code

    def scores(rubric=None):
        params = {"period": "all_time"}
        if rubric is not None:
            params["rubric"] = rubric
        response = client.get("/api/ui/workout-leaderboard", params=params)
        assert response.status_code == 200
        return [(row["username"], row["score"]) for row in response.json()["entries"]]

    current = {**saved, "rubric": "form-v2", "exercises": [{**saved["exercises"][0], "score": 6.4}]}
    assert publish({**saved, "exercises": [{**saved["exercises"][0], "score": 2}]}, brian) == 204
    assert publish(saved) == 204
    assert scores("form-v2") == []
    assert scores() == [("anna", 7), ("brian", 3)]
    assert publish(current) == 204
    assert publish(saved) == 204
    assert scores() == [("anna", 6.4), ("brian", 3)]
    assert scores("legacy") == [("anna", 7), ("brian", 2)]
    assert publish({**current, "exercises": [{**current["exercises"][0], "score": 2}]}) == 422
    assert publish({**current, "exercises": []}) == 204
    assert scores() == [("brian", 3)]

    revised = {**current, "rubric": "form-v3", "exercises": [{**saved["exercises"][0], "score": 5.9}]}
    assert publish(revised) == 204
    assert publish(current) == 204  # An older client re-published the same recording.
    assert scores() == [("anna", 5.9), ("brian", 3)]
    assert scores("form-v2") == [("anna", 6.4)]
    assert scores("form-v3") == [("anna", 5.9)]
    assert publish({**revised, "exercises": []}) == 204
    assert scores() == [("brian", 3)]

    strict = {**revised, "rubric": "form-v4", "exercises": [{**saved["exercises"][0], "score": 3}]}
    assert publish(strict) == 204
    assert publish(revised) == 204
    assert scores() == [("anna", 3), ("brian", 3)]
    assert scores("form-v4") == [("anna", 3)]

    balanced = {**strict, "rubric": "form-v5", "exercises": [{**saved["exercises"][0], "score": 6.5}]}
    assert publish(balanced) == 204
    assert publish(strict) == 204
    assert scores() == [("anna", 6.5), ("brian", 3)]
