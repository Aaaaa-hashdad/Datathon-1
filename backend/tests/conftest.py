import os

# Keep the module-level app (built on import) local and in memory during tests.
os.environ["DATABASE_URL"] = "sqlite://"

from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

PASSWORD = "correct-horse-1"
# The profile sign-up requires.
PROFILE = {"grad_year": 2027, "major": "Kinesiology", "weight_lb": 175, "height_in": 70,
           "gender": "prefer_not_to_say", "birth_date": "2005-04-12"}


def signup(username: str, password: str = PASSWORD, **changes) -> dict:
    """A complete sign-up body."""
    return {"username": username, "password": password, **PROFILE, **changes}


def local_settings(tmp_path) -> Settings:
    # Always local in tests, even if backend/.env points at Supabase.
    # A tiny stand-in for the team's ui/ folder (the real one is never modified).
    ui = tmp_path / "ui"
    (ui / "assets").mkdir(parents=True, exist_ok=True)
    (ui / "index.html").write_text('<div id="app"></div><script src="mock-data.js"></script><script src="app.js"></script>')
    (ui / "mock-data.js").write_text("window.REVGYM_MOCK = { exercises: [{ id: 'squat' }], users: [{ id: 'fake' }] };")
    (ui / "app.js").write_text("console.log('ui');")
    (ui / "assets" / "logo.png").write_bytes(b"png")
    return Settings(database_url="sqlite://", phone_https_port=8443, ui_dir=ui)


@dataclass
class TestUser:
    id: int
    username: str
    token: str

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}


@pytest.fixture
def client(tmp_path):
    # Fresh in-memory database and upload folder for every test.
    with TestClient(create_app(local_settings(tmp_path))) as c:
        yield c


@pytest.fixture
def make_user(client):
    def _make(username: str) -> TestUser:
        res = client.post("/auth/register", json=signup(username))
        assert res.status_code == 201, res.text
        data = res.json()
        return TestUser(data["user"]["id"], username, data["token"])

    return _make


@pytest.fixture
def scan(client):
    def _scan(user: TestUser, exercise="bench_press", weight=135, scores=(90, 90, 90), recorded_at=None):
        body = {
            "exercise": exercise,
            "weight_lb": weight,
            "reps": [{"form_score": s, "angles": {"elbow_tuck": 60}} for s in scores],
        }
        if recorded_at is not None:
            body["recorded_at"] = recorded_at
        res = client.post("/scans", json=body, headers=user.headers)
        assert res.status_code == 201, res.text
        return res.json()

    return _scan
