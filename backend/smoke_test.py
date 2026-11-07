"""End-to-end check of RevGym against your real database (e.g. Supabase).

Uses throwaway accounts, exercises sign-up (with the profile), log in, the
leaderboard, phone linking and the live camera link, then deletes everything
it created.

Usage: python smoke_test.py            (runs RevGym in-process with your .env)
       python smoke_test.py --server   (tests the server started with run.py)
"""

import secrets
import sys
import warnings

import httpx
from sqlalchemy import text

from app.config import Settings
from app.db import make_engine

PC = "http://127.0.0.1:8000"
PHONE = "https://127.0.0.1:8443"  # the phone side, over the self-signed HTTPS port
SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\n"
PROFILE = {"grad_year": 2027, "major": "Kinesiology", "weight_lb": 181.5, "height_in": 71,
           "gender": "prefer_not_to_say", "birth_date": "2005-03-14"}

warnings.filterwarnings("ignore", message="Unverified HTTPS request")
results: list[tuple[bool, str]] = []


def check(ok: bool, label: str) -> bool:
    results.append((bool(ok), label))
    print(("  PASS  " if ok else "  FAIL  ") + label)
    return bool(ok)


def clients():
    """In-process RevGym with your .env settings; `--server` tests the server started by run.py."""
    if "--server" in sys.argv:
        print("Testing the running server (PC http :8000, phone https :8443).")
        return httpx.Client(base_url=PC, timeout=60), httpx.Client(base_url=PHONE, timeout=60, verify=False)
    from fastapi.testclient import TestClient

    from app.main import create_app

    print("Testing RevGym in-process with your .env settings.")
    app_client = TestClient(create_app(), base_url="http://127.0.0.1")
    return app_client, app_client


def main() -> int:
    pc, phone = clients()
    username = f"smoke_{secrets.token_hex(3)}"
    password = secrets.token_urlsafe(12)

    try:
        print("\nServer")
        health = pc.get("/health").json()
        check(health["status"] == "ok", f"server is up (database={health['database']})")

        print("\nSign up with profile")
        no_profile = pc.post("/auth/register", json={"username": username, "password": password})
        check(no_profile.status_code == 422, "sign-up without the profile is refused")
        too_young = pc.post("/auth/register", json={"username": username, "password": password, **PROFILE, "birth_date": "2020-01-01"})
        check(too_young.status_code == 422 and "at least 13" in too_young.text, "under-13 date of birth is refused")
        r = pc.post("/auth/register", json={"username": username, "password": password, **PROFILE})
        check(r.status_code == 201, "sign up with year, major, weight, height, gender, date of birth")
        auth = {"Authorization": f"Bearer {r.json()['token']}"}
        with make_engine(Settings().database_url).connect() as c:
            row = c.execute(text("select grad_year, major, weight_lb, height_in, gender, birth_date, password_hash "
                                 "from users where username=:u"), {"u": username}).one()
        check((row.grad_year, row.major, row.weight_lb, row.height_in, row.gender, str(row.birth_date)) ==
              (2027, "Kinesiology", 181.5, 71, "prefer_not_to_say", "2005-03-14"), "profile saved in the users table")
        check(row.password_hash.startswith("scrypt$") and password not in row.password_hash, "password stored only as a hash")
        check(pc.post("/auth/register", json={"username": username, "password": password, **PROFILE}).status_code == 409,
              "duplicate username rejected")

        print("\nLog in")
        check(pc.post("/auth/login", json={"username": username, "password": "wrong-password"}).status_code == 401, "wrong password rejected")
        r = pc.post("/auth/login", json={"username": username, "password": password})
        check(r.status_code == 200, "log in with username + password")
        me = pc.get("/auth/me", headers=auth).json()
        check(me["username"] == username and me["grad_year"] == 2027 and me["gender"] == "prefer_not_to_say", "my account shows my profile")
        r = pc.patch("/me/profile", headers=auth, json={"weight_lb": 185, "major": "Nutrition"})
        check(r.status_code == 200 and r.json()["weight_lb"] == 185 and r.json()["major"] == "Nutrition", "profile can be edited later")

        print("\nLeaderboard and the team UI")
        r = pc.post("/scans", headers=auth, json={"exercise": "bench_press", "weight_lb": 999,
                                                  "reps": [{"form_score": 94}, {"form_score": 90}]})
        check(r.status_code == 201 and r.json()["points"] == 92, "a scanned set scores 92 pts")
        top = pc.get("/leaderboard", params={"exercise": "bench_press", "period": "week"}).json()["entries"][0]
        check(top["username"] == username and top["weight_lb"] == 999, "it tops the bench leaderboard")
        live = pc.get("/api/ui/live", headers=auth)
        cu = live.json()["currentUser"]
        check(cu["classYear"] == "'27" and cu["major"] == "Nutrition", "team UI shows Class of '27 · Nutrition")
        check(all(s not in live.text for s in ("weight_lb", "birth_date", "2005-03-14", "prefer_not_to_say")),
              "team UI never receives weight, gender or date of birth")

        print("\nPhone link (QR) and live camera")
        code = pc.post("/devices/pair-code", headers=auth).json()["code"]
        r = phone.post("/devices/pair", json={"code": code, "device_name": "Smoke phone"})
        check(r.status_code == 200, "phone links with the QR code")
        dev = {"X-Device-Token": r.json()["device_token"]}
        device_id = pc.get("/me/devices", headers=auth).json()[0]["id"]
        phone.post("/device/live/poll", headers=dev, json={"camera": True})
        offer_id = pc.post(f"/me/devices/{device_id}/live/offer", headers=auth, json={"sdp": SDP}).json()["offer_id"]
        inbox = phone.post("/device/live/poll", headers=dev, json={"camera": True}).json()
        check(inbox["offer"] and inbox["offer"]["id"] == offer_id, "phone receives the PC's live-view offer")
        check(phone.get("/auth/me", headers=dev).status_code == 401, "the phone token can't read my account")

        print("\nPrivacy and log out")
        other = pc.post("/auth/register", json={"username": username + "_b", "password": password, **PROFILE}).json()
        other_auth = {"Authorization": f"Bearer {other['token']}"}
        check(pc.get("/auth/me", headers=other_auth).json()["username"] == username + "_b", "another user only sees their own account")
        check(pc.post(f"/me/devices/{device_id}/live/offer", headers=other_auth, json={"sdp": SDP}).status_code == 404, "another user can't use my phone")
        check(pc.post("/auth/logout", headers=auth).status_code == 204 and pc.get("/auth/me", headers=auth).status_code == 401, "log out ends the session")

    except Exception as exc:  # report, then still clean up
        check(False, f"unexpected error: {type(exc).__name__}: {str(exc)[:200]}")
    finally:
        cleanup(username)

    passed = sum(ok for ok, _ in results)
    print(f"\n{passed}/{len(results)} checks passed.")
    return 0 if passed == len(results) else 1


def cleanup(username: str) -> None:
    """Delete the throwaway accounts and everything they made."""
    with make_engine(Settings().database_url).begin() as c:
        ids = [r[0] for r in c.execute(text("select id from users where username in (:a, :b)"), {"a": username, "b": username + "_b"})]
        for uid in ids:
            c.execute(text("delete from reps where set_id in (select id from scan_sets where user_id=:u)"), {"u": uid})
            for table in ("scan_sets", "devices", "login_sessions", "pair_codes"):
                c.execute(text(f"delete from {table} where user_id=:u"), {"u": uid})
            c.execute(text("delete from users where id=:u"), {"u": uid})
    print(f"\nCleaned up {len(ids)} test account(s).")


if __name__ == "__main__":
    sys.exit(main())
