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
# Short page edit-lock timers for editlock.mjs (services/pages.py: idle, hidden, heartbeat TTL; the
# editor reads them from the lock answers): PB_LOCK_IDLE_S / PB_LOCK_HIDDEN_S / PB_LOCK_TTL_S, and
# PB_LOCK_GONE_S (the holder's tabs closed without a word: services/viewers._editor_left).
for _k in ("idle", "hidden", "ttl", "gone"):
    if os.environ.get(f"PB_LOCK_{_k.upper()}_S"):
        setattr(mod.settings, f"page_lock_{_k}_s", float(os.environ[f"PB_LOCK_{_k.upper()}_S"]))


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

# PB_FAKE_DOCS_ASK=1: Ask AI on a guide shows its composer (mobile-guides.mjs measures it against the
# on-screen keyboard). Only the guide Ask status says "configured" (the docs_ai router's view of docs_agent;
# Pages AI, search and Analytics AI still see the real, unconfigured client, so their menus don't change):
# no question is sent, and no key is needed.
if os.environ.get("PB_FAKE_DOCS_ASK"):
    from app.routers import docs_ai as _docs_ai
    from app.services import docs_agent as _real_docs_agent

    class _AskConfigured:
        def __getattr__(self, name):
            return getattr(_real_docs_agent, name)

        @staticmethod
        def configured():
            return True

    _docs_ai.docs_agent = _AskConfigured()

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
            if system.startswith("You compare a section"):
                # Meeting memory's AI check (meeting-memory.mjs): a decision naming a weekday that the section
                # gives as another weekday contradicts it; one whose words are mostly missing is left out.
                sec = _re.search(r"<untrusted_section[^>]*>(.*?)</untrusted_section>", user, _re.S)
                sec = (sec.group(1) if sec else "").lower()
                days = r"monday|tuesday|wednesday|thursday|friday|saturday|sunday"
                res = []
                for lab, text in _re.findall(r"\[(d\d+)\] \([^)]*\) ([^\n]+)", user):
                    dd, sd = set(_re.findall(days, text.lower())), set(_re.findall(days, sec))
                    if dd and sd and not dd & sd:
                        res.append({"id": lab, "verdict": "contradicts", "note": f"The section says {sorted(sd)[0].title()}, the decision says {sorted(dd)[0].title()}."})
                    elif len(_words(text) & _words(sec)) * 2 < len(_words(text)):
                        res.append({"id": lab, "verdict": "omits", "note": "The section doesn't mention it."})
                    else:
                        res.append({"id": lab, "verdict": "consistent", "note": None})
                return _MStream(_json.dumps({"results": res}))
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
            # Says when and where, like the real model is asked to ("On 28 Oct, in Daily Standup, …").
            n = best[0].split("-")[0][1:] if best else (ns[0] if ns else None)
            head = _re.search(rf'<untrusted_meeting n="{n}" title="([^"]*)"[^>]*? day="\w+ (\d+ \w+)', user) if n else None
            ser = _re.search(rf'<untrusted_meeting n="{n}"[^>]*? series="([^"]*)"', user) if n else None
            where = f"On {head.group(2)}, in {ser.group(1) if ser else head.group(1)}, " if head else ""
            return _MStream(f"<ranking>{','.join(ns[:2])}</ranking>\n\n{where}{said}{cite} — see [M1].")

    _mclient = _NS(messages=_MMessages())
    meetings_ai.docs_agent = _NS(get_client=lambda: _mclient, configured=lambda: True)

# Ask (services/ask_markdrop.py, and its live suggestions services/ask_suggestions.py) against a fake model:
# PB_FAKE_ASK_AI=1 (ask-home.mjs, ask-page.mjs). The expansion keeps
# the question (a follow-up: the question with the conversation's first one) and its words; an answer ranks the first
# three candidates and cites them, plus the first transcript moment it was sent; catch-up and action items cite
# everything. Streams like the real API; nothing leaves the machine.
if os.environ.get("PB_FAKE_ASK_AI"):
    import asyncio as _aaio
    import json as _ajson
    import re as _are
    from types import SimpleNamespace as _ANS

    from app.services import ask_markdrop

    class _AStream:
        def __init__(self, text: str):
            self.text = text

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            for i in range(0, len(self.text), 10):
                await _aaio.sleep(0.03)
                yield _ANS(type="text", text=self.text[i:i + 10])

        async def get_final_message(self):
            return _ANS(content=[_ANS(type="text", text=self.text)], stop_reason="end_turn",
                        usage=_ANS(input_tokens=2500, output_tokens=len(self.text) // 4 + 5, cache_read_input_tokens=0,
                                   cache_creation_input_tokens=0, cache_creation=None))

    class _AMessages:
        def stream(self, **params):
            system = params["system"][0]["text"]
            user = "\n".join(b["text"] for b in params["messages"][-1]["content"])
            if system.startswith('You write suggested questions for "Ask"'):
                # Ask's live suggestions (services/ask_suggestions.py): a question per meeting and page it was
                # sent (so a source that should never be sent shows up in the list if it is).
                qs = []
                for title in _are.findall(r"^Meeting: (.+?)(?: \(\d{4}-\d{2}-\d{2}\))?(?: · series .+)?$", user, _are.M)[:4]:
                    qs.append({"topic": title.split()[0], "question": f"What did we decide in {title}?"})
                for title in _are.findall(r"^Page: (.+?)(?: — headings: .*)?$", user, _are.M)[:4]:
                    qs.append({"topic": title.split()[0], "question": f"What's still open on {title}?"})
                return _AStream(_ajson.dumps({"questions": qs}))
            if "Return only JSON" in system:
                q = user.rsplit("Search: ", 1)[-1].strip()
                first = _are.search(r"Q: ([^\n]+)", user)
                standalone = f"{first.group(1)} {q}" if first else q
                words = [w for w in _are.findall(r"[A-Za-z]{4,}", standalone) if w.lower() not in ("what", "when", "does", "with", "about")]
                return _AStream(_ajson.dumps({"standalone": standalone, "terms": words[:6], "titles": []}))
            if "open action items" in system:
                ns = _are.findall(r'<untrusted_task n="(\d+)"', user)
                items = "\n".join(f"- {t.strip()[:80]} [{n}]" for n, t in _are.findall(r'<untrusted_task n="(\d+)"[^>]*>\n([^\n]*)', user))
                return _AStream(f"<ranking>{','.join(ns)}</ranking>\n\nYou have {len(ns)} open action item{'s' if len(ns) != 1 else ''}:\n{items}")
            ns = _are.findall(r'<untrusted_document n="(\d+)" title="([^"]*)"', user)
            if not ns:
                return _AStream("<ranking></ranking>\n\nNothing you can open answers that.")
            if "caught up" in system:
                bullets = "\n".join(f"- **{t}** changed this week [{n}]." for n, t in ns[:4])
                return _AStream(f"<ranking>{','.join(n for n, _ in ns[:4])}</ranking>\n\nHere's your week:\n{bullets}")
            moments = _are.findall(r"\[(\d+-s\d+)\] \S+ ([^:\n]+): ([^\n]+)", user)
            top = ns[:3]
            said = f" {moments[0][1]} said: \"{moments[0][2][:90]}\" [{moments[0][0]}]." if moments else ""
            cites = " ".join(f"**{t}** covers it [{n}]." for n, t in top)
            return _AStream(f"<ranking>{','.join(n for n, _ in top)}</ranking>\n\nFrom what you can open: {cites}{said}")

    _aclient = _ANS(messages=_AMessages())
    ask_markdrop.docs_agent = _ANS(get_client=lambda: _aclient, configured=lambda: True)
    from app.services import ask_suggestions as _ask_sugg

    _ask_sugg.docs_agent = _ANS(get_client=lambda: _aclient, configured=lambda: True)
    # PB_FAKE_PAGES_AI=1 too (meeting-memory.mjs): Page AI counts as set up, so pages show Ask and the editor's
    # AI features (answers come from the same fake).
    if os.environ.get("PB_FAKE_PAGES_AI"):
        from app.services import pages_ai as _pages_ai

        _pages_ai.docs_agent = _ANS(get_client=lambda: _aclient, configured=lambda: True)

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
# a Slack user per code, a few channels, users.lookupByEmail knows Ben). The browser's trips to slack.fake are intercepted by the test.
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
        if method == "users.lookupByEmail":
            # Slack notifications turned on (slack.mjs `optin`): Ben (the seed's member) is in Acme Slack
            # under his Markdrop email; nobody else is.
            if str(data.get("email") or "").lower() == "ben@acme.test":
                return httpx.Response(200, json={"ok": True, "user": {
                    "id": "U-BEN-EMAIL", "name": "ben", "deleted": False, "is_bot": False, "is_email_confirmed": True,
                    "profile": {"email": "ben@acme.test", "real_name": "Ben in Slack"}}})
            # Action items after meetings (slack.mjs `actionitems`): Zara isn't in Markdrop, but is in Acme Slack.
            if str(data.get("email") or "").lower() == "zara@outside.test":
                return httpx.Response(200, json={"ok": True, "user": {
                    "id": "U-ZARA", "name": "zara", "deleted": False, "is_bot": False, "is_email_confirmed": True,
                    "profile": {"email": "zara@outside.test", "real_name": "Zara Khan"}}})
            return httpx.Response(200, json={"ok": False, "error": "users_not_found"})
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

    # Background loops are off here: /__sandbox/slack/flush sends what's queued (the action-items
    # messages wait a minute first, so "now" is two minutes on).
    @mod.app.post("/__sandbox/slack/flush", include_in_schema=False)
    async def _slack_flush():
        from datetime import datetime as _sdt, timedelta as _std, timezone as _stz

        from app import database as _sdatabase
        from app.services import slack as _slack_svc, slack_notify as _slack_notify

        await _slack_svc.drain()
        return {"sent": await _slack_notify.flush(_sdatabase.get_database(), now=_sdt.now(_stz.utc) + _std(minutes=2))}

# Push notifications (services/push.py) for push.mjs: PB_PUSH=1. A VAPID pair made for this run only
# (never a real one), and a fake push service inside this API: /__sandbox/fakepush/<id> keeps what it
# was sent (encrypted, as a real push service would get it), GET /__sandbox/fakepush lists it (the test
# decrypts with its browser's key), /__sandbox/push/flush runs one delivery pass now (background loops
# are off here). /__sandbox/fakepush/answer {status} makes it answer 410 etc.
if os.environ.get("PB_PUSH"):
    import base64 as _b64
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz

    from fastapi import Request as _Req

    from app import database as _database
    from app.services import push as _push, webpush as _webpush

    _keys = _webpush.generate_keys()
    mod.settings.vapid_private_key = _keys["private"]
    mod.settings.vapid_public_key = _keys["public"]
    mod.settings.vapid_subject = "mailto:e2e@example.com"
    mod.settings.push_endpoint_hosts_extra = f"127.0.0.1:{8180 + 10 * STACK_ID}"
    _received: list[dict] = []
    _answer = {"status": 201}

    @mod.app.post("/__sandbox/fakepush/answer", include_in_schema=False)
    async def _fakepush_answer(request: _Req):
        _answer["status"] = int((await request.json()).get("status") or 201)
        return {"status": _answer["status"]}

    @mod.app.post("/__sandbox/fakepush/{sub_id}", include_in_schema=False)
    async def _fakepush(sub_id: str, request: _Req):
        from fastapi.responses import Response as _Resp

        _received.append({"id": sub_id, "body": _b64.b64encode(await request.body()).decode(),
                          "headers": {k: v for k, v in request.headers.items()
                                      if k in ("authorization", "ttl", "content-encoding", "topic", "urgency")}})
        return _Resp(status_code=_answer["status"])

    @mod.app.get("/__sandbox/fakepush", include_in_schema=False)
    async def _fakepush_list():
        return {"received": _received}

    @mod.app.delete("/__sandbox/fakepush", include_in_schema=False)
    async def _fakepush_clear():
        _received.clear()
        _answer["status"] = 201
        return {"ok": True}

    @mod.app.post("/__sandbox/push/flush", include_in_schema=False)
    async def _push_flush():
        db = _database.get_database()
        _push._last_prune = None
        await db[_push.PUSH_LOG].delete_many({})  # each step's page is new; no two-minute gap here
        return await _push.flush(db, _dt.now(_tz.utc) + _td(minutes=5))

# Team memory (services/workspace_memory.py) against a fake model: PB_FAKE_TEAM_AI=1 (team.mjs). It reads a
# meeting's transcript lines "[sN] t Speaker: …" sentence by sentence — "Done: X" (update), "Working on: X"
# (working_on), "Target: X by <when>" (target, the date resolved by the service), "Blocked: X (waiting on
# Name)" (blocker), "Decision: X" (decision), "Status: X" (status) — and a document's "@Name is X" sentences
# (working_on); a product word (Sourcing, Billing, Onboarding, Mobile) names the project. Streams like the real
# API; nothing leaves. Background loops are off here: POST /__sandbox/team-memory/run reads everything
# changed now (pages without the 10-minute wait), and POST /__sandbox/team-memory/member adds a member.
if os.environ.get("PB_FAKE_TEAM_AI"):
    import json as _tjson
    import re as _tre
    from datetime import datetime as _tdt, timedelta as _ttd, timezone as _ttz
    from types import SimpleNamespace as _TNS

    from app import database as _tdatabase
    from app.services import workspace_memory as _wm

    _wm.DEBOUNCE = _ttd(0)
    _PROJ = ("Sourcing", "Billing", "Onboarding", "Mobile")

    def _proj(t):
        return next((p for p in _PROJ if p.lower() in t.lower()), None)

    def _team_facts(user):
        facts = []
        for seg, who, text in _tre.findall(r"\[s(\d+)\] \S+ ([^:\n]+): ([^\n]+)", user):
            for kind, body in _tre.findall(r"(Done|Working on|Target|Blocked|Decision|Status|Role): ([^.]+)", text):
                f = {"person": who.strip(), "cite": f"s{seg}", "project": _proj(body), "confidence": 0.9}
                if kind == "Target":
                    m = _tre.search(r"^(.*?) by (.+)$", body)
                    f.update(kind="target", text=(m.group(1) if m else body).strip().capitalize(), due_text=(m.group(2) if m else None))
                elif kind == "Blocked":
                    m = _tre.search(r"^(.*?)\s*\(waiting on ([^)]+)\)", body)
                    f.update(kind="blocker", text=(m.group(1) if m else body).strip().capitalize(), waiting_on=(m.group(2) if m else None))
                else:
                    f.update(kind={"Done": "update", "Working on": "working_on", "Decision": "decision", "Status": "status",
                                   "Role": "role"}[kind], text=body.strip().capitalize())
                facts.append(f)
        for name, what in _tre.findall(r"@([A-Z][a-z]+ [A-Z][a-z]+) is ([^.\n]+)", user):
            facts.append({"person": name, "kind": "working_on", "text": what.strip().capitalize(), "project": _proj(what), "cite": None})
        return {"facts": facts}

    class _TStream:
        def __init__(self, text):
            self.text = text

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            yield _TNS(type="text", text=self.text)

        async def get_final_message(self):
            return _TNS(content=[_TNS(type="text", text=self.text)], stop_reason="end_turn",
                        usage=_TNS(input_tokens=4000, output_tokens=len(self.text) // 4 + 5, cache_read_input_tokens=0,
                                   cache_creation_input_tokens=0, cache_creation=None))

    class _TMessages:
        def stream(self, **params):
            user = "\n".join(b["text"] for b in params["messages"][-1]["content"])
            return _TStream(_tjson.dumps(_team_facts(user)))

    _tclient = _TNS(messages=_TMessages())
    _wm.docs_agent = _TNS(get_client=lambda: _tclient, configured=lambda: True)

    @mod.app.post("/__sandbox/team-memory/run", include_in_schema=False)
    async def _team_run():
        db = _tdatabase.get_database()
        out = []
        for _ in range(20):
            rep = await _wm.background(db, now=_tdt.now(_ttz.utc))
            out.append(rep)
            if not rep.get("done"):
                break
        return {"passes": out}

    @mod.app.post("/__sandbox/team-memory/member", include_in_schema=False)
    async def _team_member(body: dict):
        db = _tdatabase.get_database()
        u = await db["users"].find_one({"_id": __import__("bson").ObjectId(body["user_id"])})
        await db["memberships"].update_one({"workspace_id": body["workspace_id"], "user_id": body["user_id"]},
                                           {"$set": {"role": body.get("role", "member"), "created_at": _tdt.now(_ttz.utc),
                                                     "email": u["email"], "name": u.get("name")}}, upsert=True)
        return {"ok": True}

# Comments AI (services/comments/ai.py) against a fake model: PB_FAKE_COMMENTS_AI=1 (comments-review.mjs).
# Apply with AI rewrites the passage ("… (revised)", or the words the thread asks for in quotes); a summary
# names every thread it was sent; @AI answers from the page's first line and cites it; the tone check
# offers a fixed kinder rewrite. Streams like the real API; nothing leaves the machine.
if os.environ.get("PB_FAKE_COMMENTS_AI"):
    import asyncio as _caio
    import json as _cjson
    import re as _cre
    from types import SimpleNamespace as _CNS

    from app.services.comments import ai as _comments_ai

    class _CStream:
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
                await _caio.sleep(0.01)
                yield _CNS(type="text", text=self.text[i:i + 12])

        async def get_final_message(self):
            return _CNS(content=[_CNS(type="text", text=self.text)], stop_reason="end_turn",
                        usage=_CNS(input_tokens=1500, output_tokens=len(self.text) // 4 + 5, cache_read_input_tokens=0,
                                   cache_creation_input_tokens=0, cache_creation=None))

    class _CMessages:
        def stream(self, **params):
            system = params["system"][0]["text"]
            user = "\n".join(b["text"] for b in params["messages"][-1]["content"])
            if system.startswith("You edit one passage"):
                passage = _cre.search(r"<untrusted_passage>\n(.*?)\n</untrusted_passage>", user, _cre.S)
                asked = _cre.search(r"[\"“]([^\"”]{2,80})[\"”]", user.split("<untrusted_thread>", 1)[-1])
                text = asked.group(1) if asked else f"{passage.group(1) if passage else 'this'} (revised)"
                return _CStream(_cjson.dumps({"replacement": text, "note": "Reworded as the thread asks."}))
            if system.startswith("You summarise the comment threads"):
                ns = [int(n) for n in _cre.findall(r"^Thread (\d+) ·", user, _cre.M)]
                if os.environ.get("PB_DOCS_WORLD"):
                    # The docs media world (collab-docs-setup.mjs): a summary that reads like a real one.
                    return _CStream(_cjson.dumps({
                        "decided": [{"text": "Launch moves to Tuesday, after QA signs off on the new checkout",
                                     "threads": ns[:1]},
                                    {"text": "Apple Pay ships in the second wave, not on launch day", "threads": ns[1:2] or ns[:1]}],
                        "open": [{"text": "Whether EU customers wait for the new cookie banner", "threads": ns[2:3] or ns[:1]}],
                        "waiting": [{"person": "Riya Sharma", "text": "to accept Alex's wording for the rollout plan",
                                     "threads": ns[:1]}]}))
                return _CStream(_cjson.dumps({
                    "decided": [{"text": f"Settled in {len(ns)} thread(s)", "threads": ns[:1]}],
                    "open": [{"text": "Wording still being discussed", "threads": ns[1:2] or ns[:1]}],
                    "waiting": [{"person": "Ada Owner", "text": "to accept the edit", "threads": ns[:1]}]}))
            if system.startswith("You are Markdrop AI"):
                doc = _cre.search(r'<untrusted_document n="1"[^>]*>\n(.*?)\n', user)
                return _CStream(f"From the page: {(doc.group(1) if doc else 'nothing')[:80]} [1].")
            if system.startswith("You check a comment"):
                return _CStream(_cjson.dumps({"ok": False, "issues": ["harsh wording"],
                                              "rewrite": "Could we take another look at this part?"}))
            return _CStream("{}")

    _cclient = _CNS(messages=_CMessages())
    _comments_ai.docs_agent = _CNS(get_client=lambda: _cclient, configured=lambda: True)

# Jira Cloud against a fake Atlassian (PB_FAKE_JIRA=1, jira.mjs): backend/tests/_jira_fake.FakeJira answers
# OAuth (codes "code-acc-<name>") and Jira REST in process. Accounts: Ada, Ben and Wes see every project;
# Vic sees only WEB (so a PAY chip stays a bare key for him). The browser's trips to auth.jira.test are
# intercepted by the test and sent back to the callback page. Drafts come from a fake model (below): the
# item's words as the summary, the first member named in it as the assignee, "due YYYY-MM-DD" as the due
# date. POST /__sandbox/jira/reset rebuilds the fake world; /__sandbox/jira/move {key, status, by} moves an
# issue in "Jira" and delivers the signed webhook to /api/v1/jira/webhook/<ws> like Jira does;
# GET /__sandbox/jira/issue/<key> reads an issue back. Nothing leaves the machine.
if os.environ.get("PB_FAKE_JIRA"):
    import json as _jjson
    import re as _jre
    from types import SimpleNamespace as _JNS

    from app.services import jira_ai as _jira_ai, jira_api as _jira_api
    from app.utils import crypto as _jcrypto
    from tests._jira_fake import FakeJira as _FakeJira, today_plus as _jtoday

    mod.settings.atlassian_client_id = "fake-atlassian-client"
    mod.settings.atlassian_client_secret = "fake-atlassian-secret"
    mod.settings.atlassian_auth_base = "https://auth.jira.test"
    mod.settings.atlassian_api_base = "https://api.jira.test"
    if not mod.settings.token_encryption_key:
        mod.settings.token_encryption_key = "8Kq0Qb3oQ1n3yYbqQh1w8sV9t6rXo5Wm2Zc4Jd7Lp0E="
    _jcrypto._fernet.cache_clear()

    def _jira_world() -> _FakeJira:
        f = _FakeJira()
        # PB_DOCS_WORLD=1: the docs media world's names (collab-docs-setup.mjs renames the Markdrop people too).
        _n = (["Riya Sharma", "Alex Chen", "Sam Lee", "Maya Patel"] if os.environ.get("PB_DOCS_WORLD")
              else ["Ada Owner", "Ben Member", "Wes Admin", "Vic Viewer"])
        f.add_account("acc-ada", _n[0], "ada@acme.test")
        f.add_account("acc-ben", _n[1], "ben@acme.test")
        f.add_account("acc-wes", _n[2], "wes@acme.test")
        f.add_account("acc-vic", _n[3], "vic@acme.test", projects=["WEB"])
        f.add_issue("PAY", "Retry failed card payments", status="In Progress", assignee="acc-ben", due=_jtoday(-2), priority="High")
        f.add_issue("PAY", "Refund flow for annual plans", assignee="acc-ben", due=_jtoday(6))
        f.add_issue("PAY", "Invoice PDF footer", status="Blocked", assignee="acc-wes")
        f.add_issue("WEB", "Pricing page copy", status="Done", assignee="acc-ben")
        f.add_issue("WEB", "Cookie banner for EU", assignee="acc-ada", due=_jtoday(3))
        f.add_issue("SEC", "Rotate the signing keys", assignee="acc-wes")
        # Jira in pages (jira-pages.mjs): a workflow step whose screen asks for a resolution.
        f.extra_transitions.append(("61", "Resolve", "Done", {"resolution": {
            "name": "Resolution", "required": True, "schema": {"type": "resolution"},
            "allowedValues": [{"id": "1", "name": "Fixed"}, {"id": "2", "name": "Won't do"}]}}))
        return f

    _JIRA = {"fake": _jira_world()}

    async def _jira_handler(request: httpx.Request) -> httpx.Response:
        return await _JIRA["fake"].handler(request)

    _jira_api.TRANSPORT = httpx.MockTransport(_jira_handler)

    _J_ITEM = _jre.compile(r"<untrusted_item>\n(.*?)\n</untrusted_item>", _jre.S)

    def _jira_fields(text: str, members: list[str]) -> dict:
        t = _jre.sub(r":person\[[^\]]*\]\{[^}]*\}", "", text)
        t = _jre.sub(r"\[\d\d:\d\d\]\([^)]*\)|\{#[^}]*\}|·", " ", t)
        due = _jre.search(r"due (\d{4}-\d{2}-\d{2})", t)
        t = _jre.sub(r"due \d{4}-\d{2}-\d{2}", "", t)
        t = " ".join(t.split()).strip(" .-")
        who = next((m for m in members if m.split()[0].lower() in text.lower()), "")
        if who and t.lower().startswith(who.lower()):
            t = t[len(who):].strip(" :,-")
        return {"summary": (t[:1].upper() + t[1:])[:120] or "New issue",
                "description": f"Goal: {t}.\nDone when it's shipped and checked.",
                "issue_type": "Bug" if _jre.search(r"\b(broken|bug|fails?)\b", t, _jre.I) else "Task",
                "priority": "High" if _jre.search(r"\b(asap|urgent|blocker)\b", t, _jre.I) else "",
                "assignee": who, "due": due.group(1) if due else "",
                "labels": ["billing"] if "billing" in t.lower() else []}

    class _JStream:
        def __init__(self, text):
            self.text = text

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def __aiter__(self):
            return self._gen()

        async def _gen(self):
            yield _JNS(type="text", text=self.text)

        async def get_final_message(self):
            return _JNS(content=[_JNS(type="text", text=self.text)], stop_reason="end_turn",
                        usage=_JNS(input_tokens=700, output_tokens=len(self.text) // 4 + 5, cache_read_input_tokens=0,
                                   cache_creation_input_tokens=0, cache_creation=None))

    class _JMessages:
        def stream(self, **params):
            user = params["messages"][-1]["content"][-1]["text"]
            mm = _jre.search(r"^Members[^:]*: (.*)$", user, _jre.M)
            members = [] if not mm or mm.group(1) == "(none)" else [x.strip() for x in mm.group(1).split(";")]
            body = (_J_ITEM.search(user) or _JNS(group=lambda _n: "")).group(1)
            if params["system"][0]["text"].startswith("You turn each numbered item"):
                rows = _jre.findall(r"^(\d+)\. (.*)$", body, _jre.M)
                return _JStream(_jjson.dumps({"drafts": [{"n": int(n), **_jira_fields(t, members)} for n, t in rows]}))
            return _JStream(_jjson.dumps(_jira_fields(body, members)))

    _jclient = _JNS(messages=_JMessages())
    _jira_ai.docs_agent = _JNS(get_client=lambda: _jclient, configured=lambda: True)

    @mod.app.post("/__sandbox/jira/reset", include_in_schema=False)
    async def _jira_reset():
        _JIRA["fake"] = _jira_world()
        return {"ok": True}

    @mod.app.post("/__sandbox/jira/move", include_in_schema=False)
    async def _jira_move(body: dict):
        f = _JIRA["fake"]
        payload = f.move(body["key"], body["status"], body.get("by"))
        token = f.jwt(mod.settings.atlassian_client_secret)
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(f"http://127.0.0.1:{8180 + 10 * STACK_ID}/api/v1/jira/webhook/{body['workspace_id']}",
                                  content=_jjson.dumps(payload), headers={"Authorization": f"Bearer {token}",
                                                                          "Content-Type": "application/json"})
        return {"status": r.status_code, "body": r.json() if r.headers.get("content-type", "").startswith("application/json") else None}

    @mod.app.get("/__sandbox/jira/issue/{key}", include_in_schema=False)
    async def _jira_issue(key: str):
        it = _JIRA["fake"].issues.get(key)
        return it or {"missing": True}

    @mod.app.get("/__sandbox/jira/comments/{key}", include_in_schema=False)
    async def _jira_comments(key: str):
        return {"comments": _JIRA["fake"].comments.get(key, [])}

    @mod.app.get("/__sandbox/jira/webhooks", include_in_schema=False)
    async def _jira_webhooks():
        return {"webhooks": {str(k): v for k, v in _JIRA["fake"].webhooks.items()}}
# The Google Meet script's "Check now" web app, faked: PB_FAKE_MEET_SCRIPT=1 (docs shots of Check for new meetings).
# POST /__sandbox/meet-script/queue {workspace_id, item} holds a Doc (an /inbox body) for the next check; a check
# (meetings_inbox.CHECK_TRANSPORT) finds the connection by its check key, delivers the held Docs through the real
# inbox (meetings_inbox.receive), waits a moment like a real run, and answers with its counts via Google's echo URL.
if os.environ.get("PB_FAKE_MEET_SCRIPT"):
    import asyncio as _masyncio
    import json as _mjson

    from app import database as _mdatabase
    from app.services import meetings_inbox as _mi

    _held: list[dict] = []
    _replies: dict[str, dict] = {}
    _ECHO = "https://script.googleusercontent.com/macros/echo?user_content_key="

    async def _fake_script(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            key = str(req.url).split("user_content_key=", 1)[-1]
            return httpx.Response(200, json=_replies.pop(key, {"ok": False, "error": "failed"}))
        body = _mjson.loads(req.content or b"{}")
        db = _mdatabase.get_database()
        rec = await db["api_tokens"].find_one({"scope": _mi.SCOPE, "check_key": body.get("key")}) if body.get("key") else None
        if rec is None:
            return httpx.Response(200, json={"ok": False, "error": "bad_key"})
        mine = [h for h in _held if h["workspace_id"] == rec["workspace_id"]]
        results: dict[str, int] = {}
        for h in mine:
            _held.remove(h)
            got = await _mi.receive(db, rec, {"source": "google-meet-script", "version": 4, **h["item"]})
            results[got["status"]] = results.get(got["status"], 0) + 1
        await _masyncio.sleep(float(os.environ.get("PB_FAKE_MEET_SCRIPT_DELAY", "2")))
        k = str(len(_replies) + 1) + "x" + str(id(req))
        _replies[k] = {"ok": True, "found": len(mine), "sent": len(mine), "results": results, "skipped": {}, "remaining": 0}
        return httpx.Response(302, headers={"location": _ECHO + k})

    _mi.CHECK_TRANSPORT = httpx.MockTransport(_fake_script)

    @mod.app.post("/__sandbox/meet-script/queue", include_in_schema=False)
    async def _meet_queue(body: dict):
        _held.append({"workspace_id": body["workspace_id"], "item": body["item"]})
        return {"held": len(_held)}


import uvicorn  # noqa: E402

# Keep idle connections open well past the client's own idle limit (Node's fetch drops one after 4 s).
# At uvicorn's default 5 s the scripts' first request after a blocking step (mcpToken / reseed run
# Python with execFileSync, which holds Node's event loop for 2–5 s, so its 4 s timer never fires)
# went out on a socket the server had just closed: "fetch failed" (ECONNRESET on macOS,
# UND_ERR_SOCKET "other side closed" on Linux), e.g. bughunt draft-after-append's append_blocks.
uvicorn.run(mod.asgi, host="127.0.0.1", port=8180 + 10 * STACK_ID, log_level="warning", timeout_keep_alive=60)
