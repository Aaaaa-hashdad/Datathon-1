import os

# Keep the module-level app (built on import) local and in memory during tests.
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = ""

from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

PASSWORD = "correct-horse-1"


def local_settings(tmp_path) -> Settings:
    # Always local in tests, even if backend/.env points at Supabase.
    return Settings(database_url="sqlite://", supabase_url="", supabase_service_key="",
                    upload_dir=tmp_path / "uploads", secret_key="test-secret", phone_https_port=8443)


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
        res = client.post("/auth/register", json={"username": username, "password": PASSWORD})
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
