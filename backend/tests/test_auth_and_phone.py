from datetime import date, timedelta

import pytest
from conftest import PASSWORD, PROFILE, signup
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PairCode, User


def creds(username, password=PASSWORD):
    """Login body (username + password only)."""
    return {"username": username, "password": password}


# ---------- accounts ----------

def test_register_login_me_logout(client):
    res = client.post("/auth/register", json=signup("maya"))
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
    client.post("/auth/register", json=signup("maya"))
    wrong_pw = client.post("/auth/login", json=creds("maya", "wrong-password"))
    no_user = client.post("/auth/login", json=creds("nobody"))
    assert wrong_pw.status_code == no_user.status_code == 401
    assert wrong_pw.json() == no_user.json()


def test_register_rules(client):
    client.post("/auth/register", json=signup("maya"))
    assert client.post("/auth/register", json=signup("maya")).status_code == 409
    assert client.post("/auth/register", json=signup("ok_name", "short")).status_code == 422
    assert client.post("/auth/register", json=signup("bad name!")).status_code == 422


# ---------- sign-up profile ----------

def test_signup_saves_the_profile(client):
    res = client.post("/auth/register", json=signup("maya", grad_year=2026, major="  Computer Science ",
                                                    weight_lb=142.5, height_in=65, gender="female", birth_date="2004-09-30"))
    assert res.status_code == 201, res.text
    token = res.json()["token"]
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert (me["grad_year"], me["major"], me["weight_lb"], me["height_in"], me["gender"], me["birth_date"]) == \
        (2026, "Computer Science", 142.5, 65, "female", "2004-09-30")
    # It's really in the users table.
    with Session(client.app.state.engine) as db:
        row = db.scalar(select(User).where(User.username == "maya"))
        assert (row.grad_year, row.gender, row.birth_date) == (2026, "female", date(2004, 9, 30))


@pytest.mark.parametrize("field", ["grad_year", "major", "weight_lb", "height_in", "gender", "birth_date"])
def test_signup_needs_every_profile_field(client, field):
    body = signup("maya")
    del body[field]
    assert client.post("/auth/register", json=body).status_code == 422


@pytest.mark.parametrize("change, words", [
    ({"weight_lb": 20}, "greater than or equal to 50"),
    ({"height_in": 120}, "less than or equal to 96"),
    ({"gender": "robot"}, "Input should be"),
    ({"grad_year": 1900}, "graduation year"),
    ({"birth_date": str(date.today() - timedelta(days=365 * 10))}, "at least 13"),
    ({"birth_date": str(date.today() + timedelta(days=5))}, "future"),
    ({"major": "x"}, "at least 2"),
])
def test_signup_profile_rules(client, change, words):
    res = client.post("/auth/register", json=signup("maya", **change))
    assert res.status_code == 422
    assert words in res.text
    with Session(client.app.state.engine) as db:
        assert db.scalar(select(User)) is None  # nothing saved


def test_profile_can_be_changed_later(client, make_user):
    maya = make_user("maya")
    res = client.patch("/me/profile", headers=maya.headers, json={"weight_lb": 180, "major": "Nutrition"})
    assert res.status_code == 200
    assert (res.json()["weight_lb"], res.json()["major"], res.json()["grad_year"]) == (180, "Nutrition", PROFILE["grad_year"])
    assert client.patch("/me/profile", headers=maya.headers, json={"birth_date": "2030-01-01"}).status_code == 422
    assert client.patch("/me/profile", json={"weight_lb": 1}).status_code == 401


def test_login_only_needs_username_and_password(client):
    client.post("/auth/register", json=signup("maya"))
    assert client.post("/auth/login", json=creds("maya")).status_code == 200


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


def test_linked_phone_is_only_a_camera(client, make_user):
    maya = make_user("maya")
    phone = pair(client, maya, "Maya's iPhone")
    assert client.get("/device/me", headers=phone).json() == {"device_name": "Maya's iPhone", "username": "maya"}
    assert client.get("/me/devices", headers=maya.headers).json()[0]["last_seen_at"] is not None
    # Nothing can be uploaded, and a phone token can't read or change the account.
    assert client.post("/recordings", headers=phone, files={"video": ("x.mp4", b"x", "video/mp4")}).status_code in (404, 405)
    assert client.post("/scan-files", headers=phone, files={"file": ("s.csv", b"x", "text/csv")}).status_code in (404, 405)
    assert client.get("/auth/me", headers=phone).status_code == 401
    assert client.patch("/me/profile", headers=phone, json={"major": "x y"}).status_code == 401


def test_unlinked_phone_stops_working(client, make_user):
    maya = make_user("maya")
    phone = pair(client, maya)
    device_id = client.get("/me/devices", headers=maya.headers).json()[0]["id"]
    assert client.delete(f"/me/devices/{device_id}", headers=maya.headers).status_code == 204
    assert client.post("/device/live/poll", json={"camera": True}, headers=phone).status_code == 401
    assert client.get("/device/me", headers=phone).status_code == 401
