"use client";

/**
 * The customizable part of Home (brief .work/briefs/custom-dashboard.md): under the greeting and the Ask
 * bar, a wide main column and a narrow side column, each an ordered list of widgets — the team Overview's
 * two stacks (a tall card in one never leaves a hole in the other; one column on phones, main then side).
 *
 * No drag and drop: Customize gives each widget ↑ ↓, Move to side/main, Settings and Remove, "+ Add widget"
 * opens the catalog, and Templates / Reset to default / Set as workspace default (admins) sit in its bar.
 * Every change saves at once (PUT /me/dashboard; the server validates it against the registry).
 *
 * Speed: the last layout is kept on this device and drawn at once; the widgets built on GET /home are
 * Home's own sections and use the data Home already loads in parallel; the rest load on demand, each its
 * own request and skeleton (components/home/widgets).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Button, Dialog, Dropdown, Field, Icon, IconButton, Input, Select, Skeleton, cx, useToast, type MenuEntry } from "@/components/ui";
import {
  applyPreset, cacheDashboard, cachedDashboard, clearWorkspaceDefault, getDashboard, resetDashboard, saveDashboard, savedWorkspace,
  setWorkspaceDefault, type CatalogEntry, type Dashboard as Dash, type Layout, type Widget,
} from "@/lib/dashboard";
import { add, count, move, moveAcross, moves, pickable, remove, update, type SettingField } from "@/lib/dashboardCore.mjs";
import { CATEGORIES, STATUSES } from "@/lib/backlog.mjs";
import { errorStatus } from "@/lib/workspaces";
import { teamsSlot, useTeamsSidebar } from "@/lib/teamsStore";
import { useWorkspaceTree } from "@/lib/workspaceStore";
import { quickSearch, type QuickFile } from "@/lib/me";
import { track } from "@/lib/track";
import type { WidgetProps } from "./widgets";
import { markVisit } from "@/lib/people";
import "./dashboard.css";

const load = (name: keyof typeof import("./widgets")) =>
  dynamic<WidgetProps>(() => import("./widgets").then((m) => m[name] as React.ComponentType<WidgetProps>), {
    ssr: false, loading: () => <div className="th-card db-card" aria-hidden><Skeleton width="40%" /><div className="mt-3"><Skeleton variant="rect" height={120} /></div></div>,
  });

const OWN: Record<string, React.ComponentType<WidgetProps>> = {
  favorites: load("FavoritesWidget"), folder: load("FolderWidget"), backlog: load("BacklogWidget"), brief: load("BriefWidget"),
  memory: load("MemoryWidget"), deals: load("DealsWidget"), activity: load("ActivityWidget"), views: load("ViewsWidget"),
  pinned: load("PinnedWidget"), quick: load("QuickWidget"), ask: load("AskWidget"), changes: load("ChangesWidget"),
};
const TeamMeetings = load("TeamMeetingsWidget");

/** What Home draws before its layout arrives the first time (the server's Default, same ids). */
const FALLBACK: Layout = {
  main: [{ id: "m0", type: "recent", settings: { count: 8 } }, { id: "m1", type: "meetings", settings: { count: 6 } }, { id: "m2", type: "workspaces", settings: {} }],
  side: [{ id: "s0", type: "needs_you", settings: { count: 4 } }, { id: "s1", type: "todos", settings: { count: 5 } }],
};

const ENUM_LABEL: Record<string, string> = {
  ...Object.fromEntries(CATEGORIES.map(([k, l]) => [k, l])), ...Object.fromEntries(STATUSES.map(([k, l]) => [k, l])),
  "7d": "Last 7 days", "30d": "Last 30 days",
};

export interface DashboardProps {
  userId: string;
  /** Customize mode (Home draws the Customize button in its header). */
  editing: boolean;
  onEditing: (on: boolean) => void;
  /** Home's own sections (GET /home, recent): returns undefined for a type it doesn't draw. */
  renderHome: (w: Widget, wide: boolean) => React.ReactNode | undefined;
}

export function Dashboard({ userId, renderHome, editing, onEditing: setEditing }: DashboardProps) {
  const toast = useToast();
  const [d, setD] = useState<Dash | null>(null);
  const [picker, setPicker] = useState<"main" | "side" | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | null>(null);
  const ws = d?.workspace?.id ?? null;
  // A look at the workspace: "What changed since I last looked" counts from its end (lib/people.ts).
  useEffect(() => { if (ws) markVisit(ws); }, [ws]);

  // The layout: this device's copy at once, then the server's.
  useEffect(() => {
    const want = savedWorkspace() || "auto";
    const cached = cachedDashboard(userId, want);
    if (cached) setD(cached);
    let on = true;
    const done = (x: Dash) => { if (!on) return; cacheDashboard(userId, x); setD((cur) => (cur && cur.catalog && !x.catalog ? { ...x, catalog: cur.catalog, presets: cur.presets } : x)); };
    getDashboard(want).then(done).catch((e) => {
      if (want !== "auto" && errorStatus(e) === 404) getDashboard("auto").then(done).catch(() => {});
    });
    return () => { on = false; };
  }, [userId]);

  const keepCatalog = useCallback((x: Dash) => setD((cur) => ({ ...x, catalog: x.catalog ?? cur?.catalog, presets: x.presets ?? cur?.presets })), []);

  /** Show the change now, save it a moment later (one request for quick clicks); the newest change wins. */
  const commit = useCallback((next: Layout) => {
    setD((cur) => (cur ? { ...cur, ...next, source: "mine" } : cur));
    const mine = ++seq.current;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saveDashboard(ws, next).then((x) => {
        if (mine !== seq.current) return;
        keepCatalog(x);
        cacheDashboard(userId, x);
      }).catch((e) => {
        toast.error(e instanceof Error ? e.message : "Couldn't save your Home. Try again.");
        getDashboard(ws).then(keepCatalog).catch(() => {});
      });
    }, 350);
  }, [ws, userId, keepCatalog, toast]);

  const replace = useCallback(async (what: string, run: () => Promise<Dash>, undoable = true) => {
    const before = d ? { main: d.main, side: d.side } : null;
    const wasMine = d?.source === "mine";
    try {
      const x = await run();
      seq.current++;
      keepCatalog(x);
      cacheDashboard(userId, x);
      track("home_action", { what: `customize_${what}` });
      toast.toast({
        message: what === "reset" ? "Home reset to default" : what === "default" ? "Members who haven't customized now see this Home" : "Template applied", kind: "success",
        ...(undoable && before ? { action: { label: "Undo", onClick: () => {
          void (wasMine ? saveDashboard(ws, before) : resetDashboard(ws)).then((y) => { keepCatalog(y); cacheDashboard(userId, y); }).catch(() => {});
        } } } : {}),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change your Home. Try again.");
    }
  }, [d, ws, userId, keepCatalog, toast]);

  const layout: Layout = d ? { main: d.main, side: d.side } : FALLBACK;
  const catalog = d?.catalog ?? [];
  const entry = (type: string) => catalog.find((c) => c.type === type);
  const editingWidget = settingsFor && d ? [...d.main, ...d.side].find((w) => w.id === settingsFor) ?? null : null;
  const sideEmpty = !layout.side.length && !editing;
  const mainEmpty = !layout.main.length && !editing;

  const draw = (w: Widget, col: "main" | "side") => {
    const wide = col === "main" && !sideEmpty;
    let body: React.ReactNode;
    if (w.available === false) {
      body = <Unavailable w={w} entry={entry(w.type)} onRemove={() => commit(remove(layout, w.id))} onSettings={w.setup ? () => setSettingsFor(w.id) : null} />;
    } else if (w.type === "meetings" && w.settings.team) {
      body = <TeamMeetings ws={ws} w={w} wide={wide} />;
    } else {
      const Own = OWN[w.type];
      body = Own ? <Own ws={ws} w={w} wide={wide} /> : renderHome(w, wide);
    }
    if (body === undefined || body === null) return null;
    const m = moves(layout, w.id);
    const label = entry(w.type)?.label ?? w.type;
    return (
      <div key={w.id} className={cx("db-slot", editing && "db-slot--edit")} data-widget={w.type} data-testid="home-widget">
        {editing && (
          <div className="db-ctl" role="toolbar" aria-label={`${label}: move, settings, remove`}>
            <span className="db-ctl__name"><Icon name={entry(w.type)?.icon ?? "grid"} size={14} /> {label}</span>
            <span className="db-ctl__btns">
              <IconButton icon="arrowUp" label={`Move ${label} up`} size="sm" disabled={!m.up} onClick={() => commit(move(layout, w.id, -1))} data-testid="home-w-up" />
              <IconButton icon="arrowDown" label={`Move ${label} down`} size="sm" disabled={!m.down} onClick={() => commit(move(layout, w.id, 1))} data-testid="home-w-down" />
              <Button size="sm" variant="ghost" iconLeft={m.across === "side" ? "arrowRight" : "arrowLeft"} className="db-ctl__across"
                onClick={() => commit(moveAcross(layout, w.id))} data-testid="home-w-across">
                {m.across === "side" ? "Move to side" : "Move to main"}
              </Button>
              {Object.keys(entry(w.type)?.settings ?? {}).length > 0 && (
                <IconButton icon="settings" label={`${label} settings`} size="sm" onClick={() => setSettingsFor(w.id)} data-testid="home-w-settings" />
              )}
              <IconButton icon="x" label={`Remove ${label}`} size="sm" onClick={() => commit(remove(layout, w.id))} data-testid="home-w-remove" />
            </span>
          </div>
        )}
        <div className="db-slot__body" inert={editing || undefined}>{body}</div>
      </div>
    );
  };

  const addBtn = (col: "main" | "side") => editing && (
    <button type="button" className="db-add md-focus" onClick={() => setPicker(col)} disabled={!d || count(layout) >= (d?.max ?? 16)} data-testid={`home-add-${col}`}>
      <Icon name="plus" size={16} /> Add widget{col === "side" ? " to the side" : ""}
    </button>
  );

  const presetItems: MenuEntry[] = [
    { header: "Start from a template" },
    ...(d?.presets ?? []).map((p) => ({ label: p.label, description: p.description, icon: "grid",
      onClick: () => void replace("preset", () => applyPreset(ws, p.id)) })),
  ];

  return (
    <div className={cx("db", editing && "db--edit")} data-testid="home-dashboard" data-source={d?.source ?? "loading"}>
      {editing ? (
        <div className="db-bar" role="region" aria-label="Customize your Home">
          <span className="db-bar__title">
            <Icon name="grid" size={16} /> Customize your Home
            {d?.workspace?.name && <span className="db-bar__ws ph-sensitive ph-mask">in {d.workspace.name}</span>}
          </span>
          <span className="db-bar__acts">
            <Dropdown portal align="right" minWidth={300} aria-label="Templates" items={presetItems}
              trigger={<Button size="sm" variant="secondary" iconRight="chevronDown" data-testid="home-templates">Templates</Button>} />
            <Button size="sm" variant="ghost" onClick={() => void replace("reset", () => resetDashboard(ws))} disabled={d?.source !== "mine"} data-testid="home-reset">Reset to default</Button>
            {d?.can_set_default && ws && (
              <Dropdown portal align="right" minWidth={260} aria-label="Workspace default" items={[
                { label: "Set as workspace default", description: "Members who haven't customized their Home see this one.", icon: "users",
                  onClick: () => void replace("default", () => setWorkspaceDefault(ws, layout), false) },
                ...(d.has_workspace_default ? [{ label: "Clear workspace default", icon: "x", onClick: () => void replace("clear", () => clearWorkspaceDefault(ws), false) }] : []),
              ]} trigger={<Button size="sm" variant="ghost" iconRight="chevronDown" data-testid="home-ws-default">Workspace default</Button>} />
            )}
            <Button size="sm" variant="primary" onClick={() => setEditing(false)} data-testid="home-customize-done">Done</Button>
          </span>
        </div>
      ) : null}

      <div className={cx("db-grid", (sideEmpty || mainEmpty) && "db-grid--one")}>
        {!mainEmpty && (
          <div className="db-stack db-stack--main" data-testid="home-col-main">
            {addBtn("main")}
            {layout.main.map((w) => draw(w, "main"))}
            {editing && !layout.main.length && <p className="db-empty">Nothing in the main column.</p>}
          </div>
        )}
        {!sideEmpty && (
          <div className="db-stack db-stack--side" data-testid="home-col-side">
            {addBtn("side")}
            {layout.side.map((w) => draw(w, "side"))}
            {editing && !layout.side.length && <p className="db-empty">Nothing on the side. Small cards fit well here.</p>}
          </div>
        )}
      </div>
      {!editing && !layout.main.length && !layout.side.length && d && (
        <div className="db-nothing">
          <p>Your Home has no widgets.</p>
          <Button size="sm" variant="secondary" iconLeft="grid" onClick={() => setEditing(true)}>Customize</Button>
        </div>
      )}

      <Picker open={!!picker} col={picker ?? "main"} catalog={catalog} layout={layout} max={d?.max ?? 16} onClose={() => setPicker(null)}
        onPick={(c) => {
          const next = add(layout, c, picker ?? "main", undefined, d?.max ?? 16);
          setPicker(null);
          if (!next) return;
          commit(next);
          track("home_action", { what: "add_widget", type: c.type });
          if (Object.values(c.settings).some((f) => f.required)) setSettingsFor(next[picker ?? "main"][0]!.id);
        }} />
      {editingWidget && (
        <SettingsDialog ws={ws} w={editingWidget} entry={entry(editingWidget.type)} onClose={() => setSettingsFor(null)}
          onSave={(s) => { commit(update(layout, editingWidget.id, s)); setSettingsFor(null); }} />
      )}
    </div>
  );
}

/* ── A widget that can't show: why, and Remove ── */

function Unavailable({ w, entry, onRemove, onSettings }: { w: Widget; entry?: CatalogEntry; onRemove: () => void; onSettings: (() => void) | null }) {
  return (
    <section className="th-card db-card db-na" data-testid="home-w-unavailable">
      <div className="th-ch"><h2><Icon name={entry?.icon ?? "grid"} size={16} /> <span className="truncate">{entry?.label ?? "Widget"}</span></h2></div>
      <p className="th-empty"><Icon name={onSettings ? "settings" : "lock"} size={14} /> {w.note || "Not available."}</p>
      <div className="db-na__acts">
        {onSettings && <Button size="sm" variant="secondary" onClick={onSettings}>Choose</Button>}
        <Button size="sm" variant="ghost" onClick={onRemove} data-testid="home-w-na-remove">Remove</Button>
      </div>
    </section>
  );
}

/* ── + Add widget ── */

function Picker({ open, col, catalog, layout, max, onClose, onPick }: {
  open: boolean; col: "main" | "side"; catalog: CatalogEntry[]; layout: Layout; max: number; onClose: () => void; onPick: (c: CatalogEntry) => void;
}) {
  const rows = pickable(catalog, layout, max);
  const full = count(layout) >= max;
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={col === "side" ? "Add a widget to the side" : "Add a widget"}
      description={full ? `Your Home has ${max} widgets, the most it can hold. Remove one to add another.` : "It goes at the top of the column. Move it from there."}>
      <ul className="db-cat" data-testid="home-picker">
        {rows.map((c) => (
          <li key={c.type}>
            <button type="button" className="db-cat__item md-focus" disabled={c.disabled} onClick={() => onPick(c)} data-testid={`home-pick-${c.type}`}>
              <span className="db-cat__ico" aria-hidden><Icon name={c.icon} size={18} /></span>
              <span className="db-cat__text">
                <span className="db-cat__name">{c.label}{!c.available && <span className="db-cat__na"> · not available here</span>}</span>
                <span className="db-cat__desc">{c.description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/* ── Settings ── */

function SettingsDialog({ ws, w, entry, onClose, onSave }: {
  ws: string | null; w: Widget; entry?: CatalogEntry; onClose: () => void; onSave: (s: Record<string, string | number | null>) => void;
}) {
  const fields = Object.entries(entry?.settings ?? {});
  const [vals, setVals] = useState<Record<string, string | number | null>>(() => ({ ...(w.settings as Record<string, string | number | null>) }));
  const missing = fields.find(([k, f]) => f.required && !vals[k]);
  return (
    <Dialog open onClose={onClose} size="md" title={`${entry?.label ?? "Widget"} settings`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!!missing} onClick={() => onSave(vals)} data-testid="home-settings-save">Save</Button></>}>
      <div className="db-fields" data-testid="home-settings">
        {fields.map(([key, f]) => (
          <SettingInput key={key} ws={ws} type={w.type} field={f} value={vals[key] ?? null} onChange={(v) => setVals((s) => ({ ...s, [key]: v }))} title={w.title} />
        ))}
      </div>
    </Dialog>
  );
}

function SettingInput({ ws, type, field: f, value, onChange, title }: {
  ws: string | null; type: string; field: SettingField; value: string | number | null; onChange: (v: string | number | null) => void; title?: string;
}) {
  useTeamsSidebar(ws && f.kind === "team" ? [ws] : []);
  const tree = useWorkspaceTree(ws && f.kind === "folder" ? ws : null).tree;
  if (f.kind === "count") {
    const opts = Array.from({ length: (f.max ?? 12) - (f.min ?? 3) + 1 }, (_, i) => String((f.min ?? 3) + i));
    return (
      <Field label={f.label}>
        <Select value={String(value ?? f.default ?? "")} onChange={(e) => onChange(Number(e.target.value))} options={opts.map((o) => ({ value: o, label: o }))} />
      </Field>
    );
  }
  if (f.kind === "enum") {
    const opts = [...(f.default == null ? [{ value: "", label: f.empty ?? "Any" }] : []), ...(f.options ?? []).map((o) => ({ value: o, label: ENUM_LABEL[o] ?? o }))];
    return <Field label={f.label}><Select value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)} options={opts} data-testid={`home-set-${f.label.toLowerCase()}`} /></Field>;
  }
  if (f.kind === "team") {
    const slot = ws ? teamsSlot(ws) : null;
    const teams = (slot ? slot.teams : []).filter((t) => t.can_read && !(type === "backlog" && t.general));
    const opts = [{ value: "", label: f.required ? "Choose a team…" : f.empty ?? "All teams" }, ...teams.map((t) => ({ value: t.id, label: t.name }))];
    return <Field label={f.label}><Select value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)} options={opts} data-testid="home-set-team" /></Field>;
  }
  if (f.kind === "folder") {
    const folders = [...(tree?.folders ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    const opts = [{ value: "", label: tree ? "Choose a folder…" : "Loading folders…" }, ...folders.map((x) => ({ value: x.id, label: `${" ".repeat(x.depth)}${x.name}` }))];
    return <Field label={f.label}><Select value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)} options={opts} data-testid="home-set-folder" /></Field>;
  }
  return <PagePicker value={typeof value === "string" ? value : null} title={title} onChange={onChange} />;
}

function PagePicker({ value, title, onChange }: { value: string | null; title?: string; onChange: (v: string | null) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<QuickFile[] | null>(null);
  const [picked, setPicked] = useState<{ slug: string; title: string } | null>(value ? { slug: value, title: title || value } : null);
  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return; }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      quickSearch(q.trim(), 8, ctl.signal).then((r) => setHits(r.files.filter((f) => f.kind === "markdown" && !f.encrypted))).catch(() => {});
    }, 200);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [q]);
  const list = useMemo(() => hits ?? [], [hits]);
  return (
    <div className="db-pagepick">
      {picked && (
        <p className="db-pagepick__now"><Icon name="doc" size={14} /> <span className="truncate ph-sensitive" dir="auto">{picked.title}</span></p>
      )}
      <Field label={picked ? "Pick another page" : "Page"}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your pages…" data-testid="home-set-page" />
      </Field>
      {list.length > 0 && (
        <ul className="db-pagepick__list">
          {list.map((f) => (
            <li key={f.slug}>
              <button type="button" className={cx("db-pagepick__hit md-focus", picked?.slug === f.slug && "is-on")}
                onClick={() => { setPicked({ slug: f.slug, title: f.title || f.slug }); onChange(f.slug); }}>
                <Icon name={f.editor === "blocks" ? "doc" : "lines"} size={14} />
                <span className="truncate ph-sensitive" dir="auto">{f.title || f.slug}</span>
                {f.workspace?.name && <span className="db-pagepick__where ph-sensitive ph-mask">{f.workspace.name}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {hits && !list.length && <p className="th-empty">No pages match.</p>}
    </div>
  );
}
