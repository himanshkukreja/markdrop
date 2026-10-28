"""Rule-based insights for creator analytics (build spec §5).

Pure functions over the numbers the read API already computed — no database
access here, so every rule is testable on a fixture. An insight:

    {key, title, body, severity: "info"|"warning"|"success",
     cta?: {label, tab}, thumb?: str, slug?: str}

``thumb`` is a timestamp ("2:14") the UI turns into a video frame. A
section-drop insight also carries ``section`` (the heading id; the UI swaps in
the heading's text, which the server never has for encrypted documents and
doesn't parse for the rest).

Rules emit only on a sample of at least :data:`MIN_SESSIONS` sessions unless
noted, and never more than :data:`MAX_INSIGHTS`.
"""

from __future__ import annotations

MIN_SESSIONS = 20
MAX_INSIGHTS = 4
_SEVERITY_ORDER = {"warning": 0, "success": 1, "info": 2}


def fmt_t(seconds: float) -> str:
    """2:14, or 1:02:03 past an hour."""
    s = max(0, int(round(seconds or 0)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _insight(key: str, title: str, body: str, severity: str, *, cta: tuple[str, str] | None = None,
             thumb: str | None = None, **extra) -> dict:
    out = {"key": key, "title": title, "body": body, "severity": severity}
    if cta:
        out["cta"] = {"label": cta[0], "tab": cta[1]}
    if thumb is not None:
        out["thumb"] = thumb
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


def biggest_drop(retention: list[dict], *, dur: float, after: float = 10.0, within: float = 10.0,
                 tail: float = 5.0) -> dict | None:
    """The steepest fall in a retention curve: the 10-second window (starting
    after 0:10, ending before the last few seconds, where everyone leaves
    anyway) that loses the most viewers. ``{t, delta, pct}`` — ``t`` is the
    single step inside the window where most of it happens."""
    if len(retention) < 2:
        return None
    step = (retention[1]["t"] - retention[0]["t"]) or 1.0
    w = max(1, int(round(within / step)))
    best = None
    for i, p in enumerate(retention):
        j = i + w
        if p["t"] < after or j >= len(retention) or retention[j]["t"] > dur - tail:
            continue
        delta = p["pct"] - retention[j]["pct"]
        if best is None or delta > best[0]:
            best = (delta, i, j)
    if best is None or best[0] <= 0:
        return None
    delta, i, j = best
    k = max(range(i, j), key=lambda x: retention[x]["pct"] - retention[x + 1]["pct"])
    return {"t": retention[k + 1]["t"], "delta": round(delta, 1), "pct": retention[j]["pct"]}


def for_document(s: dict) -> list[dict]:
    """Insights for one document from its computed stats ``s``:

    kind, slug?, views, prev_views (None for range=all), sessions,
    playing, retention [{t,pct}], dur, hold30, other_hold30 (median of the
    owner's other videos, or None), versions [{version, sessions, metric}]
    newest first, metric_label, phone {n, slow_pct}, sections [{id,
    reached_pct}], pages {reach: [{page,pct}]}, channels [{channel, views,
    engaged_pct}], engaged_pct (all sessions), signals [{platform, n}].
    """
    kind = s.get("kind")
    sessions = s.get("sessions") or 0
    out: list[dict] = []
    media_tab = "listening" if kind == "audio" else "video"
    noun = "listeners" if kind == "audio" else "viewers"

    if kind in ("video", "audio") and (s.get("playing") or 0) >= MIN_SESSIONS and s.get("retention"):
        drop = biggest_drop(s["retention"], dur=s.get("dur") or 0)
        if drop and drop["delta"] >= 8:
            t = fmt_t(drop["t"])
            out.append(_insight(
                "media_drop", f"Most {noun} leave at {t}",
                f"{drop['delta']:.0f}% of {noun} stop within 10 seconds of {t}.",
                "warning", cta=("See the moment", media_tab), thumb=t if kind == "video" else None))
        hold, usual = s.get("hold30"), s.get("other_hold30")
        if hold is not None and usual is not None and abs(hold - usual) >= 10:
            better = hold > usual
            out.append(_insight(
                "hold_30s",
                f"{hold:.0f}% are still {'watching' if kind == 'video' else 'listening'} at 0:30",
                f"{'Above' if better else 'Below'} your usual {usual:.0f}% for "
                f"{'videos' if kind == 'video' else 'audio'}.",
                "success" if better else "warning", cta=("See retention", media_tab),
                thumb="0:30" if kind == "video" else None))

    versions = s.get("versions") or []
    if len(versions) >= 2:
        cur, prev = versions[0], versions[1]
        if (cur.get("sessions") or 0) >= MIN_SESSIONS and (prev.get("sessions") or 0) >= MIN_SESSIONS \
                and cur.get("metric") is not None and prev.get("metric") is not None:
            delta = cur["metric"] - prev["metric"]
            if abs(delta) >= 10:
                label = (s.get("metric_label") or "engagement").lower()
                out.append(_insight(
                    "version_compare",
                    f"Version {cur['version']} {'does better' if delta > 0 else 'does worse'} than "
                    f"version {prev['version']}",
                    f"{label.capitalize()}: {cur['metric']:.0f}% now, {prev['metric']:.0f}% before "
                    f"({'+' if delta > 0 else ''}{delta:.0f} pts).",
                    "success" if delta > 0 else "warning", cta=("Compare versions", "versions")))

    phone = s.get("phone") or {}
    if kind == "video" and (phone.get("n") or 0) >= MIN_SESSIONS and (phone.get("slow_pct") or 0) >= 20:
        out.append(_insight(
            "phone_slow", "Slow starts on phones",
            f"{phone['slow_pct']:.0f}% of phone viewers wait more than 5 seconds for the video to start.",
            "warning", cta=("See playback", "video")))

    if kind == "doc" and sessions >= MIN_SESSIONS:
        secs = s.get("sections") or []
        best = None
        for a, b in zip(secs, secs[1:]):
            d = (a.get("reached_pct") or 0) - (b.get("reached_pct") or 0)
            if d >= 10 and (best is None or d > best[0]):
                best = (d, a["id"])
        if best:
            out.append(_insight(
                "section_drop", f"Readers leave at #{best[1]}",
                f"{best[0]:.0f}% of readers stop after this section.",
                "warning", cta=("See sections", "content"), section=best[1]))

    if kind == "pdf" and sessions >= MIN_SESSIONS:
        reach = (s.get("pages") or {}).get("reach") or []
        best = None
        for a, b in zip(reach, reach[1:]):
            d = (a.get("pct") or 0) - (b.get("pct") or 0)
            if d >= 10 and (best is None or d > best[0]):
                best = (d, a["page"])
        if best:
            out.append(_insight(
                "page_drop", f"Readers stop after page {best[1]}",
                f"{best[0]:.0f}% of readers don't go past page {best[1]}.",
                "warning", cta=("See pages", "pages")))

    views, prev = s.get("views") or 0, s.get("prev_views")
    if prev is not None and max(views, prev) >= 30:
        if prev == 0 or views >= prev * 1.5:
            change = 100 if prev == 0 else round(100 * (views - prev) / prev)
            out.append(_insight(
                "trend_up", f"Views up {change}%",
                f"{views} views this period, {prev} the one before.", "success"))
        elif views <= prev * 0.5:
            change = round(100 * (prev - views) / prev)
            out.append(_insight(
                "trend_down", f"Views down {change}%",
                f"{views} views this period, {prev} the one before.", "info"))

    channels = s.get("channels") or []
    avg = s.get("engaged_pct")
    total = sum(c.get("views") or 0 for c in channels)
    if sessions >= MIN_SESSIONS and total and avg:
        for c in sorted(channels, key=lambda c: -(c.get("views") or 0)):
            share = 100 * (c.get("views") or 0) / total
            eng = c.get("engaged_pct")
            if share >= 30 and eng is not None and eng >= 1.5 * avg:
                out.append(_insight(
                    "top_channel", f"{c['channel']} brings your most engaged {noun if kind in ('video', 'audio') else 'readers'}",
                    f"{share:.0f}% of views, and {eng / avg:.1f}× more likely to finish than average.",
                    "success", cta=("See audience", "audience")))
                break

    for sig in sorted(s.get("signals") or [], key=lambda x: -(x.get("n") or 0)):
        if (sig.get("n") or 0) >= 5:
            where = "elsewhere" if sig["platform"] == "Other" else f"in {sig['platform']}"
            out.append(_insight(
                "share_signal", f"Shared {where} {sig['n']} times",
                "Link previews were fetched — people are passing this link around.",
                "info", cta=("See audience", "audience")))
            break

    if s.get("slug"):
        for i in out:
            i["slug"] = s["slug"]
    return rank(out)[:MAX_INSIGHTS]


def rank(insights: list[dict]) -> list[dict]:
    """Warnings first, then good news, then information (stable within each)."""
    return sorted(insights, key=lambda i: _SEVERITY_ORDER.get(i.get("severity"), 3))


def top_across(per_doc: list[list[dict]], limit: int = MAX_INSIGHTS) -> list[dict]:
    """The home board's insights: the best of each document first, so one
    document doesn't fill every slot."""
    firsts = rank([lst[0] for lst in per_doc if lst])
    rest = rank([i for lst in per_doc for i in lst[1:]])
    return (firsts + rest)[:limit]
