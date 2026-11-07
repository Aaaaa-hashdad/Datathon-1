"""Live link between the PC and a linked phone's camera.

The PC and phone talk directly over Wi-Fi with WebRTC (video goes phone -> PC,
never through this server). This server only passes the small setup messages
(the "offer" and "answer") and the PC's record/stop commands.

Both sides poll about once a second. State lives in memory: it is only needed
while both screens are open, and nothing here has to survive a restart.
"""

import threading
import time
from dataclasses import dataclass, field

ONLINE_WINDOW_SECONDS = 6


@dataclass
class Channel:
    offer: dict | None = None          # from PC: {"id": n, "sdp": "..."}
    answer: dict | None = None         # from phone: {"id": n, "sdp": "..."}
    commands: list[dict] = field(default_factory=list)  # PC -> phone, oldest first
    phone_seen: float = 0.0
    phone_state: dict = field(default_factory=lambda: {"camera": False, "recording": False})
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

    def send_command(self, device_id: int, command: dict) -> None:
        with self._lock:
            cmds = self._ch(device_id).commands
            cmds.append(command)
            del cmds[:-10]  # never let a stale backlog build up

    def status(self, device_id: int) -> dict:
        with self._lock:
            ch = self._ch(device_id)
            online = time.monotonic() - ch.phone_seen < ONLINE_WINDOW_SECONDS
            return {"online": online, **(ch.phone_state if online else {"camera": False, "recording": False})}

    # ----- phone side -----

    def phone_poll(self, device_id: int, state: dict | None) -> dict:
        """Phone checks in: report its state, collect any new offer and commands."""
        with self._lock:
            ch = self._ch(device_id)
            ch.phone_seen = time.monotonic()
            if state is not None:
                ch.phone_state = {"camera": bool(state.get("camera")), "recording": bool(state.get("recording"))}
            offer = ch.offer
            ch.offer = None
            commands, ch.commands = ch.commands, []
            return {"offer": offer, "commands": commands}

    def post_answer(self, device_id: int, offer_id: int, sdp: str) -> None:
        with self._lock:
            self._ch(device_id).answer = {"id": offer_id, "sdp": sdp}

    def forget(self, device_id: int) -> None:
        with self._lock:
            self._channels.pop(device_id, None)
