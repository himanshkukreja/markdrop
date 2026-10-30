/**
 * The editor's document schema as TipTap extensions, without any React: the visual editor adds its
 * node views on top (`withNodeViews`), and the tests build the same ProseMirror schema from here
 * (`getSchema(baseExtensions())`), so what the tests round-trip is exactly what the editor holds.
 *
 * Node and mark names match markdown.mjs. Every attribute that carries meaning is also written to
 * the DOM as `data-*` and read back, so copy/paste inside the editor keeps it; `md` (the source
 * bookkeeping) is never rendered: a pasted block is written canonically.
 */
import { Extension, Mark, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";

/* ── attribute helpers ───────────────────────────────────────────────────── */

const MD = { default: null, rendered: false, keepOnSplit: false };

function str(name, def = null) {
  return {
    default: def,
    parseHTML: (el) => el.getAttribute(`data-${name}`) ?? def,
    renderHTML: (a) => (a[name] == null ? {} : { [`data-${name}`]: String(a[name]) }),
  };
}

function bool(name, def = false) {
  return {
    default: def,
    parseHTML: (el) => {
      const v = el.getAttribute(`data-${name}`);
      return v == null ? def : v === "true";
    },
    renderHTML: (a) => (a[name] == null ? {} : { [`data-${name}`]: String(a[name]) }),
  };
}

function json(name, def) {
  return {
    default: def,
    parseHTML: (el) => {
      const v = el.getAttribute(`data-${name}`);
      if (v == null) return def;
      try {
        return JSON.parse(v);
      } catch {
        return def;
      }
    },
    renderHTML: (a) => (a[name] == null ? {} : { [`data-${name}`]: JSON.stringify(a[name]) }),
  };
}

const directiveAttrs = () => ({ label: str("label"), attributes: json("attributes", {}), md: MD });

function container(name, content, extra = {}, attrs = {}) {
  return Node.create({
    name,
    group: "block",
    content,
    defining: true,
    draggable: true,
    ...extra,
    addAttributes() {
      return { ...directiveAttrs(), ...attrs };
    },
    parseHTML() {
      return [{ tag: `div[data-docs="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["div", mergeAttributes(HTMLAttributes, { "data-docs": name }), 0];
    },
  });
}

/* ── docs blocks ─────────────────────────────────────────────────────────── */

/** `:::note|tip|warning|danger[title]`. */
export const Callout = container("callout", "block+", {}, { kind: str("kind", "note") });
/** `::::steps`: each heading at the first heading's level starts a numbered step. */
export const Steps = container("steps", "block+");
/** `:::details[summary]`: a collapsible section. */
export const Details = container("details", "block+");
/** `::::tabs{sync}` holding `:::tab[label]` panes. */
export const Tabs = container("tabs", "tab+");
export const Tab = container("tab", "block+", { group: undefined, isolating: true, draggable: false });
/** `::::cards` holding `:::card[title]{href icon}`. */
export const Cards = container("cards", "card+");
export const Card = container("card", "block+", { group: undefined, isolating: true, draggable: true });

/** `::video{…}`, `::clip{…}`, `::embed{…}`, `::api{…}`: one line, edited through a form. */
export const DirectiveLeaf = Node.create({
  name: "directiveLeaf",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { name: str("name", "video"), ...directiveAttrs() };
  },
  parseHTML() {
    return [{ tag: "div[data-docs=directiveLeaf]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-docs": "directiveLeaf" })];
  },
});

/** A paragraph that is one image: the docs' figure (title = caption; a `.dark` file is its dark twin). */
export const Figure = Node.create({
  name: "figure",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { src: str("src", ""), alt: str("alt", ""), title: str("title"), md: MD };
  },
  parseHTML() {
    return [{ tag: "figure[data-docs=figure]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes(HTMLAttributes, { "data-docs": "figure" })];
  },
});

/** Source the visual editor doesn't model (HTML, definitions, unknown directives…), kept verbatim. */
export const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { value: str("value", ""), md: MD };
  },
  parseHTML() {
    return [{ tag: "div[data-docs=rawBlock]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-docs": "rawBlock" })];
  },
});

/** `$$ … $$`. */
export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes() {
    return { meta: str("meta"), md: MD };
  },
  parseHTML() {
    return [{ tag: "pre[data-docs=mathBlock]", preserveWhitespace: "full" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["pre", mergeAttributes(HTMLAttributes, { "data-docs": "mathBlock" }), ["code", 0]];
  },
});

/* ── inline ──────────────────────────────────────────────────────────────── */

export const InlineImage = Node.create({
  name: "image",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: str("src", ""), alt: str("alt", ""), title: str("title") };
  },
  parseHTML() {
    return [{ tag: "img[data-docs=image]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { "data-docs": "image", src: HTMLAttributes["data-src"], alt: HTMLAttributes["data-alt"] })];
  },
});

export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { value: str("value", "") };
  },
  parseHTML() {
    return [{ tag: "span[data-docs=inlineMath]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-docs": "inlineMath" }), `$${HTMLAttributes["data-value"] ?? ""}$`];
  },
});

export const RawInline = Node.create({
  name: "rawInline",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { value: str("value", "") };
  },
  parseHTML() {
    return [{ tag: "span[data-docs=rawInline]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-docs": "rawInline", class: "dxe-rawinline" }), HTMLAttributes["data-value"] ?? ""];
  },
});

/** `:kbd[⌘ K]`. */
export const Kbd = Mark.create({
  name: "kbd",
  parseHTML() {
    return [{ tag: "kbd" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["kbd", mergeAttributes(HTMLAttributes, { class: "md-kbd" }), 0];
  },
});

/** Markdown allows a link or bold around inline code, so `code` excludes nothing. */
export const InlineCode = Code.extend({ excludes: "" });

/** Bookkeeping and Markdown-only attributes on the StarterKit / table nodes. */
export const MarkdownAttrs = Extension.create({
  name: "docsMarkdownAttrs",
  addGlobalAttributes() {
    return [
      { types: ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "codeBlock", "horizontalRule", "table", "tableRow"], attributes: { md: MD } },
      { types: ["codeBlock"], attributes: { meta: str("meta") } },
      { types: ["bulletList"], attributes: { spread: bool("spread"), marker: str("marker", "-") } },
      { types: ["orderedList"], attributes: { spread: bool("spread"), marker: str("marker", "."), incr: bool("incr", true) } },
      {
        types: ["listItem"],
        attributes: {
          spread: bool("spread"),
          checked: {
            default: null,
            parseHTML: (el) => {
              const v = el.getAttribute("data-checked");
              return v == null ? null : v === "true";
            },
            renderHTML: (a) => (typeof a.checked === "boolean" ? { "data-checked": String(a.checked), "data-task": "" } : {}),
          },
        },
      },
      { types: ["table"], attributes: { align: json("align", null) } },
      { types: ["link"], attributes: { kind: str("kind", "inline") } },
    ];
  },
});

/** GFM table cells hold one line of inline content. */
const Cell = TableCell.extend({ content: "inline*" });
const Header = TableHeader.extend({ content: "inline*" });

/**
 * The schema + editing behaviour, React-free. `placeholder` etc. are added by the editor.
 */
export function baseExtensions() {
  return [
    StarterKit.configure({
      code: false,
      underline: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        HTMLAttributes: { target: null, rel: null, class: null },
      },
      dropcursor: { color: "var(--accent)", width: 2 },
    }),
    InlineCode,
    Kbd,
    MarkdownAttrs,
    Table.configure({ resizable: false, allowTableNodeSelection: true }),
    TableRow,
    Header,
    Cell,
    Callout,
    Steps,
    Details,
    Tabs,
    Tab,
    Cards,
    Card,
    DirectiveLeaf,
    Figure,
    RawBlock,
    MathBlock,
    InlineImage,
    InlineMath,
    RawInline,
  ];
}

/** Replaces the named extensions by `ext.extend(overrides[name])` (node views, keymaps). */
export function withOverrides(extensions, overrides) {
  return extensions.map((e) => (overrides[e.name] ? e.extend(overrides[e.name]) : e));
}
