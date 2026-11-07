"""RevGym: the PC app's server.

The PC is the main app (sign up / log in, leaderboard, live phone camera).
A phone on the same Wi-Fi scans a QR code to link, then acts as the live camera.
No video or files are stored.

Data: Supabase Postgres when DATABASE_URL is set in backend/.env (accounts,
profiles, logins, scanned sets), otherwise a local SQLite file.

Run:   python run.py   (PC on http://127.0.0.1:8000, phone page on HTTPS :8443)
Docs:  http://127.0.0.1:8000/docs
"""

from collections.abc import Iterator
from datetime import timezone
from typing import Literal

import json

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import ui_bridge
from .auth import bearer, check_login, end_session, hash_password, make_auth_dependencies, start_session, user_for_token
from .config import BACKEND_DIR, Settings
from .db import Base, add_missing_columns, make_engine, make_session_factory, secure_supabase_tables
from .devices import lan_address, make_device_dependency, new_pair_code, qr_svg_data_uri, redeem_pair_code
from .leaderboard import build_leaderboard
from .live import LiveHub
from .models import Device, Rep, ScanSet, User, utcnow
from .schemas import (
    AuthOut,
    Credentials,
    DeviceOut,
    LeaderboardOut,
    LiveAnswerIn,
    LiveOfferIn,
    PairCodeOut,
    PairIn,
    PairOut,
    PhoneStateIn,
    ProfileIn,
    ScanIn,
    SignUpIn,
    ScanOut,
    UserOut,
)
from .scoring import QUALIFYING_FORM_SCORE, Exercise, qualifies, set_form_score, set_points

STATIC_DIR = BACKEND_DIR / "app" / "static"
SESSION_COOKIE = "revgym_session"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    engine = make_engine(settings.database_url or None)
    Base.metadata.create_all(engine)
    add_missing_columns(engine)
    secure_supabase_tables(engine)
    SessionLocal = make_session_factory(engine)

    live = LiveHub()

    app = FastAPI(title="RevGym API", version="0.6.0")
    app.state.engine = engine
    app.state.live = live

    def get_db() -> Iterator[Session]:
        with SessionLocal() as session:
            yield session

    optional_user, current_user = make_auth_dependencies(get_db)
    current_device = make_device_dependency(get_db)

    def owned_device(device_id: int, user: User, db: Session) -> Device:
        device = db.get(Device, device_id)
        if device is None or device.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
        return device

    # ---------- web pages ----------

    class RevalidatedStatic(StaticFiles):
        """Browsers re-check our CSS/JS on each load (cheap 304s), so updates show up right away."""

        def file_response(self, *args, **kwargs):
            response = super().file_response(*args, **kwargs)
            response.headers["Cache-Control"] = "no-cache"
            return response

    app.mount("/static", RevalidatedStatic(directory=STATIC_DIR), name="static")

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def pc_app():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/phone", include_in_schema=False)
    def phone_camera():
        return FileResponse(STATIC_DIR / "phone.html")

    # ---------- general ----------

    @app.get("/health")
    def health():
        return {"status": "ok", "database": engine.dialect.name}

    @app.get("/exercises")
    def list_exercises():
        return {"exercises": [e.value for e in Exercise], "qualifying_form_score": QUALIFYING_FORM_SCORE}

    # ---------- accounts ----------

    def set_session_cookie(request: Request, response: Response, token: str) -> None:
        # Lets the team's unchanged UI page (/ui/) know who you are. HttpOnly: page scripts can't read it.
        # Only GET routes accept this cookie, so other sites can't use it to change anything.
        response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax",
                            secure=request.url.scheme == "https", max_age=30 * 24 * 3600, path="/")

    def cookie_user(request: Request, db: Session = Depends(get_db)) -> User | None:
        token = request.cookies.get(SESSION_COOKIE)
        return user_for_token(db, token) if token else None

    def viewer(
        bearer_user: User | None = Depends(optional_user),
        from_cookie: User | None = Depends(cookie_user),
    ) -> User | None:
        """For read-only routes: a Bearer token or the /ui/ cookie."""
        return bearer_user or from_cookie

    @app.post("/auth/register", response_model=AuthOut, status_code=status.HTTP_201_CREATED)
    def register(body: SignUpIn, request: Request, response: Response, db: Session = Depends(get_db)):
        """Sign up. Saves the account and profile to the users table (Supabase)."""
        user = User(
            username=body.username,
            password_hash=hash_password(body.password),
            grad_year=body.grad_year,
            major=body.major,
            weight_lb=body.weight_lb,
            height_in=body.height_in,
            gender=body.gender,
            birth_date=body.birth_date,
        )
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "That username is taken.")
        token = start_session(db, user)
        set_session_cookie(request, response, token)
        return {"token": token, "user": user}

    @app.post("/auth/login", response_model=AuthOut)
    def login(body: Credentials, request: Request, response: Response, db: Session = Depends(get_db)):
        user = check_login(db, body.username, body.password)
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong username or password.")
        token = start_session(db, user)
        set_session_cookie(request, response, token)
        return {"token": token, "user": user}

    @app.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
    def logout(
        response: Response,
        creds: HTTPAuthorizationCredentials | None = Depends(bearer),
        _user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        end_session(db, creds.credentials)
        response.delete_cookie(SESSION_COOKIE, path="/")

    @app.get("/auth/me", response_model=UserOut)
    def me(user: User = Depends(current_user)):
        return user

    @app.patch("/me/profile", response_model=UserOut)
    def update_profile(body: ProfileIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
        """Change your profile (graduation year, major, weight, height, gender, date of birth, ...)."""
        for field_name, value in body.model_dump(exclude_unset=True).items():
            setattr(user, field_name, value)
        db.commit()
        db.refresh(user)
        return user

    # ---------- the team's UI, unchanged, with live data ----------

    ui_dir = settings.ui_dir

    def ui_file(name: str):
        """A file inside the UI folder, or None (also blocks ../ tricks)."""
        root = ui_dir.resolve()
        if not root.is_dir():
            return None
        path = (root / name).resolve()
        if root not in path.parents or not path.is_file():
            return None
        return path

    @app.get("/ui", include_in_schema=False)
    def ui_redirect():
        return RedirectResponse("/ui/")

    @app.get("/ui/", include_in_schema=False)
    def ui_page(user: User | None = Depends(cookie_user)):
        index = ui_file("index.html")
        if index is None:
            return HTMLResponse(f"<p>The team's UI folder wasn't found at <code>{ui_dir}</code>. "
                                "Put the <code>ui/</code> folder from the front-end branch there, "
                                "or set UI_DIR in backend/.env.</p>", status_code=404)
        if user is None:
            return FileResponse(STATIC_DIR / "ui-login.html", headers={"Cache-Control": "no-store"})
        # index.html has no <html>/<head> (it was written for an artifact host), so wrap it
        # the same way the team's preview.html does. The UI's own content is untouched.
        body = index.read_text(encoding="utf-8")
        page = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
                f"{body}\n</body></html>\n")
        return HTMLResponse(page, headers={"Cache-Control": "no-store"})

    @app.get("/ui/logout", include_in_schema=False)
    def ui_logout_page():
        return FileResponse(STATIC_DIR / "ui-logout.html", headers={"Cache-Control": "no-store"})

    @app.get("/ui/whoami", include_in_schema=False)
    def ui_whoami(user: User | None = Depends(cookie_user)):
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not logged in")
        return {"username": user.username}

    @app.post("/ui/logout", status_code=status.HTTP_204_NO_CONTENT, include_in_schema=False)
    def ui_logout(request: Request, response: Response, db: Session = Depends(get_db)):
        """End the /ui/ session. Only RevGym's own pages may call this (blocks other sites logging you out)."""
        origin = request.headers.get("origin")
        fetch_site = request.headers.get("sec-fetch-site")
        same_origin = (origin is None or origin == f"{request.url.scheme}://{request.url.netloc}") and \
                      fetch_site in (None, "same-origin")
        if not same_origin:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "cross-site request")
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            end_session(db, token)
        response.delete_cookie(SESSION_COOKIE, path="/")

    @app.get("/ui/mock-data.js", include_in_schema=False)
    def ui_live_data(user: User | None = Depends(cookie_user), db: Session = Depends(get_db)):
        """The team's own mock-data.js (for the catalog: exercises, tips, gyms), then real data on top."""
        original = ui_file("mock-data.js")
        if original is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        js = original.read_text(encoding="utf-8")
        if user is not None:
            live = json.dumps(ui_bridge.build_live(db, user), ensure_ascii=False)
            js += f"\n\n/* Live RevGym data for {user.username} (added by the backend). */\n" \
                  f"Object.assign(window.REVGYM_MOCK, {live});\n"
        return Response(js, media_type="text/javascript", headers={"Cache-Control": "no-store"})

    @app.get("/ui/{path:path}", include_in_schema=False)
    def ui_static(path: str):
        file = ui_file(path)
        if file is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        return FileResponse(file, headers={"Cache-Control": "no-cache"})

    def _live_for(user: User | None, db: Session) -> dict:
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not logged in")
        return ui_bridge.build_live(db, user)

    @app.get("/api/ui/live")
    def api_ui_live(user: User | None = Depends(viewer), db: Session = Depends(get_db)):
        """Everything the UI reads from REVGYM_MOCK (users, leaderboards, profile, history...)."""
        return _live_for(user, db)

    @app.get("/api/ui/form-leaderboard")
    def api_ui_form_board(
        exercise: str = Query(..., pattern="^(squat|bench|deadlift|ohp|pullup|curl|rdl|row|lunge)$"),
        period: Literal["week", "month", "all"] = "week",
        user: User | None = Depends(viewer),
        db: Session = Depends(get_db),
    ):
        """Same shape as the UI's Api.getFormLeaderboard(exerciseId, period)."""
        return ui_bridge.form_leaderboard(_live_for(user, db), exercise, period)

    @app.get("/api/ui/consistency-leaderboard")
    def api_ui_consistency_board(
        period: Literal["week", "month", "all"] = "week",
        user: User | None = Depends(viewer),
        db: Session = Depends(get_db),
    ):
        """Same shape as the UI's Api.getConsistencyLeaderboard(period)."""
        return ui_bridge.consistency_leaderboard(_live_for(user, db), period)

    # ---------- scans (analysed sets) ----------

    @app.post("/scans", response_model=ScanOut, status_code=status.HTTP_201_CREATED)
    def submit_scan(body: ScanIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
        """Store one analysed set for the logged-in user and score it for the leaderboard."""
        form = set_form_score([r.form_score for r in body.reps])
        recorded_at = body.recorded_at or utcnow()
        if recorded_at.tzinfo is not None:
            recorded_at = recorded_at.astimezone(timezone.utc).replace(tzinfo=None)
        scan = ScanSet(
            user_id=user.id,
            exercise=body.exercise.value,
            weight_lb=body.weight_lb,
            rep_count=len(body.reps),
            form_score=form,
            qualified=qualifies(form),
            points=set_points(form),
            recorded_at=recorded_at,
            reps=[Rep(index=i + 1, form_score=r.form_score, angles=r.angles) for i, r in enumerate(body.reps)],
        )
        db.add(scan)
        db.commit()
        db.refresh(scan)
        return scan

    @app.get("/me/scans", response_model=list[ScanOut])
    def my_scans(
        exercise: Exercise | None = None,
        limit: int = Query(20, ge=1, le=200),
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        stmt = (
            select(ScanSet)
            .where(ScanSet.user_id == user.id)
            .options(selectinload(ScanSet.reps))
            .order_by(ScanSet.recorded_at.desc(), ScanSet.id.desc())
            .limit(limit)
        )
        if exercise is not None:
            stmt = stmt.where(ScanSet.exercise == exercise.value)
        return db.scalars(stmt).all()

    # ---------- linking a phone (QR code) ----------

    @app.post("/devices/pair-code", response_model=PairCodeOut)
    def get_pair_code(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
        """PC: a QR code that links a phone. Valid for 10 minutes, single use."""
        pair = new_pair_code(db, user)
        host = request.url.hostname
        if host in ("localhost", "127.0.0.1", "::1"):
            host = lan_address()
        if settings.phone_https_port:
            base = f"https://{host}:{settings.phone_https_port}"
        else:
            port = f":{request.url.port}" if request.url.port else ""
            base = f"{request.url.scheme}://{host}{port}"
        # The code rides in the #fragment, which browsers never send to servers or logs.
        phone_url = f"{base}/phone#code={pair.code}"
        return {"code": pair.code, "expires_at": pair.expires_at, "phone_url": phone_url,
                "qr_svg": qr_svg_data_uri(phone_url)}

    @app.post("/devices/pair", response_model=PairOut)
    def pair_phone(body: PairIn, db: Session = Depends(get_db)):
        """Phone: trade the code from the QR for a device token."""
        token, user = redeem_pair_code(db, body.code, body.device_name)
        return {"device_token": token, "username": user.username}

    def _device_out(d: Device) -> DeviceOut:
        out = DeviceOut.model_validate(d)
        st = live.status(d.id)
        out.online, out.camera = st["online"], st["camera"]
        return out

    @app.get("/me/devices", response_model=list[DeviceOut])
    def my_devices(user: User = Depends(current_user), db: Session = Depends(get_db)):
        devices = db.scalars(select(Device).where(Device.user_id == user.id).order_by(Device.created_at.desc())).all()
        return [_device_out(d) for d in devices]

    @app.delete("/me/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
    def unlink_device(device_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
        device = owned_device(device_id, user, db)
        live.forget(device.id)
        db.delete(device)
        db.commit()

    @app.get("/device/me")
    def device_whoami(device: Device = Depends(current_device)):
        return {"device_name": device.name, "username": device.user.username}

    # ---------- live camera: PC side ----------

    @app.post("/me/devices/{device_id}/live/offer")
    def live_offer(device_id: int, body: LiveOfferIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
        """PC: start (or restart) the live view. Returns an id to poll the answer with."""
        owned_device(device_id, user, db)
        return {"offer_id": live.post_offer(device_id, body.sdp)}

    @app.get("/me/devices/{device_id}/live/answer")
    def live_answer(device_id: int, offer_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
        owned_device(device_id, user, db)
        return {"sdp": live.get_answer(device_id, offer_id)}

    # ---------- live camera: phone side ----------

    @app.post("/device/live/poll")
    def phone_poll(body: PhoneStateIn, device: Device = Depends(current_device)):
        """Phone: check in about once a second. Returns any new live-view offer."""
        return live.phone_poll(device.id, body.camera)

    @app.post("/device/live/answer", status_code=status.HTTP_204_NO_CONTENT)
    def phone_answer(body: LiveAnswerIn, device: Device = Depends(current_device)):
        live.post_answer(device.id, body.offer_id, body.sdp)

    # ---------- leaderboard ----------

    @app.get("/leaderboard", response_model=LeaderboardOut)
    def leaderboard(
        exercise: Literal["all"] | Exercise = "all",
        period: Literal["week", "all_time"] = "week",
        limit: int = Query(50, ge=1, le=500),
        user: User | None = Depends(optional_user),
        db: Session = Depends(get_db),
    ):
        """Public. When logged in, `me` holds your own rank even if you're outside the top `limit`."""
        return build_leaderboard(db, exercise, period, limit=limit, user_id=user.id if user else None)

    return app


app = create_app()
