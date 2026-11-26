"use client";

/**
 * The filter bar on a team's backlog page (backend services/team_backlog.py; model lib/backlog.mjs), above the page
 * in View and in Edit: category and priority chips with counts, status / date / company / owner menus, search, Hide
 * done, "Group by", "N of M", Copy and CSV. Leads also get "Refresh backlog" and the count of items from private
 * calls (kept off the page).
 *
 * It filters what's on screen, nothing else: lines that don't match are hidden by a stylesheet keyed on their block
 * ids (the editor's DOM is never touched), and the selection lives in the URL (?category=bug&priority=urgent,high
 * &since=30d&group=priority…), so a filtered view can be shared — Slack's "Open the changed items" is one
 * (?items=b-…,b-…). "Group by" other than Category (View only) draws the same items regrouped below the bar and hides
 * the page's own category toggles while it's on: the stored page stays category-sectioned, so edits, comments and
 * anchors are unaffected. There a priority chip opens a menu that sets it (a person's decision, it wins) through the
 * backlog API, which rewrites the page.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Dropdown, IconButton, Input, Select, cx, useToast } from "@/components/ui";
import {
  CATEGORIES, DATE_RANGES, EMPTY_FILTER, GROUPS, PRIORITIES, PRIORITY_LABEL, STATUSES, categoryCounts, choices, filterFromQuery,
  groupItems, hideCss, isActive, matches, parseBacklog, priorityCounts, queryWithFilter, toCsv, toText,
  type BacklogFilter, type BacklogLine, type BacklogPriority,
} from "@/lib/backlog.mjs";
import { backlogStatus, refreshBacklog, refreshMessage, setPriorities, type BacklogStatus } from "@/lib/backlogApi";
import "./backlog.css";

type Props = {
  content: string;
  workspaceId: string | null;
  teamId: string;
  /** The editor is showing (empty categories stay: a line can be moved into them). */
  editing?: boolean;
  signedIn?: boolean;
};

const STYLE_ID = "md-backlog-filter";
const CAT_LABEL = /^(Feature request|Bug|Improvement|Task|Follow-up|Question) · \d+ open/;
const DONE_LABEL = /^Done · \d+$/;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string | null) => (d ? `${MONTH[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}` : "");
const STATUS_LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", done: "Done", wont_do: "Won't do" };

function useStyle(text: string) {
  useEffect(() => {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = text;
  }, [text]);
  useEffect(() => () => document.getElementById(STYLE_ID)?.remove(), []);
}

function PriorityChip({ p, onPick, busy }: { p: BacklogPriority; onPick?: (p: BacklogPriority) => void; busy?: boolean }) {
  const chip = (
    <button type="button" className={cx("bl-prio", `bl-prio--${p}`, onPick && "bl-prio--btn")} disabled={!onPick || busy}
      aria-label={onPick ? `Priority: ${PRIORITY_LABEL[p]}. Change it` : `Priority: ${PRIORITY_LABEL[p]}`} data-testid="backlog-prio">
      {PRIORITY_LABEL[p]}
    </button>
  );
  if (!onPick) return chip;
  return (
    <Dropdown trigger={chip} align="left" portal aria-label="Set the priority"
      items={PRIORITIES.map(([k, label]) => ({ label, icon: k === p ? "check" : undefined, onClick: () => onPick(k) }))} />
  );
}

export function BacklogBar({ content, workspaceId, teamId, editing = false, signedIn = true }: Props) {
  const toast = useToast();
  const [filter, setFilter] = useState<BacklogFilter>(EMPTY_FILTER);
  const [status, setStatus] = useState<BacklogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // Priorities just picked here, until the rewritten page arrives with them.
  const [picked, setPicked] = useState<Record<string, BacklogPriority>>({});
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => setFilter(filterFromQuery(window.location.search)), []);
  useEffect(() => {
    if (!signedIn || !workspaceId) return;
    let live = true;
    backlogStatus(workspaceId, teamId).then((s) => { if (live) setStatus(s); }).catch(() => undefined);
    return () => { live = false; };
  }, [workspaceId, teamId, signedIn]);

  const parsed = useMemo(() => parseBacklog(content).items, [content]);
  const items: BacklogLine[] = useMemo(() => parsed.map((i) => (picked[i.block] ? { ...i, priority: picked[i.block] } : i)), [parsed, picked]);
  useEffect(() => setPicked((cur) => {
    const left = Object.fromEntries(Object.entries(cur).filter(([b, p]) => parsed.find((i) => i.block === b)?.priority !== p));
    return Object.keys(left).length === Object.keys(cur).length ? cur : left;
  }), [parsed]);
  const shown = useMemo(() => items.filter((i) => matches(i, filter)), [items, filter]);
  const counts = useMemo(() => categoryCounts(items, filter), [items, filter]);
  const pcounts = useMemo(() => priorityCounts(items, filter), [items, filter]);
  const { companies, owners } = useMemo(() => choices(items), [items]);
  const active = isActive(filter);
  const grouped = filter.group !== "category" && !editing;
  const groups = useMemo(() => (grouped ? groupItems(shown, filter.group, filter.dateBy) : []), [grouped, shown, filter.group, filter.dateBy]);
  useStyle(hideCss(items, filter) + (active && !editing ? "\n[data-bl-empty] { display: none !important; }" : "")
    + (grouped ? "\ndetails[data-bl-cat] { display: none !important; }" : ""));

  // View: a category with no items at all (its "Nothing here yet.") goes while a filter is on; every category
  // toggle is marked so "Group by" can set the page's own list aside. The reader's own <details>, never the editor's.
  useEffect(() => {
    if (editing) return;
    const id = requestAnimationFrame(() => {
      document.querySelectorAll<HTMLDetailsElement>("details.pb-details").forEach((d) => {
        const label = d.querySelector("summary")?.textContent?.trim() ?? "";
        const cat = CAT_LABEL.test(label);
        const empty = cat && !d.querySelector("li[data-bid]");
        if (empty) d.setAttribute("data-bl-empty", "");
        else d.removeAttribute("data-bl-empty");
        if (cat && !DONE_LABEL.test(label)) d.setAttribute("data-bl-cat", "");
      });
      // The priority written on a line (**Urgent**, **High**, **Low**) drawn as a chip.
      document.querySelectorAll<HTMLElement>("details.pb-details li[data-bid] strong").forEach((el) => {
        const k = PRIORITIES.find(([, l]) => l === el.textContent?.trim())?.[0];
        if (k) el.setAttribute("data-bl-prio", k);
        else el.removeAttribute("data-bl-prio");
      });
    });
    return () => cancelAnimationFrame(id);
  }, [content, editing, active, grouped]);

  const update = (patch: Partial<BacklogFilter>) => {
    const next = { ...filter, ...patch };
    setFilter(next);
    const q = queryWithFilter(window.location.search, next);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${q}${window.location.hash}`);
  };
  const togglePriority = (k: string) =>
    update({ priority: filter.priority.includes(k) ? filter.priority.filter((x) => x !== k) : PRIORITIES.map(([p]) => p).filter((p) => p === k || filter.priority.includes(p)) });

  const pick = async (it: BacklogLine, p: BacklogPriority) => {
    if (!workspaceId || p === it.priority) return;
    setSaving(it.block);
    setPicked((cur) => ({ ...cur, [it.block]: p }));
    try {
      const r = await setPriorities(workspaceId, teamId, [{ id: it.block, priority: p }]);
      if (r.failed.length) throw new Error(r.failed[0].error);
      toast.success(`${PRIORITY_LABEL[p]}: ${it.text.length > 48 ? `${it.text.slice(0, 47)}…` : it.text}`);
    } catch (e) {
      setPicked((cur) => Object.fromEntries(Object.entries(cur).filter(([b]) => b !== it.block)));
      toast.error(e instanceof Error ? e.message : "Couldn't change the priority.");
    } finally {
      setSaving(null);
    }
  };
  const canPick = signedIn && !!workspaceId && !!status;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toText(shown));
      toast.success(`Copied ${shown.length} item${shown.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Couldn't copy. Try again.");
    }
  };
  const csv = () => {
    const blob = new Blob([toCsv(shown, window.location.origin)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "backlog.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const refresh = async () => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const r = await refreshBacklog(workspaceId, teamId);
      toast.success(refreshMessage(r));
      setStatus(await backlogStatus(workspaceId, teamId).catch(() => status));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't refresh the backlog.");
    } finally {
      setBusy(false);
    }
  };

  if (!items.length && !status?.lead) return null;
  return (
    <section className="bl-bar no-print" aria-label="Filter the backlog" data-testid="backlog-bar">
      <div className="bl-cats" role="group" aria-label="Category">
        <button type="button" className={cx("bl-chip", !filter.category && "bl-chip--on")} aria-pressed={!filter.category}
          onClick={() => update({ category: "" })}>
          All <span className="bl-chip__n">{items.filter((i) => matches(i, filter, "category")).length}</span>
        </button>
        {CATEGORIES.map(([key, label]) => (
          <button key={key} type="button" className={cx("bl-chip", filter.category === key && "bl-chip--on")} data-cat={key}
            aria-pressed={filter.category === key} onClick={() => update({ category: filter.category === key ? "" : key })}>
            {label} <span className="bl-chip__n">{counts[key] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="bl-cats" role="group" aria-label="Priority" data-testid="backlog-priorities">
        <span className="bl-label">Priority</span>
        {PRIORITIES.map(([key, label]) => (
          <button key={key} type="button" className={cx("bl-chip", `bl-chip--${key}`, filter.priority.includes(key) && "bl-chip--on")}
            data-prio={key} aria-pressed={filter.priority.includes(key)} onClick={() => togglePriority(key)}>
            <span className={cx("bl-dot", `bl-dot--${key}`)} aria-hidden />{label} <span className="bl-chip__n">{pcounts[key] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="bl-row">
        <Input size="sm" iconPrefix="search" placeholder="Search the backlog" aria-label="Search the backlog" value={filter.search}
          wrapClassName="bl-search" onChange={(e) => update({ search: e.target.value })} data-testid="backlog-search" />
        <Select aria-label="Status" className="bl-select" value={filter.status} onChange={(e) => update({ status: e.target.value })}
          options={[{ value: "", label: "Any status" }, ...STATUSES.map(([value, label]) => ({ value, label }))]} />
        <Select aria-label="Date" className="bl-select" value={filter.since} data-testid="backlog-since"
          onChange={(e) => update({ since: e.target.value, ...(e.target.value !== "custom" ? { from: "", to: "" } : {}) })}
          options={DATE_RANGES.map(([value, label]) => ({ value, label }))} />
        {filter.since && (
          <Select aria-label="Date of" className="bl-select bl-select--narrow" value={filter.dateBy}
            onChange={(e) => update({ dateBy: e.target.value === "last" ? "last" : "first" })}
            options={[{ value: "first", label: "First seen" }, { value: "last", label: "Last mentioned" }]} />
        )}
        {filter.since === "custom" && (
          <span className="bl-range">
            <Input size="sm" type="date" aria-label="From" value={filter.from} max={filter.to || undefined}
              onChange={(e) => update({ from: e.target.value })} />
            <span aria-hidden>–</span>
            <Input size="sm" type="date" aria-label="To" value={filter.to} min={filter.from || undefined}
              onChange={(e) => update({ to: e.target.value })} />
          </span>
        )}
        {companies.length > 0 && (
          <Select aria-label="Company" className="bl-select" value={filter.company} onChange={(e) => update({ company: e.target.value })}
            options={[{ value: "", label: "Any company" }, ...companies.map((c) => ({ value: c, label: c }))]} />
        )}
        {owners.length > 0 && (
          <Select aria-label="Owner" className="bl-select" value={filter.owner} onChange={(e) => update({ owner: e.target.value })}
            options={[{ value: "", label: "Anyone" }, ...owners.map((o) => ({ value: o.id, label: o.name }))]} />
        )}
        <Checkbox label="Hide done" checked={filter.hideDone} onChange={(e) => update({ hideDone: e.target.checked })} />
      </div>
      <div className="bl-row bl-row--end">
        <label className="bl-group">
          <span>Group by</span>
          <Select aria-label="Group by" className="bl-select bl-select--narrow" value={filter.group} disabled={editing}
            title={editing ? "Group by works while viewing the page" : undefined} data-testid="backlog-group"
            onChange={(e) => update({ group: e.target.value as BacklogFilter["group"] })}
            options={GROUPS.map(([value, label]) => ({ value, label }))} />
        </label>
        <span className="bl-count" aria-live="polite">{active ? `${shown.length} of ${items.length} items` : `${items.length} items`}</span>
        {active && <Button size="sm" variant="ghost" onClick={() => update({ ...EMPTY_FILTER, group: filter.group })}>Clear filters</Button>}
        <span className="bl-spacer" />
        <IconButton size="sm" icon="copy" label="Copy the list" onClick={() => void copy()} disabled={!shown.length} />
        <IconButton size="sm" icon="download" label="Export CSV" onClick={csv} disabled={!shown.length} />
        {status?.lead && (
          <Button size="sm" variant="secondary" iconLeft="refresh" loading={busy} onClick={() => void refresh()} data-testid="backlog-refresh">
            Refresh backlog
          </Button>
        )}
      </div>
      {filter.items.length > 0 && (
        <p className="bl-note" data-testid="backlog-items-note">
          Showing the {filter.items.length} item{filter.items.length === 1 ? "" : "s"} a call changed.{" "}
          <button type="button" className="bl-link" onClick={() => update({ items: [] })}>Show everything</button>
        </p>
      )}
      {status?.lead && (status.private ?? 0) > 0 && (
        <p className="bl-private">
          {status.private} item{status.private === 1 ? "" : "s"} from private calls {status.private === 1 ? "isn't" : "aren't"} on this page.
        </p>
      )}
      {grouped && (
        <div className="bl-groups" data-testid="backlog-groups">
          {groups.length === 0 && <p className="bl-private">Nothing matches this filter.</p>}
          {groups.map((g) => (
            <section key={g.key} className="bl-group-sec" aria-label={g.label}>
              <h3 className="bl-group-h">{g.label} <span className="bl-chip__n">{g.items.length}</span></h3>
              <ul className="bl-list">
                {g.items.map((it) => (
                  <li key={it.block} className={cx("bl-item", it.status === "done" && "bl-item--done")} data-testid="backlog-group-item">
                    <PriorityChip p={it.priority} busy={saving === it.block}
                      onPick={canPick && it.status !== "done" ? (p) => void pick(it, p) : undefined} />
                    <span className="bl-item__text" dir="auto">{it.text}</span>
                    <span className="bl-item__meta">
                      {[it.status !== "open" ? STATUS_LABEL[it.status] : null, filter.group !== "category" ? CATEGORIES.find(([k]) => k === it.category)?.[1] : null,
                        filter.group !== "company" ? it.company : null, filter.group !== "owner" && it.owner ? it.owner.name : null,
                        it.calls > 1 ? `${it.calls} calls` : null].filter(Boolean).join(" · ")}
                      {it.from && <> · <a href={it.from.href}>{it.from.title.split(" · ")[0]}</a></>}
                      {(filter.dateBy === "last" ? it.lastDate : it.firstDate) && <> · {short(filter.dateBy === "last" ? it.lastDate : it.firstDate)}</>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
