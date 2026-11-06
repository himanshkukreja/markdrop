"""Run the Ask Markdrop eval: seed the world, ask every question through POST /api/v1/ask, grade, write a scorecard.

    # offline (fake model; CI runs a slice of this in tests/test_ask_eval.py)
    zsh .work/heavy.sh .venv/bin/python -m unittest tests.ask_eval.run
    # real Claude Haiku 5.5 (manual; the key is read from the main checkout's backend/.env, never printed)
    ASK_EVAL_MODE=real ASK_EVAL_OUT=<dir> zsh .work/heavy.sh .venv/bin/python -m unittest tests.ask_eval.run

Env: ASK_EVAL_MODE fake|real, ASK_EVAL_OUT (scorecard dir), ASK_EVAL_ONLY (comma-separated ids or
categories), ASK_EVAL_CONCURRENCY (default 4), ASK_EVAL_KEYFILE (default <repo>/backend/.env).

Every model call is recorded (prompt, raw output, usage) against the question that made it, so the
grader can check access leaks in *prompts* and citation labels against what the prompt offered.
"""

from __future__ import annotations

import asyncio
import contextvars
import copy
import json
import os
import re
import statistics
import time
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests._access_env import AccessWorld  # noqa: F401  (pins settings first)
from tests.test_meetings import fake_script as meetings_fake
from tests.test_pages_ai import AIEnv, FakeStream, parse_sse, prompt_of, usage

from app.config import get_settings
from app.services import ai_usage, ask_markdrop, docs_agent, meeting_memory, meetings, search_index

try:  # the baseline run (origin/main) has no ask_me
    from app.services import ask_me
except ImportError:  # pragma: no cover
    ask_me = None
from tests.ask_eval import grade as G
from tests.ask_eval import questions as QS
from tests.ask_eval import world as W

settings = get_settings()
CURRENT: contextvars.ContextVar[str | None] = contextvars.ContextVar("ask_eval_q", default=None)
REPO = Path(__file__).resolve().parents[3]
# The main checkout (a worktree lives in <main>/.work/wt/<name>): scorecards go to <main>/.work/assistant-me/evals.
MAIN = next((p.parent for p in Path(__file__).resolve().parents if p.name == ".work"), REPO)
# Haiku 5.5 list prices (USD per million tokens), for the cost report only.
PRICE = {"input": 1.0, "output": 5.0, "cache_read": 0.1, "cache_write": 1.25}


def _api_key() -> str:
    path = Path(os.environ.get("ASK_EVAL_KEYFILE") or MAIN / "backend" / ".env")
    for line in path.read_text().splitlines():
        m = re.match(r"^\s*(?:MARKDROP_)?ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$", line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    raise RuntimeError("no Anthropic key in " + str(path))


class _Rec:
    """Wraps a stream (real or fake) and records the final text and usage."""

    def __init__(self, inner, rec: dict):
        self.inner, self.rec = inner, rec

    async def __aenter__(self):
        self.s = await self.inner.__aenter__()
        return self

    async def __aexit__(self, *exc):
        return await self.inner.__aexit__(*exc)

    def __aiter__(self):
        return self.s.__aiter__()

    async def get_final_message(self):
        m = await self.s.get_final_message()
        texts = [getattr(b, "text", "") for b in getattr(m, "content", []) or [] if getattr(b, "type", None) == "text"]
        self.rec.update(raw="".join(texts), stop=getattr(m, "stop_reason", None), ms=round((time.monotonic() - self.rec["t0"]) * 1000))
        u = getattr(m, "usage", None)
        if u is not None:
            self.rec["usage"] = {"input": getattr(u, "input_tokens", 0) or 0, "output": getattr(u, "output_tokens", 0) or 0,
                                 "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0,
                                 "cache_write": getattr(u, "cache_creation_input_tokens", 0) or 0}
        return m

    def __getattr__(self, name):
        return getattr(self.s, name)


class Recorder:
    """The model client under test: import summaries always come from the world's fixed notes; every
    other call goes to the real client (real mode) or the fake answerer, and is recorded."""

    def __init__(self, real=None):
        self.real = real
        self.calls: list[dict] = []
        self.messages = self

    def stream(self, **kw):
        if W.is_generate(kw):
            return FakeStream(W.fake_generate(kw), "end_turn", usage(0, 0))
        rec = {"q": CURRENT.get(), "params": copy.deepcopy(kw), "t0": time.monotonic(), "raw": None, "usage": None}
        self.calls.append(rec)
        inner = self.real.messages.stream(**kw) if self.real is not None else FakeStream(fake_answer(kw), "end_turn", usage())
        return _Rec(inner, rec)

    def create(self, **kw):
        if self.real is None:
            raise AssertionError("messages.create in fake mode")
        return self.real.messages.create(**kw)


def fake_answer(params: dict) -> str:
    """A crude stand-in for the model (offline): ranks the first items and quotes their first line."""
    system = params["system"][0]["text"]
    user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
    if "Return only JSON" in system and "standalone" in system:
        q = user.rsplit("Search: ", 1)[-1]
        words = [w for w in re.findall(r"[A-Za-z0-9]{3,}", q)][:6]
        return json.dumps({"standalone": q, "terms": words, "titles": []})
    if system.startswith(("You are Ask Markdrop", "You are Ask AI inside a page")):
        ns = re.findall(r'<untrusted_(?:document|task) n="(\d+)"', user)[:3]
        lines = re.findall(r"\[(\d+-s\d+)\][^\n]*", user)[:2]
        cites = " ".join(f"[{x}]" for x in [*ns, *lines])
        return f"<ranking>{','.join(ns)}</ranking>\n\nFrom what you can open: {cites or 'nothing matches.'}"
    return meetings_fake(params)


def scope_of(spec: str | None, ws: str) -> dict:
    spec = spec or "everything"
    if spec == "meetings":
        return {"kind": "meetings", "workspace": ws}
    if spec == "workspace":
        return {"kind": "workspace", "workspace": ws}
    if spec.startswith("doc:"):
        return {"kind": "doc", "page": spec[4:]}
    return {"kind": "everything"}


def selected(only: str | None) -> list[dict]:
    if not only:
        return list(QS.Q)
    keys = {x.strip() for x in only.split(",") if x.strip()}
    return [q for q in QS.Q if q["id"] in keys or q["cat"] in keys]


class EvalWorld(AccessWorld, AIEnv):
    mode = "fake"

    async def asyncSetUp(self):
        await super().asyncSetUp()
        for mod in (ai_usage, meetings, search_index, ask_markdrop, meeting_memory):
            await mod.ensure_indexes(self.db)
        self.setup_ai()
        self.addCleanup(self.restore_ai)
        saved = {k: getattr(settings, k) for k in ("search_ai_enabled", "search_ai_daily_usd", "search_ai_monthly_usd",
                                                     "meetings_ai_enabled", "meetings_ai_daily_usd", "meetings_ai_monthly_usd")}
        self.addCleanup(lambda: [setattr(settings, k, v) for k, v in saved.items()])
        settings.search_ai_enabled = settings.meetings_ai_enabled = True
        settings.search_ai_daily_usd = settings.meetings_ai_daily_usd = 500.0
        settings.search_ai_monthly_usd = settings.meetings_ai_monthly_usd = 5000.0
        settings.ai_burst_per_minute = 10_000
        settings.ai_burst_per_day = 100_000
        ai_usage.invalidate_settings()
        if ask_me is not None:
            ask_me.forget_names()
        real = None
        if self.mode == "real":
            import anthropic

            key = _api_key()
            settings.anthropic_api_key = key
            real = anthropic.AsyncAnthropic(api_key=key, max_retries=4, timeout=anthropic.Timeout(120.0, connect=10.0))
        self.rec = Recorder(real)
        p = mock.patch.object(docs_agent, "get_client", lambda: self.rec)
        p.start()
        self.addCleanup(p.stop)
        self.ids = await W.seed(self)

    async def asyncTearDown(self):
        for t in list(meetings._bg):
            await asyncio.wait({t}, timeout=10)
        await super().asyncTearDown()

    async def ask_one(self, item: dict, thread_id: str | None = None) -> dict:
        who = item.get("who") or "hk"
        body = {"question": item["q"], "scope": scope_of(item.get("scope"), self.ids["workspace"])}
        if thread_id:
            body["thread_id"] = thread_id
        token = CURRENT.set(item["id"])
        t0 = time.monotonic()
        try:
            r = await self.http.post("/api/v1/ask", headers=self.session(who), json=body, timeout=300)
        finally:
            CURRENT.reset(token)
        ms = round((time.monotonic() - t0) * 1000)
        out = {"id": item["id"], "cat": item["cat"], "who": who, "q": item["q"], "scope": item.get("scope") or "everything",
               "ms": ms, "answer": "", "citations": [], "usage": None, "error": None, "thread_id": None}
        if r.status_code != 200:
            out["error"] = f"HTTP {r.status_code}: {r.text[:200]}"
            return out
        for ev, data in parse_sse(r.text):
            if ev == "done":
                out.update(answer=data.get("answer") or "", citations=data.get("citations") or [], usage=data.get("usage"),
                           thread_id=data.get("thread_id"), intent=data.get("intent"), scope_label=(data.get("scope") or {}).get("label"))
            elif ev in ("error", "limit"):
                out["error"] = f"{ev}: {data.get('detail') or data.get('message')}"
        calls = [c for c in self.rec.calls if c["q"] == item["id"]]
        out["prompts"] = [prompt_of(c["params"]) for c in calls]
        answer_calls = [c for c in calls if not ("Return only JSON" in c["params"]["system"][0]["text"])]
        out["raws"] = [(prompt_of(c["params"]), c.get("raw") or "") for c in answer_calls]
        out["calls"] = [{"system": c["params"]["system"][0]["text"][:40], "usage": c.get("usage"), "ms": c.get("ms"),
                         "stop": c.get("stop")} for c in calls]
        return out

    async def run_all(self, items: list[dict], concurrency: int) -> list[dict]:
        sem = asyncio.Semaphore(concurrency)
        results: list[dict] = []

        async def one(item: dict):
            async with sem:
                res = await self.ask_one(item)
                res["grade"] = G.grade(item, res)
                results.append(res)
                then = item.get("then")
                if then:
                    sub = {**then, "id": item["id"] + "b", "cat": item["cat"], "who": item.get("who"), "scope": item.get("scope")}
                    res2 = await self.ask_one(sub, thread_id=res.get("thread_id"))
                    res2["grade"] = G.grade(sub, res2)
                    results.append(res2)

        await asyncio.gather(*(one(i) for i in items))
        order = {q["id"]: n for n, q in enumerate(QS.Q)}
        results.sort(key=lambda r: (order.get(r["id"].rstrip("b"), 999), r["id"]))
        return results


def cost_of(u: dict | None) -> float:
    if not u:
        return 0.0
    return (u.get("input", 0) * PRICE["input"] + u.get("output", 0) * PRICE["output"] + u.get("cache_read", 0) * PRICE["cache_read"]
            + u.get("cache_write", 0) * PRICE["cache_write"]) / 1e6


def scorecard(results: list[dict], mode: str) -> tuple[dict, str]:
    cats: dict[str, list[dict]] = {}
    for r in results:
        cats.setdefault(r["cat"], []).append(r)
    calls = [c for r in results for c in r.get("calls") or []]
    cost = sum(cost_of(c.get("usage")) for c in calls)
    lat = sorted(r["ms"] for r in results)
    toks_in = [sum((c.get("usage") or {}).get("input", 0) + (c.get("usage") or {}).get("cache_read", 0) + (c.get("usage") or {}).get("cache_write", 0)
                   for c in r.get("calls") or []) for r in results]
    toks_out = [sum((c.get("usage") or {}).get("output", 0) for c in r.get("calls") or []) for r in results]
    n_pass = sum(1 for r in results if r["grade"]["pass"])
    summary = {
        "mode": mode, "at": datetime.now().isoformat(timespec="seconds"), "n": len(results), "passed": n_pass,
        "score": round(100 * n_pass / max(1, len(results)), 1),
        "leaks": sum(1 for r in results if r["grade"]["leak"]),
        "hallucinated_citations": sum(r["grade"]["halluc"] for r in results),
        "citation_lists": sum(r["grade"]["lists"] for r in results),
        "cost_usd": round(cost, 4), "cost_per_question": round(cost / max(1, len(results)), 5),
        "latency_ms": {"p50": lat[len(lat) // 2] if lat else 0, "p95": lat[int(len(lat) * 0.95) - 1] if lat else 0},
        "avg_tokens": {"input": round(statistics.mean(toks_in)) if toks_in else 0, "output": round(statistics.mean(toks_out)) if toks_out else 0},
        "categories": {c: {"n": len(rs), "passed": sum(1 for r in rs if r["grade"]["pass"]),
                           "score": round(100 * sum(1 for r in rs if r["grade"]["pass"]) / len(rs), 1)} for c, rs in sorted(cats.items())},
    }
    md = [f"# Ask Markdrop eval ({mode}) {summary['at']}", "",
          f"**Score {summary['score']}%** ({n_pass}/{len(results)}) · leaks {summary['leaks']} · hallucinated citations "
          f"{summary['hallucinated_citations']} · citation lists {summary['citation_lists']} · cost ${summary['cost_usd']} "
          f"(${summary['cost_per_question']}/q) · latency p50 {summary['latency_ms']['p50']} ms, p95 {summary['latency_ms']['p95']} ms · "
          f"avg tokens in {summary['avg_tokens']['input']} / out {summary['avg_tokens']['output']}", "",
          "| Category | Passed | Score |", "| --- | --- | --- |"]
    for c, v in summary["categories"].items():
        md.append(f"| {c} | {v['passed']}/{v['n']} | {v['score']}% |")
    md += ["", "## Failures", ""]
    for r in results:
        if not r["grade"]["pass"]:
            md.append(f"### {r['id']} ({r['cat']}, {r['who']}, {r['scope']}): {r['q']}")
            md.append("- " + "; ".join(r["grade"]["fails"]))
            md.append("")
            md.append("> " + (r.get("answer") or r.get("error") or "").replace("\n", "\n> "))
            md.append("")
    return summary, "\n".join(md)


def write(results: list[dict], mode: str, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    summary, md = scorecard(results, mode)
    slim = [{k: v for k, v in r.items() if k not in ("prompts", "raws")} | {"raw": [x[1] for x in r.get("raws") or []]} for r in results]
    (out / "results.json").write_text(json.dumps({"summary": summary, "results": slim}, indent=1, default=str))
    (out / "scorecard.md").write_text(md)
    (out / "prompts.json").write_text(json.dumps({r["id"]: r.get("prompts") for r in results}, indent=1, default=str))
    return summary


class Run(EvalWorld):
    """The whole eval (fake by default)."""

    mode = os.environ.get("ASK_EVAL_MODE", "fake")

    async def test_eval(self):
        items = selected(os.environ.get("ASK_EVAL_ONLY"))
        results = await self.run_all(items, int(os.environ.get("ASK_EVAL_CONCURRENCY", "4")))
        out = Path(os.environ.get("ASK_EVAL_OUT") or MAIN / ".work" / "assistant-me" / "evals" /
                   f"{self.mode}-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
        summary = write(results, self.mode, out)
        print("\nASK EVAL", json.dumps({k: summary[k] for k in ("mode", "score", "passed", "n", "leaks", "hallucinated_citations",
                                                              "cost_usd", "latency_ms", "avg_tokens")}), "->", out)
        self.assertEqual(summary["leaks"], 0)


if __name__ == "__main__":
    unittest.main()
