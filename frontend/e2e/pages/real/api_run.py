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

# Analytics AI (services/analytics_ai_home.py) against a fake model: PB_FAKE_ANALYTICS_AI=1 (analytics-ai.mjs).
# The story names the first document it was given; Ask calls top_documents, then answers with the first
# link the tool returned; gaps groups the first items. Streams like the real API; nothing leaves the machine.
if os.environ.get("PB_FAKE_ANALYTICS_AI"):
    import asyncio as _aio
    import json as _json
    import re as _re
    from types import SimpleNamespace as _NS

    from app.services import analytics_ai_home as _aah

    class _AStream:
        def __init__(self, blocks, stop):
            self.blocks, self.stop = blocks, stop

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            for b in self.blocks:
                if b.type == "text":
                    for i in range(0, len(b.text), 10):
                        await _aio.sleep(0.03)
                        yield _NS(type="text", text=b.text[i:i + 10])

        async def get_final_message(self):
            return _NS(content=self.blocks, stop_reason=self.stop, stop_details=None,
                       usage=_NS(input_tokens=1500, output_tokens=200, cache_read_input_tokens=0,
                                 cache_creation_input_tokens=0, cache_creation=None))

    def _text(t):
        return _AStream([_NS(type="text", text=t)], "end_turn")

    class _AMessages:
        def stream(self, **params):
            system = params["system"][0]["text"]
            user = params["messages"][0]["content"][-1]["text"]
            if "Insights" in system:
                titles = _re.findall(r'"ref":"(d\d+)","title":"([^"]*)"', user)
                ref, title = titles[0] if titles else ("", "your links")
                return _text(_json.dumps({"headline": "Views are up this week", "bullets": [
                    {"text": f"{title} drew most of the new views, likely from news.ycombinator.com.", "ref": ref, "tab": "audience"},
                    {"text": "Most people read on desktop; mobile grew a little.", "ref": "", "tab": "none"},
                    {"text": f"{title} was published this period and is already your top link.", "ref": ref, "tab": "overview"}]}))
            if "what to write next" in system:
                n = len(_re.findall(r"^\d+\. ", user, _re.M))
                return _text(_json.dumps({"gaps": [{"topic": "Contractor onboarding", "items": list(range(1, min(n, 2) + 1)),
                                                    "why": "People search for onboarding steps and find nothing.",
                                                    "outline": ["Before day one", "Laptop and accounts", "First week", "Who to ask"]}]}))
            if not any(m["role"] == "assistant" for m in params["messages"]):
                return _AStream([_NS(type="text", text="Let me check. "),
                                 _NS(type="tool_use", id="tu_1", name="top_documents",
                                     input={"range": "30d", "metric": "views", "kind": "any", "limit": 3})], "tool_use")
            res = params["messages"][-1]["content"][0]["content"]
            m = _re.search(r'"title": "([^"]*)", "kind": "[a-z]+", "href": "([^"]*)", "views": (\d+)', res)
            ans = (f"Your top link this month is [{m.group(1)}]({m.group(2)}) with {m.group(3)} views." if m
                   else "I couldn't find views for that period.")
            return _text(ans)

    _aclient = _NS(messages=_AMessages())
    _aah.docs_agent = _NS(get_client=lambda: _aclient, configured=lambda: True)

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
