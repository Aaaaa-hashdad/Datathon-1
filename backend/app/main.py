"""RevGym: the PC app's server.

The PC is the main app (log in, leaderboard, live phone camera, recordings).
A phone on the same Wi-Fi scans a QR code to link, then acts as the camera.

Data: Supabase Postgres + Supabase Storage when configured in backend/.env,
otherwise a local SQLite file and backend/uploads.

Run:   python run.py   (PC on http://127.0.0.1:8000, phone page on HTTPS :8443)
Docs:  http://127.0.0.1:8000/docs
"""

from collections.abc import Iterator
from datetime import timezone
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .auth import bearer, check_login, end_session, hash_password, make_auth_dependencies, start_session
from .config import BACKEND_DIR, Settings
from .db import Base, make_engine, make_session_factory, secure_supabase_tables
from .devices import lan_address, make_device_dependency, new_pair_code, qr_svg_data_uri, receive_video, redeem_pair_code
from .leaderboard import build_leaderboard
from .live import LiveHub
from .models import Device, Recording, Rep, ScanSet, User, utcnow
from .schemas import (
    AuthOut,
    Credentials,
    DeviceOut,
    LeaderboardOut,
    LiveAnswerIn,
    LiveCommandIn,
    LiveOfferIn,
    PairCodeOut,
    PairIn,
    PairOut,
    PhoneStateIn,
    PlayOut,
    RecordingOut,
    ScanIn,
    ScanOut,
    UserOut,
)
from .scoring import QUALIFYING_FORM_SCORE, Exercise, qualifies, set_form_score, set_points
from .storage import LocalStore, SupabaseStore

STATIC_DIR = BACKEND_DIR / "app" / "static"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    engine = make_engine(settings.database_url or None)
    Base.metadata.create_all(engine)
    secure_supabase_tables(engine)
    SessionLocal = make_session_factory(engine)

    if settings.uses_supabase_storage:
        store = SupabaseStore(settings.supabase_url, settings.supabase_service_key, settings.storage_bucket)
        store.ensure_bucket()
    else:
        store = LocalStore(settings.upload_dir, settings.secret_key)
    temp_dir = settings.upload_dir / ".incoming"
    live = LiveHub()

    app = FastAPI(title="RevGym API", version="0.4.0")
    app.state.engine = engine
    app.state.store = store
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

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def pc_app():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/phone", include_in_schema=False)
    def phone_camera():
        return FileResponse(STATIC_DIR / "phone.html")

    # ---------- general ----------

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "database": engine.dialect.name,
            "video_storage": "supabase" if settings.uses_supabase_storage else "local",
        }

    @app.get("/exercises")
    def list_exercises():
        return {"exercises": [e.value for e in Exercise], "qualifying_form_score": QUALIFYING_FORM_SCORE}

    # ---------- accounts ----------

    @app.post("/auth/register", response_model=AuthOut, status_code=status.HTTP_201_CREATED)
    def register(body: Credentials, db: Session = Depends(get_db)):
        user = User(username=body.username, password_hash=hash_password(body.password))
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "That username is taken.")
        return {"token": start_session(db, user), "user": user}

    @app.post("/auth/login", response_model=AuthOut)
    def login(body: Credentials, db: Session = Depends(get_db)):
        user = check_login(db, body.username, body.password)
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong username or password.")
        return {"token": start_session(db, user), "user": user}

    @app.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
    def logout(
        creds: HTTPAuthorizationCredentials | None = Depends(bearer),
        _user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        end_session(db, creds.credentials)

    @app.get("/auth/me", response_model=UserOut)
    def me(user: User = Depends(current_user)):
        return user

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
        out.online, out.camera, out.recording = st["online"], st["camera"], st["recording"]
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

    @app.post("/me/devices/{device_id}/live/command", status_code=status.HTTP_202_ACCEPTED)
    def live_command(device_id: int, body: LiveCommandIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
        """PC: tell the phone to start or stop recording."""
        owned_device(device_id, user, db)
        if body.action == "start" and body.exercise is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Pick a lift before recording.")
        if not live.status(device_id)["online"]:
            raise HTTPException(status.HTTP_409_CONFLICT, "Your phone isn't connected. Open the RevGym camera page on it.")
        live.send_command(device_id, body.model_dump(mode="json"))

    # ---------- live camera: phone side ----------

    @app.post("/device/live/poll")
    def phone_poll(body: PhoneStateIn, device: Device = Depends(current_device)):
        """Phone: check in about once a second. Returns any new offer and commands."""
        return live.phone_poll(device.id, body.model_dump())

    @app.post("/device/live/answer", status_code=status.HTTP_204_NO_CONTENT)
    def phone_answer(body: LiveAnswerIn, device: Device = Depends(current_device)):
        live.post_answer(device.id, body.offer_id, body.sdp)

    # ---------- recordings (phone -> PC) ----------

    def _recording_out(rec: Recording) -> RecordingOut:
        out = RecordingOut.model_validate(rec)
        out.device_name = rec.device.name if rec.device else None
        return out

    @app.post("/recordings", response_model=RecordingOut, status_code=status.HTTP_201_CREATED)
    def upload_recording(
        exercise: Exercise = Form(...),
        video: UploadFile = File(...),
        device: Device = Depends(current_device),
        db: Session = Depends(get_db),
    ):
        """Phone: upload a recorded set. It shows up on the PC right away."""
        temp_path, stored_name, content_type, size = receive_video(video, temp_dir)
        try:
            store.put(stored_name, temp_path, content_type)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Couldn't save the video. Try again.")
        rec = Recording(
            user_id=device.user_id,
            device_id=device.id,
            exercise=exercise.value,
            stored_name=stored_name,
            content_type=content_type,
            size_bytes=size,
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)
        return _recording_out(rec)

    @app.get("/me/recordings", response_model=list[RecordingOut])
    def my_recordings(
        limit: int = Query(30, ge=1, le=200),
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        recs = db.scalars(
            select(Recording)
            .where(Recording.user_id == user.id)
            .options(selectinload(Recording.device))
            .order_by(Recording.created_at.desc(), Recording.id.desc())
            .limit(limit)
        ).all()
        return [_recording_out(r) for r in recs]

    @app.get("/me/recordings/{recording_id}/play", response_model=PlayOut)
    def play_recording(recording_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
        """PC: a link to the video that works for 15 minutes."""
        rec = db.get(Recording, recording_id)
        if rec is None or rec.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "recording not found")
        try:
            return {"url": store.play_url(rec.stored_name)}
        except Exception:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Couldn't load that video right now.")

    @app.get("/media/{name}", include_in_schema=False)
    def local_media(name: str, exp: int, sig: str):
        if not isinstance(store, LocalStore):
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        path = store.open_signed(name, exp, sig)
        if path is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "This link expired.")
        return FileResponse(path)

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
