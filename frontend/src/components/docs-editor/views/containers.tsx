"use client";

/**
 * Node views for the directive containers. Each renders with the published docs' classes (Alert
 * markup for callouts, dx-steps / dx-tabs / dx-cards / dx-details) so a page looks like it will
 * once published, plus the controls to change what the Markdown can express: callout kind and
 * title, tab names, card title / link / icon, the details summary.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { Dropdown, Icon, IconButton, Badge } from "@/components/ui";
import { labelText, textLabel } from "../core/fence.mjs";
import { useHost } from "../host";
import { cardColumns } from "@/docs/render/rules.mjs";
import { cardAt } from "../core/cards.mjs";
import { IconPicker, LabelInput, childPositions, cx, setAttrsAt, withAttr } from "./shared";
import { focusGripAt, pressCardGrip, stepCardIn } from "./cardDrag";
import { EmojiPicker } from "./EmojiPicker";

/** Notion's block colours (a page's callout backgrounds; styles in pages.css `.pb-bg-*`). */
export const BLOCK_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/* ── Callout ─────────────────────────────────────────────────────────────── */

export const CALLOUT_KINDS = {
  note: { label: "Note", tone: "info", icon: "info" },
  tip: { label: "Tip", tone: "success", icon: "bulb" },
  warning: { label: "Warning", tone: "warning", icon: "alert" },
  danger: { label: "Danger", tone: "danger", icon: "alertCircle" },
} as const;
type Kind = keyof typeof CALLOUT_KINDS;

/** Replaces a container node by its children (the "Remove … keep content" action). */
function unwrap({ editor, node, getPos }: Pick<ReactNodeViewProps, "editor" | "node" | "getPos">) {
  const pos = getPos();
  if (typeof pos !== "number") return;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(pos, pos + node.nodeSize, node.content);
      return true;
    })
    .run();
}

export function CalloutView(props: ReactNodeViewProps) {
  const { node, updateAttributes, deleteNode } = props;
  const host = useHost();
  const kind = (node.attrs.kind in CALLOUT_KINDS ? node.attrs.kind : "note") as Kind;
  const k = CALLOUT_KINDS[kind];
  // A page's callout can have its own emoji and a background colour ({icon="🚀" color=blue}).
  const a = (node.attrs.attributes ?? {}) as Record<string, string>;
  const [picking, setPicking] = useState(false);
  const setA = (patch: Record<string, string | null>) => {
    const next: Record<string, string> = { ...a };
    for (const [key, v] of Object.entries(patch)) {
      if (v) next[key] = v;
      else delete next[key];
    }
    updateAttributes({ attributes: next });
  };
  const color = BLOCK_COLORS.includes(a.color) ? a.color : null;
  return (
    <NodeViewWrapper className={cx("md-alert", `md-alert--${k.tone}`, "dx-callout", `dx-callout--${kind}`, "dxe-callout", color && `pb-bg-${color}`)} data-kind={kind}>
      <span contentEditable={false} className="dxe-callout__kind">
        <Dropdown
          aria-label="Callout type"
          align="left"
          portal
          trigger={
            <button type="button" className="dxe-callout__kindbtn" aria-label={`${k.label} callout: change type`} disabled={host.readOnly}>
              {a.icon ? <span className="dxe-callout__emoji">{a.icon}</span> : <Icon name={k.icon} />}
            </button>
          }
          items={[
            ...(Object.keys(CALLOUT_KINDS) as Kind[]).map((key) => ({
              label: CALLOUT_KINDS[key].label,
              icon: CALLOUT_KINDS[key].icon,
              onClick: () => updateAttributes({ kind: key }),
            })),
            ...(host.pages
              ? [
                  { label: a.icon ? "Change icon…" : "Choose an icon…", icon: "sparkle", separated: true, onClick: () => setPicking(true) },
                  ...(a.icon ? [{ label: "Remove icon", icon: "x", onClick: () => setA({ icon: null }) }] : []),
                  { header: "Background", separated: true },
                  { label: `${!color ? "✓ " : ""}Default`, onClick: () => setA({ color: null }) },
                  ...BLOCK_COLORS.map((c) => ({ label: `${color === c ? "✓ " : ""}${c[0].toUpperCase()}${c.slice(1)}`, tile: <span className={`pb-swatch pb-bg-${c}`} />, onClick: () => setA({ color: c }) })),
                ]
              : []),
            { label: "Remove callout, keep text", icon: "x", separated: true, onClick: () => unwrap(props) },
            { label: "Delete callout", icon: "trash", danger: true, onClick: () => deleteNode() },
          ]}
        />
        {picking && <EmojiPicker onPick={(e) => { setA({ icon: e }); setPicking(false); }} onRemove={a.icon ? () => { setA({ icon: null }); setPicking(false); } : undefined} onClose={() => setPicking(false)} />}
      </span>
      <div className="md-alert__main">
        <span contentEditable={false} className="dxe-callout__title">
          <LabelInput
            className="md-alert__title"
            label={node.attrs.label}
            placeholder={`${k.label} title (optional)`}
            aria-label={`${k.label} title`}
            readOnly={host.readOnly}
            onChange={(label) => updateAttributes({ label })}
          />
        </span>
        <NodeViewContent className="md-alert__body" />
      </div>
    </NodeViewWrapper>
  );
}

/* ── Steps ───────────────────────────────────────────────────────────────── */

export function StepsView({ node, editor, getPos }: ReactNodeViewProps) {
  const host = useHost();
  let depth = 3;
  let count = 0;
  node.forEach((c) => {
    if (c.type.name === "heading" && !count) depth = c.attrs.level;
  });
  node.forEach((c) => {
    if (c.type.name === "heading" && c.attrs.level === depth) count++;
  });
  const addStep = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const end = pos + node.nodeSize - 1;
    editor
      .chain()
      .focus()
      .command(({ tr, state }) => {
        const s = state.schema;
        tr.insert(end, [s.nodes.heading.create({ level: depth }), s.nodes.paragraph.create()]);
        tr.setSelection(TextSelection.create(tr.doc, end + 1));
        return true;
      })
      .run();
  };
  return (
    <NodeViewWrapper className="dxe-block dxe-steps" data-depth={depth}>
      <NodeViewContent className="dxe-steps__body" />
      {!host.readOnly && (
        <div contentEditable={false} className="dxe-blockbar">
          <button type="button" className="dxe-linkbtn" onClick={addStep}>
            <Icon name="plus" /> Add step {count + 1}
          </button>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */

export function TabsView(props: ReactNodeViewProps) {
  const { node, editor, getPos, updateAttributes, deleteNode } = props;
  const host = useHost();
  const [active, setActive] = useState(0);
  const labels: string[] = [];
  node.forEach((c) => labels.push(labelText(c.attrs.label)));
  const current = Math.min(active, labels.length - 1);
  const sync = (node.attrs.attributes ?? {}).sync as string | undefined;

  // Follow the cursor: moving into a hidden pane shows it.
  useEffect(() => {
    const onSel = () => {
      const pos = getPos();
      if (typeof pos !== "number") return;
      const { from } = editor.state.selection;
      if (from <= pos || from >= pos + node.nodeSize) return;
      const kids = childPositions(node, pos);
      let i = kids.length - 1;
      while (i > 0 && kids[i] > from) i--;
      setActive(i);
    };
    editor.on("selectionUpdate", onSel);
    return () => {
      editor.off("selectionUpdate", onSel);
    };
  }, [editor, getPos, node]);

  const focusPane = (i: number) => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const p = childPositions(node, pos)[i];
    if (p === undefined) return;
    editor.chain().focus().setTextSelection(p + 2).run();
  };
  const addTab = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const end = pos + node.nodeSize - 1;
    editor
      .chain()
      .command(({ tr, state }) => {
        const s = state.schema;
        tr.insert(end, s.nodes.tab.create({ label: textLabel(`Tab ${labels.length + 1}`) }, s.nodes.paragraph.create()));
        return true;
      })
      .run();
    setActive(labels.length);
  };
  const removeTab = (i: number) => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    if (labels.length <= 1) return deleteNode();
    const p = childPositions(node, pos)[i];
    const child = node.child(i);
    editor.chain().command(({ tr }) => {
      tr.delete(p, p + child.nodeSize);
      return true;
    }).run();
    setActive(Math.max(0, i - 1));
  };
  const moveTab = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= labels.length) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    const kids: ReturnType<typeof node.child>[] = [];
    node.forEach((c) => kids.push(c));
    [kids[i], kids[j]] = [kids[j], kids[i]];
    editor.chain().command(({ tr }) => {
      tr.replaceWith(pos + 1, pos + node.nodeSize - 1, kids);
      return true;
    }).run();
    setActive(j);
  };

  return (
    <NodeViewWrapper className="dx-tabs dxe-tabs" data-active={current}>
      <div contentEditable={false} className="dxe-tabbar dx-tabs__list">
        <div role="tablist" aria-label="Tabs" className="dxe-tabbar__tabs">
          {labels.map((l, i) =>
            i === current && !host.readOnly ? (
              <input
                key={i}
                role="tab"
                aria-selected
                className="dxe-tabbar__tab dxe-tabbar__tab--on"
                value={l}
                size={Math.max(4, l.length + 1)}
                aria-label={`Tab ${i + 1} name`}
                onChange={(e) => {
                  const pos = getPos();
                  if (typeof pos === "number") setAttrsAt(editor, childPositions(node, pos)[i], { label: textLabel(e.target.value) });
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" && e.currentTarget.selectionStart === l.length && i < labels.length - 1) setActive(i + 1);
                  else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0 && i > 0) setActive(i - 1);
                  else if (e.key === "Enter" || e.key === "ArrowDown") {
                    e.preventDefault();
                    focusPane(i);
                  }
                }}
              />
            ) : (
              <button key={i} type="button" role="tab" aria-selected={i === current} className={cx("dxe-tabbar__tab", i === current && "dxe-tabbar__tab--on")} onClick={() => setActive(i)}>
                {l || `Tab ${i + 1}`}
              </button>
            ),
          )}
        </div>
        {sync && (
          <Badge size="sm" icon="refresh">
            {sync}
          </Badge>
        )}
        {!host.readOnly && (
          <>
            <IconButton icon="plus" label="Add tab" size="sm" onClick={addTab} />
            <Dropdown
              aria-label="Tab actions"
              portal
              trigger={<IconButton icon="more" label="Tab actions" size="sm" />}
              items={[
                { label: "Move tab left", icon: "arrowLeft", disabled: current === 0, onClick: () => moveTab(current, -1) },
                { label: "Move tab right", icon: "arrowRight", disabled: current === labels.length - 1, onClick: () => moveTab(current, 1) },
                {
                  label: sync ? `Stop syncing "${sync}"` : "Sync with other tab groups…",
                  icon: "refresh",
                  onClick: () => {
                    const key = sync ? "" : window.prompt("Tab groups with the same key switch together (for example os, lang):", "os") ?? "";
                    updateAttributes({ attributes: withAttr(node.attrs.attributes, "sync", key.trim()) });
                  },
                },
                { label: "Delete this tab", icon: "trash", danger: true, separated: true, onClick: () => removeTab(current) },
                { label: "Delete all tabs", icon: "trash", danger: true, onClick: () => deleteNode() },
              ]}
            />
          </>
        )}
      </div>
      <NodeViewContent className="dx-tabs__panel dxe-tabs__panes" />
    </NodeViewWrapper>
  );
}

/* ── Cards ───────────────────────────────────────────────────────────────── */

export function CardsView({ node, editor, getPos, updateAttributes }: ReactNodeViewProps) {
  const host = useHost();
  const addCard = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const end = pos + node.nodeSize - 1;
    editor
      .chain()
      .focus()
      .command(({ tr, state }) => {
        const s = state.schema;
        tr.insert(end, s.nodes.card.create({ label: null, attributes: { icon: "doc" } }, s.nodes.paragraph.create()));
        tr.setSelection(TextSelection.create(tr.doc, end + 2));
        return true;
      })
      .run();
  };
  const attrs = (node.attrs.attributes ?? {}) as Record<string, string>;
  // The same columns the published guide uses (rules.mjs cardColumns: `cols`, else from the count).
  const cols = cardColumns(node.childCount, attrs.cols);
  return (
    <NodeViewWrapper className="dxe-block dxe-cards">
      <NodeViewContent className="dx-cards dxe-cards__grid" data-cols={cols} style={{ "--dx-cols": cols } as CSSProperties} />
      {!host.readOnly && (
        <div contentEditable={false} className="dxe-blockbar">
          <button type="button" className="dxe-linkbtn" onClick={addCard}>
            <Icon name="plus" /> Add card
          </button>
          <label className="dxe-cards__cols">
            <span>Columns</span>
            <select
              value={/^[1-4]$/.test(attrs.cols ?? "") ? attrs.cols : ""}
              aria-label="Columns"
              onChange={(e) => updateAttributes({ attributes: withAttr(attrs, "cols", e.target.value) })}
            >
              <option value="">Auto ({cardColumns(node.childCount)})</option>
              {["1", "2", "3", "4"].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** Where a card sits in its grid, read when its grip is used (siblings change without re-rendering it). */
function cardPlace(editor: ReactNodeViewProps["editor"], getPos: ReactNodeViewProps["getPos"]) {
  const pos = getPos();
  const c = typeof pos === "number" ? cardAt(editor.state.doc, pos) : null;
  if (!c) return { index: 0, count: 1, vertical: false };
  const cols = cardColumns(c.grid.childCount, ((c.grid.attrs.attributes ?? {}) as Record<string, string>).cols);
  return { index: c.index, count: c.grid.childCount, vertical: cols === 1 };
}

export function CardView({ node, editor, getPos, updateAttributes, deleteNode }: ReactNodeViewProps) {
  const host = useHost();
  const [menu, setMenu] = useState(false);
  const attrs = (node.attrs.attributes ?? {}) as Record<string, string>;
  const title = labelText(node.attrs.label);
  const place = cardPlace(editor, getPos);
  const [earlier, later] = place.vertical ? ["Move up", "Move down"] : ["Move left", "Move right"];
  const step = (dir: -1 | 1, refocus: boolean) => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const at = stepCardIn(editor, pos, dir);
    if (at !== null && refocus) focusGripAt(editor, at);
  };
  return (
    <NodeViewWrapper className={cx("dx-card", attrs.href && "dx-card--link", attrs.cover && "dx-card--cover", "dxe-card")}>
      {attrs.cover && (
        <span contentEditable={false} className="dx-card__cover" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={host.resolveAsset(attrs.cover)} alt="" />
        </span>
      )}
      <div contentEditable={false} className="dxe-card__head">
        <IconPicker
          className="dx-card__icon"
          value={attrs.icon}
          label="Card icon"
          readOnly={host.readOnly}
          onChange={(icon) => updateAttributes({ attributes: withAttr(attrs, "icon", icon ?? "") })}
        />
        {!host.readOnly && (
          <span className={cx("dxe-card__tools", menu && "dxe-card__tools--on")}>
            <Dropdown
              open={menu}
              onOpenChange={setMenu}
              align="right"
              portal
              aria-label="Card actions"
              trigger={
                <button
                  type="button"
                  className="dxe-card__grip"
                  aria-label={`Move card${title ? ` “${title}”` : ""}, ${place.index + 1} of ${place.count}`}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
                  title={`Drag to move · click for options · Alt+arrows move it`}
                  onPointerDown={(e) => pressCardGrip(e, editor, getPos, title)}
                  onKeyDown={(e) => {
                    if (!e.altKey || e.metaKey || e.ctrlKey) return;
                    const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
                    if (!dir) return;
                    e.preventDefault();
                    step(dir, true);
                  }}
                >
                  <Icon name="grip" />
                </button>
              }
              items={[
                { label: earlier, icon: place.vertical ? "arrowUp" : "arrowLeft", kbd: place.vertical ? "Alt ↑" : "Alt ←", disabled: place.index === 0, onClick: () => step(-1, false) },
                { label: later, icon: place.vertical ? "arrowDown" : "arrowRight", kbd: place.vertical ? "Alt ↓" : "Alt →", disabled: place.index >= place.count - 1, onClick: () => step(1, false) },
                { label: "Delete card", icon: "trash", danger: true, separated: true, onClick: () => deleteNode() },
              ]}
            />
            <IconButton icon="trash" label="Delete card" size="sm" className="dxe-card__del" onClick={() => deleteNode()} />
          </span>
        )}
      </div>
      <span contentEditable={false} className="dxe-card__fields">
        <LabelInput className="dx-card__title" label={node.attrs.label} placeholder="Card title" aria-label="Card title" readOnly={host.readOnly} onChange={(label) => updateAttributes({ label })} />
        <span className="dxe-card__href">
          <Icon name="link" />
          <input
            value={attrs.href ?? ""}
            placeholder="/page or https://…"
            aria-label="Card link"
            readOnly={host.readOnly}
            onChange={(e) => updateAttributes({ attributes: withAttr(attrs, "href", e.target.value.trim()) })}
          />
        </span>
      </span>
      <NodeViewContent className="dx-card__body" />
    </NodeViewWrapper>
  );
}

/* ── Private section ─────────────────────────────────────────────────────── */

/**
 * `:::private[title]{access="<rule>"}`: who may see it (the guide's rules, from the host), an
 * optional title readers without access see on the lock card, and the content.
 */
export function PrivateView({ node, updateAttributes }: ReactNodeViewProps) {
  const host = useHost();
  const attrs = (node.attrs.attributes ?? {}) as Record<string, string>;
  const access = attrs.access || "members";
  const rules = host.accessRules ?? [];
  const known = rules.some((r) => r.id === access);
  return (
    <NodeViewWrapper className="dxe-private" data-access={access}>
      <div contentEditable={false} className="dxe-private__head">
        <Icon name="lock" className="dxe-private__icon" />
        <span className="dxe-private__kicker">Private section</span>
        <label className="dxe-private__who">
          <span className="sr-only">Who can see this section</span>
          <select
            value={access}
            disabled={host.readOnly}
            aria-label="Who can see this section"
            onChange={(e) => updateAttributes({ attributes: withAttr(attrs, "access", e.target.value) })}
          >
            {!known && <option value={access}>{access} (not a rule on this guide)</option>}
            {(rules.length ? rules : [{ id: "members", name: "Team members", kind: "members" }]).map((r) => (
              <option key={r.id} value={r.id}>
                {r.kind === "members" ? "Team members" : r.kind === "password" ? `${r.name} (password)` : r.name}
              </option>
            ))}
          </select>
        </label>
        <LabelInput label={node.attrs.label} placeholder="Title readers see on the lock (optional)" aria-label="Private section title" readOnly={host.readOnly} onChange={(label) => updateAttributes({ label })} />
      </div>
      <NodeViewContent className="dxe-private__body" />
    </NodeViewWrapper>
  );
}

/* ── Details ─────────────────────────────────────────────────────────────── */

export function DetailsView({ node, updateAttributes, editor, getPos }: ReactNodeViewProps) {
  const host = useHost();
  const [open, setOpen] = useState(true);
  return (
    <NodeViewWrapper className="dx-details dxe-details" data-open={open ? "" : undefined}>
      <div contentEditable={false} className="dxe-details__summary">
        <button type="button" className="dxe-details__toggle" aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)}>
          <Icon name="chevronRight" className="dx-details__chev" />
        </button>
        {node.attrs.label == null && typeof node.attrs.attributes?.summary === "string" ? (
          // A page's toggle keeps its summary as `{summary="…"}`.
          <LabelInput
            label={node.attrs.attributes.summary}
            className={/^[123]$/.test(String(node.attrs.attributes.heading ?? "")) ? `dxe-details__h dxe-details__h--${node.attrs.attributes.heading}` : undefined}
            placeholder={node.attrs.attributes.heading ? `Toggle heading ${node.attrs.attributes.heading}` : "Toggle"}
            aria-label="Toggle summary"
            autoFocus={!host.readOnly && !node.attrs.attributes.summary && !!node.attrs.attributes.heading}
            onEnter={() => {
              const pos = getPos();
              if (typeof pos !== "number") return;
              editor.chain().setTextSelection(pos + 2).run();
              editor.view.focus();
            }}
            readOnly={host.readOnly}
            onChange={(summary) => updateAttributes({ attributes: { ...node.attrs.attributes, summary: summary ?? "" } })}
          />
        ) : (
          <LabelInput label={node.attrs.label} placeholder="Summary" aria-label="Details summary" readOnly={host.readOnly} onChange={(label) => updateAttributes({ label })} />
        )}
      </div>
      <NodeViewContent className="dx-details__body" />
    </NodeViewWrapper>
  );
}
