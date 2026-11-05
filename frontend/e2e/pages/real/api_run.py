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

# Analytics AI per document (services/analytics_ai_doc.py) against a fake model: PB_FAKE_ANALYTICS_AI=1
# (analytics-ai-doc.mjs). The fake reads the numbers it was sent and answers in the shape each kind asks
# for, pointing at real sections / moments / pages / versions, after a short pause so the running
# state shows. Every call's prompt is kept in $PB_STACK/analytics-ai-calls.jsonl (text only, images
# counted) so the run can check what was sent.
if os.environ.get("PB_FAKE_ANALYTICS_AI"):
    import asyncio as _aio
    import json as _json
    from pathlib import Path as _Path
    from types import SimpleNamespace as _NS

    from app.services import analytics_ai_doc

    _calls = _Path(os.environ.get("PB_STACK") or ".") / "analytics-ai-calls.jsonl"

    def _numbers(user: str) -> dict:
        head = user.split("The numbers (from Markdrop):\n", 1)[1]
        return _json.loads(head.split("\n\n", 1)[0])

    def _answer(system: str, user: str) -> str:
        d = _numbers(user)
        if "Markdown document" in system:
            rows = d["sections"]
            worst = max(rows[1:] or rows, key=lambda r: r["lost_before_pct"])
            slow = max(rows, key=lambda r: r["median_s"])
            f = [{"severity": "high", "title": f"Readers leave at {worst['title']}",
                  "why": f"{worst['lost_before_pct']:.0f}% fewer readers reach it than the section before, and the text there is long and dense.",
                  "suggestion": "Lead with the one thing most readers need, and move the details to a short table.",
                  "section": worst["n"]},
                 {"severity": "medium", "title": f"{slow['title']} takes the longest",
                  "why": f"Readers spend {slow['median_s']:.0f} s there, the most of any section.",
                  "suggestion": "Split it into two shorter sections with clear headings.", "section": slow["n"]},
                 {"severity": "low", "title": "Few read to the end",
                  "why": f"Only {d['read_to_end_pct']:.0f}% reach the last section.",
                  "suggestion": "Link to the last section from the introduction.", "section": None}]
            if worst.get("text_attached"):
                f[0]["rewrite"] = ("Set your **API key** first. Everything else is optional:\n\n"
                                   "| Setting | What it does |\n|---|---|\n| `region` | Where your data lives |\n| `plan` | Your billing plan |")
            return _json.dumps({"summary": f"Most readers stop at {worst['title']}: it is long and its key step comes last.", "findings": f})
        if "chapter marks" in system:
            ms = d["key_moments"] or [{"t": 0, "kind": "drop"}]
            dur = d["media"]["duration_s"] or 60
            f = [{"severity": "high" if i == 0 else "medium",
                  "title": {"drop": "Viewers leave here", "skip": "People skip this part", "rewatch": "People replay this"}[m["kind"]] + f" ({int(m['t'] // 60)}:{int(m['t'] % 60):02d})",
                  "why": f"{m.get('delta') or m.get('dip') or m.get('ratio')} at this moment; {m['still_watching_pct']:.0f}% are still watching.",
                  "suggestion": {"drop": "Cut the slow lead-in and show the result first.", "skip": "Shorten it or make it its own chapter.", "rewatch": "Slow it down or add a caption."}[m["kind"]],
                  "t": m["t"]} for i, m in enumerate(ms[:4])]
            while len(f) < 3:
                f.append({"severity": "low", "title": "Steady after the first minute", "why": "Few leave in the middle.", "suggestion": "Keep the pacing.", "t": None})
            ch = [{"t": 0, "title": "Intro"}, {"t": round(dur * 0.3), "title": "Setup"}, {"t": round(dur * 0.65), "title": "Results"}]
            return _json.dumps({"summary": "Viewers leave during the opening; the middle holds them.", "findings": f, "chapters": ch})
        if "The item is a PDF" in system:
            pages = d["pages"]
            worst = max(pages[1:] or pages, key=lambda r: r["lost_before_pct"])
            slow = max(pages, key=lambda r: r["median_s"])
            f = [{"severity": "high", "title": f"Page {worst['page']} loses readers", "why": f"{worst['lost_before_pct']:.0f} points fewer reach it.", "suggestion": "Cut the page before it to one chart.", "page": worst["page"]},
                 {"severity": "medium", "title": f"Page {slow['page']} holds attention", "why": f"Median {slow['median_s']:.0f} s.", "suggestion": "Move it earlier.", "page": slow["page"]},
                 {"severity": "low", "title": "The ending is rarely reached", "why": "Few reach the last page.", "suggestion": "Add a one-line summary at the top.", "page": None}]
            return _json.dumps({"summary": f"Readers stop around page {worst['page']}.", "findings": f})
        vs = sorted(d["versions"], key=lambda v: -v["value"])
        w = vs[0]
        return _json.dumps({"summary": f"Version {w['version']} works better.",
                            "verdict": {"winner": w["version"], "headline": f"v{w['version']} keeps more viewers",
                                        "explanation": f"{w['value']:.0f}% against {vs[1]['value']:.0f}% for v{vs[1]['version']}." if len(vs) > 1 else ""},
                            "findings": [{"severity": "high", "title": "The new opening works", "why": "More people stay past 0:30.", "suggestion": "Keep it.", "version": w["version"]},
                                         {"severity": "medium", "title": "Both lose people at the end", "why": "The last 10 seconds drop.", "suggestion": "Trim the outro."},
                                         {"severity": "low", "title": "Older versions are too old to judge", "why": "Few recent sessions.", "suggestion": "Compare the two newest only."}]})

    class _DStream:
        def __init__(self, text: str):
            self.text = text

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            await _aio.sleep(1.2)
            for i in range(0, len(self.text), 40):
                await _aio.sleep(0.01)
                yield _NS(type="text", text=self.text[i:i + 40])

        async def get_final_message(self):
            return _NS(content=[_NS(type="text", text=self.text)], stop_reason="end_turn",
                       usage=_NS(input_tokens=3200, output_tokens=len(self.text) // 4 + 5, cache_read_input_tokens=0,
                                 cache_creation_input_tokens=0, cache_creation=None))

    class _DMessages:
        def stream(self, **params):
            system = params["system"][0]["text"]
            blocks = params["messages"][-1]["content"]
            user = "\n".join(b["text"] for b in blocks if b["type"] == "text")
            with _calls.open("a") as fh:
                fh.write(_json.dumps({"system": system[:80], "user": user,
                                      "images": sum(1 for b in blocks if b["type"] == "image")}) + "\n")
            return _DStream(_answer(system, blocks[0]["text"]))

    _dclient = _NS(messages=_DMessages())
    analytics_ai_doc.docs_agent = _NS(get_client=lambda: _dclient, configured=lambda: True)

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

# Markdrop for Slack against a fake Slack (PB_FAKE_SLACK=1, slack.mjs): the app counts as set up, and
# every Web API call is answered in process (oauth.v2.access → team "Acme Slack", Sign in with Slack →
# a Slack user per code, a few channels). The browser's trips to slack.fake are intercepted by the test.
# Nothing leaves the machine; no real Slack app or secret exists here.
if os.environ.get("PB_FAKE_SLACK"):
    import json as _sjson
    from urllib.parse import parse_qs as _sqs

    from app.services import slack_api as _slack_api
    from app.utils import crypto as _crypto

    mod.settings.slack_client_id = "fake.client"
    mod.settings.slack_client_secret = "fake-client-secret"
    mod.settings.slack_signing_secret = "fake-signing-secret"
    mod.settings.slack_api_base = "https://slack.fake/api"
    mod.settings.slack_web_base = "https://slack.fake"
    if not mod.settings.token_encryption_key:
        mod.settings.token_encryption_key = "8Kq0Qb3oQ1n3yYbqQh1w8sV9t6rXo5Wm2Zc4Jd7Lp0E="
    _crypto._fernet.cache_clear()
    SLACK_CALLS = os.path.join(os.environ.get("PB_WORK", "/tmp"), "stack", "slack-calls.jsonl")

    def _slack(request: httpx.Request) -> httpx.Response:
        method = request.url.path.rsplit("/", 1)[-1]
        body = request.content.decode() if request.content else ""
        data = _sjson.loads(body or "{}") if body.startswith("{") else {k: v[0] for k, v in _sqs(body).items()}
        with open(SLACK_CALLS, "a") as fh:
            fh.write(_sjson.dumps({"method": method, "data": data}) + "\n")
        if method == "oauth.v2.access":
            return httpx.Response(200, json={"ok": True, "access_token": "xoxb-fake", "token_type": "bot",
                                             "scope": "commands,chat:write", "bot_user_id": "UBOT", "app_id": "AFAKE",
                                             "team": {"id": "TFAKE", "name": "Acme Slack"}, "authed_user": {"id": "U-INSTALLER"}})
        if method == "openid.connect.token":
            return httpx.Response(200, json={"ok": True, "access_token": "xoxp-" + data.get("code", "x")})
        if method == "openid.connect.userInfo":
            who = request.headers.get("authorization", "").rsplit("-", 1)[-1]
            return httpx.Response(200, json={"ok": True, "name": f"slack-{who}", "https://slack.com/team_id": "TFAKE",
                                             "https://slack.com/user_id": f"U-{who.upper()}"})
        if method == "conversations.list":
            return httpx.Response(200, json={"ok": True, "channels": [
                {"id": "C1", "name": "general", "is_private": False},
                {"id": "C2", "name": "meetings", "is_private": False},
                {"id": "C3", "name": "partners", "is_private": False, "is_ext_shared": True},
                {"id": "G1", "name": "leads", "is_private": True, "is_member": True}]})
        if method == "conversations.info":
            return httpx.Response(200, json={"ok": True, "channel": {"id": data.get("channel"), "is_ext_shared": False}})
        if method == "chat.postMessage":
            return httpx.Response(200, json={"ok": True, "channel": data.get("channel"), "ts": "1.0001"})
        return httpx.Response(200, json={"ok": True})

    _slack_api.TRANSPORT = httpx.MockTransport(_slack)

import uvicorn  # noqa: E402

uvicorn.run(mod.asgi, host="127.0.0.1", port=8180 + 10 * STACK_ID, log_level="warning")
