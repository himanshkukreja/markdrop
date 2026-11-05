"use client";

/**
 * A workspace folder as a database (services/page_db.py): its pages as a table or a board, with
 * the folder's typed properties as columns. The folder view (FolderView) shows the views bar
 * always; "List" is its own list, any other tab renders here.
 *
 *   Table   sticky header and title column, resizable columns, sort / filter / group, every cell
 *           editable in place by people who can edit that page, "+ New page" at the end.
 *   Board   one column per option of a Select (then "No <name>"); drag a card to another column
 *           and the page's value changes (optimistic, put back if the server refuses).
 *
 * Saved views (up to 20) belong to the folder: members and admins add, rename and change them
 * (saved as they change); viewers can still sort and filter for themselves. With no saved views,
 * "Table" and "Board" are offered as they are. Rows are what the caller can read: the server never
 * sends another page (and never a locked page's title in a link).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCorners, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { Button, Icon, Skeleton, cx, useToast } from "@/components/ui";
import { createPage } from "@/lib/pages";
import { workspaceChanged, useWorkspaceChanged } from "@/lib/workspaceStore";
import { PropsApiError, getFolderDatabase, patchPageProperties, putFolderProperties, putFolderViews, replayViews, type FolderDatabase as Db, type LinkInfo } from "./api";
import {
  OP_LABELS, TYPE_LABELS, applyView, findProp, groupRows, newViewId, opsFor, optionColor,
  type DbRow, type FilterOp, type Person, type PropDef, type PropValue, type SavedView,
} from "./model.mjs";
import { Pop } from "./Pop";
import { AddProperty, PropertyMenu } from "./SchemaMenus";
import { OptionChip, PropsCtx, TYPE_ICONS, ValueEditor, ValueView, isEmptyValue, type PropsContext } from "./Values";
import "./props.css";

// The column under the pointer; else the nearest (a keyboard drag, or a drop between columns).
const columnCollision: CollisionDetection = (args) => {
  const hit = pointerWithin(args);
  return hit.length ? hit : closestCorners(args);
};

const blankView = (type: "table" | "board", schema: PropDef[], id: string = type): SavedView => ({
  id, name: type === "table" ? "Table" : "Board", type, sort: [], filter: [],
  group: type === "board" ? schema.find((p) => p.type === "select")?.key ?? null : null, hidden: [], widths: {}, order: [],
});

/** The tabs bar alone (for the List view, which FolderView draws itself). */
export interface FolderDatabaseProps {
  workspaceId: string;
  folderId: string;
  /** "table" | "board" | a saved view's id; null = List. */
  view: string | null;
  onView: (v: string | null) => void;
  /** Workspace member or admin: may change the schema, save views, add pages. */
  member: boolean;
  phone?: boolean;
}

export function FolderDatabase({ workspaceId, folderId, view, onView, member, phone }: FolderDatabaseProps) {
  const toast = useToast();
  const [db, setDb] = useState<Db | null>(null);
  const [error, setError] = useState("");
  const [people, setPeople] = useState<Record<string, Person>>({});
  const [links, setLinks] = useState<Record<string, LinkInfo>>({});
  const seq = useRef(0);
  // Only when a table or board is open (the List view needs the views, not the rows).
  const open = view !== null;
  const [hasRows, setHasRows] = useState(false);
  const load = useCallback(async (quiet = false) => {
    const id = ++seq.current;
    if (!quiet) setError("");
    try {
      const r = await getFolderDatabase(workspaceId, folderId, { rows: open });
      if (id !== seq.current) return;
      setHasRows(open);
      setDb(r);
      setPeople((p) => ({ ...p, ...r.people }));
      setLinks((l) => ({ ...l, ...r.links }));
    } catch (e) {
      if (id === seq.current && !quiet) setError(e instanceof Error ? e.message : "Couldn't load this folder's pages");
    }
  }, [workspaceId, folderId, open]);
  useEffect(() => { if ((open && !hasRows) || !db) void load(); }, [load, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useWorkspaceChanged(workspaceId, useCallback(() => { if (open) void load(true); }, [open, load]));

  const schema = useMemo(() => db?.properties ?? [], [db]);
  const saved = useMemo(() => db?.views ?? [], [db]);
  const canSchema = member && !!db?.can_edit_schema;
  const tabs: SavedView[] = saved.length ? saved : [blankView("table", schema), blankView("board", schema)];
  const current = view ? tabs.find((t) => t.id === view) ?? (view === "table" || view === "board" ? blankView(view, schema) : null) : null;
  // Changes to a view: saved for members (a saved view), kept here otherwise.
  const [drafts, setDrafts] = useState<Record<string, SavedView>>({});
  const live = current ? drafts[current.id] ?? current : null;
  const isSaved = !!current && saved.some((v) => v.id === current.id);
  const dirty = !!live && !isSaved && JSON.stringify(live) !== JSON.stringify(current);
  const saveTimer = useRef<number | null>(null);

  // Saved against the rev they were read at; when someone else changed the views meanwhile, this
  // change is replayed onto theirs (by view) instead of saving over them.
  const persistViews = useCallback(async (views: SavedView[]) => {
    try {
      let r;
      try {
        r = await putFolderViews(workspaceId, folderId, views, db?.rev);
      } catch (e) {
        if (!(e instanceof PropsApiError && e.status === 409)) throw e;
        const fresh = await getFolderDatabase(workspaceId, folderId, { rows: false });
        r = await putFolderViews(workspaceId, folderId, replayViews(saved, views, fresh.views ?? []), fresh.rev);
        setDb((d) => (d ? { ...d, properties: r!.properties } : d));
      }
      setDb((d) => (d ? { ...d, views: r.views, rev: r.rev } : d));
      return r.views;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the view");
      return null;
    }
  }, [workspaceId, folderId, toast, db?.rev, saved]);

  const changeView = (patch: Partial<SavedView>) => {
    if (!live) return;
    const next = { ...live, ...patch };
    setDrafts((d) => ({ ...d, [next.id]: next }));
    if (isSaved && member) {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void persistViews(saved.map((v) => (v.id === next.id ? next : v)));
      }, 600);
    }
  };

  const saveSchema = useCallback(async (next: PropDef[]) => {
    const r = await putFolderProperties(workspaceId, folderId, next, db?.rev);
    setDb((d) => (d ? { ...d, properties: r.properties, views: r.views, rev: r.rev } : d));
    setDrafts({});
    return r.properties;
  }, [workspaceId, folderId, db?.rev]);

  const ctx: PropsContext = useMemo(() => ({
    workspaceId, people, links, canEditSchema: canSchema,
    remember: (p, l) => { if (Object.keys(p).length) setPeople((x) => ({ ...x, ...p })); if (Object.keys(l).length) setLinks((x) => ({ ...x, ...l })); },
    addOption: async (prop, name) => {
      const opts = prop.options ?? [];
      const s = await saveSchema(schema.map((p) => (p.key === prop.key ? { ...p, options: [...opts, { name, color: (["blue", "green", "orange", "purple", "pink", "yellow", "red", "brown", "gray"] as const)[opts.length % 9] }] } : p)));
      return s.find((p) => p.key === prop.key) ?? null;
    },
    pageHref: (s) => `/${encodeURIComponent(s)}`,
  }), [workspaceId, people, links, canSchema, saveSchema, schema]);

  /* values: optimistic, through the page's own save path */
  const setValue = useCallback(async (row: DbRow, key: string, v: PropValue | null) => {
    const before = row.values;
    const optimistic = { ...row.values };
    if (v === null) delete optimistic[key];
    else optimistic[key] = v;
    setDb((d) => (d ? { ...d, rows: d.rows.map((r) => (r.slug === row.slug ? { ...r, values: optimistic } : r)) } : d));
    try {
      const r = await patchPageProperties(row.slug, { [key]: v });
      setDb((d) => (d ? { ...d, rows: d.rows.map((x) => (x.slug === row.slug ? { ...x, values: r.values, rev: r.rev } : x)) } : d));
      if (r.page_properties) {
        setPeople((p) => ({ ...p, ...r.page_properties!.people }));
        setLinks((l) => ({ ...l, ...r.page_properties!.links }));
      }
    } catch (e) {
      setDb((d) => (d ? { ...d, rows: d.rows.map((x) => (x.slug === row.slug ? { ...x, values: before } : x)) } : d));
      toast.error(e instanceof Error ? e.message : "Couldn't change it");
    }
  }, [toast]);

  const newPage = useCallback(async (title: string, preset: Record<string, PropValue>) => {
    try {
      const r = await createPage({ title: title.trim() || "Untitled", workspace: workspaceId, folder: folderId });
      const slug = r.document.slug;
      if (Object.keys(preset).length) await patchPageProperties(slug, preset).catch(() => null);
      await load(true);
      workspaceChanged(workspaceId);
      return slug;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create the page");
      return null;
    }
  }, [workspaceId, folderId, load, toast]);

  /* tabs */
  const [addViewOpen, setAddViewOpen] = useState(false);
  const addViewRef = useRef<HTMLButtonElement>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; el: HTMLElement } | null>(null);
  const addView = async (type: "table" | "board") => {
    const base = blankView(type, schema, newViewId());
    const g = schema.find((p) => p.key === base.group);
    if (type === "board" && g) base.name = `By ${g.name}`;
    const views = await persistViews([...saved, base]);
    if (views) onView(base.id);
  };
  const saveDraft = async () => {
    if (!live) return;
    const v = { ...live, id: newViewId() };
    const views = await persistViews([...saved.length ? saved : [], v]);
    if (views) { setDrafts({}); onView(v.id); toast.success(`Saved “${v.name}”`); }
  };

  const rows = useMemo(() => (db && live ? applyView(db.rows, live, schema, people) : []), [db, live, schema, people]);
  // A link to a view that was deleted (or never existed): back to the list.
  useEffect(() => { if (db && view && !current) onView(null); }, [db, view, current, onView]);

  return (
    <PropsCtx.Provider value={ctx}>
      <div className="pp-db pp-scope">
        <div className="pp-bar">
          <div className="pp-tabs" role="tablist" aria-label="Views">
            <button type="button" role="tab" className="pp-tab" aria-selected={view === null} onClick={() => onView(null)}>
              <Icon name="list" size={15} />List
            </button>
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="pp-tab"
                aria-selected={view === t.id}
                onClick={(e) => (view === t.id && member && saved.some((v) => v.id === t.id) ? setTabMenu({ id: t.id, el: e.currentTarget }) : onView(t.id))}
                title={view === t.id && member && saved.some((v) => v.id === t.id) ? "Rename, duplicate or delete this view" : undefined}
              >
                <Icon name={t.type === "board" ? "columns" : "table"} size={15} />
                <span className="ph-sensitive">{t.name}</span>
                {view === t.id && member && saved.some((v) => v.id === t.id) && <Icon name="chevronDown" size={12} />}
              </button>
            ))}
            {member && db && saved.length < 20 && (
              <button ref={addViewRef} type="button" className="pp-tab" aria-label="Add a view" aria-haspopup="dialog" aria-expanded={addViewOpen} onClick={() => setAddViewOpen(true)}>
                <Icon name="plus" size={15} />
              </button>
            )}
          </div>
          {live && db && <Toolbar view={live} schema={schema} phone={phone} onChange={changeView} people={people} />}
        </div>
        {addViewOpen && (
          <Pop anchor={addViewRef.current} onClose={() => setAddViewOpen(false)} title="Add a view" width={240}>
            <div className="pp-pop__body">
              {(["table", "board"] as const).map((t) => (
                <button key={t} type="button" className="pp-opt" disabled={t === "board" && !schema.some((p) => p.type === "select")} onClick={() => { setAddViewOpen(false); void addView(t); }}>
                  <Icon name={t === "board" ? "columns" : "table"} size={15} />
                  {t === "table" ? "Table" : "Board"}
                  {t === "board" && !schema.some((p) => p.type === "select") && <span className="pp-opt__trail" style={{ fontSize: 12 }}>needs a Select</span>}
                </button>
              ))}
            </div>
          </Pop>
        )}
        {tabMenu && (
          <ViewMenu view={saved.find((v) => v.id === tabMenu.id)!} anchor={tabMenu.el} onClose={() => setTabMenu(null)}
            onRename={(name) => void persistViews(saved.map((v) => (v.id === tabMenu.id ? { ...v, name } : v)))}
            onDuplicate={async () => { const v = { ...saved.find((x) => x.id === tabMenu.id)!, id: newViewId() }; v.name = `${v.name} copy`; const r = await persistViews([...saved, v]); if (r) onView(v.id); }}
            onDelete={async () => { const r = await persistViews(saved.filter((v) => v.id !== tabMenu.id)); if (r) onView(null); }} />
        )}

        {live && (live.filter.length + live.sort.length > 0 || (dirty && member)) && (
          <RuleChips view={live} schema={schema} onChange={changeView} trailing={dirty && member ? <Button size="sm" variant="secondary" className="pp-save" onClick={() => void saveDraft()}>Save view</Button> : null} />
        )}

        {live && error && (
          <div className="pp-db-empty"><strong>Couldn&apos;t load the pages</strong><span>{error}</span><Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Try again</Button></div>
        )}
        {live && (!db || !hasRows) && !error && <div className="flex flex-col gap-2" aria-label="Loading">{[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rect" height={36} />)}</div>}
        {live && db && hasRows && live.type === "table" && (
          <TableView rows={rows} schema={schema} view={live} onView={changeView} canSchema={canSchema} member={member} phone={phone}
            onValue={setValue} onNew={newPage} saveSchema={saveSchema} people={people} />
        )}
        {live && db && hasRows && live.type === "board" && (
          <BoardView rows={rows} schema={schema} view={live} canSchema={canSchema} member={member}
            onValue={setValue} onNew={newPage} saveSchema={saveSchema} people={people} />
        )}
        {live && db && hasRows && (
          <div className="pp-foot">
            <span>{rows.length === db.rows.length ? `${db.rows.length} page${db.rows.length === 1 ? "" : "s"}` : `${rows.length} of ${db.rows.length} pages`}{db.truncated ? " · showing the newest 500" : ""}</span>
            <span>Only pages you can open are listed.</span>
          </div>
        )}
      </div>
    </PropsCtx.Provider>
  );
}

/* ── toolbar: filter, sort, group, properties ─────────────────────────── */

function Toolbar({ view, schema, phone, onChange, people }: { view: SavedView; schema: PropDef[]; phone?: boolean; onChange: (p: Partial<SavedView>) => void; people: Record<string, Person> }) {
  const [open, setOpen] = useState<null | "filter" | "sort" | "group" | "props">(null);
  const refs = { filter: useRef<HTMLButtonElement>(null), sort: useRef<HTMLButtonElement>(null), group: useRef<HTMLButtonElement>(null), props: useRef<HTMLButtonElement>(null) };
  const tool = (k: "filter" | "sort" | "group" | "props", icon: string, label: string, on: boolean) => (
    <button ref={refs[k]} type="button" className={cx("pp-tool", on && "pp-tool--on")} aria-haspopup="dialog" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)} aria-label={label}>
      <Icon name={icon} size={15} /><span className="pp-tool__label">{label}</span>
    </button>
  );
  const groupable = schema.filter((p) => ["select", "multi_select", "person", "checkbox", "date"].includes(p.type));
  return (
    <div className="pp-tools">
      {tool("filter", "filter", "Filter", view.filter.length > 0)}
      {tool("sort", "sort", "Sort", view.sort.length > 0)}
      {view.type === "table" && groupable.length > 0 && tool("group", "layers", "Group", !!view.group)}
      {!phone && tool("props", "eye", "Properties", view.hidden.length > 0)}
      {open === "filter" && (
        <Pop anchor={refs.filter.current} onClose={() => setOpen(null)} title="Filter" width={380} align="end">
          <FilterEditor view={view} schema={schema} onChange={onChange} people={people} />
        </Pop>
      )}
      {open === "sort" && (
        <Pop anchor={refs.sort.current} onClose={() => setOpen(null)} title="Sort" width={340} align="end">
          <SortEditor view={view} schema={schema} onChange={onChange} />
        </Pop>
      )}
      {open === "group" && (
        <Pop anchor={refs.group.current} onClose={() => setOpen(null)} title="Group by" width={240} align="end">
          <div className="pp-pop__body">
            <button type="button" className="pp-opt" onClick={() => { onChange({ group: null }); setOpen(null); }}>None{!view.group && <span className="pp-opt__trail"><Icon name="check" size={14} /></span>}</button>
            {groupable.map((p) => (
              <button key={p.key} type="button" className="pp-opt" onClick={() => { onChange({ group: p.key }); setOpen(null); }}>
                <Icon name={TYPE_ICONS[p.type]!} size={15} className="text-text-muted" />{p.name}
                {view.group === p.key && <span className="pp-opt__trail"><Icon name="check" size={14} /></span>}
              </button>
            ))}
          </div>
        </Pop>
      )}
      {open === "props" && (
        <Pop anchor={refs.props.current} onClose={() => setOpen(null)} title="Properties" width={260} align="end">
          <div className="pp-pop__body">
            <div className="pp-label">Shown in this view</div>
            {schema.map((p) => {
              const shown = !view.hidden.includes(p.key);
              return (
                <button key={p.key} type="button" className="pp-opt" aria-pressed={shown} onClick={() => onChange({ hidden: shown ? [...view.hidden, p.key] : view.hidden.filter((k) => k !== p.key) })}>
                  <Icon name={TYPE_ICONS[p.type]!} size={15} className="text-text-muted" />{p.name}
                  <span className="pp-opt__trail"><Icon name={shown ? "eye" : "eyeOff"} size={15} /></span>
                </button>
              );
            })}
            {!schema.length && <div className="pp-pop__hint">This folder has no properties yet.</div>}
          </div>
        </Pop>
      )}
    </div>
  );
}

const propLabel = (schema: PropDef[], key: string) => (key === "title" ? "Title" : key === "updated_at" ? "Last edited" : key === "created_at" ? "Created" : findProp(schema, key)?.name ?? key);

function RuleChips({ view, schema, onChange, trailing }: { view: SavedView; schema: PropDef[]; onChange: (p: Partial<SavedView>) => void; trailing?: React.ReactNode }) {
  return (
    <div className="pp-rules">
      {view.sort.map((s, i) => (
        <button key={`s${i}`} type="button" className="pp-rule" onClick={() => onChange({ sort: view.sort.filter((_, j) => j !== i) })} aria-label={`Remove sort by ${propLabel(schema, s.key)}`}>
          <Icon name={s.dir === "desc" ? "arrowDown" : "arrowUp"} size={13} /><span>{propLabel(schema, s.key)}</span><Icon name="x" size={12} />
        </button>
      ))}
      {view.filter.map((f, i) => {
        const p = findProp(schema, f.key);
        const v = f.op === "is_empty" || f.op === "is_not_empty" ? "" : p?.type === "date" && typeof f.value === "string" ? ` ${f.value}` : f.value === null || f.value === undefined || f.value === "" ? "…" : ` ${String(f.value)}`;
        return (
          <button key={`f${i}`} type="button" className="pp-rule" onClick={() => onChange({ filter: view.filter.filter((_, j) => j !== i) })} aria-label={`Remove the filter on ${propLabel(schema, f.key)}`}>
            <Icon name="filter" size={13} /><span className="ph-sensitive">{propLabel(schema, f.key)} {OP_LABELS[f.op]}{v}</span><Icon name="x" size={12} />
          </button>
        );
      })}
      {trailing}
    </div>
  );
}

function SortEditor({ view, schema, onChange }: { view: SavedView; schema: PropDef[]; onChange: (p: Partial<SavedView>) => void }) {
  const keys = [{ key: "title", name: "Title" }, ...schema.filter((p) => p.type !== "link").map((p) => ({ key: p.key, name: p.name })), { key: "updated_at", name: "Last edited" }, { key: "created_at", name: "Created" }];
  const set = (sort: SavedView["sort"]) => onChange({ sort });
  return (
    <div className="pp-pop__body" style={{ padding: 8 }}>
      {view.sort.map((s, i) => (
        <div key={i} className="flex items-center gap-2 py-1">
          <select className="pp-input" style={{ flex: 1 }} value={s.key} aria-label="Sort by" onChange={(e) => set(view.sort.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}>
            {keys.map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}
          </select>
          <select className="pp-input" style={{ width: 120 }} value={s.dir} aria-label="Direction" onChange={(e) => set(view.sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button type="button" className="pp-chip__x" aria-label="Remove this sort" onClick={() => set(view.sort.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
        </div>
      ))}
      {view.sort.length < 5 && (
        <button type="button" className="pp-opt" onClick={() => set([...view.sort, { key: keys.find((k) => !view.sort.some((s) => s.key === k.key))?.key ?? "title", dir: "asc" }])}>
          <Icon name="plus" size={15} /> Add a sort
        </button>
      )}
    </div>
  );
}

function FilterEditor({ view, schema, onChange, people }: { view: SavedView; schema: PropDef[]; onChange: (p: Partial<SavedView>) => void; people: Record<string, Person> }) {
  const keys = [{ key: "title", name: "Title", type: "text" as const }, ...schema.map((p) => ({ key: p.key, name: p.name, type: p.type }))];
  const set = (filter: SavedView["filter"]) => onChange({ filter });
  return (
    <div className="pp-pop__body" style={{ padding: 8 }}>
      {view.filter.map((f, i) => {
        const p = findProp(schema, f.key);
        const type = p?.type ?? "text";
        const ops = opsFor(type);
        const upd = (patch: Partial<SavedView["filter"][number]>) => set(view.filter.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        const needsValue = f.op !== "is_empty" && f.op !== "is_not_empty";
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 py-1">
            <select className="pp-input" style={{ flex: "1 1 110px", width: "auto" }} value={f.key} aria-label="Property" onChange={(e) => {
              const np = findProp(schema, e.target.value);
              upd({ key: e.target.value, op: opsFor(np?.type ?? "text")[0]!, value: np?.type === "checkbox" ? true : null });
            }}>
              {keys.map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}
            </select>
            <select className="pp-input" style={{ flex: "0 1 130px", width: "auto" }} value={f.op} aria-label="Condition" onChange={(e) => upd({ op: e.target.value as FilterOp })}>
              {ops.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
            </select>
            {needsValue && (
              type === "select" || type === "multi_select" ? (
                <select className="pp-input" style={{ flex: "1 1 120px", width: "auto" }} value={String(f.value ?? "")} aria-label="Value" onChange={(e) => upd({ value: e.target.value || null })}>
                  <option value="">Choose…</option>
                  {(p?.options ?? []).map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                </select>
              ) : type === "person" ? (
                <select className="pp-input ph-sensitive" style={{ flex: "1 1 120px", width: "auto" }} value={String(f.value ?? "")} aria-label="Person" onChange={(e) => upd({ value: e.target.value || null })}>
                  <option value="">Choose…</option>
                  {Object.entries(people).map(([id, pp]) => <option key={id} value={id}>{pp.name}</option>)}
                </select>
              ) : type === "checkbox" ? (
                <select className="pp-input" style={{ flex: "1 1 110px", width: "auto" }} value={String(f.value === true)} aria-label="Value" onChange={(e) => upd({ value: e.target.value === "true" })}>
                  <option value="true">Checked</option>
                  <option value="false">Not checked</option>
                </select>
              ) : (
                <input className="pp-input" style={{ flex: "1 1 120px", width: "auto" }} type={type === "date" ? "date" : type === "number" ? "number" : "text"} value={f.value === null || f.value === undefined ? "" : String(f.value)} aria-label="Value"
                  onChange={(e) => upd({ value: type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value })} placeholder="Value" />
              )
            )}
            <button type="button" className="pp-chip__x" aria-label="Remove this filter" onClick={() => set(view.filter.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
          </div>
        );
      })}
      {view.filter.length < 10 && (
        <button type="button" className="pp-opt" onClick={() => {
          const p = schema[0];
          set([...view.filter, p ? { key: p.key, op: opsFor(p.type)[0]!, value: p.type === "checkbox" ? true : null } : { key: "title", op: "contains", value: "" }]);
        }}>
          <Icon name="plus" size={15} /> Add a filter
        </button>
      )}
    </div>
  );
}

function ViewMenu({ view, anchor, onClose, onRename, onDuplicate, onDelete }: { view: SavedView; anchor: HTMLElement; onClose: () => void; onRename: (n: string) => void; onDuplicate: () => void; onDelete: () => void }) {
  const [name, setName] = useState(view.name);
  const commit = () => { const n = name.trim(); if (n && n !== view.name) onRename(n.slice(0, 60)); };
  return (
    <Pop anchor={anchor} onClose={() => { commit(); onClose(); }} title="View" width={240}>
      <div className="pp-field"><input value={name} onChange={(e) => setName(e.target.value)} aria-label="View name" maxLength={60} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); onClose(); } }} /></div>
      <div className="pp-pop__body">
        <button type="button" className="pp-opt" onClick={() => { onDuplicate(); onClose(); }}><Icon name="copy" size={15} /> Duplicate</button>
        <button type="button" className="pp-opt pp-opt--danger" onClick={() => { onDelete(); onClose(); }}><Icon name="trash" size={15} /> Delete view</button>
      </div>
    </Pop>
  );
}

/* ── cells ────────────────────────────────────────────────────────────── */

function TitleCell({ row }: { row: DbRow }) {
  return (
    <div className="pp-title">
      <span className="pp-title__icon" aria-hidden>
        {row.icon && !/^(asset:|https?:)/.test(row.icon) ? row.icon : row.icon_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.icon_url} alt="" />
        ) : <Icon name="doc" size={16} />}
      </span>
      <a href={`/${encodeURIComponent(row.slug)}`} className="ph-sensitive" dir="auto">{row.title}</a>
    </div>
  );
}

function Cell({ row, prop, onValue }: { row: DbRow; prop: PropDef; onValue: (row: DbRow, key: string, v: PropValue | null) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const v = row.values[prop.key];
  if (!row.can_edit) return <div className="pp-td"><ValueView prop={prop} value={v} compact placeholder={null} /></div>;
  if (prop.type === "checkbox") {
    return (
      <div className="pp-td">
        <button type="button" className={cx("pp-check", v === true && "pp-check--on")} role="checkbox" aria-checked={v === true} aria-label={`${prop.name} of ${row.title}`} onClick={() => onValue(row, prop.key, v === true ? null : true)}>
          <Icon name="check" size={11} />
        </button>
      </div>
    );
  }
  return (
    <>
      <button ref={ref} type="button" className="pp-td" aria-haspopup="dialog" aria-expanded={open} aria-label={`${prop.name} of ${row.title}`} onClick={() => setOpen(true)}>
        <ValueView prop={prop} value={v} compact placeholder={null} />
      </button>
      {open && (
        <Pop anchor={ref.current} onClose={() => setOpen(false)} title={prop.name} width={prop.type === "date" ? 288 : 320} matchWidth>
          <ValueEditor prop={prop} value={v} onChange={(nv) => onValue(row, prop.key, nv)} onClose={() => setOpen(false)} />
        </Pop>
      )}
    </>
  );
}

interface ViewProps {
  rows: DbRow[];
  schema: PropDef[];
  view: SavedView;
  canSchema: boolean;
  member: boolean;
  people: Record<string, Person>;
  onValue: (row: DbRow, key: string, v: PropValue | null) => void;
  onNew: (title: string, preset: Record<string, PropValue>) => Promise<string | null>;
  saveSchema: (next: PropDef[]) => Promise<PropDef[]>;
}

/** Values a new page made in a group (or under "is" filters) starts with. */
function presetFor(view: SavedView, schema: PropDef[], group?: { value: PropValue | null } | null): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const f of view.filter) {
    const p = findProp(schema, f.key);
    if (!p || f.value === null || f.value === undefined || f.value === "") continue;
    if (f.op === "is" && ["select", "person", "text", "date", "number", "checkbox"].includes(p.type)) out[p.key] = f.value as PropValue;
    if (f.op === "contains" && p.type === "multi_select") out[p.key] = [String(f.value)];
  }
  const gp = view.group ? findProp(schema, view.group) : null;
  if (gp && group && group.value !== null) out[gp.key] = gp.type === "multi_select" ? [String(group.value)] : group.value;
  return out;
}

function NewRow({ onCreate, colSpan, label = "New page" }: { onCreate: (title: string) => Promise<unknown>; colSpan?: number; label?: string }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const body = editing ? (
    <input autoFocus className="pp-newinput" value={title} placeholder="Page title, then Enter" aria-label="New page title" maxLength={200} disabled={busy}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => { if (!title.trim() && !busy) setEditing(false); }}
      onKeyDown={async (e) => {
        if (e.key === "Escape") { setEditing(false); setTitle(""); }
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        e.preventDefault();
        setBusy(true);
        await onCreate(title);
        setBusy(false);
        setTitle("");
      }} />
  ) : (
    <button type="button" className="pp-newbtn" onClick={() => setEditing(true)}><Icon name="plus" size={15} /> {label}</button>
  );
  return colSpan ? <tr className="pp-newrow"><td colSpan={colSpan}>{body}</td></tr> : body;
}

/* ── table ────────────────────────────────────────────────────────────── */

function TableView({ rows, schema, view, onView, canSchema, member, phone, people, onValue, onNew, saveSchema }: ViewProps & { onView: (p: Partial<SavedView>) => void; phone?: boolean }) {
  const cols = useMemo(() => {
    const order = view.order.filter((k) => schema.some((p) => p.key === k));
    const rest = schema.filter((p) => !order.includes(p.key)).map((p) => p.key);
    return [...order, ...rest].map((k) => schema.find((p) => p.key === k)!).filter((p) => p && !view.hidden.includes(p.key));
  }, [schema, view.order, view.hidden]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ prop: PropDef; el: HTMLElement } | null>(null);
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const titleW = view.widths.title ?? (phone ? 200 : 280);
  const width = (p: PropDef) => view.widths[p.key] ?? (p.type === "checkbox" ? 110 : p.type === "date" || p.type === "number" ? 150 : p.type === "link" || p.type === "multi_select" ? 220 : 180);
  const groups = view.group ? groupRows(rows, view.group, schema, people) : null;
  const span = cols.length + 1 + (canSchema ? 1 : 0);

  // Column resize: the handle follows the pointer (no React render per move); written once on release.
  const startResize = (key: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest("th") as HTMLElement | null;
    const col = th ? th.closest("table")?.querySelector<HTMLElement>(`col[data-k="${key}"]`) : null;
    if (!th || !col) return;
    const start = e.clientX;
    const from = th.getBoundingClientRect().width;
    let w = from;
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("pp-resize--on");
    const move = (ev: PointerEvent) => {
      w = Math.max(80, Math.min(800, from + ev.clientX - start));
      col.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      handle.classList.remove("pp-resize--on");
      onView({ widths: { ...view.widths, [key]: Math.round(w) } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const sortOf = (k: string) => view.sort.find((s) => s.key === k);
  const header = (
    <thead>
      <tr>
        <th className="pp-col--title">
          <div className="pp-th" style={{ cursor: "default" }}><Icon name="type" size={14} /><span>Title</span>
            {sortOf("title") && <Icon name={sortOf("title")!.dir === "desc" ? "arrowDown" : "arrowUp"} size={13} className="pp-th__sort" />}
          </div>
          {!phone && <span className="pp-resize" onPointerDown={(e) => startResize("title", e)} aria-hidden />}
        </th>
        {cols.map((p) => (
          <th key={p.key}>
            <button type="button" className="pp-th" aria-haspopup="dialog" onClick={(e) => setMenu({ prop: p, el: e.currentTarget })}>
              <Icon name={TYPE_ICONS[p.type]!} size={14} /><span>{p.name}</span>
              {sortOf(p.key) && <Icon name={sortOf(p.key)!.dir === "desc" ? "arrowDown" : "arrowUp"} size={13} className="pp-th__sort" />}
            </button>
            {!phone && <span className="pp-resize" onPointerDown={(e) => startResize(p.key, e)} aria-hidden />}
          </th>
        ))}
        {canSchema && (
          <th style={{ width: 44 }}>
            <button type="button" className="pp-th" aria-label="Add a property" title="Add a property" onClick={(e) => setAdding(e.currentTarget)} style={{ justifyContent: "center" }}><Icon name="plus" size={15} /></button>
          </th>
        )}
      </tr>
    </thead>
  );
  const body = (list: DbRow[]) => list.map((r) => (
    <tr key={r.slug}>
      <td className="pp-col--title"><TitleCell row={r} /></td>
      {cols.map((p) => <td key={p.key}><Cell row={r} prop={p} onValue={onValue} /></td>)}
      {canSchema && <td />}
    </tr>
  ));
  return (
    <>
      <div className="pp-tablewrap" role="region" aria-label="Pages as a table" tabIndex={0}>
        <table className="pp-table" style={{ width: titleW + cols.reduce((n, p) => n + width(p), 0) + (canSchema ? 44 : 0) }}>
          <colgroup>
            <col data-k="title" style={{ width: titleW }} />
            {cols.map((p) => <col key={p.key} data-k={p.key} style={{ width: width(p) }} />)}
            {canSchema && <col style={{ width: 44 }} />}
          </colgroup>
          {header}
          {groups ? groups.filter((g) => g.rows.length || g.id !== "__none").map((g) => (
            <tbody key={g.id}>
              <tr className="pp-group">
                <th colSpan={span} style={{ textAlign: "left" }}>
                  <button type="button" className="pp-group__head" aria-expanded={!collapsed.has(g.id)} onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })}>
                    <Icon name="chevronDown" size={14} />
                    {g.color ? <OptionChip name={g.label ?? ""} color={g.color} /> : <span className="ph-sensitive">{g.label}</span>}
                    <span className="pp-count">{g.rows.length}</span>
                  </button>
                </th>
              </tr>
              {!collapsed.has(g.id) && body(g.rows)}
              {!collapsed.has(g.id) && member && <NewRow colSpan={span} onCreate={(t) => onNew(t, presetFor(view, schema, g))} />}
            </tbody>
          )) : (
            <tbody>
              {body(rows)}
              {member && <NewRow colSpan={span} onCreate={(t) => onNew(t, presetFor(view, schema))} />}
            </tbody>
          )}
        </table>
        {!rows.length && !member && <div className="pp-db-empty" style={{ margin: 12 }}><strong>No pages</strong><span>Nothing here matches, or there&apos;s nothing you can open.</span></div>}
      </div>
      {menu && (
        <Pop anchor={menu.el} onClose={() => setMenu(null)} title={menu.prop.name} width={280}>
          <PropertyMenu prop={menu.prop} all={schema} canEdit={canSchema} onClose={() => setMenu(null)}
            onSave={async (next) => { await saveSchema(schema.map((x) => (x.key === next.key ? next : x))); setMenu((m) => (m ? { ...m, prop: next } : m)); }}
            onRemove={async () => { await saveSchema(schema.filter((x) => x.key !== menu.prop.key)); }}
            extra={[
              { label: "Sort ascending", icon: "arrowUp", on: sortOf(menu.prop.key)?.dir === "asc", onClick: () => onView({ sort: [{ key: menu.prop.key, dir: "asc" }] }) },
              { label: "Sort descending", icon: "arrowDown", on: sortOf(menu.prop.key)?.dir === "desc", onClick: () => onView({ sort: [{ key: menu.prop.key, dir: "desc" }] }) },
              { label: "Filter", icon: "filter", onClick: () => onView({ filter: [...view.filter, { key: menu.prop.key, op: opsFor(menu.prop.type)[0]!, value: menu.prop.type === "checkbox" ? true : null }] }) },
              ...(["select", "multi_select", "person", "checkbox", "date"].includes(menu.prop.type) ? [{ label: view.group === menu.prop.key ? "Ungroup" : menu.prop.type === "date" ? "Group by month" : "Group by this", icon: "layers", onClick: () => onView({ group: view.group === menu.prop.key ? null : menu.prop.key }) }] : []),
              { label: "Hide in this view", icon: "eyeOff", onClick: () => onView({ hidden: [...view.hidden, menu.prop.key] }) },
            ]} />
        </Pop>
      )}
      {adding && (
        <Pop anchor={adding} onClose={() => setAdding(null)} title="Add a property" width={300} align="end">
          <AddProperty taken={schema} onAdd={async (def) => { await saveSchema([...schema, def]); }} onClose={() => setAdding(null)} />
        </Pop>
      )}
    </>
  );
}

/* ── board ────────────────────────────────────────────────────────────── */

function BoardView({ rows, schema, view, canSchema, member, people, onValue, onNew, saveSchema }: ViewProps) {
  const groupProp = view.group ? findProp(schema, view.group) : null;
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [dragging, setDragging] = useState<DbRow | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );
  // No Select to group by: the pages still show, as cards in one column, with how to get columns.
  if (!groupProp || groupProp.type !== "select") {
    const shownAll = schema.filter((p) => !view.hidden.includes(p.key));
    return (
      <div className="flex flex-col gap-3">
        <div className="pp-board-hint" role="note">
          <Icon name="columns" size={16} />
          <span>{canSchema ? "Add a Select property, like Status, to sort these pages into columns." : "Columns come from a Select property, like Status. Ask a member of the workspace to add one."}</span>
          {canSchema && (
            <>
              <Button size="sm" variant="secondary" iconLeft="plus" onClick={(e) => setAdding(e.currentTarget)}>Add a Select property</Button>
              {adding && (
                <Pop anchor={adding} onClose={() => setAdding(null)} title="Add a property" width={300}>
                  <AddProperty taken={schema} presetType="select" onAdd={async (def) => { await saveSchema([...schema, def]); }} onClose={() => setAdding(null)} />
                </Pop>
              )}
            </>
          )}
        </div>
        <div className="pp-board" role="list" aria-label="Pages">
          <section className="pp-col" data-pp-color="default" role="listitem" aria-label={`All pages: ${rows.length} page${rows.length === 1 ? "" : "s"}`}>
            <div className="pp-col__head">
              <span className="text-[13px] font-semibold text-text-secondary">All pages</span>
              <span className="pp-count">{rows.length}</span>
            </div>
            {rows.map((r) => <CardBody key={r.slug} row={r} props={shownAll} ro />)}
            {!rows.length && <div className="pp-col__empty">No pages</div>}
            {member && <NewRow label="New" onCreate={(t) => onNew(t, presetFor(view, schema, null))} />}
          </section>
        </div>
      </div>
    );
  }
  const groups = groupRows(rows, groupProp.key, schema, people);
  const shown = schema.filter((p) => p.key !== groupProp.key && !view.hidden.includes(p.key));
  const onStart = (e: DragStartEvent) => setDragging(rows.find((r) => r.slug === e.active.id) ?? null);
  const onEnd = (e: DragEndEvent) => {
    setDragging(null);
    setOverCol(null);
    const row = rows.find((r) => r.slug === e.active.id);
    const to = e.over?.id as string | undefined;
    if (!row || !to) return;
    const g = groups.find((x) => x.id === to);
    if (!g) return;
    const cur = row.values[groupProp.key];
    const next = g.value === null ? null : String(g.value);
    if ((cur ?? null) === next) return;
    onValue(row, groupProp.key, next);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={columnCollision} autoScroll={{ threshold: { x: 0.08, y: 0.15 }, acceleration: 6 }} onDragStart={onStart} onDragEnd={onEnd} onDragOver={(e) => setOverCol((e.over?.id as string) ?? null)} onDragCancel={() => { setDragging(null); setOverCol(null); }}
      accessibility={{ announcements: {
        onDragStart: ({ active }) => `Picked up ${rows.find((r) => r.slug === active.id)?.title ?? "a page"}.`,
        onDragOver: ({ over }) => (over ? `Over ${groups.find((g) => g.id === over.id)?.label ?? "a column"}.` : "Not over a column."),
        onDragEnd: ({ over }) => (over ? `Moved to ${groups.find((g) => g.id === over.id)?.label ?? "a column"}.` : "Put back."),
        onDragCancel: () => "Put back.",
      } }}>
      <div className="pp-board" role="list" aria-label={`Pages by ${groupProp.name}`}>
        {groups.map((g) => (
          <Column key={g.id} id={g.id} label={g.label ?? ""} color={g.color} count={g.rows.length} over={overCol === g.id && !!dragging}>
            {g.rows.map((r) => <Card key={r.slug} row={r} props={shown} draggable={r.can_edit} hidden={dragging?.slug === r.slug} />)}
            {!g.rows.length && <div className="pp-col__empty">{dragging ? "Drop here" : "No pages"}</div>}
            {member && <NewRow label="New" onCreate={(t) => onNew(t, presetFor(view, schema, g))} />}
          </Column>
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.16,1,.3,1)" }}>
        {dragging ? <CardBody row={dragging} props={shown} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({ id, label, color, count, over, children }: { id: string; label: string; color: string | null; count: number; over: boolean; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <section ref={setNodeRef} className={cx("pp-col", over && "pp-col--over")} data-pp-color={color ?? "default"} role="listitem" aria-label={`${label}: ${count} page${count === 1 ? "" : "s"}`}>
      <div className="pp-col__head">
        {color ? <OptionChip name={label} color={color} /> : <span className="text-[13px] font-semibold text-text-secondary">{label}</span>}
        <span className="pp-count">{count}</span>
      </div>
      {children}
    </section>
  );
}

function Card({ row, props, draggable, hidden }: { row: DbRow; props: PropDef[]; draggable: boolean; hidden: boolean }) {
  const { setNodeRef, listeners, attributes } = useDraggable({ id: row.slug, disabled: !draggable });
  return (
    <div ref={setNodeRef} {...(draggable ? listeners : {})} {...(draggable ? attributes : {})} aria-roledescription={draggable ? "Draggable page" : undefined}
      className={cx(hidden && "pp-card--ghost")} style={{ outline: "none" }}>
      <CardBody row={row} props={props} ro={!draggable} />
    </div>
  );
}

function CardBody({ row, props, overlay, ro }: { row: DbRow; props: PropDef[]; overlay?: boolean; ro?: boolean }) {
  const filled = props.filter((p) => !isEmptyValue(row.values[p.key]) && !(p.type === "checkbox" && row.values[p.key] !== true)).slice(0, 5);
  return (
    <div className={cx("pp-card", overlay && "pp-card--overlay", ro && "pp-card--ro")}>
      <div className="pp-card__title">
        <span className="pp-title__icon" aria-hidden>{row.icon && !/^(asset:|https?:)/.test(row.icon) ? row.icon : <Icon name="doc" size={15} />}</span>
        <a href={`/${encodeURIComponent(row.slug)}`} className="ph-sensitive" dir="auto" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} draggable={false}>{row.title}</a>
      </div>
      {filled.length > 0 && (
        <div className="pp-card__props">
          {filled.map((p) => (
            <div key={p.key} className="pp-card__prop" title={p.name}>
              <ValueView prop={p} value={row.values[p.key]} compact />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { TYPE_LABELS, optionColor };
export default FolderDatabase;
