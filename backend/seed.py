"""Fill a database with demo accounts and scanned sets so the leaderboard has data.

Usage: python seed.py            (uses DATABASE_URL or backend/revgym.db)
Every demo account uses the password DEMO_PASSWORD below. Demo data only.
"""

import random
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.main import create_app

DEMO_PASSWORD = "revgym-demo"
BASES = {"bench_press": 225, "squat": 315, "bicep_curl": 45, "shoulder_press": 135, "deadlift": 365, "lunge": 135}
USERS = ["maya.lifts", "drose", "kofi_b", "jen.str", "tlee", "ari.k", "sam_pr", "noor"]


MAJORS = ["Kinesiology", "Computer Science", "Mechanical Engineering", "Biology", "Finance", "Nutrition", "Psychology"]
GENDERS = ["female", "male", "nonbinary", "prefer_not_to_say"]


def demo_profile(rng: random.Random) -> dict:
    """Made-up sign-up details for demo accounts."""
    grad = rng.randint(2026, 2029)
    return {
        "grad_year": grad,
        "major": rng.choice(MAJORS),
        "weight_lb": round(rng.uniform(120, 230), 1),
        "height_in": rng.randint(60, 76),
        "gender": rng.choice(GENDERS),
        "birth_date": f"{grad - 22}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
    }


def main(seed: int = 7) -> None:
    rng = random.Random(seed)
    client = TestClient(create_app())
    now = datetime.now(timezone.utc)
    for name in USERS:
        res = client.post("/auth/register", json={"username": name, "password": DEMO_PASSWORD, **demo_profile(rng)})
        if res.status_code == 409:
            print(f"{name} already exists, skipping")
            continue
        headers = {"Authorization": f"Bearer {res.json()['token']}"}
        for _ in range(rng.randint(4, 10)):
            exercise = rng.choice(list(BASES))
            weight = round(BASES[exercise] * rng.uniform(0.6, 1.3) / 5) * 5
            reps = [{"form_score": round(rng.uniform(65, 99), 1), "angles": {}} for _ in range(rng.randint(3, 8))]
            when = now - timedelta(days=rng.uniform(0, 20))
            client.post("/scans", headers=headers, json={"exercise": exercise, "weight_lb": weight,
                                                         "reps": reps, "recorded_at": when.isoformat()})
    print(f"Seeded demo data. Log in as any of {', '.join(USERS)} with password '{DEMO_PASSWORD}'.")


if __name__ == "__main__":
    main()
