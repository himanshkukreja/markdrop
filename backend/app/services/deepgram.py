"""Deepgram speech-to-text, as little of it as Zoom meetings without a transcript need (no SDK).

    POST <deepgram_api_base>/listen?model=nova-3&diarize=true&smart_format=true&utterances=true
         Authorization: Token <MARKDROP_DEEPGRAM_API_KEY>, the audio file as the body

Only ever audio (a Zoom recording's M4A, read from a temporary file that the caller deletes right
after): never video. Tests swap :data:`TRANSPORT` for an ``httpx.MockTransport``, so nothing leaves the
machine. :func:`to_vtt` turns the answer's utterances into WebVTT with one "Name: text" cue per
utterance, the shape Zoom's own transcript has (services/zoom.transcript_text, meeting_parse._vtt).
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from app.config import get_settings
from app.utils.http import shared_ssl

log = logging.getLogger("markdrop.zoom")

TRANSPORT: httpx.AsyncBaseTransport | None = None
TIMEOUT = httpx.Timeout(900.0, connect=15.0)
CHUNK = 1024 * 1024


class DeepgramError(Exception):
    def __init__(self, status: int, reason: str = ""):
        super().__init__(f"{status} {reason}".strip())
        self.status = status
        self.reason = reason

    @property
    def limited(self) -> bool:
        return self.status == 429


def configured() -> bool:
    return get_settings().deepgram_configured


def params() -> dict[str, str]:
    return {"model": get_settings().deepgram_model or "nova-3", "diarize": "true", "smart_format": "true",
            "utterances": "true", "punctuate": "true"}


async def _file_chunks(path: str):
    with open(path, "rb") as f:
        while True:
            b = f.read(CHUNK)
            if not b:
                return
            yield b


async def transcribe_file(path: str, mime: str = "audio/mp4") -> dict:
    """Deepgram's answer for an audio file on disk (streamed, never read whole into memory)."""
    s = get_settings()
    if not s.deepgram_api_key:
        raise DeepgramError(503, "Speech-to-text isn't set up on this server.")
    headers = {"Authorization": f"Token {s.deepgram_api_key}", "Content-Type": mime,
               "Content-Length": str(os.path.getsize(path))}
    async with httpx.AsyncClient(verify=shared_ssl(), timeout=TIMEOUT, transport=TRANSPORT) as c:
        r = await c.post(s.deepgram_api_base.rstrip("/") + "/listen", params=params(), headers=headers,
                         content=_file_chunks(path))
    if r.status_code >= 400:
        try:
            body = r.json()
            reason = str(body.get("err_msg") or body.get("reason") or body.get("message") or "")[:300]
        except ValueError:
            reason = r.text[:200]
        raise DeepgramError(r.status_code, reason)
    return r.json()


def duration_s(result: dict) -> float:
    try:
        return max(0.0, float(((result or {}).get("metadata") or {}).get("duration") or 0.0))
    except (TypeError, ValueError):
        return 0.0


def utterances(result: dict) -> list[dict]:
    """[{start, end, speaker (int), text}] in order; empty texts dropped."""
    out = []
    for u in ((result or {}).get("results") or {}).get("utterances") or []:
        text = " ".join(str(u.get("transcript") or "").split())
        if not text:
            continue
        try:
            start, end = float(u.get("start") or 0.0), float(u.get("end") or 0.0)
        except (TypeError, ValueError):
            continue
        sp = u.get("speaker")
        out.append({"start": start, "end": max(end, start), "speaker": int(sp) if isinstance(sp, (int, float)) else 0,
                    "text": text})
    out.sort(key=lambda u: u["start"])
    return out


def _ts(sec: float) -> str:
    ms = int(round(max(0.0, sec) * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def to_vtt(utts: list[dict], names: dict[int, str] | None = None) -> str:
    """WebVTT, one cue per utterance: "<name>: <text>" (a speaker without a name: "Speaker N", 1-based)."""
    names = names or {}
    lines = ["WEBVTT", ""]
    for i, u in enumerate(utts):
        who = names.get(u["speaker"]) or f"Speaker {u['speaker'] + 1}"
        lines += [str(i + 1), f"{_ts(u['start'])} --> {_ts(u['end'])}", f"{who}: {u['text']}", ""]
    return "\n".join(lines)


def describe(result: Any) -> str:
    """For logs: never the words."""
    return f"{len(utterances(result))} utterances, {duration_s(result):.0f}s"
