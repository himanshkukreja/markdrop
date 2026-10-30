"use client";

/**
 * Node views for the directive containers. Each renders with the published docs' classes (Alert
 * markup for callouts, dx-steps / dx-tabs / dx-cards / dx-details) so a page looks like it will
 * once published, plus the controls to change what the Markdown can express: callout kind and
 * title, tab names, card title / link / icon, the details summary.
 */
import { useEffect, useState } from "react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { Dropdown, Icon, IconButton, Badge } from "@/components/ui";
import { labelText, textLabel } from "../core/fence.mjs";
import { useHost } from "../host";
import { IconPicker, LabelInput, childPositions, cx, setAttrsAt, withAttr } from "./shared";

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
  return (
    <NodeViewWrapper className={cx("md-alert", `md-alert--${k.tone}`, "dx-callout", `dx-callout--${kind}`, "dxe-callout")} data-kind={kind}>
      <span contentEditable={false} className="dxe-callout__kind">
        <Dropdown
          aria-label="Callout type"
          align="left"
          portal
          trigger={
            <button type="button" className="dxe-callout__kindbtn" aria-label={`${k.label} callout: change type`} disabled={host.readOnly}>
              <Icon name={k.icon} />
            </button>
          }
          items={[
            ...(Object.keys(CALLOUT_KINDS) as Kind[]).map((key) => ({
              label: CALLOUT_KINDS[key].label,
              icon: CALLOUT_KINDS[key].icon,
              onClick: () => updateAttributes({ kind: key }),
            })),
            { label: "Remove callout, keep text", icon: "x", separated: true, onClick: () => unwrap(props) },
            { label: "Delete callout", icon: "trash", danger: true, onClick: () => deleteNode() },
          ]}
        />
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

export function CardsView({ node, editor, getPos }: ReactNodeViewProps) {
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
  return (
    <NodeViewWrapper className="dxe-block dxe-cards">
      <NodeViewContent className="dx-cards dxe-cards__grid" />
      {!host.readOnly && (
        <div contentEditable={false} className="dxe-blockbar">
          <button type="button" className="dxe-linkbtn" onClick={addCard}>
            <Icon name="plus" /> Add card
          </button>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export function CardView({ node, updateAttributes, deleteNode }: ReactNodeViewProps) {
  const host = useHost();
  const attrs = (node.attrs.attributes ?? {}) as Record<string, string>;
  return (
    <NodeViewWrapper className={cx("dx-card", attrs.href && "dx-card--link", "dxe-card")}>
      <div contentEditable={false} className="dxe-card__head">
        <IconPicker
          className="dx-card__icon"
          value={attrs.icon}
          label="Card icon"
          readOnly={host.readOnly}
          onChange={(icon) => updateAttributes({ attributes: withAttr(attrs, "icon", icon ?? "") })}
        />
        {!host.readOnly && <IconButton icon="trash" label="Delete card" size="sm" className="dxe-card__del" onClick={() => deleteNode()} />}
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

/* ── Details ─────────────────────────────────────────────────────────────── */

export function DetailsView({ node, updateAttributes }: ReactNodeViewProps) {
  const host = useHost();
  const [open, setOpen] = useState(true);
  return (
    <NodeViewWrapper className="dx-details dxe-details" data-open={open ? "" : undefined}>
      <div contentEditable={false} className="dxe-details__summary">
        <button type="button" className="dxe-details__toggle" aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)}>
          <Icon name="chevronRight" className="dx-details__chev" />
        </button>
        <LabelInput label={node.attrs.label} placeholder="Summary" aria-label="Details summary" readOnly={host.readOnly} onChange={(label) => updateAttributes({ label })} />
      </div>
      <NodeViewContent className="dx-details__body" />
    </NodeViewWrapper>
  );
}
