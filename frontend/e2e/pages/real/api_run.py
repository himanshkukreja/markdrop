"""The docs-media sandbox API (scripts/docs-media/stack/run_api.py, STACK_ID=5: :8230, db
markdrop_docs_demo_5), with the cache purge delivered to the local Next server like production does
(run_api.py swallows it), so an access change really purges /<slug>."""
import importlib.util
import os
from pathlib import Path

import httpx

os.environ.setdefault("STACK_ID", "5")
STACK_ID = int(os.environ["STACK_ID"])
NEXT_PORT = 3400 + 10 * STACK_ID
RUN_API = Path(__file__).resolve().parents[3] / "scripts" / "docs-media" / "stack" / "run_api.py"
spec = importlib.util.spec_from_file_location("run_api", RUN_API)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

from app.services import revalidate  # noqa: E402

mod.settings.page_revalidate_enabled = True
# The workspace domain used in the E2E is acme.localhost (WebKit can't map a real host name to
# 127.0.0.1); the domain service refuses *.localhost as reserved, so its origin is allowed statically.
mod.settings.cors_origins.append(f"http://acme.localhost:{NEXT_PORT}")


async def _post(payload: dict) -> int:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(f"http://localhost:{NEXT_PORT}/api/revalidate", json=payload)
            return r.status_code
    except Exception:
        return 0


revalidate._post = _post

# AI search (services/search_ai.py) against a fake model: PB_FAKE_SEARCH_AI=1 (search.mjs). The fake
# expands the question into its own words, ranks the first candidates it was sent and cites them,
# streaming like the real API. Nothing leaves the machine; the sandbox never has a real key.
if os.environ.get("PB_FAKE_SEARCH_AI"):
    import asyncio
    import json
    import re
    from types import SimpleNamespace as NS

    from app.services import search_ai

    class _Stream:
        def __init__(self, text: str):
            self.text = text

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            for i in range(0, len(self.text), 12):
                await asyncio.sleep(0.03)
                yield NS(type="text", text=self.text[i:i + 12])

        async def get_final_message(self):
            return NS(content=[NS(type="text", text=self.text)], stop_reason="end_turn",
                      usage=NS(input_tokens=1200, output_tokens=len(self.text) // 4 + 5, cache_read_input_tokens=0,
                               cache_creation_input_tokens=0, cache_creation=None))

    class _Messages:
        def stream(self, **params):
            system = params["system"][0]["text"]
            user = params["messages"][-1]["content"][-1]["text"]
            if "Return only JSON" in system:
                words = [w for w in re.findall(r"[A-Za-z]{4,}", user) if w.lower() not in ("search", "what", "where", "does", "with")]
                return _Stream(json.dumps({"terms": words[:6], "titles": []}))
            docs = re.findall(r'<untrusted_document n="(\d+)" title="([^"]*)"', user)
            if not docs:
                return _Stream("<ranking></ranking>\n\nI couldn't find anything about that in your documents.")
            top = docs[:2]
            ranking = ",".join(n for n, _ in top)
            cites = " ".join(f"**{t}** covers it [{n}]." for n, t in top)
            return _Stream(f"<ranking>{ranking}</ranking>\n\nFrom your documents: {cites} Check the sources for details.")

    _client = NS(messages=_Messages())
    search_ai.docs_agent = NS(get_client=lambda: _client, configured=lambda: True)

# Meetings AI (services/meetings_ai.py) against a fake model: PB_FAKE_MEETINGS_AI=1 (meetings.mjs). It writes a
# meeting's sections from the transcript lines it was sent (decisions: "decide"/"agree" lines; action items:
# "will"/"can you" lines, owned by their speaker; questions: lines ending in "?"), and answers questions by
# citing the transcript line sharing most words with the question. Streams like the real API; nothing leaves.
if os.environ.get("PB_FAKE_MEETINGS_AI"):
    import asyncio as _aio
    import json as _json
    import re as _re
    from types import SimpleNamespace as _NS

    from app.services import meetings_ai

    class _MStream:
        def __init__(self, text: str):
            self.text = text

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            for i in range(0, len(self.text), 14):
                await _aio.sleep(0.02)
                yield _NS(type="text", text=self.text[i:i + 14])

        async def get_final_message(self):
            return _NS(content=[_NS(type="text", text=self.text)], stop_reason="end_turn",
                       usage=_NS(input_tokens=6000, output_tokens=len(self.text) // 4 + 5, cache_read_input_tokens=0,
                                 cache_creation_input_tokens=0, cache_creation=None))

    _LINE = _re.compile(r"\[(s\d+)\] \S+ ([^:\n]+): ([^\n]+)")

    def _words(t):
        return {w for w in _re.findall(r"[a-z]{4,}", t.lower())}

    class _MMessages:
        def stream(self, **params):
            system = params["system"][0]["text"]
            user = "\n".join(b["text"] for b in params["messages"][-1]["content"])
            lines = _LINE.findall(user)
            if system.startswith("You write the team's notes") or system.startswith("You merge partial"):
                dec = [{"text": t.rstrip("."), "cite": s} for s, _w, t in lines if _re.search(r"decide|agree", t, _re.I)][:3]
                act = [{"text": _re.sub(r"^(yes,? )?(i'll|i will|can you)\s*", "", t, flags=_re.I).rstrip(".?"), "owner": w, "due": None, "cite": s}
                       for s, w, t in lines if _re.search(r"\b(i'll|i will|will)\b", t, _re.I)][:4]
                oq = [{"text": t, "cite": s} for s, _w, t in lines if t.strip().endswith("?")][:2]
                top = [{"title": " ".join(t.split()[:3]), "gist": t[:80], "cite": s} for s, _w, t in lines[:2]]
                first = lines[0][2] if lines else "The team met."
                out = {"summary": f"The team met. {first}", "highlights": [t for _s, _w, t in lines[:2]], "decisions": dec,
                       "action_items": act, "open_questions": oq, "topics": top, "type": "Planning"}
                return _MStream(_json.dumps(out))
            if system.startswith("You read Google's meeting notes"):
                return _MStream(_json.dumps({"decisions": [{"text": "Ship on Friday"}], "open_questions": [], "topics": [], "type": "Planning"}))
            q = user.rsplit("The question", 1)[-1]
            if system.startswith("You answer questions about one meeting"):
                best = max(lines, key=lambda x: len(_words(x[2]) & _words(q)), default=None)
                if not best:
                    return _MStream("The notes say the team met [n1].")
                return _MStream(f"{best[1]} said: {best[2]} [{best[0]}]. See also the notes [n1].")
            ns = _re.findall(r'<untrusted_meeting n="(\d+)"', user)
            segs = _re.findall(r"\[(M\d+-s\d+)\] \S+ ([^:\n]+): ([^\n]+)", user)
            best = max(segs, key=lambda x: len(_words(x[2]) & _words(q)), default=None)
            cite = f" [{best[0]}]" if best else ""
            said = f"{best[1]} said {best[2]}" if best else "The meetings don't say"
            return _MStream(f"<ranking>{','.join(ns[:2])}</ranking>\n\n{said}{cite} — see [M1].")

    _mclient = _NS(messages=_MMessages())
    meetings_ai.docs_agent = _NS(get_client=lambda: _mclient, configured=lambda: True)

# PB_R2_LATENCY_MS=N: every publicity change on the fake R2 takes N ms, like a HEAD + copy against the
# real bucket, so a big workspace's sign-in change takes long enough to watch (lock.mjs).
_lat = float(os.environ.get("PB_R2_LATENCY_MS") or 0) / 1000
if _lat:
    import time

    from app.services import r2

    _set_public = r2.set_public

    def _slow_set_public(key, public, content_type=None, epoch=None):
        time.sleep(_lat)
        return _set_public(key, public, content_type, epoch)

    def _slow_set_public_prefix(prefix, public, epoch=None):
        keys = r2.list_prefix(prefix)
        for k in keys:
            _slow_set_public(k, public, None, epoch)
        return len(keys)

    r2.set_public = _slow_set_public
    r2.set_public_prefix = _slow_set_public_prefix

import uvicorn  # noqa: E402

uvicorn.run(mod.asgi, host="127.0.0.1", port=8180 + 10 * STACK_ID, log_level="warning")
