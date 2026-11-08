from datetime import datetime, timedelta, timezone


def test_workout_leaderboard_uses_best_set_and_replaces_reanalysis(client, make_user):
    make_user("anna")
    anna = client.cookies.get("revgym_session")
    make_user("brian")
    brian = client.cookies.get("revgym_session")
    now = datetime.now(timezone.utc)

    def publish(token, items, source="2026-11-07/18-30.xlsx#1", recorded_at=now):
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

    make_user("cara")
    cara = client.cookies.get("revgym_session")
    assert publish(cara, [item(7)]).status_code == 204
    assert publish(anna, [item(8)]).status_code == 204
    assert standings() == [("anna", 8, 1, True), ("brian", 8, 2, False), ("cara", 7, 3, False)]


def test_workout_leaderboard_requires_login_and_blocks_cross_site_writes(client, make_user):
    body = {"sets": [{"source": "2026-11-07/18-30.xlsx#1", "recorded_at": "2026-11-07T18:30:00Z", "exercises": []}]}
    assert client.get("/api/ui/workout-leaderboard").status_code == 401
    assert client.post("/api/ui/workout-results", json=body).status_code == 401
    make_user("anna")
    assert client.post("/api/ui/workout-results", json=body, headers={"Origin": "https://example.org"}).status_code == 403
