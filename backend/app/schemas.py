"""Request and response shapes for the API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .scoring import Exercise


class Credentials(BaseModel):
    username: str = Field(min_length=2, max_length=32, pattern=r"^[A-Za-z0-9_.]+$")
    password: str = Field(min_length=8, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    created_at: datetime


class AuthOut(BaseModel):
    token: str
    user: UserOut


class PairCodeOut(BaseModel):
    code: str
    expires_at: datetime
    # Address the QR code opens on the phone (same Wi-Fi as the PC). Includes the code.
    phone_url: str
    # The QR code as an SVG data URI, ready for <img src>.
    qr_svg: str


class LiveOfferIn(BaseModel):
    sdp: str = Field(min_length=10, max_length=20000)


class LiveAnswerIn(BaseModel):
    offer_id: int
    sdp: str = Field(min_length=10, max_length=20000)


class LiveCommandIn(BaseModel):
    action: Literal["start", "stop"]
    exercise: Exercise | None = None


class PhoneStateIn(BaseModel):
    camera: bool = False
    recording: bool = False


class PlayOut(BaseModel):
    url: str


class PairIn(BaseModel):
    code: str = Field(min_length=4, max_length=16)
    device_name: str = Field(default="Phone", min_length=1, max_length=60)


class PairOut(BaseModel):
    device_token: str
    username: str


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    created_at: datetime
    last_seen_at: datetime | None
    # Live camera status (phone page open and checking in).
    online: bool = False
    camera: bool = False
    recording: bool = False


class RecordingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    exercise: Exercise
    size_bytes: int
    content_type: str
    status: str
    created_at: datetime
    device_name: str | None = None


class RepIn(BaseModel):
    form_score: float = Field(ge=0, le=100)
    # Joint angles in degrees from the pose pipeline, e.g. {"elbow_tuck": 62.5}.
    angles: dict[str, float] = Field(default_factory=dict)


class ScanIn(BaseModel):
    """What the phone sends after analysing a recorded set (for the logged-in user)."""

    exercise: Exercise
    weight_lb: float = Field(ge=0, le=2000)
    reps: list[RepIn] = Field(min_length=1, max_length=100)
    recorded_at: datetime | None = None


class RepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    index: int
    form_score: float
    angles: dict[str, float]


class ScanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    exercise: Exercise
    weight_lb: float
    rep_count: int
    form_score: float
    qualified: bool
    points: int
    recorded_at: datetime
    reps: list[RepOut]


class LeaderboardEntry(BaseModel):
    rank: int
    user_id: int
    username: str
    # all-lifts board: total points. Per-lift board: best set's weight.
    value: float
    weight_lb: float | None = None
    reps: int | None = None
    form_score: float | None = None


class MyStanding(BaseModel):
    entry: LeaderboardEntry
    next_up: LeaderboardEntry | None = None
    # How much `value` must grow to tie the person directly above.
    gap_to_next: float | None = None


class LeaderboardOut(BaseModel):
    exercise: Literal["all"] | Exercise
    period: Literal["week", "all_time"]
    metric: Literal["points", "weight_lb"]
    total_ranked: int
    entries: list[LeaderboardEntry]
    me: MyStanding | None = None
