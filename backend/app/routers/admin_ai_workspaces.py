"""Admin → AI → Workspaces: what AI costs per workspace (the Users view, one level up).

    GET /api/v1/admin/ai/usage/workspaces              every workspace that used AI in the range
    GET /api/v1/admin/ai/usage/workspaces/{id}         one workspace (or ``none``: calls with no workspace)
    GET /api/v1/admin/ai/usage/workspaces.csv          the list as a spreadsheet

A ledger row (``ai_requests``, services/ai_usage.py) belongs to the workspace in its ``workspace_id``:
a person's call on a workspace page, meeting or search, and the background jobs that run for a
workspace (Team memory, Ask suggestions, the weekly summary, a meeting summary after an auto-import),
which record its id too. Everything else (personal pages, docs Ask AI visitors, a call with no
workspace) is the **No workspace** row.

Who made the calls is split by actor (services/ai_log.py ``actor_kind``, which a test call keeps):
people in the app, AI apps (MCP, API tokens), system jobs and public visitors. ``audience`` filters
the range's numbers exactly as Overview and Users do (default: everything but test traffic).

Caps are per feature and global (services/ai_usage.caps): no workspace has a cap of its own. Each
workspace shows, for every feature it spent on this month, its own spend today and this month
against that feature's daily and monthly cap, as a share of the cap. Those meters count all traffic,
as the caps do, whatever the audience filter.

Each view is one aggregate over the ledger (``$facet``: the range's totals, its time buckets, the
month-to-date spend for the caps, and what the filter left out); the workspace names, owners and
member counts come from their own collections. Time buckets are UTC half hours, so a day in the
admin's timezone is exact for every whole- or half-hour offset (mongomock has no ``timezone`` for
``$dateToString``). Admins only (routers/admin.require_admin: anyone else gets a 404).
"""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.routers.admin import get_db, require_admin
from app.routers.admin_ai import (
    _audience, _aware, _cap, _csv_cell, _days, _feature_keys, _iso, _label, _tz, _users_info, _window,
)
from app.services import ai_log, ai_usage

router = APIRouter(prefix="/api/v1/admin/ai/usage", tags=["admin"])

NONE = "none"                      # the No workspace row
ACTORS = ("people", "apps", "system", "public")
_SORTS = ("cost", "requests", "tokens", "name", "members", "last_used")
TOP_USERS = 3


def _ws_key(v) -> str:
    return str(v) if v else NONE


def _actor(g: dict) -> str:
    """people | apps | system | public for a group key (actor_kind survives a test call)."""
    kind = g.get("ak") or (g.get("a") if g.get("a") != "test" else None)
    return {"user": "people", "api": "apps", "system": "system", "public": "public"}.get(
        kind, "people" if g.get("u") else "public")


def _bucket_day(g: dict, zone) -> str | None:
    """The admin's local date of a UTC half-hour bucket."""
    try:
        start = datetime.strptime(g["h"], "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError):
        return None
    if g.get("m"):
        start += timedelta(minutes=30)
    return start.astimezone(zone).date().isoformat()


def _month_start(now: datetime) -> datetime:
    return now.astimezone(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _ws_match(ws: str | None) -> dict:
    if ws is None:
        return {}
    return {"workspace_id": {"$in": [None, ""]}} if ws == NONE else {"workspace_id": ws}


async def _aggregate(db, since: datetime, until: datetime, audience: str, *, ws: str | None = None) -> dict:
    """The one ledger aggregate behind a view: {rows, time, caps, left_out}.

    ``rows``: the range's calls (audience applied) grouped by workspace, feature, actor, person and
    test flag (and job, for one workspace); ``time``: the same calls' cost and count per UTC half
    hour (by workspace for the list, by feature for one workspace); ``caps``: month-to-date cost per
    workspace and feature, split today / earlier (all traffic, as the caps count it); ``left_out``:
    what the audience filter left out of the range."""
    month = _month_start(until)
    # Naive UTC inside an expression: pymongo sends it as UTC; mongomock compares it to its stored naive values.
    midnight = ai_usage.utc_midnight(until).replace(tzinfo=None)
    window = {"ts": {"$gte": since, "$lt": until}}
    aq = ai_log.audience_query(audience)
    key = {"w": "$workspace_id", "f": "$feature", "ak": "$actor_kind", "a": "$actor", "u": "$user_id", "t": "$test"}
    if ws is not None:
        key["j"] = "$job"
    sums = {"c": {"$sum": "$cost_usd"}, "n": {"$sum": 1}, "ti": {"$sum": "$usage.input"},
            "to": {"$sum": "$usage.output"}, "cr": {"$sum": "$usage.cache_read"},
            "cw5": {"$sum": "$usage.cache_write_5m"}, "cw1": {"$sum": "$usage.cache_write_1h"}, "last": {"$max": "$ts"}}
    half = {"h": {"$dateToString": {"format": "%Y-%m-%dT%H", "date": "$ts"}}, "m": {"$gte": [{"$minute": "$ts"}, 30]}}
    in_window = {"$match": {"$and": [window, aq]} if aq else window}
    facets: dict = {
        "rows": [in_window, {"$group": {"_id": key, **sums}}],
        "time": [in_window, {"$group": {"_id": {("f" if ws is not None else "w"): ("$feature" if ws is not None else "$workspace_id"),
                                                **half}, "c": {"$sum": "$cost_usd"}, "n": {"$sum": 1}}}],
        "caps": [{"$match": {"ts": {"$gte": month}}},
                 {"$group": {"_id": {"w": "$workspace_id", "f": "$feature", "d": {"$gte": ["$ts", midnight]}},
                             "c": {"$sum": "$cost_usd"}}}],
    }
    if aq:
        facets["left"] = [{"$match": {"$and": [window, {"$nor": [aq]}]}},
                          {"$group": {"_id": None, "n": {"$sum": 1}, "c": {"$sum": "$cost_usd"},
                                      "t": {"$sum": {"$cond": [{"$eq": ["$test", True]}, 1, 0]}}}}]
    pipeline = [{"$match": {"ts": {"$gte": min(since, month)}, **_ws_match(ws)}}, {"$facet": facets}]
    out = (await db[ai_usage.REQUESTS].aggregate(pipeline).to_list(length=1) or [{}])[0]
    left = (out.get("left") or [{}])[0]
    return {"rows": [{**r, **(r.get("_id") or {})} for r in out.get("rows") or []],
            "time": [{**r, **(r.get("_id") or {})} for r in out.get("time") or []],
            "caps": [{**r, **(r.get("_id") or {})} for r in out.get("caps") or []],
            "left_out": {"calls": int(left.get("n") or 0), "test": int(left.get("t") or 0),
                         "cost_usd": round(float(left.get("c") or 0), 6)}}


class _Sum:
    """Requests, cost and tokens of a set of grouped rows."""

    __slots__ = ("requests", "cost", "tok", "last")

    def __init__(self):
        self.requests = 0
        self.cost = 0.0
        self.tok = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
        self.last: datetime | None = None

    def add(self, g: dict) -> None:
        self.requests += int(g.get("n") or 0)
        self.cost += float(g.get("c") or 0)
        self.tok["input"] += int(g.get("ti") or 0)
        self.tok["output"] += int(g.get("to") or 0)
        self.tok["cache_read"] += int(g.get("cr") or 0)
        self.tok["cache_write"] += int(g.get("cw5") or 0) + int(g.get("cw1") or 0)
        ts = _aware(g.get("last"))
        if ts and (self.last is None or ts > self.last):
            self.last = ts

    def out(self) -> dict:
        t = self.tok
        return {"requests": self.requests, "cost_usd": round(self.cost, 6), "tokens": dict(t),
                "tokens_in": t["input"] + t["cache_read"] + t["cache_write"], "tokens_out": t["output"],
                "total_tokens": sum(t.values()), "last_used": _iso(self.last)}


def _small(s: _Sum) -> dict:
    return {"requests": s.requests, "cost_usd": round(s.cost, 6)}


async def _workspaces_info(db, ids: set[str]) -> dict[str, dict]:
    """{id: {name, owner_id, deleting, settings, members}} for the real workspaces among ``ids``."""
    oids = [ObjectId(i) for i in ids if ObjectId.is_valid(i)]
    if not oids:
        return {}
    rows = await db["workspaces"].find({"_id": {"$in": oids}}, {"name": 1, "owner_id": 1, "deleting": 1, "settings": 1}) \
        .to_list(length=len(oids))
    info = {str(r["_id"]): {"name": r.get("name") or "", "owner_id": r.get("owner_id"), "deleting": bool(r.get("deleting")),
                            "settings": r.get("settings") or {}, "members": 0} for r in rows}
    if info:
        async for m in db["memberships"].aggregate([{"$match": {"workspace_id": {"$in": list(info)}}},
                                                     {"$group": {"_id": "$workspace_id", "n": {"$sum": 1}}}]):
            if m["_id"] in info:
                info[m["_id"]]["members"] = int(m["n"])
    return info


def _person(uid: str, users: dict[str, dict]) -> dict:
    u = users.get(uid) or {}
    return {"user_id": uid, "email": u.get("email") or "", "name": u.get("name") or "", "deleted": uid not in users}


def _meta(ws: str, info: dict[str, dict], users: dict[str, dict]) -> dict:
    if ws == NONE:
        return {"workspace_id": NONE, "none": True, "name": "No workspace", "deleted": False, "owner": None,
                "members": None}
    w = info.get(ws)
    if w is None:
        return {"workspace_id": ws, "none": False, "name": "Deleted workspace", "deleted": True, "owner": None,
                "members": None}
    return {"workspace_id": ws, "none": False, "name": w["name"] or "Untitled workspace", "deleted": w["deleting"],
            "owner": _person(w["owner_id"], users) if w.get("owner_id") else None, "members": w["members"]}


class _Caps:
    """The caps each workspace's spend counts against: per feature, global (no per-workspace caps)."""

    def __init__(self, db):
        self.db = db
        self._feature: dict[str, dict] = {}

    async def feature(self, f: str) -> dict:
        if f not in self._feature:
            d, m = await ai_usage.caps(self.db, f)
            self._feature[f] = {"daily_cap_usd": _cap(d), "monthly_cap_usd": _cap(m),
                                "feature_today_usd": round(await ai_usage.spend_today(self.db, f), 6),
                                "feature_month_usd": round(await ai_usage.spend_month(self.db, f), 6)}
        return self._feature[f]

    async def rows(self, spend: dict[str, list[float]]) -> list[dict]:
        """``spend``: {feature: [today, month]} of one workspace → one row per feature, plus "All AI"
        when the global cap is set. ``*_pct``: the workspace's share of the cap (None: no cap)."""
        out = []
        total = [0.0, 0.0]
        for f, (today, month) in spend.items():
            total[0] += today
            total[1] += month
            if month <= 0:
                continue
            c = await self.feature(f)
            out.append(self._row(f, _label(f), today, month, c))
        c = await self.feature(ai_usage.ALL)
        if total[1] > 0 and (c["daily_cap_usd"] is not None or c["monthly_cap_usd"] is not None):
            out.append(self._row(ai_usage.ALL, "All AI features", total[0], total[1], c))
        return sorted(out, key=lambda r: (-(r["month_pct"] or 0), -r["month_usd"]))

    @staticmethod
    def _row(f: str, label: str, today: float, month: float, c: dict) -> dict:
        def share(v: float, cap: float | None) -> float | None:
            return round(100 * v / cap, 1) if cap else None
        return {"feature": f, "label": label, "today_usd": round(today, 6), "month_usd": round(month, 6), **c,
                "today_pct": share(today, c["daily_cap_usd"]), "month_pct": share(month, c["monthly_cap_usd"])}


def _caps_spend(caps: list[dict], ws: str | None = None) -> dict[str, dict[str, list[float]]]:
    """{workspace: {feature: [today, month]}} from the caps facet."""
    out: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    for g in caps:
        k = ws or _ws_key(g.get("w"))
        c = float(g.get("c") or 0)
        cell = out[k][g.get("f") or "?"]
        cell[1] += c
        if g.get("d"):
            cell[0] += c
    return out


def _features_out(per: dict[str, _Sum]) -> list[dict]:
    return sorted(({"key": f, "label": _label(f), **_small(s), "tokens_in": s.out()["tokens_in"],
                    "tokens_out": s.tok["output"]} for f, s in per.items()), key=lambda r: -r["cost_usd"])


# ── The list ──


async def _table(db, since: datetime, until: datetime, tz: str, audience: str, q: str | None) -> dict:
    zone = _tz(tz)
    agg = await _aggregate(db, since, until, audience)
    days = _days(since, until, zone)
    total: dict[str, _Sum] = defaultdict(_Sum)
    actors: dict[str, dict[str, _Sum]] = defaultdict(lambda: defaultdict(_Sum))
    test: dict[str, _Sum] = defaultdict(_Sum)
    feats: dict[str, dict[str, _Sum]] = defaultdict(lambda: defaultdict(_Sum))
    people: dict[str, dict[str, _Sum]] = defaultdict(lambda: defaultdict(_Sum))
    for g in agg["rows"]:
        k = _ws_key(g.get("w"))
        total[k].add(g)
        actors[k][_actor(g)].add(g)
        if g.get("t") is True:
            test[k].add(g)
        feats[k][g.get("f") or "?"].add(g)
        if g.get("u"):
            people[k][g["u"]].add(g)
    spark: dict[str, dict[str, float]] = defaultdict(lambda: dict.fromkeys(days, 0.0))
    for g in agg["time"]:
        d = _bucket_day(g, zone)
        k = _ws_key(g.get("w"))
        if d in spark[k]:
            spark[k][d] += float(g.get("c") or 0)
    spend = _caps_spend(agg["caps"])
    info = await _workspaces_info(db, set(total))
    tops = {k: sorted(p.items(), key=lambda kv: -kv[1].cost)[:TOP_USERS] for k, p in people.items()}
    users = await _users_info(db, {w["owner_id"] for w in info.values() if w.get("owner_id")}
                              | {u for t in tops.values() for u, _s in t})
    caps = _Caps(db)
    needle = (q or "").strip().lower()
    items = []
    for k, s in total.items():
        row = _meta(k, info, users)
        owner = row["owner"] or {}
        if needle and needle not in f"{row['name']} {k} {owner.get('email', '')} {owner.get('name', '')}".lower():
            continue
        row.update(s.out())
        row["people"] = len(people[k])
        row["by_actor"] = {a: _small(actors[k][a]) if a in actors[k] else {"requests": 0, "cost_usd": 0.0} for a in ACTORS}
        row["test"] = _small(test[k]) if k in test else {"requests": 0, "cost_usd": 0.0}
        row["features"] = _features_out(feats[k])
        row["spark"] = [round(spark[k][d], 6) for d in days]
        row["top_users"] = [{**_person(u, users), **_small(v)} for u, v in tops.get(k, [])]
        row["caps"] = await caps.rows(spend.get(k, {}))
        items.append(row)
    grand = _Sum()
    for k, s in total.items():
        grand.requests += s.requests
        grand.cost += s.cost
    return {"items": items, "days": days, "left_out": agg["left_out"],
            "totals": {"requests": grand.requests, "cost_usd": round(grand.cost, 6),
                       "workspaces": sum(1 for k in total if k != NONE),
                       "no_workspace_usd": round(total[NONE].cost, 6) if NONE in total else 0.0}}


def _sort(items: list[dict], sort: str, order: str) -> list[dict]:
    key = {"cost": lambda r: r["cost_usd"], "requests": lambda r: r["requests"], "tokens": lambda r: r["total_tokens"],
           "name": lambda r: r["name"].lower(), "members": lambda r: r["members"] if r["members"] is not None else -1,
           "last_used": lambda r: r["last_used"] or ""}[sort]
    return sorted(items, key=key, reverse=order == "desc")


@router.get("/workspaces")
async def usage_workspaces(
    range_: str = Query("30d", alias="range"),
    tz: str = "UTC",
    audience: str = Query("live", max_length=20),
    q: str | None = Query(None, max_length=200),
    sort: str = Query("cost"),
    order: str = Query("desc"),
    page: int = Query(1, ge=1, le=10_000),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """Every workspace that used AI in the range (and the No workspace row): cost, calls, tokens,
    cost by actor and by feature, a per-day trend, the top people, and the caps it counts against."""
    since, until, key = _window(range_)
    audience = _audience(audience)
    sort = sort if sort in _SORTS else "cost"
    order = "asc" if order == "asc" else "desc"
    t = await _table(db, since, until, tz, audience, q)
    items = _sort(t["items"], sort, order)
    start = (page - 1) * limit
    return {"range": key, "audience": audience, "left_out": t["left_out"], "days": t["days"], "totals": t["totals"],
            "sort": sort, "order": order, "page": page, "pages": max(1, -(-len(items) // limit)), "total": len(items),
            "items": items[start:start + limit]}


@router.get("/workspaces.csv")
async def usage_workspaces_csv(
    range_: str = Query("30d", alias="range"),
    tz: str = "UTC",
    audience: str = Query("live", max_length=20),
    q: str | None = Query(None, max_length=200),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    since, until, key = _window(range_)
    t = await _table(db, since, until, tz, _audience(audience), q)
    features = _feature_keys([{"feature": f["key"]} for r in t["items"] for f in r["features"]])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["workspace_id", "name", "owner_email", "members", "requests", "cost_usd", "input_tokens",
                "output_tokens", "cache_read_tokens", "cache_write_tokens",
                *[f"{a}_cost_usd" for a in ACTORS], "test_cost_usd", *[f"{f}_cost_usd" for f in features],
                "people", "top_user_email", "last_used"])
    for r in _sort(t["items"], "cost", "desc"):
        fc = {f["key"]: f["cost_usd"] for f in r["features"]}
        top = r["top_users"][0]["email"] if r["top_users"] else ""
        w.writerow([_csv_cell(x) for x in (
            r["workspace_id"], r["name"], (r["owner"] or {}).get("email", ""), r["members"], r["requests"],
            f"{r['cost_usd']:.6f}", r["tokens"]["input"], r["tokens"]["output"], r["tokens"]["cache_read"],
            r["tokens"]["cache_write"], *[f"{r['by_actor'][a]['cost_usd']:.6f}" for a in ACTORS],
            f"{r['test']['cost_usd']:.6f}", *[f"{fc.get(f, 0):.6f}" for f in features], r["people"], top,
            r["last_used"])])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="markdrop-ai-workspaces-{key}.csv"',
                             "Cache-Control": "no-store"})


# ── One workspace ──


@router.get("/workspaces/{workspace_id}")
async def usage_workspace(
    workspace_id: str,
    range_: str = Query("30d", alias="range"),
    tz: str = "UTC",
    audience: str = Query("live", max_length=20),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    """One workspace (or ``none``): cost per day by feature, per person, per feature, its system
    jobs, AI apps and visitors, and its caps."""
    ws = NONE if workspace_id == NONE else workspace_id
    if ws != NONE and not ObjectId.is_valid(ws):
        raise HTTPException(404, "Workspace not found")
    since, until, key = _window(range_)
    zone = _tz(tz)
    audience = _audience(audience)
    agg = await _aggregate(db, since, until, audience, ws=ws)
    info = await _workspaces_info(db, {ws}) if ws != NONE else {}
    if ws != NONE and ws not in info and not agg["rows"] and not agg["caps"]:
        raise HTTPException(404, "Workspace not found")
    total, test = _Sum(), _Sum()
    actors: dict[str, _Sum] = defaultdict(_Sum)
    feats: dict[str, _Sum] = defaultdict(_Sum)
    feat_people: dict[str, set] = defaultdict(set)
    per_user: dict[str, _Sum] = defaultdict(_Sum)
    user_apps: dict[str, _Sum] = defaultdict(_Sum)
    user_feats: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    jobs: dict[tuple, _Sum] = defaultdict(_Sum)
    public = _Sum()
    for g in agg["rows"]:
        a = _actor(g)
        f = g.get("f") or "?"
        total.add(g)
        actors[a].add(g)
        feats[f].add(g)
        if g.get("t") is True:
            test.add(g)
        if a == "system":
            jobs[(g.get("j") or ai_log.job_name(f, {}), f)].add(g)
        elif g.get("u"):
            per_user[g["u"]].add(g)
            user_feats[g["u"]][f] += float(g.get("c") or 0)
            feat_people[f].add(g["u"])
            if a == "apps":
                user_apps[g["u"]].add(g)
        else:
            public.add(g)
    features = [f for f in _feature_keys([{"feature": f} for f in feats]) if f in feats]
    series = {d: {"t": d, "requests": 0, "cost_usd": 0.0, "by_feature": dict.fromkeys(features, 0.0),
                  "requests_by_feature": dict.fromkeys(features, 0)} for d in _days(since, until, zone)}
    for g in agg["time"]:
        b = series.get(_bucket_day(g, zone) or "")
        if b is None:
            continue
        f = g.get("f") or "?"
        c = float(g.get("c") or 0)
        b["requests"] += int(g.get("n") or 0)
        b["cost_usd"] += c
        b["by_feature"][f] = b["by_feature"].get(f, 0.0) + c
        b["requests_by_feature"][f] = b["requests_by_feature"].get(f, 0) + int(g.get("n") or 0)
    for b in series.values():
        b["cost_usd"] = round(b["cost_usd"], 6)
        b["by_feature"] = {k: round(v, 6) for k, v in b["by_feature"].items()}
    w = info.get(ws) or {}
    members: dict[str, str] = {}
    if ws != NONE and w:
        async for m in db["memberships"].find({"workspace_id": ws, "user_id": {"$in": list(per_user)}},
                                              {"user_id": 1, "role": 1}):
            members[m["user_id"]] = m.get("role") or "member"
    users = await _users_info(db, set(per_user) | ({w["owner_id"]} if w.get("owner_id") else set()))
    meta = _meta(ws, info, users)
    if ws != NONE and w:
        s = w.get("settings") or {}
        meta["switches"] = {"page_ai": s.get("ai_enabled") is not False, "team_memory": bool(s.get("team_memory"))}
    user_rows = []
    for uid, s in sorted(per_user.items(), key=lambda kv: -kv[1].cost):
        o = s.out()
        user_rows.append({**_person(uid, users), "role": members.get(uid) if ws != NONE else None,
                          "member": uid in members if ws != NONE else None, **o,
                          "apps": _small(user_apps[uid]) if uid in user_apps else {"requests": 0, "cost_usd": 0.0},
                          "features": [f for f, _c in sorted(user_feats[uid].items(), key=lambda kv: -kv[1])]})
    feature_rows = []
    for f in sorted(feats, key=lambda k: -feats[k].cost):
        o = feats[f].out()
        feature_rows.append({"key": f, "label": _label(f), **o, "people": len(feat_people[f]),
                             "share_pct": round(100 * feats[f].cost / total.cost, 1) if total.cost else None})
    caps = await _Caps(db).rows(_caps_spend(agg["caps"], ws).get(ws, {}))
    return {
        "range": key, "audience": audience, "left_out": agg["left_out"],
        "workspace": meta,
        "kpis": {**total.out(), "people": len(per_user)},
        "by_actor": {a: _small(actors[a]) if a in actors else {"requests": 0, "cost_usd": 0.0} for a in ACTORS},
        "test": _small(test),
        "features": [{"key": f, "label": _label(f)} for f in features],
        "series": list(series.values()),
        "users": user_rows,
        "by_feature": feature_rows,
        "jobs": [{"job": j, "feature": f, "label": _label(f), **s.out()}
                 for (j, f), s in sorted(jobs.items(), key=lambda kv: -kv[1].cost)],
        "public": {**public.out()},
        "caps": caps,
    }
