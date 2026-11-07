"""End-to-end check of a running RevGym (start it first with `python run.py`).

Uses a throwaway account, exercises every feature against whatever database and
video storage the server is configured with (e.g. your Supabase project), then
deletes everything it created.

Usage: python smoke_test.py
"""

import secrets
import sys
import warnings

import httpx
from sqlalchemy import text

from app.config import Settings
from app.db import make_engine
from app.storage import SupabaseStore

PC = "http://127.0.0.1:8000"
PHONE = "https://127.0.0.1:8443"  # the phone side, over the self-signed HTTPS port
SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\n"

warnings.filterwarnings("ignore", message="Unverified HTTPS request")
results: list[tuple[bool, str]] = []


def check(ok: bool, label: str) -> bool:
    results.append((bool(ok), label))
    print(("  PASS  " if ok else "  FAIL  ") + label)
    return bool(ok)


def clients():
    """Use the running server if there is one; otherwise run RevGym in-process (same settings)."""
    try:
        httpx.get(f"{PC}/health", timeout=3).raise_for_status()
        print("Testing the running server (PC http :8000, phone https :8443).")
        return httpx.Client(base_url=PC, timeout=60), httpx.Client(base_url=PHONE, timeout=60, verify=False)
    except httpx.HTTPError:
        from fastapi.testclient import TestClient

        from app.main import create_app

        print("No server running: testing RevGym in-process with your .env settings.")
        app_client = TestClient(create_app(), base_url="http://127.0.0.1")
        return app_client, app_client


def main() -> int:
    pc, phone = clients()
    username = f"smoke_{secrets.token_hex(3)}"
    password = secrets.token_urlsafe(12)
    user_id = None
    stored_names: list[str] = []

    try:
        print("\nServer")
        health = pc.get("/health").json()
        check(health["status"] == "ok", f"server is up (database={health['database']}, videos={health['video_storage']})")

        print("\nAccounts")
        r = pc.post("/auth/register", json={"username": username, "password": password})
        check(r.status_code == 201, "sign up")
        user_id = r.json()["user"]["id"]
        auth = {"Authorization": f"Bearer {r.json()['token']}"}
        check(pc.post("/auth/register", json={"username": username, "password": password}).status_code == 409, "duplicate username rejected")
        check(pc.post("/auth/login", json={"username": username, "password": "wrong-password"}).status_code == 401, "wrong password rejected")
        r = pc.post("/auth/login", json={"username": username, "password": password})
        check(r.status_code == 200, "log in")
        check(pc.get("/auth/me", headers=auth).json()["username"] == username, "who am I")

        print("\nScans and leaderboard")
        r = pc.post("/scans", headers=auth, json={"exercise": "bench_press", "weight_lb": 999,
                                                  "reps": [{"form_score": 94, "angles": {"elbow_tuck": 58}}, {"form_score": 90}]})
        check(r.status_code == 201 and r.json()["points"] == 92 and r.json()["qualified"], "good set scored (92 pts)")
        r = pc.post("/scans", headers=auth, json={"exercise": "bench_press", "weight_lb": 2000, "reps": [{"form_score": 50}]})
        check(r.status_code == 201 and not r.json()["qualified"], "sloppy set doesn't qualify")
        board = pc.get("/leaderboard", params={"exercise": "bench_press", "period": "week"}, headers=auth).json()
        top = board["entries"][0] if board["entries"] else {}
        check(top.get("username") == username and top.get("weight_lb") == 999, "999 lb set is #1 on bench (the 2000 lb sloppy one is ignored)")
        board = pc.get("/leaderboard", params={"exercise": "all", "period": "all_time"}, headers=auth).json()
        check(board["me"] is not None and board["me"]["entry"]["value"] == 92, f"my all-lifts rank is #{board['me']['entry']['rank'] if board['me'] else '?'} with 92 pts")
        check(pc.get("/leaderboard").status_code == 200, "leaderboard is public")
        check(len(pc.get("/me/scans", headers=auth).json()) == 2, "my scan history")

        print("\nLinking a phone by QR (phone side over HTTPS)")
        r = pc.post("/devices/pair-code", headers=auth).json()
        check(r["qr_svg"].startswith("data:image/svg+xml") and "#code=" in r["phone_url"], f"QR code points to {r['phone_url'].split('#')[0]}")
        check(phone.get("/phone").status_code == 200, "phone camera page loads over HTTPS")
        r = phone.post("/devices/pair", json={"code": r["code"], "device_name": "Smoke phone"})
        check(r.status_code == 200, "phone links with the code")
        dev = {"X-Device-Token": r.json()["device_token"]}
        device_id = pc.get("/me/devices", headers=auth).json()[0]["id"]

        print("\nLive camera link")
        phone.post("/device/live/poll", headers=dev, json={"camera": True, "recording": False})
        d = pc.get("/me/devices", headers=auth).json()[0]
        check(d["online"] and d["camera"], "PC sees the phone online with camera on")
        offer_id = pc.post(f"/me/devices/{device_id}/live/offer", headers=auth, json={"sdp": SDP}).json()["offer_id"]
        inbox = phone.post("/device/live/poll", headers=dev, json={"camera": True}).json()
        check(inbox["offer"] and inbox["offer"]["id"] == offer_id, "phone receives the PC's live-view offer")
        phone.post("/device/live/answer", headers=dev, json={"offer_id": offer_id, "sdp": SDP + "a=answer\r\n"})
        ans = pc.get(f"/me/devices/{device_id}/live/answer", params={"offer_id": offer_id}, headers=auth).json()
        check(ans["sdp"] and ans["sdp"].endswith("a=answer\r\n"), "PC receives the phone's answer")
        pc.post(f"/me/devices/{device_id}/live/command", headers=auth, json={"action": "start", "exercise": "squat"})
        cmds = phone.post("/device/live/poll", headers=dev, json={"camera": True, "recording": True}).json()["commands"]
        check(cmds == [{"action": "start", "exercise": "squat"}], "Start recording reaches the phone")
        check(pc.get("/me/devices", headers=auth).json()[0]["recording"], "PC sees the phone recording")

        print("\nVideo upload and playback")
        video = b"\x00\x00\x00\x18ftypmp42" + secrets.token_bytes(256 * 1024)
        r = phone.post("/recordings", headers=dev, data={"exercise": "squat"}, files={"video": ("set.mp4", video, "video/mp4")})
        check(r.status_code == 201, f"phone uploads a {len(video) // 1024} KB video")
        rec_id = r.json()["id"]
        with make_engine(Settings().database_url).connect() as c:
            stored_names = [row[0] for row in c.execute(text("select stored_name from recordings where user_id=:u"), {"u": user_id})]
        recs = pc.get("/me/recordings", headers=auth).json()
        check([x["id"] for x in recs] == [rec_id], "it shows up in the PC's Recordings")
        url = pc.get(f"/me/recordings/{rec_id}/play", headers=auth).json()["url"]
        fetch = (lambda u: httpx.get(u, timeout=60)) if url.startswith("http") else pc.get
        played = fetch(url)
        check(played.status_code == 200 and played.content == video, f"it plays back byte-for-byte from {'Supabase Storage' if 'supabase.co' in url else 'this PC'}")
        check(fetch(url.split("?")[0]).status_code >= 400, "the video can't be opened without the signed link")

        print("\nPrivacy")
        other = pc.post("/auth/register", json={"username": username + "_b", "password": password}).json()
        other_auth = {"Authorization": f"Bearer {other['token']}"}
        check(pc.get("/me/recordings", headers=other_auth).json() == [], "another user can't see my recordings")
        check(pc.get(f"/me/recordings/{rec_id}/play", headers=other_auth).status_code == 404, "another user can't play my video")
        check(pc.post(f"/me/devices/{device_id}/live/command", headers=other_auth, json={"action": "stop"}).status_code == 404, "another user can't control my phone")
        check(phone.get("/me/recordings", headers=dev).status_code == 401, "the phone token can't read my account")

        print("\nUnlink and log out")
        check(pc.delete(f"/me/devices/{device_id}", headers=auth).status_code == 204, "unlink the phone")
        check(phone.post("/recordings", headers=dev, data={"exercise": "squat"},
                         files={"video": ("x.mp4", b"x" * 100, "video/mp4")}).status_code == 401, "unlinked phone can't upload")
        check(pc.post("/auth/logout", headers=auth).status_code == 204 and pc.get("/auth/me", headers=auth).status_code == 401, "log out ends the session")

    except Exception as exc:  # report, then still clean up
        check(False, f"unexpected error: {type(exc).__name__}: {str(exc)[:200]}")
    finally:
        cleanup(username, stored_names)

    passed = sum(ok for ok, _ in results)
    print(f"\n{passed}/{len(results)} checks passed.")
    return 0 if passed == len(results) else 1


def cleanup(username: str, stored_names: list[str]) -> None:
    """Delete the throwaway accounts and everything they made."""
    settings = Settings()
    with make_engine(settings.database_url).begin() as c:
        ids = [r[0] for r in c.execute(text("select id from users where username in (:a, :b)"), {"a": username, "b": username + "_b"})]
        for uid in ids:
            c.execute(text("delete from reps where set_id in (select id from scan_sets where user_id=:u)"), {"u": uid})
            for table in ("scan_sets", "recordings", "devices", "login_sessions", "pair_codes"):
                c.execute(text(f"delete from {table} where user_id=:u"), {"u": uid})
            c.execute(text("delete from users where id=:u"), {"u": uid})
    if stored_names and settings.uses_supabase_storage:
        store = SupabaseStore(settings.supabase_url, settings.supabase_service_key, settings.storage_bucket)
        store.http.request("DELETE", f"{store.base}/object/{settings.storage_bucket}",
                           headers=store.headers, json={"prefixes": stored_names})
    elif stored_names:
        for name in stored_names:
            (settings.upload_dir / name).unlink(missing_ok=True)
    print(f"\nCleaned up the test accounts ({len(stored_names)} video file(s) deleted).")


if __name__ == "__main__":
    sys.exit(main())
