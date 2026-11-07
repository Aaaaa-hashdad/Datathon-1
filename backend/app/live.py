"""Live link between the PC and a linked phone's camera.

The PC and phone talk directly over Wi-Fi with WebRTC (video goes phone -> PC,
never through this server, and is never stored). This server only passes the
small setup messages: the PC's "offer" and the phone's "answer".

The phone polls about once a second. State lives in memory: it is only needed
while both screens are open, and nothing here has to survive a restart.
"""

import threading
import time
from dataclasses import dataclass

ONLINE_WINDOW_SECONDS = 6


@dataclass
class Channel:
    offer: dict | None = None          # from PC: {"id": n, "sdp": "..."}
    answer: dict | None = None         # from phone: {"id": n, "sdp": "..."}
    phone_seen: float = 0.0
    camera: bool = False
    next_id: int = 1


class LiveHub:
    def __init__(self):
        self._lock = threading.Lock()
        self._channels: dict[int, Channel] = {}

    def _ch(self, device_id: int) -> Channel:
        return self._channels.setdefault(device_id, Channel())

    # ----- PC side -----

    def post_offer(self, device_id: int, sdp: str) -> int:
        with self._lock:
            ch = self._ch(device_id)
            offer_id = ch.next_id
            ch.next_id += 1
            ch.offer = {"id": offer_id, "sdp": sdp}
            ch.answer = None
            return offer_id

    def get_answer(self, device_id: int, offer_id: int) -> str | None:
        with self._lock:
            ans = self._ch(device_id).answer
            return ans["sdp"] if ans and ans["id"] == offer_id else None

    def status(self, device_id: int) -> dict:
        with self._lock:
            ch = self._ch(device_id)
            online = time.monotonic() - ch.phone_seen < ONLINE_WINDOW_SECONDS
            return {"online": online, "camera": online and ch.camera}

    # ----- phone side -----

    def phone_poll(self, device_id: int, camera: bool) -> dict:
        """Phone checks in: report whether its camera is on, collect any new offer."""
        with self._lock:
            ch = self._ch(device_id)
            ch.phone_seen = time.monotonic()
            ch.camera = camera
            offer, ch.offer = ch.offer, None
            return {"offer": offer}

    def post_answer(self, device_id: int, offer_id: int, sdp: str) -> None:
        with self._lock:
            self._ch(device_id).answer = {"id": offer_id, "sdp": sdp}

    def forget(self, device_id: int) -> None:
        with self._lock:
            self._channels.pop(device_id, None)
