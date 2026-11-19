"use client";

/**
 * The filter bar on a team's backlog page (backend services/team_backlog.py; model lib/backlog.mjs), above the page
 * in View and in Edit: category chips with counts, status / company / owner menus, search, Hide done, "N of M",
 * Copy and CSV. Leads also get "Refresh backlog" and the count of items from private calls (kept off the page).
 *
 * It filters what's on screen, nothing else: lines that don't match are hidden by a stylesheet keyed on their block
 * ids (the editor's DOM is never touched), and the selection lives in the URL (?category=bug&status=open…), so a
 * filtered view can be shared. The page stays a page: edit, comment and share it as usual.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, IconButton, Input, Select, cx, useToast } from "@/components/ui";
import {
  CATEGORIES, EMPTY_FILTER, STATUSES, categoryCounts, choices, filterFromQuery, hideCss, isActive, matches, parseBacklog,
  queryWithFilter, toCsv, toText, type BacklogFilter,
} from "@/lib/backlog.mjs";
import { backlogStatus, refreshBacklog, refreshMessage, type BacklogStatus } from "@/lib/backlogApi";
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

export function BacklogBar({ content, workspaceId, teamId, editing = false, signedIn = true }: Props) {
  const toast = useToast();
  const [filter, setFilter] = useState<BacklogFilter>(EMPTY_FILTER);
  const [status, setStatus] = useState<BacklogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setFilter(filterFromQuery(window.location.search)), []);
  useEffect(() => {
    if (!signedIn || !workspaceId) return;
    let live = true;
    backlogStatus(workspaceId, teamId).then((s) => { if (live) setStatus(s); }).catch(() => undefined);
    return () => { live = false; };
  }, [workspaceId, teamId, signedIn]);

  const { items } = useMemo(() => parseBacklog(content), [content]);
  const shown = useMemo(() => items.filter((i) => matches(i, filter)), [items, filter]);
  const counts = useMemo(() => categoryCounts(items, filter), [items, filter]);
  const { companies, owners } = useMemo(() => choices(items), [items]);
  const active = isActive(filter);
  useStyle(hideCss(items, filter) + (active && !editing ? "\n[data-bl-empty] { display: none !important; }" : ""));

  // View: a category with no items at all (its "Nothing here yet.") goes while a filter is on. The reader's own
  // <details>, never the editor's.
  useEffect(() => {
    if (editing) return;
    const id = requestAnimationFrame(() => {
      document.querySelectorAll<HTMLDetailsElement>("details.pb-details").forEach((d) => {
        const label = d.querySelector("summary")?.textContent?.trim() ?? "";
        const empty = CAT_LABEL.test(label) && !d.querySelector("li[data-bid]");
        if (empty) d.setAttribute("data-bl-empty", "");
        else d.removeAttribute("data-bl-empty");
      });
    });
    return () => cancelAnimationFrame(id);
  }, [content, editing, active]);

  const update = (patch: Partial<BacklogFilter>) => {
    const next = { ...filter, ...patch };
    setFilter(next);
    const q = queryWithFilter(window.location.search, next);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${q}${window.location.hash}`);
  };

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
      <div className="bl-row">
        <Input size="sm" iconPrefix="search" placeholder="Search the backlog" aria-label="Search the backlog" value={filter.search}
          wrapClassName="bl-search" onChange={(e) => update({ search: e.target.value })} data-testid="backlog-search" />
        <Select aria-label="Status" className="bl-select" value={filter.status} onChange={(e) => update({ status: e.target.value })}
          options={[{ value: "", label: "Any status" }, ...STATUSES.map(([value, label]) => ({ value, label }))]} />
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
        <span className="bl-count" aria-live="polite">{active ? `${shown.length} of ${items.length} items` : `${items.length} items`}</span>
        {active && <Button size="sm" variant="ghost" onClick={() => update(EMPTY_FILTER)}>Clear filters</Button>}
        <span className="bl-spacer" />
        <IconButton size="sm" icon="copy" label="Copy the list" onClick={() => void copy()} disabled={!shown.length} />
        <IconButton size="sm" icon="download" label="Export CSV" onClick={csv} disabled={!shown.length} />
        {status?.lead && (
          <Button size="sm" variant="secondary" iconLeft="refresh" loading={busy} onClick={() => void refresh()} data-testid="backlog-refresh">
            Refresh backlog
          </Button>
        )}
      </div>
      {status?.lead && (status.private ?? 0) > 0 && (
        <p className="bl-private">
          {status.private} item{status.private === 1 ? "" : "s"} from private calls {status.private === 1 ? "isn't" : "aren't"} on this page.
        </p>
      )}
    </section>
  );
}
