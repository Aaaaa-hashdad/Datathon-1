from datetime import timedelta

from conftest import PASSWORD
from sqlalchemy.orm import Session

from app.models import PairCode


def creds(username, password=PASSWORD):
    return {"username": username, "password": password}


# ---------- accounts ----------

def test_register_login_me_logout(client):
    res = client.post("/auth/register", json=creds("maya"))
    assert res.status_code == 201
    assert res.json()["user"]["username"] == "maya"
    assert "password" not in res.text and "hash" not in res.text

    res = client.post("/auth/login", json=creds("maya"))
    assert res.status_code == 200
    headers = {"Authorization": f"Bearer {res.json()['token']}"}
    assert client.get("/auth/me", headers=headers).json()["username"] == "maya"

    assert client.post("/auth/logout", headers=headers).status_code == 204
    assert client.get("/auth/me", headers=headers).status_code == 401


def test_bad_logins_give_the_same_message(client):
    client.post("/auth/register", json=creds("maya"))
    wrong_pw = client.post("/auth/login", json=creds("maya", "wrong-password"))
    no_user = client.post("/auth/login", json=creds("nobody"))
    assert wrong_pw.status_code == no_user.status_code == 401
    assert wrong_pw.json() == no_user.json()


def test_register_rules(client):
    client.post("/auth/register", json=creds("maya"))
    assert client.post("/auth/register", json=creds("maya")).status_code == 409
    assert client.post("/auth/register", json=creds("ok_name", "short")).status_code == 422
    assert client.post("/auth/register", json=creds("bad name!")).status_code == 422


def test_password_is_hashed(client):
    from app.auth import hash_password, verify_password

    stored = hash_password(PASSWORD)
    assert PASSWORD not in stored
    assert verify_password(PASSWORD, stored)
    assert not verify_password("nope-nope", stored)
    assert hash_password(PASSWORD) != stored  # random salt


# ---------- phone pairing + sync ----------

def pair(client, user, name="Pixel"):
    code = client.post("/devices/pair-code", headers=user.headers).json()["code"]
    res = client.post("/devices/pair", json={"code": code, "device_name": name})
    assert res.status_code == 200, res.text
    return {"X-Device-Token": res.json()["device_token"]}


def upload(client, device_headers, exercise="squat", data=b"\x00\x00\x00\x18ftypmp42fake-video", ctype="video/mp4"):
    return client.post(
        "/recordings",
        data={"exercise": exercise},
        files={"video": ("set.mp4", data, ctype)},
        headers=device_headers,
    )


def test_pair_code_gives_qr_for_https_phone_page(client, make_user):
    maya = make_user("maya")
    assert client.post("/devices/pair-code").status_code == 401
    data = client.post("/devices/pair-code", headers=maya.headers).json()
    assert len(data["code"]) == 6
    assert data["phone_url"].startswith("https://")
    assert data["phone_url"].endswith(f":8443/phone#code={data['code']}")
    assert data["qr_svg"].startswith("data:image/svg+xml")


def test_new_pair_code_replaces_old_one(client, make_user):
    maya = make_user("maya")
    old = client.post("/devices/pair-code", headers=maya.headers).json()["code"]
    client.post("/devices/pair-code", headers=maya.headers)
    assert client.post("/devices/pair", json={"code": old}).status_code == 400


def test_pair_code_is_single_use(client, make_user):
    maya = make_user("maya")
    code = client.post("/devices/pair-code", headers=maya.headers).json()["code"]
    first = client.post("/devices/pair", json={"code": code.lower()})  # case-insensitive
    assert first.status_code == 200
    assert first.json()["username"] == "maya"
    assert client.post("/devices/pair", json={"code": code}).status_code == 400


def test_expired_pair_code_rejected(client, make_user):
    maya = make_user("maya")
    code = client.post("/devices/pair-code", headers=maya.headers).json()["code"]
    # Push the code's expiry into the past.
    with Session(client.app.state.engine) as db:
        pair = db.get(PairCode, code)
        pair.expires_at -= timedelta(minutes=11)
        db.commit()
    res = client.post("/devices/pair", json={"code": code})
    assert res.status_code == 400
    assert "expired" in res.json()["detail"]


def test_phone_upload_syncs_to_pc(client, make_user):
    maya, bob = make_user("maya"), make_user("bob")
    phone = pair(client, maya, "Maya's iPhone")

    assert client.get("/device/me", headers=phone).json() == {"device_name": "Maya's iPhone", "username": "maya"}

    res = upload(client, phone, exercise="deadlift")
    assert res.status_code == 201, res.text
    rec = res.json()
    assert rec["exercise"] == "deadlift"
    assert rec["status"] == "uploaded"
    assert rec["device_name"] == "Maya's iPhone"

    listed = client.get("/me/recordings", headers=maya.headers).json()
    assert [r["id"] for r in listed] == [rec["id"]]
    url = client.get(f"/me/recordings/{rec['id']}/play", headers=maya.headers).json()["url"]
    video = client.get(url)  # signed link: works in a <video> tag without the login header
    assert video.status_code == 200
    assert video.content.endswith(b"fake-video")

    # Tampered or other-file links don't work.
    assert client.get(url.replace("sig=", "sig=0")).status_code == 404
    assert client.get(url.replace("exp=", "exp=1")).status_code == 404

    # Other users can't see or play it.
    assert client.get("/me/recordings", headers=bob.headers).json() == []
    assert client.get(f"/me/recordings/{rec['id']}/play", headers=bob.headers).status_code == 404

    devices = client.get("/me/devices", headers=maya.headers).json()
    assert devices[0]["last_seen_at"] is not None


def test_upload_rules(client, make_user):
    maya = make_user("maya")
    phone = pair(client, maya)
    assert upload(client, {"X-Device-Token": "bogus"}).status_code == 401
    assert upload(client, {}).status_code == 401
    assert upload(client, maya.headers).status_code == 401  # a login token isn't a phone token
    assert upload(client, phone, ctype="text/plain").status_code == 415
    assert upload(client, phone, data=b"").status_code == 400
    assert upload(client, phone, exercise="yoga").status_code == 422


def test_unlinked_phone_stops_syncing(client, make_user):
    maya = make_user("maya")
    phone = pair(client, maya)
    device_id = client.get("/me/devices", headers=maya.headers).json()[0]["id"]
    assert client.delete(f"/me/devices/{device_id}", headers=maya.headers).status_code == 204
    assert upload(client, phone).status_code == 401
    assert client.get("/device/me", headers=phone).status_code == 401
