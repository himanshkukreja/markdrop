/**
 * remark plugin for pages (documents in the block editor): turns the block syntax into plain
 * elements carrying `data-pb` markers, which PageRenderer's components draw. Runs before the
 * sanitizer, which keeps exactly these markers and nothing an author could add (no raw HTML).
 *
 *   :::note|tip|warning|danger[Title]   → <div data-pb="callout" data-kind data-label>
 *   :::details{summary="…"} / [label]   → <details data-pb="details" data-label>
 *   ::markdrop{src mode title}          → <div data-pb="embed" data-src data-mode data-label>
 *   :markdrop[Title]{src}               → <span data-pb="mention" data-src data-label>
 *   :kbd[⌘ K]                           → <kbd>
 *   ![alt](asset:<id>)                  → the viewer's URL for that page image (or a placeholder)
 *
 * A directive pages don't know is shown as the text it was written as, never dropped silently.
 */
import { assetId, embedMode, embedSlug } from "@/lib/pageBlocks.mjs";
import { ANCHOR_RE, COLORS, attrLine, spanColor, trailingAttrs } from "@/components/docs-editor/core/attrs.mjs";

/** mdast blocks that take a line of attributes after them, and which attributes. */
const ATTR_LINE: Record<string, string> = { table: "table", code: "codeBlock", math: "mathBlock", thematicBreak: "horizontalRule" };

/** `data-*` properties for a block's attributes (`{#b-x color=red bg=…}` and friends). */
function blockProps(a: Record<string, string> | null | undefined): Record<string, unknown> {
  if (!a) return {};
  const p: Record<string, unknown> = {};
  if (a.id && ANCHOR_RE.test(a.id)) p.dataBid = a.id;
  if (a.color && COLORS.includes(a.color)) p.dataColor = a.color;
  if (a.bg && COLORS.includes(a.bg)) p.dataBg = a.bg;
  if (a.width) p.dataWidth = a.width;
  if (a.align) p.dataAlign = a.align;
  if (a.widths) p.dataWidths = a.widths;
  if (a["header-column"] !== undefined) p.dataHcol = "";
  if (a["header-row"] === "off") p.dataHrow = "off";
  if (a.caption) p.dataCaption = a.caption;
  return p;
}

function addProps(node: MdNode, props: Record<string, unknown>) {
  if (!Object.keys(props).length) return;
  node.data = { ...(node.data ?? {}), hProperties: { ...((node.data?.hProperties as Record<string, unknown>) ?? {}), ...props } };
}

interface MdNode {
  type: string;
  name?: string;
  value?: string;
  url?: string;
  alt?: string | null;
  attributes?: Record<string, string | null | undefined> | null;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown>; directiveLabel?: boolean; [k: string]: unknown };
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

const CALLOUTS = new Set(["note", "tip", "warning", "danger", "info", "caution"]);
const CALLOUT_KIND: Record<string, string> = { info: "note", caution: "warning" };

function textOf(n: MdNode): string {
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(textOf).join("");
}

function takeLabel(node: MdNode): string | undefined {
  const first = node.children?.[0];
  if (first && first.type === "paragraph" && first.data?.directiveLabel) {
    node.children!.shift();
    return textOf(first).trim();
  }
  return undefined;
}

function set(node: MdNode, hName: string, props: Record<string, unknown>) {
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== null && v !== "") p[k] = v;
  node.data = { ...(node.data ?? {}), hName, hProperties: p };
}

const attr = (n: MdNode, k: string) => {
  const v = n.attributes?.[k];
  return typeof v === "string" ? v : undefined;
};

export interface PageBlocksOptions {
  /** Page images: `asset:<id>` → the URL this viewer may load. */
  assets?: Record<string, { url: string } | undefined> | null;
}

export function remarkPageBlocks(options: PageBlocksOptions = {}) {
  const assets = options.assets ?? {};
  return (tree: MdNode, file: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : "";
    const sourceOf = (n: MdNode) => {
      const a = n.position?.start?.offset, b = n.position?.end?.offset;
      return typeof a === "number" && typeof b === "number" ? source.slice(a, b) : `:${n.name ?? ""}`;
    };
    /** Drops a trailing `{…}` attribute list from a paragraph-like node: its attributes, or null. */
    const trail = (n: MdNode, kind: string): Record<string, string> | null => {
      const kids = n.children ?? [];
      const last = kids[kids.length - 1];
      if (!last || last.type !== "text") return null;
      const t = trailingAttrs(sourceOf(last), kind);
      if (!t) return null;
      const value = (last.value ?? "").replace(/[ \t]*\{[^{}\n]*\}[ \t]*$/, "");
      if (value === last.value || (!value && kids.length === 1)) return null;
      if (value) last.value = value;
      else kids.pop();
      return t.attrs;
    };
    const anchorOf = (n: MdNode) => {
      const id = attr(n, "id");
      return id && ANCHOR_RE.test(id) ? id : undefined;
    };
    const visit = (node: MdNode, parent: MdNode | null, index: number) => {
      // A table, code block, divider or equation followed by its line of attributes.
      const kids = node.children;
      if (kids) {
        for (let i = 0; i < kids.length - 1; i++) {
          const kind = ATTR_LINE[kids[i].type];
          const next = kids[i + 1];
          if (!kind || next.type !== "paragraph") continue;
          const line = sourceOf(next);
          const a = line.includes("\n") ? null : attrLine(line, kind);
          if (!a) continue;
          addProps(kids[i], blockProps(a));
          kids.splice(i + 1, 1);
        }
      }
      switch (node.type) {
        case "paragraph": {
          const k = node.children ?? [];
          const img = k[0]?.type === "image" && (k.length === 1 || (k.length === 2 && k[1].type === "text")) ? k[0] : null;
          const figAttrs = img && k.length === 2 ? trail(node, "figure") : null;
          if (img && node.children!.length === 1) {
            // A paragraph that is one image: a figure (width, alignment, caption, full-screen view).
            set(node, "div", { dataPb: "figure", ...blockProps(figAttrs) });
            addProps(img, { dataBlock: "1", ...blockProps(figAttrs) });
          } else {
            const a = trail(node, "paragraph");
            // A tight list item's paragraph isn't an element of its own: the item carries them.
            if (a) addProps(parent?.type === "listItem" && index === 0 ? parent : node, blockProps(a));
          }
          break;
        }
        case "heading":
          addProps(node, blockProps(trail(node, "heading")));
          break;
        case "tableCell":
          addProps(node, blockProps(trail(node, "cell")));
          break;
        case "containerDirective": {
          const name = node.name ?? "";
          if (CALLOUTS.has(name)) {
            set(node, "div", { dataPb: "callout", dataKind: CALLOUT_KIND[name] ?? name, dataLabel: takeLabel(node) || attr(node, "title"), dataIcon: attr(node, "icon"), dataColor: attr(node, "color"), dataBid: anchorOf(node) });
          } else if (name === "details") {
            const label = takeLabel(node) || attr(node, "summary") || attr(node, "title") || "Details";
            const heading = /^[123]$/.test(attr(node, "heading") ?? "") ? attr(node, "heading") : undefined;
            const color = attr(node, "color"), bg = attr(node, "bg");
            set(node, "details", { dataPb: "details", dataLabel: label, dataHeading: heading, dataBid: anchorOf(node), dataColor: color && COLORS.includes(color) ? color : undefined, dataBg: bg && COLORS.includes(bg) ? bg : undefined });
          } else if (name === "columns") {
            takeLabel(node);
            set(node, "div", { dataPb: "columns", dataBid: anchorOf(node) });
          } else if (name === "column" && parent?.name === "columns") {
            takeLabel(node);
            const w = attr(node, "width");
            set(node, "div", { dataPb: "column", dataWidth: w && /^\d{1,3}(?:\.\d+)?%$/.test(w) ? w : undefined });
          } else if (name === "indent") {
            takeLabel(node);
            set(node, "div", { dataPb: "indent", dataBid: anchorOf(node) });
          } else if (name === "button" && parent) {
            // A button inserts its blocks while editing; readers don't see it (as in Notion).
            parent.children!.splice(index, 1);
            return;
          } else {
            // Unknown container (e.g. Guides-only blocks): its content, without the fences' meaning.
            takeLabel(node);
            set(node, "div", { dataPb: "unknown" });
          }
          break;
        }
        case "leafDirective": {
          if (node.name === "markdrop") {
            const slug = embedSlug(attr(node, "src"));
            const label = takeLeafLabel(node);
            set(node, "div", { dataPb: "embed", dataSrc: slug ?? "", dataMode: embedMode(attr(node, "mode")), dataLabel: attr(node, "title") || label });
            node.children = [];
          } else if (node.name === "bookmark") {
            set(node, "div", { dataPb: "bookmark", dataUrl: attr(node, "url"), dataTitle: attr(node, "title"), dataDesc: attr(node, "description"), dataImage: attr(node, "image"), dataSite: attr(node, "site") });
            node.children = [];
          } else if (node.name === "toc" || node.name === "breadcrumb") {
            set(node, "div", { dataPb: node.name });
            node.children = [];
          } else if (node.name === "page") {
            set(node, "div", { dataPb: "subpage", dataSrc: embedSlug(attr(node, "src")) ?? "" });
            node.children = [];
          } else if (node.name === "embed") {
            set(node, "div", { dataPb: "webembed", dataUrl: attr(node, "src"), dataTitle: attr(node, "title") });
            node.children = [];
          } else if (parent) {
            parent.children![index] = { type: "paragraph", children: [{ type: "text", value: sourceOf(node) }] };
            return;
          }
          if (anchorOf(node)) addProps(node, { dataBid: anchorOf(node) });
          break;
        }
        case "textDirective": {
          if (node.name === "markdrop") {
            const slug = embedSlug(attr(node, "src"));
            set(node, "span", { dataPb: "mention", dataSrc: slug ?? "", dataLabel: textOf(node).trim() });
            node.children = [];
          } else if (node.name === "date" && /^\d{4}-\d{2}-\d{2}$/.test(textOf(node).trim())) {
            set(node, "span", { dataPb: "date", dataLabel: textOf(node).trim() });
            node.children = [];
          } else if (node.name === "person") {
            set(node, "span", { dataPb: "person", dataLabel: textOf(node).trim() || "a person" });
            node.children = [];
          } else if (node.name === "kbd" && node.children?.length) {
            set(node, "kbd", { className: ["md-kbd"] });
          } else if (node.name === "span" && node.children?.length && /\]\{[^\n]*\}$/.test(sourceOf(node)) && spanColor(node.attributes as Record<string, string>)) {
            // `:span[text]{color=red}` / `{bg=yellow}`: Notion's colours.
            const c = spanColor(node.attributes as Record<string, string>)!;
            set(node, "span", { dataPb: "color", dataColor: c.color, dataBg: c.bg });
          } else if (node.name === "u" && node.children?.length && /\]$/.test(sourceOf(node))) {
            set(node, "u", {});
          } else if (parent) {
            parent.children![index] = { type: "text", value: sourceOf(node) };
            return;
          }
          break;
        }
        case "image": {
          const id = assetId(node.url);
          if (id) {
            const a = assets[id];
            if (a?.url) node.url = a.url;
            else {
              // Not (yet) resolved for this viewer: a placeholder, never the raw `asset:` address.
              set(node, "span", { dataPb: "asset", dataAsset: id, dataLabel: node.alt || "" });
              node.url = "";
            }
          }
          break;
        }
        default:
          break;
      }
      const list = node.children;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const before = list.length;
          visit(list[i], node, i);
          if (list.length < before) i -= before - list.length;
        }
      }
    };
    visit(tree, null, 0);
  };
}

/** A leaf directive's `[label]` (remark-directive keeps it as the leaf's children). */
function takeLeafLabel(node: MdNode): string | undefined {
  const t = textOf(node).trim();
  return t || undefined;
}
