"use client";

/**
 * How a typed property's value looks (chips, a person with an avatar, a date, links) and the
 * editors that change it (in a Pop): select / multi-select with search and "Create", a member
 * picker, a calendar, text, number and links (an address, or a page of the workspace).
 *
 * People and linked pages are named from what the server resolved for this viewer (PropsCtx); a
 * person or page picked here joins that cache, so it shows at once. A linked page the viewer can't
 * open shows as "Locked page", never with its title.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Icon, cx } from "@/components/ui";
import type { LinkInfo } from "./api";
import { searchMembers, searchPages } from "./api";
import { isSlug, isUrl, linkList, nextColor, optionColor, type Person, type PropDef, type PropValue } from "./model.mjs";

/* ── context ──────────────────────────────────────────────────────────── */

export interface PropsContext {
  workspaceId: string | null;
  people: Record<string, Person>;
  links: Record<string, LinkInfo>;
  peopleHidden?: boolean;
  canEditSchema: boolean;
  remember: (people: Record<string, Person>, links: Record<string, LinkInfo>) => void;
  /** Adds an option to a select property (the schema); resolves to the property as saved. */
  addOption?: (prop: PropDef, name: string) => Promise<PropDef | null>;
  /** Where a page slug links (the workspace's own domain when there is one). */
  pageHref?: (slug: string) => string;
}

export const PropsCtx = createContext<PropsContext>({ workspaceId: null, people: {}, links: {}, canEditSchema: false, remember: () => {} });
export const usePropsCtx = () => useContext(PropsCtx);

export const TYPE_ICONS: Record<string, string> = {
  select: "chevronDown", multi_select: "list", person: "user", date: "calendar", text: "type", link: "link", number: "hash", checkbox: "checkSquare",
};

/* ── chips ────────────────────────────────────────────────────────────── */

export function OptionChip({ name, color, onRemove }: { name: string; color?: string; onRemove?: () => void }) {
  return (
    <span className="pp-chip" data-pp-color={color ?? "default"} title={name}>
      <span>{name}</span>
      {onRemove && (
        <button type="button" className="pp-chip__x" aria-label={`Remove ${name}`} onClick={(e) => { e.stopPropagation(); onRemove(); }}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

const AV_COLORS = ["blue", "green", "orange", "purple", "pink", "red", "brown", "yellow"];
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export function PersonAvatar({ id, person, large }: { id: string; person?: Person | null; large?: boolean }) {
  if (!person) return <span className={cx("pp-avatar pp-avatar--anon", large && "pp-avatar--lg")} aria-hidden><Icon name="user" size={12} /></span>;
  return (
    <span className={cx("pp-avatar", large && "pp-avatar--lg")} data-pp-color={AV_COLORS[hash(id) % AV_COLORS.length]} aria-hidden>
      {person.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={person.avatar_url} alt="" referrerPolicy="no-referrer" />
      ) : (
        initials(person.name)
      )}
    </span>
  );
}

export function PersonChip({ id }: { id: string }) {
  const { people, peopleHidden } = usePropsCtx();
  const p = people[id];
  return (
    <span className="pp-person ph-sensitive ph-mask">
      <PersonAvatar id={id} person={p} />
      <span>{p?.name ?? (peopleHidden ? "A member" : "Someone")}</span>
    </span>
  );
}

export function LinkChip({ value }: { value: string }) {
  const { links, pageHref } = usePropsCtx();
  if (isUrl(value)) {
    let label = value;
    try {
      const u = new URL(value);
      label = u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname : "");
    } catch {
      /* keep */
    }
    return (
      <a className="pp-link" href={value} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()} title={value}>
        <Icon name="external" size={13} className="pp-link__icon" />
        <span>{label}</span>
      </a>
    );
  }
  const info = links[value];
  if (!info || info.state !== "ok") {
    return (
      <span className="pp-link pp-link--locked" title={info?.state === "missing" ? "This page isn't there, or you can't open it" : "You can't open this page"}>
        <Icon name="lock" size={13} className="pp-link__icon" />
        <span>{info ? "Locked page" : value}</span>
      </span>
    );
  }
  return (
    <a className="pp-link ph-sensitive" href={pageHref ? pageHref(value) : info.url ?? `/${value}`} onClick={(e) => e.stopPropagation()} title={info.title}>
      {info.icon && !/^(asset:|https?:)/.test(info.icon) ? <span className="pp-link__icon" aria-hidden>{info.icon}</span> : <Icon name="doc" size={13} className="pp-link__icon" />}
      <span>{info.title}</span>
    </a>
  );
}

export function formatDate(v: string, opts?: { short?: boolean }): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  const sameYear = d.getUTCFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: opts?.short && sameYear ? undefined : "numeric", timeZone: "UTC" });
}

export function isEmptyValue(v: unknown) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** A value, read only. */
export function ValueView({ prop, value, compact, placeholder }: { prop: PropDef; value: PropValue | undefined; compact?: boolean; placeholder?: string | null }) {
  if (prop.type === "checkbox") return <span className={cx("pp-check", value === true && "pp-check--on")} role="img" aria-label={value === true ? "Checked" : "Not checked"}><Icon name="check" size={11} /></span>;
  if (isEmptyValue(value)) return placeholder === null ? null : <span className="pp-empty">{placeholder ?? "Empty"}</span>;
  switch (prop.type) {
    case "select":
      return <OptionChip name={String(value)} color={optionColor(prop, String(value))} />;
    case "multi_select":
      return (
        <span className={cx("pp-chips", compact && "pp-chips--nowrap")}>
          {(Array.isArray(value) ? value : [String(value)]).map((v) => <OptionChip key={v} name={v} color={optionColor(prop, v)} />)}
        </span>
      );
    case "person":
      return <PersonChip id={String(value)} />;
    case "date":
      return <span className="pp-num">{formatDate(String(value), { short: compact })}</span>;
    case "link": {
      const all = linkList(value);
      // In a cell or a card: the first link and how many more.
      const shown = compact ? all.slice(0, 1) : all;
      return (
        <span className={cx("pp-chips", compact && "pp-chips--nowrap")} style={{ gap: compact ? 6 : 10 }}>
          {shown.map((v) => <LinkChip key={v} value={v} />)}
          {all.length > shown.length && <span className="pp-chip" data-pp-color="default" title={`${all.length - shown.length} more`}>+{all.length - shown.length}</span>}
        </span>
      );
    }
    case "number":
      return <span className="pp-num">{typeof value === "number" ? value.toLocaleString() : String(value)}</span>;
    default:
      return <span className={cx(compact ? "truncate" : "whitespace-pre-wrap [overflow-wrap:anywhere]")}>{String(value)}</span>;
  }
}

/* ── editors ──────────────────────────────────────────────────────────── */

export interface EditorProps {
  prop: PropDef;
  value: PropValue | undefined;
  onChange: (v: PropValue | null) => void;
  onClose: () => void;
}

export function ValueEditor(p: EditorProps) {
  switch (p.prop.type) {
    case "select":
    case "multi_select":
      return <SelectEditor {...p} />;
    case "person":
      return <PersonEditor {...p} />;
    case "date":
      return <DateEditor {...p} />;
    case "link":
      return <LinkEditor {...p} />;
    case "number":
      return <TextEditor {...p} number />;
    default:
      return <TextEditor {...p} />;
  }
}

/** ↑/↓ over a list, Enter picks. */
function useListKeys(count: number, onPick: (i: number) => void) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive((a) => Math.min(a, Math.max(0, count - 1))), [count]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (count ? (a + 1) % count : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (count ? (a - 1 + count) % count : 0)); }
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); if (count) onPick(active); }
  };
  return { active, setActive, onKeyDown };
}

function SelectEditor({ prop, value, onChange, onClose }: EditorProps) {
  const ctx = usePropsCtx();
  const multi = prop.type === "multi_select";
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const chosen = multi ? (Array.isArray(value) ? value : value ? [String(value)] : []) : value ? [String(value)] : [];
  const opts = prop.options ?? [];
  const needle = q.trim().toLowerCase();
  const shown = opts.filter((o) => !needle || o.name.toLowerCase().includes(needle));
  const canCreate = !!needle && ctx.canEditSchema && !!ctx.addOption && !opts.some((o) => o.name.toLowerCase() === needle) && opts.length < 50;
  const rows = [...shown.map((o) => ({ kind: "opt" as const, o })), ...(canCreate ? [{ kind: "new" as const, o: { name: q.trim(), color: nextColor(opts) } }] : [])];

  const pick = async (i: number) => {
    const r = rows[i];
    if (!r) return;
    let name = r.o.name;
    if (r.kind === "new") {
      setBusy(true);
      setErr("");
      try {
        const saved = await ctx.addOption!(prop, name);
        name = saved?.options?.find((o) => o.name.toLowerCase() === name.toLowerCase())?.name ?? name;
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Couldn't add it");
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setQ("");
    if (multi) onChange(chosen.includes(name) ? chosen.filter((x) => x !== name) : [...chosen, name]);
    else {
      onChange(chosen[0] === name ? null : name);
      onClose();
    }
  };
  const keys = useListKeys(rows.length, (i) => void pick(i));

  return (
    <>
      <div className="pp-pop__search">
        {chosen.map((c) => <OptionChip key={c} name={c} color={optionColor(prop, c)} onRemove={() => onChange(multi ? chosen.filter((x) => x !== c) : null)} />)}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !q && chosen.length) onChange(multi ? chosen.slice(0, -1) : null);
            keys.onKeyDown(e);
          }}
          placeholder={opts.length ? "Search for an option…" : ctx.canEditSchema ? "Type to add an option…" : "No options yet"}
          aria-label={`${prop.name}: search options`}
          maxLength={60}
          disabled={busy}
        />
      </div>
      <div className="pp-pop__body" role="listbox" aria-label={prop.name} aria-multiselectable={multi || undefined}>
        {opts.length > 0 && <div className="pp-label">{ctx.canEditSchema ? "Select an option or create one" : "Select an option"}</div>}
        {rows.map((r, i) => (
          <button
            key={`${r.kind}:${r.o.name}`}
            type="button"
            role="option"
            aria-selected={chosen.includes(r.o.name)}
            className="pp-opt"
            data-active={keys.active === i}
            onMouseEnter={() => keys.setActive(i)}
            onClick={() => void pick(i)}
          >
            {r.kind === "new" ? <span className="text-text-muted">Create</span> : null}
            <OptionChip name={r.o.name} color={r.o.color} />
            {chosen.includes(r.o.name) && <span className="pp-opt__trail"><Icon name="check" size={14} /></span>}
          </button>
        ))}
        {!rows.length && <div className="pp-pop__hint">{needle ? "No option matches." : "This property has no options yet."}</div>}
        {err && <div className="pp-pop__hint pp-err">{err}</div>}
      </div>
    </>
  );
}

function PersonEditor({ prop, value, onChange, onClose }: EditorProps) {
  const ctx = usePropsCtx();
  const [q, setQ] = useState("");
  const [list, setList] = useState<Array<{ id: string; name: string; avatar_url?: string | null }> | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!ctx.workspaceId) return;
    let live = true;
    const t = window.setTimeout(() => {
      searchMembers(ctx.workspaceId!, q)
        .then((r) => { if (live) { setList(r); setErr(""); } })
        .catch((e) => { if (live) { setList([]); setErr(e instanceof Error ? e.message : "Couldn't load the members"); } });
    }, q ? 160 : 0);
    return () => { live = false; window.clearTimeout(t); };
  }, [q, ctx.workspaceId]);
  const rows = list ?? [];
  const pick = (i: number) => {
    const m = rows[i];
    if (!m) return;
    ctx.remember({ [m.id]: { name: m.name, avatar_url: m.avatar_url ?? null } }, {});
    onChange(value === m.id ? null : m.id);
    onClose();
  };
  const keys = useListKeys(rows.length, pick);
  return (
    <>
      <div className="pp-pop__search">
        <Icon name="search" size={14} className="text-text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={keys.onKeyDown} placeholder="Search for a member…" aria-label={`${prop.name}: search members`} maxLength={100} />
      </div>
      <div className="pp-pop__body" role="listbox" aria-label={prop.name}>
        {list === null && <div className="pp-pop__hint">Loading members…</div>}
        {rows.map((m, i) => (
          <button key={m.id} type="button" role="option" aria-selected={value === m.id} className="pp-opt ph-sensitive" data-active={keys.active === i} onMouseEnter={() => keys.setActive(i)} onClick={() => pick(i)}>
            <PersonAvatar id={m.id} person={{ name: m.name, avatar_url: m.avatar_url }} large />
            <span className="ph-mask truncate">{m.name}</span>
            {value === m.id && <span className="pp-opt__trail"><Icon name="check" size={14} /></span>}
          </button>
        ))}
        {list !== null && !rows.length && <div className="pp-pop__hint">{err || (q ? "No member matches." : "No members.")}</div>}
      </div>
      {typeof value === "string" && value && (
        <div className="pp-pop__foot">
          <button type="button" className="pp-opt" style={{ width: "auto" }} onClick={() => { onChange(null); onClose(); }}>
            <Icon name="x" size={14} /> Clear
          </button>
        </div>
      )}
    </>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function DateEditor({ prop, value, onChange, onClose }: EditorProps) {
  const cur = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  const [text, setText] = useState(cur ?? "");
  const [month, setMonth] = useState(() => {
    const d = cur ? new Date(`${cur}T00:00:00`) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const today = ymd(new Date());
  const days = useMemo(() => {
    const first = new Date(month);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start on Monday
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [month]);
  const set = (v: string | null) => {
    onChange(v);
    onClose();
  };
  const typed = /^\d{4}-\d{2}-\d{2}$/.test(text.trim()) && !Number.isNaN(Date.parse(`${text.trim()}T00:00:00`));
  return (
    <>
      <div className="pp-pop__search">
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const v = e.target.value.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00`))) {
              const d = new Date(`${v}T00:00:00`);
              setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
            }
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && typed) { e.preventDefault(); set(text.trim()); } }}
          placeholder="YYYY-MM-DD"
          aria-label={`${prop.name}: date`}
          inputMode="numeric"
          maxLength={10}
        />
      </div>
      <div className="pp-cal">
        <div className="pp-cal__head">
          <button type="button" className="pp-cal__nav" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><Icon name="chevronLeft" size={16} /></button>
          <span aria-live="polite">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
          <button type="button" className="pp-cal__nav" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><Icon name="chevronRight" size={16} /></button>
        </div>
        <div className="pp-cal__grid" role="grid" aria-label={prop.name}>
          {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => <span key={d} className="pp-cal__dow" aria-hidden>{d}</span>)}
          {days.map((d) => {
            const v = ymd(d);
            return (
              <button
                key={v}
                type="button"
                className={cx("pp-cal__day", d.getMonth() !== month.getMonth() && "pp-cal__day--out", v === today && "pp-cal__day--today", v === cur && "pp-cal__day--on")}
                aria-pressed={v === cur}
                aria-label={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                onClick={() => set(v)}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </div>
      <div className="pp-pop__foot">
        <button type="button" className="pp-opt" style={{ width: "auto" }} onClick={() => set(today)}><Icon name="calendar" size={14} /> Today</button>
        {cur && <button type="button" className="pp-opt" style={{ width: "auto" }} onClick={() => set(null)}><Icon name="x" size={14} /> Clear</button>}
      </div>
    </>
  );
}

function TextEditor({ prop, value, onChange, onClose, number }: EditorProps & { number?: boolean }) {
  const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
  const [err, setErr] = useState("");
  const commit = useRef<() => boolean>(() => true);
  const done = useRef(false);
  commit.current = () => {
    if (done.current) return true;
    const t = text.trim();
    if (number) {
      if (!t) { if (value !== undefined) onChange(null); done.current = true; return true; }
      const n = Number(t.replace(/,/g, ""));
      if (!Number.isFinite(n)) { setErr("A number, please"); return false; }
      if (n !== value) onChange(n);
      done.current = true;
      return true;
    }
    if (t !== (value ?? "")) onChange(t || null);
    done.current = true;
    return true;
  };
  // Closing (a click outside, Esc) keeps what was typed, like Notion.
  useEffect(() => () => { commit.current(); }, []);
  return (
    <div className="pp-field">
      {number ? (
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (commit.current()) onClose(); } }}
          inputMode="decimal"
          aria-label={prop.name}
          placeholder="0"
          maxLength={40}
        />
      ) : (
        <textarea
          className="pp-input"
          style={{ height: "auto", minHeight: 64, padding: "6px 10px", resize: "vertical", lineHeight: "20px" }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (commit.current()) onClose(); } }}
          aria-label={prop.name}
          placeholder="Type something…"
          maxLength={2000}
          rows={3}
        />
      )}
      {err ? <span className="pp-err">{err}</span> : <span className="pp-empty" style={{ fontSize: 12 }}>Enter to save{number ? "" : " · Shift+Enter for a new line"}</span>}
    </div>
  );
}

function LinkEditor({ prop, value, onChange }: EditorProps) {
  const ctx = usePropsCtx();
  const current = linkList(value);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Array<{ slug: string; title: string; icon?: string | null }>>([]);
  const looksUrl = /^https?:\/\//i.test(q.trim());
  useEffect(() => {
    if (!ctx.workspaceId || looksUrl) { setFound([]); return; }
    let live = true;
    const t = window.setTimeout(() => {
      searchPages(ctx.workspaceId!, q).then((r) => { if (live) setFound(r); }).catch(() => { if (live) setFound([]); });
    }, 180);
    return () => { live = false; window.clearTimeout(t); };
  }, [q, ctx.workspaceId, looksUrl]);
  const add = (v: string, info?: LinkInfo) => {
    if (info) ctx.remember({}, { [v]: info });
    if (!current.includes(v)) onChange(current.length ? [...current, v] : v);
    setQ("");
  };
  const remove = (v: string) => {
    const next = current.filter((x) => x !== v);
    onChange(next.length > 1 ? next : next[0] ?? null);
  };
  const rows = looksUrl ? [] : found.filter((f) => !current.includes(f.slug));
  const keys = useListKeys(rows.length, (i) => { const r = rows[i]; if (r) add(r.slug, { state: "ok", title: r.title, slug: r.slug, icon: r.icon ?? null }); });
  return (
    <>
      {current.length > 0 && (
        <div className="pp-pop__body" style={{ borderBottom: "1px solid var(--border)", maxHeight: 140 }}>
          {current.map((v) => (
            <div key={v} className="pp-opt" style={{ cursor: "default" }}>
              <LinkChip value={v} />
              <span className="pp-opt__trail">
                <button type="button" className="pp-chip__x" aria-label="Remove this link" onClick={() => remove(v)}><Icon name="x" size={12} /></button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="pp-pop__search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && looksUrl) {
              e.preventDefault();
              if (isUrl(q.trim())) add(q.trim());
              return;
            }
            keys.onKeyDown(e);
          }}
          placeholder="Paste a link, or search for a page…"
          aria-label={`${prop.name}: add a link`}
          maxLength={2000}
        />
      </div>
      <div className="pp-pop__body" role="listbox" aria-label="Pages">
        {looksUrl ? (
          <button type="button" className="pp-opt" disabled={!isUrl(q.trim())} onClick={() => add(q.trim())}>
            <Icon name="external" size={14} /> <span className="truncate">Add {q.trim()}</span>
          </button>
        ) : (
          <>
            {rows.length > 0 && <div className="pp-label">Pages in this workspace</div>}
            {rows.map((r, i) => (
              <button key={r.slug} type="button" role="option" aria-selected={false} className="pp-opt ph-sensitive" data-active={keys.active === i} onMouseEnter={() => keys.setActive(i)} onClick={() => add(r.slug, { state: "ok", title: r.title, slug: r.slug, icon: r.icon ?? null })}>
                {r.icon && !/^(asset:|https?:)/.test(r.icon) ? <span aria-hidden>{r.icon}</span> : <Icon name="doc" size={14} />}
                <span className="truncate">{r.title}</span>
              </button>
            ))}
            {!rows.length && <div className="pp-pop__hint">{q ? "No page matches." : "Type to find a page, or paste an https:// link."}</div>}
          </>
        )}
      </div>
    </>
  );
}

export { isSlug };
