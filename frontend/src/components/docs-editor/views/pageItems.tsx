"use client";

/**
 * A page's Markdrop items (a document in the block editor, EditorHost.pages):
 *
 *   ::markdrop{src=<slug> mode=live|preview|card}   the embed block: the item as readers see it,
 *                                                   with Live / Preview / Card and Replace
 *   :markdrop[Title]{src=<slug>}                     the mention chip, inline
 *
 * Both start empty from the "/" menu and open the picker: the author's own documents and files,
 * and the page's workspace. The preview is resolved for the author through the page's embeds
 * endpoint, so it shows exactly what they may see (each reader gets their own answer).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Button, Dialog, EmptyState, FileIcon, Icon, IconButton, Input, SegmentedControl, Spinner, Tabs, type FileRenderer } from "@/components/ui";
import { useHost } from "../host";
import { services } from "../menus/mediaUpload";
import type { PagePickItem, PageResolvedItem, PagesEditorHost } from "../types";
import { cx } from "./shared";
import { JiraMentionNode } from "@/components/jira/pages/editor";

type Mode = "live" | "preview" | "card";
const MODES: Array<{ value: Mode; label: string }> = [
  { value: "live", label: "Live" },
  { value: "preview", label: "Preview" },
  { value: "card", label: "Card" },
];

/* ── resolving, shared by every block of the page ───────────────────────── */

const caches = new WeakMap<PagesEditorHost, Map<string, Promise<PageResolvedItem | null>>>();
const queues = new WeakMap<PagesEditorHost, { slugs: Set<string>; timer: number | null; waiters: Map<string, Array<(r: PageResolvedItem | null) => void>> }>();

/** One slug's answer for the author: requests made in the same tick go out as one batch. */
function resolveOne(host: PagesEditorHost, slug: string, fresh = false): Promise<PageResolvedItem | null> {
  let cache = caches.get(host);
  if (!cache) caches.set(host, (cache = new Map()));
  if (fresh) cache.delete(slug);
  const hit = cache.get(slug);
  if (hit) return hit;
  let q = queues.get(host);
  if (!q) queues.set(host, (q = { slugs: new Set(), timer: null, waiters: new Map() }));
  const queue = q;
  const p = new Promise<PageResolvedItem | null>((resolve) => {
    queue.slugs.add(slug);
    queue.waiters.set(slug, [...(queue.waiters.get(slug) ?? []), resolve]);
    if (queue.timer === null) {
      queue.timer = window.setTimeout(() => {
        const slugs = [...queue.slugs];
        const waiters = new Map(queue.waiters);
        queue.slugs.clear();
        queue.waiters.clear();
        queue.timer = null;
        host
          .resolve(slugs)
          .then((r) => slugs.forEach((s) => waiters.get(s)?.forEach((w) => w(r[s] ?? { state: "missing" }))))
          .catch(() => slugs.forEach((s) => {
            cache!.delete(s);
            waiters.get(s)?.forEach((w) => w(null));
          }));
      }, 30);
    }
  });
  cache.set(slug, p);
  return p;
}

export function useResolved(host: PagesEditorHost | undefined, slug: string | null): PageResolvedItem | null | undefined {
  const [r, setR] = useState<{ slug: string; v: PageResolvedItem | null } | null>(null);
  useEffect(() => {
    if (!host || !slug) return;
    let live = true;
    void resolveOne(host, slug).then((v) => live && setR({ slug, v }));
    return () => {
      live = false;
    };
  }, [host, slug]);
  if (!slug) return null;
  return r && r.slug === slug ? r.v : undefined;
}

/**
 * After a picker dialog closes: the dialog hands focus back to the page itself (and the page puts
 * the caret back where it was); if it couldn't, focus the page once the dialog has gone.
 */
function refocusAfterDialog(editor: ReactNodeViewProps["editor"]) {
  window.setTimeout(() => {
    if (!editor.isDestroyed && !editor.view.hasFocus() && !document.querySelector('[role="dialog"][aria-modal="true"]')) editor.commands.focus();
  }, 260);
}

/* ── the picker ──────────────────────────────────────────────────────────── */

const RENDERER_ICON: Record<string, FileRenderer> = { bundle: "zip" };
function ItemIcon({ item }: { item: PagePickItem }) {
  if (item.kind === "markdown") return <Icon name="lines" size={18} />;
  const r = item.renderer ?? "";
  return <FileIcon renderer={(RENDERER_ICON[r] ?? (["pdf", "sheet", "docx", "pptx", "text", "video", "audio", "html", "image"].includes(r) ? r : null)) as FileRenderer | null} mime={item.mime ?? ""} size={18} />;
}

const KIND_LABEL: Record<string, string> = { html: "Interactive page", bundle: "Website", pdf: "PDF", sheet: "Spreadsheet", docx: "Word document", pptx: "PowerPoint deck", text: "Text file", image: "Image", video: "Video", audio: "Audio" };

export function PageItemPicker({ open, onClose, onPick, host, purpose }: {
  open: boolean;
  onClose: () => void;
  onPick: (item: PagePickItem, mode: Mode) => void;
  host: PagesEditorHost;
  purpose: "embed" | "mention";
}) {
  const [tab, setTab] = useState<"mine" | "workspace">("mine");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PagePickItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>("live");
  const searchId = useId();

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError("");
    host
      .search(tab, query)
      .then((r) => {
        if (!live) return;
        setItems(r.items);
        setCursor(r.cursor);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load your items."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, tab, query, host]);

  const more = async () => {
    setLoading(true);
    try {
      const r = await host.search(tab, query, cursor);
      setItems((xs) => [...(xs ?? []), ...r.items]);
      setCursor(r.cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load more.");
    } finally {
      setLoading(false);
    }
  };

  const tabs = [{ value: "mine", label: "Your files" }, ...(host.workspaceName ? [{ value: "workspace", label: host.workspaceName }] : [])];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={purpose === "embed" ? "Embed a Markdrop item" : "Mention a Markdrop item"}
      description={
        purpose === "embed"
          ? "Files and pages show here as readers see them. Each reader sees an item only if they can open it; anyone else sees a locked placeholder."
          : "A chip that links to the item. Readers who can't open it see “Restricted item”."
      }
      footer={
        purpose === "embed" ? (
          <div className="dxe-pick__footer">
            <span className="dxe-pick__label" id={`${searchId}-mode`}>Show as</span>
            <SegmentedControl<Mode> aria-labelledby={`${searchId}-mode`} size="sm" value={mode} onChange={setMode} options={MODES} />
          </div>
        ) : undefined
      }
    >
      <div className="dxe-pick">
        {tabs.length > 1 && <Tabs items={tabs} value={tab} onChange={(v) => setTab(v as "mine" | "workspace")} variant="pill" size="sm" aria-label="Where the item is" />}
        <Input size="sm" iconPrefix="search" placeholder="Search by title or link" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search items" id={searchId} autoFocus />
        {error ? (
          <p className="dxe-pick__error" role="alert">{error}</p>
        ) : items && items.length === 0 && !loading ? (
          <EmptyState icon="search" title={query ? "Nothing matches" : "Nothing here yet"} description={tab === "mine" ? "Your documents and files show here." : "Items you can open in this workspace show here."} />
        ) : (
          <ul className="dxe-pick__list ph-no-capture" role="listbox" aria-label="Items">
            {(items ?? []).map((it) => (
              <li key={`${tab}:${it.slug}`} role="option" aria-selected={false}>
                <button type="button" className="dxe-pick__row md-focus" onClick={() => onPick(it, mode)} disabled={it.encrypted}>
                  <span className="dxe-pick__icon" aria-hidden>
                    <ItemIcon item={it} />
                  </span>
                  <span className="dxe-pick__main">
                    <span className="dxe-pick__title ph-sensitive" dir="auto">{it.title || it.slug}</span>
                    <span className="dxe-pick__meta">
                      {it.kind === "markdown" ? "Document" : it.type_label || KIND_LABEL[it.renderer ?? ""] || "File"}
                      {it.encrypted ? " · Encrypted, can't be embedded" : ""}
                      {" · "}
                      <span className="dxe-pick__slug">{it.slug}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {loading && (
              <li className="dxe-pick__loading">
                <Spinner label="Loading" />
              </li>
            )}
          </ul>
        )}
        {cursor && !loading && (
          <Button size="sm" variant="ghost" onClick={() => void more()}>
            Load more
          </Button>
        )}
      </div>
    </Dialog>
  );
}

/* ── the embed block ─────────────────────────────────────────────────────── */

export function PageEmbedView({ node, updateAttributes, deleteNode, selected, editor }: ReactNodeViewProps) {
  const host = useHost();
  const pages = host.pages!;
  const a = (node.attrs.attributes ?? {}) as Record<string, string>;
  const slug = a.src?.trim() || null;
  const mode = (["live", "preview", "card"].includes(a.mode) ? a.mode : "live") as Mode;
  const resolved = useResolved(pages, slug);
  const [picking, setPicking] = useState(!slug && !host.readOnly);

  const pick = (it: PagePickItem, m: Mode) => {
    setPicking(false);
    updateAttributes({ attributes: { src: it.slug, ...(m !== "live" ? { mode: m } : {}) } });
    refocusAfterDialog(editor);
  };
  const close = () => {
    setPicking(false);
    // Closed without choosing: an empty block is removed.
    if (!slug) deleteNode();
  };

  return (
    <NodeViewWrapper className={cx("dxe-block dxe-pembed", selected && "dxe-selected")} data-drag-handle="">
      <div contentEditable={false}>
        {slug ? (
          <>
            {pages.renderEmbed({ slug, mode, label: a.title || null, resolved })}
            {!host.readOnly && (
              <div className="dxe-pembed__tools">
                <SegmentedControl<Mode>
                  aria-label="Show as"
                  size="sm"
                  value={mode}
                  onChange={(m) => {
                    const { mode: _old, ...rest } = a;
                    updateAttributes({ attributes: m === "live" ? rest : { ...rest, mode: m } });
                  }}
                  options={MODES}
                />
                <Button size="sm" variant="ghost" iconLeft="refresh" onClick={() => setPicking(true)}>
                  Replace
                </Button>
                <IconButton icon="trash" label="Remove embed" size="sm" onClick={() => deleteNode()} />
              </div>
            )}
          </>
        ) : (
          <div className="dxe-drop">
            <Icon name="layers" />
            <span>Embed a file or page from Markdrop</span>
            {!host.readOnly && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
                  Choose…
                </Button>
                <IconButton icon="trash" label="Remove embed block" size="sm" onClick={() => deleteNode()} />
              </>
            )}
          </div>
        )}
      </div>
      <PageItemPicker open={picking} onClose={close} onPick={pick} host={pages} purpose="embed" />
    </NodeViewWrapper>
  );
}

/* ── the mention chip ────────────────────────────────────────────────────── */

export function MentionView(props: ReactNodeViewProps) {
  const name = String(props.node.attrs.name ?? "markdrop");
  if (name === "date") return <DateChip {...props} />;
  if (name === "person") return <PersonChip {...props} />;
  // :jira[KEY]{site}: a Jira issue (components/jira/pages/editor.tsx).
  if (name === "jira") return <JiraMentionNode {...props} />;
  return <ItemMention {...props} />;
}

/** `:date[2026-11-03]`: shown as "Nov 3, 2026"; click to change it. */
function DateChip({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const host = useHost();
  const iso = String(node.attrs.label ?? "");
  const [editing, setEditing] = useState(false);
  const d = new Date(`${iso}T12:00:00`);
  const shown = Number.isFinite(d.getTime()) ? d.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" }) : iso;
  return (
    <NodeViewWrapper as="span" className={cx("dxe-mention-wrap", selected && "dxe-selected")} contentEditable={false}>
      {editing ? (
        <input
          type="date"
          className="pb-date-input"
          defaultValue={iso}
          autoFocus
          aria-label="Date"
          onBlur={() => setEditing(false)}
          onChange={(e) => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) updateAttributes({ label: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button type="button" className="pb-mention pb-mention--date" disabled={host.readOnly} onClick={() => setEditing(true)} aria-label={`Date: ${shown}. Change it`}>
          <Icon name="calendar" size={13} aria-hidden />
          <span>{shown}</span>
        </button>
      )}
    </NodeViewWrapper>
  );
}

/**
 * `:person[Name]{id}`: a workspace member. They are picked in the `@` picker (menus/people.tsx),
 * which "/person" opens too; a chip with no one in it yet (an older draft) opens that picker when
 * chosen.
 */
function PersonChip({ node, selected, editor, getPos }: ReactNodeViewProps) {
  const host = useHost();
  const id = String((node.attrs.attributes ?? {}).id ?? "");
  const label = String(node.attrs.label ?? "");
  if (!id && !host.readOnly) {
    const pick = () => {
      const pos = typeof getPos === "function" ? getPos() : undefined;
      const open = services(editor).openPeople;
      if (typeof pos === "number" && open) open(editor, { from: pos, to: pos + node.nodeSize });
    };
    return (
      <NodeViewWrapper as="span" className={cx("dxe-mention-wrap", selected && "dxe-selected")} contentEditable={false}>
        <button type="button" className="pb-mention pb-mention--person" onClick={pick} aria-label="Pick someone to mention">
          <span aria-hidden>@</span>
          <span>Pick someone</span>
        </button>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper as="span" className={cx("dxe-mention-wrap", selected && "dxe-selected")} contentEditable={false}>
      <span className="pb-mention pb-mention--person">
        <span aria-hidden>@</span>
        <span className="ph-mask">{label || "a person"}</span>
      </span>
    </NodeViewWrapper>
  );
}

function ItemMention({ node, updateAttributes, deleteNode, selected, editor }: ReactNodeViewProps) {
  const host = useHost();
  const pages = host.pages;
  const a = (node.attrs.attributes ?? {}) as Record<string, string>;
  const slug = a.src?.trim() || null;
  const resolved = useResolved(pages, slug);
  const [picking, setPicking] = useState(!slug && !host.readOnly && !!pages);
  const label = String(node.attrs.label ?? "");
  const chip = useMemo(() => {
    if (pages) return pages.renderMention({ slug, label, resolved });
    return (
      <span className="pb-mention">
        <Icon name="link" size={13} aria-hidden />
        <span>{label || slug || "Mention"}</span>
      </span>
    );
  }, [pages, slug, label, resolved]);

  return (
    <NodeViewWrapper as="span" className={cx("dxe-mention-wrap", selected && "dxe-selected")} contentEditable={false}>
      {/* A click selects the chip in the editor; it doesn't follow the link while writing. */}
      <span onClickCapture={(e) => e.preventDefault()}>{slug ? chip : <span className="pb-mention pb-mention--loading">Choose an item…</span>}</span>
      {pages && (
        <PageItemPicker
          open={picking}
          onClose={() => {
            setPicking(false);
            if (!slug) deleteNode();
          }}
          onPick={(it) => {
            setPicking(false);
            updateAttributes({ label: (it.title || it.slug).replace(/[[\]\\\n\r]+/g, " ").trim(), attributes: { src: it.slug } });
            refocusAfterDialog(editor);
          }}
          host={pages}
          purpose="mention"
        />
      )}
    </NodeViewWrapper>
  );
}
