"use client";

/**
 * The button block (`:::button{label="Add a task"}` holding the blocks it inserts), Notion's
 * template button: clicking it puts a copy of its blocks right after it. The blocks are edited in
 * place below the button. Readers don't see buttons (they only work while editing).
 */
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Fragment } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { Icon } from "@/components/ui";
import { useHost } from "../host";
import { anchors, withoutAnchors } from "../menus/blockOps";

export function ButtonView({ node, updateAttributes, editor, getPos }: ReactNodeViewProps) {
  const host = useHost();
  const label = String(node.attrs.attributes?.label ?? "");
  const insert = () => {
    const pos = getPos();
    if (typeof pos !== "number" || !editor.isEditable) return;
    const at = pos + node.nodeSize;
    const copy = withoutAnchors(Fragment.from(node.content), anchors(editor.state.doc));
    const tr = editor.state.tr.insert(at, copy);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + copy.size, tr.doc.content.size)), -1));
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
  };
  return (
    <NodeViewWrapper className="dxe-button">
      <div contentEditable={false} className="dxe-button__row">
        <button type="button" className="dxe-button__btn" onClick={insert} disabled={host.readOnly} title="Insert a copy of the blocks below">
          <Icon name="plus" size={14} aria-hidden /> {label || "Button"}
        </button>
        <input
          className="dxe-button__label"
          value={label}
          placeholder="Button label"
          aria-label="Button label"
          readOnly={host.readOnly}
          onChange={(e) => updateAttributes({ attributes: { ...(node.attrs.attributes ?? {}), label: e.target.value.replace(/"/g, "”") } })}
        />
      </div>
      <p contentEditable={false} className="dxe-button__hint">The button inserts these blocks:</p>
      <NodeViewContent className="dxe-button__tpl" />
    </NodeViewWrapper>
  );
}
