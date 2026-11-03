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
import CodeBlock from "@tiptap/extension-code-block";
import { ListItem } from "@tiptap/extension-list";
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

/**
 * A block's attributes on pages (`{#b-x color="red"}`, see attrs.mjs): an object or null. Written to
 * the DOM as JSON (copy and paste inside the editor keeps them) and as `data-bid` / `data-color` /
 * `data-bg` for styling and for scrolling to an anchor. Never copied to the second half of a split.
 */
const BATTRS = {
  default: null,
  keepOnSplit: false,
  parseHTML: (el) => {
    const v = el.getAttribute("data-battrs");
    if (!v) return null;
    try {
      const o = JSON.parse(v);
      return o && typeof o === "object" && Object.keys(o).length ? o : null;
    } catch {
      return null;
    }
  },
  renderHTML: (a) => {
    const b = a.battrs;
    if (!b || typeof b !== "object") return {};
    const out = { "data-battrs": JSON.stringify(b) };
    if (b.id) out["data-bid"] = b.id;
    if (b.color) out["data-color"] = b.color;
    if (b.bg) out["data-bg"] = b.bg;
    return out;
  },
};

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
/** `:::private[title]{access="<rule>"}`: a section only some readers see (frontend/src/docs/access.mjs). */
export const Private = container("private", "block+");
/** `::::tabs{sync}` holding `:::tab[label]` panes. */
export const Tabs = container("tabs", "tab+");
export const Tab = container("tab", "block+", { group: undefined, isolating: true, draggable: false });
/** `::::cards` holding `:::card[title]{href icon}`. */
export const Cards = container("cards", "card+");
export const Card = container("card", "block+", { group: undefined, isolating: true, draggable: true });
/** `::::columns` holding 2–5 `:::column{width="40%"}` (pages). One column left is unwrapped (editor). */
export const Columns = container("columns", "column+", { isolating: false });
export const Column = container("column", "block+", { group: undefined, isolating: true, draggable: false });
/** `:::indent`: blocks nested under the block before it (Tab on a page). */
export const Indent = container("indent", "block+");
/** `:::button{label="…"}`: a button that inserts a copy of the blocks it holds (pages). */
export const ButtonBlock = container("button", "block+");

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
    return { src: str("src", ""), alt: str("alt", ""), title: str("title"), battrs: BATTRS, md: MD };
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
    return { meta: str("meta"), battrs: BATTRS, md: MD };
  },
  parseHTML() {
    return [{ tag: "pre[data-docs=mathBlock]", preserveWhitespace: "full", priority: 60 }];
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

/**
 * `:markdrop[Title]{src=<slug>}`: an inline chip naming a Markdrop item (a page's mention). `label`
 * is the title as written; `attributes` holds `src` and anything else the directive carries.
 */
export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { name: str("name", "markdrop"), label: str("label", ""), attributes: json("attributes", {}) };
  },
  parseHTML() {
    return [{ tag: "span[data-docs=mention]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-docs": "mention", class: "dxe-mention" }), HTMLAttributes["data-label"] ?? ""];
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

/**
 * `:span[text]{color=red}` / `{bg=yellow}`: Notion's text or background colour (pages). One colour
 * per run of text, so a new colour replaces the old one.
 */
export const Span = Mark.create({
  name: "span",
  addAttributes() {
    return { attributes: json("attributes", {}) };
  },
  parseHTML() {
    return [{ tag: "span[data-docs=span]" }];
  },
  renderHTML({ mark, HTMLAttributes }) {
    const a = mark.attrs.attributes ?? {};
    return ["span", mergeAttributes(HTMLAttributes, { "data-docs": "span", ...(a.color ? { "data-color": a.color } : {}), ...(a.bg ? { "data-bg": a.bg } : {}) }), 0];
  },
});

/** `:u[text]`: underline (pages; ⌘U). */
export const Underline = Mark.create({
  name: "underline",
  parseHTML() {
    return [{ tag: "u" }, { style: "text-decoration", consuming: false, getAttrs: (v) => (String(v).includes("underline") ? {} : false) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["u", HTMLAttributes, 0];
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
      { types: ["paragraph", "heading", "codeBlock", "horizontalRule", "table", "tableCell", "tableHeader"], attributes: { battrs: BATTRS } },
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
      codeBlock: false,
      listItem: false,
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
    // Separate from StarterKit so the editor can give them node views (withOverrides).
    CodeBlock.configure({ defaultLanguage: null, enableTabIndentation: true }),
    ListItem,
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
    Private,
    Tabs,
    Tab,
    Cards,
    Card,
    Columns,
    Column,
    Indent,
    ButtonBlock,
    Span,
    Underline,
    DirectiveLeaf,
    Figure,
    RawBlock,
    MathBlock,
    InlineImage,
    InlineMath,
    RawInline,
    Mention,
  ];
}

/** Replaces the named extensions by `ext.extend(overrides[name])` (node views, keymaps). */
export function withOverrides(extensions, overrides) {
  return extensions.map((e) => (overrides[e.name] ? e.extend(overrides[e.name]) : e));
}
