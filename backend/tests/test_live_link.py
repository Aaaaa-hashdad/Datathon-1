from app.db import normalize_url

SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\n"


def pair(client, user):
    code = client.post("/devices/pair-code", headers=user.headers).json()["code"]
    res = client.post("/devices/pair", json={"code": code, "device_name": "Pixel"})
    phone = {"X-Device-Token": res.json()["device_token"]}
    device_id = client.get("/me/devices", headers=user.headers).json()[0]["id"]
    return phone, device_id


def phone_poll(client, phone, camera=True):
    res = client.post("/device/live/poll", json={"camera": camera}, headers=phone)
    assert res.status_code == 200, res.text
    return res.json()


# ---------- live camera link ----------

def test_device_shows_online_after_phone_checks_in(client, make_user):
    maya = make_user("maya")
    phone, _ = pair(client, maya)
    assert client.get("/me/devices", headers=maya.headers).json()[0]["online"] is False
    phone_poll(client, phone, camera=True)
    dev = client.get("/me/devices", headers=maya.headers).json()[0]
    assert (dev["online"], dev["camera"]) == (True, True)
    phone_poll(client, phone, camera=False)
    assert client.get("/me/devices", headers=maya.headers).json()[0]["camera"] is False


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


def test_no_recording_commands_any_more(client, make_user):
    maya = make_user("maya")
    _, device_id = pair(client, maya)
    res = client.post(f"/me/devices/{device_id}/live/command", json={"action": "start"}, headers=maya.headers)
    assert res.status_code in (404, 405)


def test_live_endpoints_are_private(client, make_user):
    maya, bob = make_user("maya"), make_user("bob")
    phone, device_id = pair(client, maya)
    assert client.post(f"/me/devices/{device_id}/live/offer", json={"sdp": SDP}, headers=bob.headers).status_code == 404
    assert client.get(f"/me/devices/{device_id}/live/answer", params={"offer_id": 1}, headers=bob.headers).status_code == 404
    assert client.post("/device/live/poll", json={}, headers={"X-Device-Token": "nope"}).status_code == 401
    assert client.post("/device/live/poll", json={}, headers=maya.headers).status_code == 401


# ---------- Supabase connection string ----------

def test_supabase_url_gets_psycopg_driver():
    url = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    assert normalize_url(url).startswith("postgresql+psycopg://postgres.abc:pw@")
    assert normalize_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_url("sqlite://") == "sqlite://"
