#!/usr/bin/env python3
"""Run one shard of the backend test suite (CI: .github/workflows/ci.yml, job backend).

    python .github/scripts/backend_shard.py --shard 1 --total 8          # run shard 1 of 8
    python .github/scripts/backend_shard.py --shard 1 --total 8 --list   # print its modules only

The modules are backend/tests/test_*.py. They are split by recorded duration
(.github/scripts/backend-durations.json, seconds per module; a module not listed there counts as
DEFAULT_SECONDS) with a deterministic longest-first greedy packing, so every runner computes the
same split and the shards finish at about the same time. Refresh the durations from a run's
`backend-timings-*` artifacts with --merge-timings (see the workflow notes).

Each module runs in its own `python -m unittest -v tests.<module>` process (from backend/), so a
module can't leak state into the next, its log is its own, and its time is measured. The shard
writes ci-out/ (summary.md, timings.json, logs/<module>.log for every module, failing ones listed
first in summary.md) and appends the summary to $GITHUB_STEP_SUMMARY. Exit 1 when any module fails.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
TESTS = BACKEND / "tests"
DURATIONS = Path(__file__).with_name("backend-durations.json")
DEFAULT_SECONDS = 15.0
MODULE_TIMEOUT = int(os.environ.get("CI_MODULE_TIMEOUT", "400"))


def modules() -> list[str]:
    return sorted(p.stem for p in TESTS.glob("test_*.py"))


def durations() -> dict[str, float]:
    try:
        return {k: float(v) for k, v in json.loads(DURATIONS.read_text()).items()}
    except FileNotFoundError:
        return {}


def split(total: int) -> list[list[str]]:
    known = durations()
    cost = {m: known.get(m, DEFAULT_SECONDS) for m in modules()}
    bins: list[tuple[float, int, list[str]]] = [(0.0, i, []) for i in range(total)]
    for m in sorted(cost, key=lambda m: (-cost[m], m)):
        bins.sort(key=lambda b: (b[0], b[1]))
        load, idx, items = bins[0]
        items.append(m)
        bins[0] = (load + cost[m], idx, items)
    bins.sort(key=lambda b: b[1])
    return [sorted(items) for _, _, items in bins]


RAN = re.compile(r"^Ran (\d+) tests? in ([\d.]+)s", re.M)
RESULT = re.compile(r"^(OK|FAILED)(?: \((.*)\))?\s*$", re.M)


def _hung_tasks(pid: int) -> str:
    """What a hung test process is waiting on: its asyncio task tree (Python 3.14's `python -m asyncio
    pstree`, which needs ptrace rights: sudo on the runners), else its threads' stacks."""
    if sys.version_info < (3, 14):
        return "(no asyncio task tree before Python 3.14)"
    last = ""
    for cmd in (["sudo", "-n", sys.executable, "-m", "asyncio", "pstree", str(pid)],
                [sys.executable, "-m", "asyncio", "pstree", str(pid)]):
        try:
            r = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout
        last = r.stdout
    return f"(no asyncio task tree: {last.strip()[-300:] if last else 'pstree unavailable'})"


def _run_once(mod: str) -> tuple[str, int]:
    proc = subprocess.Popen(
        [sys.executable, "-X", "faulthandler", "-m", "unittest", "-v", f"tests.{mod}"],
        cwd=BACKEND, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        out, _ = proc.communicate(timeout=MODULE_TIMEOUT)
        return out, proc.returncode
    except subprocess.TimeoutExpired:
        tree = _hung_tasks(proc.pid)
        if tree.startswith("(no"):
            proc.send_signal(signal.SIGABRT)  # -X faulthandler prints every thread's stack
        else:
            proc.kill()
        try:
            out, _ = proc.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
        return f"{out}\n\nTIMEOUT after {MODULE_TIMEOUT}s. Its asyncio tasks then:\n{tree}\n", 124


def run_module(mod: str, logs: Path) -> dict:
    """One module in its own process. A module that hangs (a timeout: the bar is ~4x the slowest module's
    CI time) is run once more; passing then still says so (`hung once`), with the hung run's task tree
    in its log, so a race shows up without holding the shard for 20 minutes."""
    log = logs / f"{mod}.log"
    t0 = time.monotonic()
    out, rc = _run_once(mod)
    hung = ""
    if rc == 124:
        hung = out
        out, rc = _run_once(mod)
        out = f"{out}\n\n==== the first run hung ====\n{hung}"
    secs = time.monotonic() - t0
    log.write_text(out)
    ran = RAN.findall(out)
    res = RESULT.findall(out)
    detail = res[0][1] if res else ""
    if hung:
        detail = f"hung once{'; ' + detail if detail else ''}"
    return {
        "module": mod,
        "ok": rc == 0,
        "rc": rc,
        "seconds": round(secs, 1),
        "tests": int(ran[0][0]) if ran else 0,
        "detail": detail,
        "hung": bool(hung),
        "failures": re.findall(r"^(?:FAIL|ERROR): (.+)$", out, re.M)[:20],
    }


def merge_timings(paths: list[str]) -> None:
    merged = durations()
    for p in paths:
        for row in json.loads(Path(p).read_text()):
            merged[row["module"]] = row["seconds"]
    live = set(modules())
    merged = {k: v for k, v in sorted(merged.items()) if k in live}
    DURATIONS.write_text(json.dumps(merged, indent=2) + "\n")
    print(f"wrote {DURATIONS} ({len(merged)} modules, {sum(merged.values()):.0f}s total)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", type=int)
    ap.add_argument("--total", type=int)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--out", default=str(ROOT / "ci-out"))
    ap.add_argument("--merge-timings", nargs="+", metavar="TIMINGS_JSON")
    a = ap.parse_args()
    if a.merge_timings:
        merge_timings(a.merge_timings)
        return 0
    if not (a.total and a.shard and 1 <= a.shard <= a.total):
        ap.error("--shard N --total M with 1 <= N <= M")
    mine = split(a.total)[a.shard - 1]
    if a.list:
        print("\n".join(mine))
        return 0

    out = Path(a.out)
    logs = out / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    print(f"shard {a.shard}/{a.total}: {len(mine)} modules", flush=True)
    rows = []
    t0 = time.monotonic()
    for mod in mine:
        r = run_module(mod, logs)
        rows.append(r)
        mark = "ok  " if r["ok"] else "FAIL"
        print(f"{mark} {r['seconds']:7.1f}s {r['tests']:4d} tests  {mod} {('(' + r['detail'] + ')') if r['detail'] else ''}", flush=True)
        if r["hung"]:
            print(f"::warning title=Backend module hung::{mod} hung once (timeout {MODULE_TIMEOUT}s) and was run again: "
                  f"{'passed' if r['ok'] else 'failed'} the second time. Its asyncio task tree is in backend-logs-{a.shard}/logs/{mod}.log")
        if not r["ok"] or r["hung"]:
            print(f"::group::{mod} log (tail)")
            print("\n".join((logs / f"{mod}.log").read_text().splitlines()[-120:]))
            print("::endgroup::", flush=True)
    wall = time.monotonic() - t0

    failed = [r for r in rows if not r["ok"]]
    (out / "timings.json").write_text(json.dumps(rows, indent=2) + "\n")
    lines = [
        f"### Backend shard {a.shard}/{a.total}: {'PASS' if not failed else f'FAIL ({len(failed)} module(s))'}",
        "",
        f"{sum(r['tests'] for r in rows)} tests in {len(rows)} modules, {wall:.0f}s",
        "",
    ]
    if failed:
        lines += ["| Failed module | rc | tests | first failures |", "|---|---|---|---|"]
        for r in failed:
            lines.append(f"| `{r['module']}` | {r['rc']} | {r['tests']} | {'<br>'.join(r['failures'][:5]) or r['detail']} |")
        lines.append("")
    hung = [r for r in rows if r["hung"]]
    if hung:
        names = ", ".join(f"`{r['module']}`" for r in hung)
        lines += [f"Hung once and run again: {names} (their asyncio task trees are in the logs artifact)", ""]
    perf = [ln for r in rows for ln in (logs / f"{r['module']}.log").read_text().splitlines() if ln.startswith("SEARCH PERF")]
    if perf:
        lines += ["```", *perf, "```", ""]
    lines += ["<details><summary>Per-module times</summary>", "", "| Module | s | tests | result |", "|---|---|---|---|"]
    for r in sorted(rows, key=lambda r: -r["seconds"]):
        lines.append(f"| `{r['module']}` | {r['seconds']} | {r['tests']} | {'ok' if r['ok'] else 'FAIL'} {r['detail']} |")
    lines += ["", "</details>", ""]
    summary = "\n".join(lines)
    (out / "summary.md").write_text(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(summary)
    # Keep only failing logs in the uploaded artifact's failed/ folder for quick access.
    if failed:
        (out / "failed").mkdir(exist_ok=True)
        for r in failed:
            (out / "failed" / f"{r['module']}.log").write_text((logs / f"{r['module']}.log").read_text())
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
