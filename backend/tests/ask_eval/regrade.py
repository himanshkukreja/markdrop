"""Grade a finished eval run again with the current questions and grader (no model calls, no database).

    .venv/bin/python -m tests.ask_eval.regrade <run dir> [<run dir>…]

Writes scorecard-regraded.md and prints the summary. Questions added since the run are skipped."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from tests.ask_eval import grade as G
from tests.ask_eval import questions as QS


def items() -> dict[str, dict]:
    out = {}
    for q in QS.Q:
        out[q["id"]] = q
        if q.get("then"):
            out[q["id"] + "b"] = {**q["then"], "id": q["id"] + "b", "cat": q["cat"], "who": q.get("who"), "scope": q.get("scope")}
    return out


def regrade(run: Path) -> dict:
    from tests.ask_eval.run import scorecard

    data = json.loads((run / "results.json").read_text())
    prompts = json.loads((run / "prompts.json").read_text())
    qs = items()
    results = []
    for r in data["results"]:
        item = qs.get(r["id"])
        if item is None:
            continue
        ps = prompts.get(r["id"]) or []
        answer_ps = [p for p in ps if "Return only JSON" not in p]
        r = {**r, "cat": item["cat"], "prompts": ps, "raws": list(zip(answer_ps, r.get("raw") or []))}
        r["grade"] = G.grade(item, r)
        results.append(r)
    summary, md = scorecard(results, data["summary"]["mode"] + " (regraded)")
    (run / "scorecard-regraded.md").write_text(md)
    return summary


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        s = regrade(Path(arg))
        print(arg, json.dumps({k: s[k] for k in ("score", "passed", "n", "leaks", "hallucinated_citations", "cost_usd",
                                                 "latency_ms", "avg_tokens")}))
        print("  ", {c: v["score"] for c, v in s["categories"].items()})
