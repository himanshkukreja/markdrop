"""A fake Zoom (Server-to-Server OAuth + REST v2 + recording downloads), in process, for the tests and the
e2e stack (frontend/e2e/pages/real/api_run.py, PB_FAKE_ZOOM=1). Nothing leaves the machine.

* ``https://zoom.test/oauth/token?grant_type=account_credentials&account_id=…`` (HTTP Basic: the app's
  Client ID and Secret) → an hour-long token with :attr:`FakeZoom.scopes`.
* ``https://api.zoom.test/v2/``: ``users``, ``users/{email}/recordings`` (from/to, one month at most),
  ``meetings/{uuid}/recordings``, ``past_meetings/{uuid}/participants``.
* ``https://zoom.test/rec/download/<uuid>``: the meeting's transcript (WebVTT).

:meth:`event` builds the webhook body Zoom would send; :meth:`limit` makes the next calls answer 429.
"""

from __future__ import annotations

import base64
import json
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote, unquote

import httpx

AUTH = "https://zoom.test"
API = "https://api.zoom.test/v2"
ACCOUNT = "acct-ZOOM1"
CLIENT_ID = "zoom-client-1"
CLIENT_SECRET = "zoom-client-secret-1"
SECRET_TOKEN = "zoom-secret-token-1"
ALL_SCOPES = ["user:read:list_users:admin", "cloud_recording:read:list_user_recordings:admin",
              "cloud_recording:read:list_recording_files:admin", "meeting:read:list_past_participants:admin"]


def vtt(lines: list[tuple[str, str]]) -> str:
    out = ["WEBVTT", ""]
    for i, (who, text) in enumerate(lines):
        a, b = i * 7, i * 7 + 6
        out += [str(i + 1), f"00:{a // 60:02d}:{a % 60:02d}.000 --> 00:{b // 60:02d}:{b % 60:02d}.000", f"{who}: {text}", ""]
    return "\n".join(out)


class FakeZoom:
    def __init__(self):
        self.account_id, self.client_id, self.client_secret = ACCOUNT, CLIENT_ID, CLIENT_SECRET
        self.scopes = list(ALL_SCOPES)
        self.users: dict[str, dict] = {}          # id → {id, email, first_name, last_name}
        self.meetings: dict[str, dict] = {}       # uuid → meeting object (with recording_files)
        self.participants: dict[str, list[str]] = {}
        self.transcripts: dict[str, str] = {}
        self.tokens: dict[str, float] = {}
        self.calls: list[tuple[str, str]] = []
        self.n = 0
        self.ttl = 3600
        self.limited = 0                          # the next n API calls answer 429

    # ── World building ──

    def add_user(self, email: str, first: str, last: str = "") -> str:
        uid = f"zu-{len(self.users) + 1}"
        self.users[uid] = {"id": uid, "email": email, "first_name": first, "last_name": last, "type": 2}
        return uid

    def uid_of(self, email: str) -> str | None:
        return next((u["id"] for u in self.users.values() if u["email"].lower() == email.lower()), None)

    def add_meeting(self, uuid: str, topic: str, host_email: str, start: str, *, duration: int = 30,
                    transcript: bool = True, participants: list[str] | None = None,
                    lines: list[tuple[str, str]] | None = None, tz: str = "Asia/Kolkata") -> dict:
        host = self.uid_of(host_email)
        files = [{"id": f"f-{uuid}-mp4", "file_type": "MP4", "recording_type": "shared_screen_with_speaker_view",
                  "status": "completed", "download_url": f"{AUTH}/rec/download/{uuid}.mp4"}]
        if transcript:
            files.append({"id": f"f-{uuid}-vtt", "file_type": "TRANSCRIPT", "file_extension": "VTT",
                          "recording_type": "audio_transcript", "status": "completed",
                          "download_url": f"{AUTH}/rec/download/{quote(uuid, safe='')}"})
            self.transcripts[uuid] = vtt(lines or [("Ada Lovelace", f"Welcome to {topic}."),
                                                   ("Grace Hopper", "Let's review the pipeline."),
                                                   ("Ada Lovelace", "I'll send the proposal to Acme by Friday.")])
        m = {"uuid": uuid, "id": 80000000000 + len(self.meetings), "account_id": self.account_id, "host_id": host,
             "topic": topic, "type": 2, "start_time": start, "timezone": tz, "duration": duration,
             "recording_count": len(files), "recording_files": files}
        self.meetings[uuid] = m
        self.participants[uuid] = participants if participants is not None else ["Ada Lovelace", "Grace Hopper", "Priya Raman"]
        return m

    def add_transcript(self, uuid: str) -> None:
        m = self.meetings[uuid]
        m["recording_files"].append({"id": f"f-{uuid}-vtt", "file_type": "TRANSCRIPT", "recording_type": "audio_transcript",
                                     "status": "completed", "download_url": f"{AUTH}/rec/download/{quote(uuid, safe='')}"})
        self.transcripts[uuid] = vtt([("Ada Lovelace", "The transcript came later."), ("Grace Hopper", "Good.")])

    def event(self, name: str, uuid: str, *, host_email: bool = True) -> dict:
        m = json.loads(json.dumps(self.meetings[uuid]))
        if host_email:
            m["host_email"] = self.users[m["host_id"]]["email"]
        if name == "recording.completed":
            m["recording_files"] = [f for f in m["recording_files"] if f["file_type"] != "TRANSCRIPT"] \
                if not getattr(self, "transcript_in_completed", False) else m["recording_files"]
        return {"event": name, "event_ts": 1, "payload": {"account_id": self.account_id, "object": m},
                "download_token": "dl-" + uuid}

    def limit(self, n: int = 1) -> None:
        self.limited = n

    # ── The transport ──

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _json(self, status: int, body: dict, **headers) -> httpx.Response:
        return httpx.Response(status, json=body, headers=headers)

    def _authed(self, req: httpx.Request) -> bool:
        auth = req.headers.get("authorization", "")
        tok = auth[7:] if auth.startswith("Bearer ") else ""
        if tok.startswith("dl-"):
            return True
        exp = self.tokens.get(tok)
        return exp is not None and exp > datetime.now(timezone.utc).timestamp()

    def _handle(self, req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        self.calls.append((req.method, url))
        if url.startswith(AUTH + "/oauth/token"):
            basic = req.headers.get("authorization", "")[6:]
            try:
                cid, sec = base64.b64decode(basic).decode().split(":", 1)
            except Exception:
                cid, sec = "", ""
            if req.url.params.get("grant_type") != "account_credentials" or req.url.params.get("account_id") != self.account_id \
                    or cid != self.client_id or sec != self.client_secret:
                return self._json(400, {"reason": "Invalid client_id or client_secret", "error": "invalid_client"})
            self.n += 1
            tok = f"ztok-{self.n}"
            self.tokens[tok] = datetime.now(timezone.utc).timestamp() + self.ttl
            return self._json(200, {"access_token": tok, "token_type": "bearer", "expires_in": self.ttl,
                                    "scope": " ".join(self.scopes), "api_url": "https://api.zoom.us"})
        if url.startswith(AUTH + "/rec/download/"):
            if not self._authed(req):
                return self._json(401, {"code": 124, "message": "Invalid access token."})
            uuid = unquote(req.url.raw_path.decode().split("?", 1)[0].rsplit("/", 1)[1])
            if uuid not in self.transcripts:
                return self._json(404, {"code": 3301, "message": "No file"})
            return httpx.Response(200, content=self.transcripts[uuid].encode())
        if not url.startswith(API):
            return self._json(404, {"code": 404, "message": "Unknown host"})
        if not self._authed(req):
            return self._json(401, {"code": 124, "message": "Invalid access token."})
        if self.limited > 0:
            self.limited -= 1
            return self._json(429, {"code": 429, "message": "Too many requests."}, **{"Retry-After": "0"})
        raw = req.url.raw_path.decode().split("?", 1)[0]
        path = raw[len("/v2/"):]
        parts = path.split("/")
        q = req.url.params
        if path == "users":
            if "user:read:list_users:admin" not in self.scopes:
                return self._json(400, {"code": 4711, "message": "Invalid access token, does not contain scopes."})
            return self._json(200, {"users": list(self.users.values()), "next_page_token": "", "total_records": len(self.users)})
        if len(parts) == 3 and parts[0] == "users" and parts[2] == "recordings":
            email = unquote(parts[1])
            if self.uid_of(email) is None:
                return self._json(404, {"code": 1001, "message": "User does not exist."})
            a, b = date.fromisoformat(q["from"]), date.fromisoformat(q["to"])
            if (b - a).days > 31:
                return self._json(400, {"code": 300, "message": "The range is longer than a month."})
            uid = self.uid_of(email)
            out = [m for m in self.meetings.values() if m["host_id"] == uid
                   and a <= datetime.fromisoformat(m["start_time"].replace("Z", "+00:00")).date() <= b]
            return self._json(200, {"from": q["from"], "to": q["to"], "meetings": out, "next_page_token": ""})
        if len(parts) == 3 and parts[0] == "meetings" and parts[2] == "recordings":
            uuid = unquote(unquote(parts[1]))
            m = self.meetings.get(uuid)
            if m is None:
                return self._json(404, {"code": 3301, "message": "This recording does not exist."})
            return self._json(200, m)
        if len(parts) == 3 and parts[0] == "past_meetings" and parts[2] == "participants":
            if "meeting:read:list_past_participants:admin" not in self.scopes:
                return self._json(400, {"code": 4711, "message": "Invalid access token, does not contain scopes."})
            uuid = unquote(unquote(parts[1]))
            if uuid not in self.participants:
                return self._json(404, {"code": 3001, "message": "Meeting does not exist."})
            return self._json(200, {"participants": [{"id": f"p{i}", "name": n} for i, n in enumerate(self.participants[uuid])],
                                    "next_page_token": ""})
        return self._json(404, {"code": 404, "message": f"No route {path}"})


def iso_days_ago(days: int, hour: int = 9) -> str:
    d = datetime.now(timezone.utc).replace(hour=hour, minute=0, second=0, microsecond=0) - timedelta(days=days)
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")
