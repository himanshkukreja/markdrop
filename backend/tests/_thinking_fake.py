"""A fake Anthropic client whose model thinks before it answers, the way Claude Haiku 5.5 does.

Each call spends ``think`` tokens on thinking first (none when the request sends
``thinking: {"type": "disabled"}``), then writes the reply. Thinking and reply share the
request's ``max_tokens``, which the fake never exceeds: when the reply doesn't fit, it comes back
cut (``stop_reason == "max_tokens"``), with whatever part fitted, or nothing at all. That is the
production bug (meetings eval 2026-11-05): a cap sized for the answer alone came back empty.

Usage carries ``output_tokens`` (thinking included, as billed) and
``output_tokens_details.thinking_tokens``. ``calls`` records every request and what it cost.
"""

from __future__ import annotations

import asyncio
import copy
import math
from types import SimpleNamespace

CHARS_PER_TOKEN = 4


def tokens(text: str) -> int:
    return math.ceil(len(text or "") / CHARS_PER_TOKEN)


class _Stream:
    def __init__(self, message):
        self.message = message

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for b in self.message.content:
            await asyncio.sleep(0)
            if b.type == "thinking":
                yield SimpleNamespace(type="thinking", thinking="", snapshot="")
            elif b.type == "text":
                for i in range(0, len(b.text), 9):
                    await asyncio.sleep(0)
                    yield SimpleNamespace(type="text", text=b.text[i:i + 9], snapshot=b.text[:i + 9])

    async def get_final_message(self):
        return self.message


class ThinkingModel:
    """``reply``: the full answer (str, or callable(params) -> str). ``think``: thinking tokens per
    call (int, or callable(params) -> int)."""

    def __init__(self, reply, think: int = 1100, input_tokens: int = 900):
        self.reply = reply
        self.think = think
        self.input_tokens = input_tokens
        self.calls: list[dict] = []
        self.messages = self

    def _run(self, kw: dict):
        cap = int(kw["max_tokens"])
        text = self.reply(kw) if callable(self.reply) else self.reply
        off = (kw.get("thinking") or {}).get("type") == "disabled"
        think = 0 if off else (self.think(kw) if callable(self.think) else self.think)
        thought = min(think, cap)
        room = cap - thought
        need = tokens(text)
        if need <= room:
            visible, out, stop = text, thought + need, "end_turn"
        else:
            visible, out, stop = text[:room * CHARS_PER_TOKEN], cap, "max_tokens"
        assert out <= cap
        self.calls.append({"params": copy.deepcopy(kw), "max_tokens": cap, "output_tokens": out,
                           "thinking_tokens": thought, "stop": stop, "visible": visible,
                           "thinking": not off})
        content = []
        if thought:
            content.append(SimpleNamespace(type="thinking", thinking="", signature="sig"))
        if visible:
            content.append(SimpleNamespace(type="text", text=visible))
        usage = SimpleNamespace(input_tokens=self.input_tokens, output_tokens=out, cache_read_input_tokens=0,
                                cache_creation_input_tokens=0, cache_creation=None,
                                output_tokens_details=SimpleNamespace(thinking_tokens=thought))
        return SimpleNamespace(id="msg_fake", type="message", role="assistant", model=kw.get("model"),
                               content=content, stop_reason=stop, stop_details=None, usage=usage)

    def stream(self, **kw):
        return _Stream(self._run(kw))

    async def create(self, **kw):
        return self._run(kw)

    # What the tests check.

    def caps(self) -> list[int]:
        return [c["max_tokens"] for c in self.calls]

    def output_tokens(self) -> int:
        return sum(c["output_tokens"] for c in self.calls)

    def assert_caps_honoured(self, case) -> None:
        for c in self.calls:
            case.assertLessEqual(c["output_tokens"], c["max_tokens"])
