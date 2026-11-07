import json
from pathlib import Path

import httpx

from app.db import normalize_url
from app.storage import SupabaseStore

SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\n"


def pair(client, user):
    code = client.post("/devices/pair-code", headers=user.headers).json()["code"]
    res = client.post("/devices/pair", json={"code": code, "device_name": "Pixel"})
    phone = {"X-Device-Token": res.json()["device_token"]}
    device_id = client.get("/me/devices", headers=user.headers).json()[0]["id"]
    return phone, device_id


def phone_poll(client, phone, camera=True, recording=False):
    res = client.post("/device/live/poll", json={"camera": camera, "recording": recording}, headers=phone)
    assert res.status_code == 200, res.text
    return res.json()


# ---------- live camera link ----------

def test_device_shows_online_after_phone_checks_in(client, make_user):
    maya = make_user("maya")
    phone, _ = pair(client, maya)
    assert client.get("/me/devices", headers=maya.headers).json()[0]["online"] is False
    phone_poll(client, phone, camera=True)
    dev = client.get("/me/devices", headers=maya.headers).json()[0]
    assert (dev["online"], dev["camera"], dev["recording"]) == (True, True, False)


def test_offer_answer_handshake(client, make_user):
    maya = make_user("maya")
    phone, device_id = pair(client, maya)

    offer_id = client.post(f"/me/devices/{device_id}/live/offer", json={"sdp": SDP}, headers=maya.headers).json()["offer_id"]
    assert client.get(f"/me/devices/{device_id}/live/answer", params={"offer_id": offer_id}, headers=maya.headers).json() == {"sdp": None}

    inbox = phone_poll(client, phone)
    assert inbox["offer"] == {"id": offer_id, "sdp": SDP}
    assert phone_poll(client, phone)["offer"] is None  # delivered once

    assert client.post("/device/live/answer", json={"offer_id": offer_id, "sdp": SDP + "a"}, headers=phone).status_code == 204
    answer = client.get(f"/me/devices/{device_id}/live/answer", params={"offer_id": offer_id}, headers=maya.headers).json()
    assert answer == {"sdp": SDP + "a"}

    # A newer offer makes the old answer stale.
    new_id = client.post(f"/me/devices/{device_id}/live/offer", json={"sdp": SDP}, headers=maya.headers).json()["offer_id"]
    assert client.get(f"/me/devices/{device_id}/live/answer", params={"offer_id": new_id}, headers=maya.headers).json() == {"sdp": None}


def test_record_commands_reach_the_phone(client, make_user):
    maya = make_user("maya")
    phone, device_id = pair(client, maya)
    cmd_url = f"/me/devices/{device_id}/live/command"

    # Phone not connected yet.
    assert client.post(cmd_url, json={"action": "start", "exercise": "squat"}, headers=maya.headers).status_code == 409

    phone_poll(client, phone)
    assert client.post(cmd_url, json={"action": "start"}, headers=maya.headers).status_code == 422
    assert client.post(cmd_url, json={"action": "start", "exercise": "squat"}, headers=maya.headers).status_code == 202
    assert phone_poll(client, phone, recording=True)["commands"] == [{"action": "start", "exercise": "squat"}]
    assert client.get("/me/devices", headers=maya.headers).json()[0]["recording"] is True

    client.post(cmd_url, json={"action": "stop"}, headers=maya.headers)
    assert phone_poll(client, phone)["commands"] == [{"action": "stop", "exercise": None}]


def test_live_endpoints_are_private(client, make_user):
    maya, bob = make_user("maya"), make_user("bob")
    phone, device_id = pair(client, maya)
    assert client.post(f"/me/devices/{device_id}/live/offer", json={"sdp": SDP}, headers=bob.headers).status_code == 404
    assert client.post(f"/me/devices/{device_id}/live/command", json={"action": "stop"}, headers=bob.headers).status_code == 404
    assert client.post("/device/live/poll", json={}, headers={"X-Device-Token": "nope"}).status_code == 401
    assert client.post("/device/live/poll", json={}, headers=maya.headers).status_code == 401


# ---------- Supabase plumbing (no network: a fake Supabase answers) ----------

def test_supabase_url_gets_psycopg_driver():
    url = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    assert normalize_url(url).startswith("postgresql+psycopg://postgres.abc:pw@")
    assert normalize_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_url("sqlite://") == "sqlite://"


def test_supabase_store_uploads_and_signs(tmp_path: Path):
    calls = []

    def fake_supabase(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, request.headers.get("Authorization")))
        if request.url.path == "/storage/v1/bucket":
            return httpx.Response(400, json={"message": "The resource already exists"})
        if request.url.path.startswith("/storage/v1/object/sign/"):
            assert json.loads(request.content) == {"expiresIn": 900}
            return httpx.Response(200, json={"signedURL": "/object/sign/recordings/a.mp4?token=t"})
        if request.url.path == "/storage/v1/object/recordings/a.mp4":
            assert request.headers["Content-Type"] == "video/mp4"
            assert request.content == b"video-bytes"
            return httpx.Response(200, json={"Key": "recordings/a.mp4"})
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(fake_supabase))
    store = SupabaseStore("https://proj.supabase.co", "service-key", "recordings", client=client)
    store.ensure_bucket()  # "already exists" is fine

    src = tmp_path / "incoming.mp4"
    src.write_bytes(b"video-bytes")
    store.put("a.mp4", src, "video/mp4")
    assert not src.exists()  # temp file cleaned up

    assert store.play_url("a.mp4") == "https://proj.supabase.co/storage/v1/object/sign/recordings/a.mp4?token=t"
    assert all(auth == "Bearer service-key" for _, _, auth in calls)


def test_new_style_secret_key_only_uses_apikey_header():
    seen = []

    def fake(request: httpx.Request) -> httpx.Response:
        seen.append((request.headers.get("apikey"), request.headers.get("Authorization")))
        return httpx.Response(200, json={"signedURL": "/object/sign/recordings/a.mp4?token=t"})

    store = SupabaseStore("https://proj.supabase.co", "sb_secret_abc", "recordings",
                          client=httpx.Client(transport=httpx.MockTransport(fake)))
    store.play_url("a.mp4")
    assert seen == [("sb_secret_abc", None)]
