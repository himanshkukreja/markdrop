import type { Editor, Range, JSONContent } from "@tiptap/core";

/**
 * Commands the editor provides on `editor.storage.dxeServices` (VisualEditor sets them), so this
 * module stays free of runtime imports (the tests load it in Node).
 */
interface BlockServices {
  insertColumns?: (e: Editor, n: number, r: Range) => void;
  uploadMedia?: (e: Editor, r: Range, kind: "video" | "audio" | "file") => void;
}
const svc = (e: Editor) => (e.storage as unknown as { dxeServices?: BlockServices }).dxeServices ?? {};
const insertColumns = (e: Editor, n: number, r: Range) => svc(e).insertColumns?.(e, n, r);
const uploadMedia = (e: Editor, r: Range, kind: "video" | "audio" | "file") => svc(e).uploadMedia?.(e, r, kind);

/** One entry of the "/" menu. */
export interface BlockItem {
  id: string;
  label: string;
  hint: string;
  icon: string;
  /** Shown instead of the icon (an emoji). */
  glyph?: string;
  keywords: string;
  /** Inserts the block in place of the typed "/query" range. */
  run: (editor: Editor, range: Range) => void;
}

const p = (): JSONContent => ({ type: "paragraph" });
const h = (level: number): JSONContent => ({ type: "heading", attrs: { level } });

function insert(content: JSONContent | JSONContent[]) {
  return (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).insertContent(content).run();
    // A block with text inside (a callout, a toggle…): put the caret in it, ready to type.
    const first = Array.isArray(content) ? content[0] : content;
    if (first?.content?.length) {
      const { state } = editor;
      const at = Math.max(0, Math.min(range.from - 1, state.doc.content.size));
      let target: number | null = null;
      state.doc.nodesBetween(at, Math.min(state.doc.content.size, at + 4000), (n, pos) => {
        if (target !== null) return false;
        if (n.isTextblock && pos >= at) {
          target = pos + 1;
          return false;
        }
        return true;
      });
      if (target !== null) editor.commands.setTextSelection(target);
    } else if (first && (first.type === "directiveLeaf" || first.type === "figure")) {
      // A one-line block (an embed, a bookmark…): keep typing on a new line below it.
      const { state } = editor;
      const at = Math.max(0, Math.min(range.from - 1, state.doc.content.size));
      let after: number | null = null;
      state.doc.nodesBetween(at, Math.min(state.doc.content.size, at + 4), (n, pos) => {
        if (after !== null) return false;
        if (n.type.name === first.type && pos >= at) {
          after = pos + n.nodeSize;
          return false;
        }
        return true;
      });
      if (after !== null) {
        const next = state.doc.resolve(after).nodeAfter;
        if (next && next.type.name === "paragraph" && next.content.size === 0) editor.commands.setTextSelection(after + 1);
        else editor.chain().insertContentAt(after, { type: "paragraph" }).setTextSelection(after + 1).run();
      }
    }
  };
}

const CALLOUTS: Array<[string, string, string, string]> = [
  ["note", "Note", "info", "Extra context worth a look"],
  ["tip", "Tip", "bulb", "A shortcut or good practice"],
  ["warning", "Warning", "alert", "Something to be careful about"],
  ["danger", "Danger", "alertCircle", "Data loss or security risk"],
];

export const BLOCK_ITEMS: BlockItem[] = [
  { id: "text", label: "Text", hint: "Plain paragraph", icon: "lines", keywords: "paragraph p", run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { id: "h2", label: "Heading", hint: "Section title", icon: "heading", keywords: "h2 title section", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { id: "h3", label: "Subheading", hint: "Smaller section title", icon: "heading", keywords: "h3 heading", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  ...CALLOUTS.map(
    ([kind, label, icon, hint]): BlockItem => ({
      id: `callout-${kind}`,
      label: kind === "note" ? "Callout" : `${label} callout`,
      hint: kind === "note" ? "Note, tip, warning" : hint,
      icon,
      keywords: `callout admonition alert ${kind} ${label}`,
      run: insert({ type: "callout", attrs: { kind }, content: [p()] }),
    }),
  ),
  { id: "steps", label: "Steps", hint: "Numbered how-to", icon: "list", keywords: "steps procedure howto numbered", run: insert({ type: "steps", content: [h(3), p(), h(3), p()] }) },
  {
    id: "tabs",
    label: "Tabs",
    hint: "macOS · Windows · Linux",
    icon: "columns",
    keywords: "tabs os platform language switch",
    run: insert({
      type: "tabs",
      content: [
        { type: "tab", attrs: { label: "macOS" }, content: [p()] },
        { type: "tab", attrs: { label: "Windows" }, content: [p()] },
        { type: "tab", attrs: { label: "Linux" }, content: [p()] },
      ],
    }),
  },
  {
    id: "cards",
    label: "Cards",
    hint: "Links with icons",
    icon: "layers",
    keywords: "cards grid links next steps",
    run: insert({
      type: "cards",
      content: [
        { type: "card", attrs: { label: null, attributes: { icon: "doc" } }, content: [p()] },
        { type: "card", attrs: { label: null, attributes: { icon: "doc" } }, content: [p()] },
      ],
    }),
  },
  { id: "details", label: "Details", hint: "Collapsible section", icon: "chevronRight", keywords: "details collapse toggle accordion faq", run: insert({ type: "details", attrs: { label: "More details" }, content: [p()] }) },
  { id: "private", label: "Private section", hint: "Only some readers see it", icon: "lock", keywords: "private section restricted members customers password lock access", run: insert({ type: "private", attrs: { label: null, attributes: { access: "members" } }, content: [p()] }) },
  { id: "image", label: "Image", hint: "Light and dark versions", icon: "image", keywords: "image picture screenshot figure photo", run: insert({ type: "figure", attrs: { src: "", alt: "", title: null } }) },
  { id: "video", label: "Video", hint: "Upload or Markdrop link", icon: "film", keywords: "video recording screencast", run: insert({ type: "directiveLeaf", attrs: { name: "video", attributes: {} } }) },
  { id: "clip", label: "Clip", hint: "Short silent loop", icon: "play", keywords: "clip loop gif animation", run: insert({ type: "directiveLeaf", attrs: { name: "clip", attributes: {} } }) },
  {
    id: "markdrop",
    label: "Markdrop file",
    hint: "Interactive HTML, PDF, video",
    icon: "layers",
    keywords: "markdrop file embed html demo prototype calculator interactive pdf video website zip site upload artifact",
    run: insert({ type: "directiveLeaf", attrs: { name: "markdrop", attributes: {} } }),
  },
  { id: "embed", label: "Embed", hint: "A page from another site", icon: "globe", keywords: "embed iframe page", run: insert({ type: "directiveLeaf", attrs: { name: "embed", attributes: {} } }) },
  { id: "code", label: "Code", hint: "With a title and copy button", icon: "code", keywords: "code snippet fence pre", run: (e, r) => e.chain().focus().deleteRange(r).setCodeBlock().run() },
  {
    id: "table",
    label: "Table",
    hint: "Rows and columns",
    icon: "table",
    keywords: "table grid rows columns",
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  { id: "api", label: "API endpoint", hint: "Card linking to an endpoint page", icon: "server", keywords: "api endpoint openapi operation rest", run: insert({ type: "directiveLeaf", attrs: { name: "api", attributes: {} } }) },
  { id: "bullets", label: "Bulleted list", hint: "Simple list", icon: "list", keywords: "ul bullet list unordered", run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { id: "numbers", label: "Numbered list", hint: "Ordered list", icon: "list", keywords: "ol numbered ordered list", run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  {
    id: "tasks",
    label: "Checklist",
    hint: "List with checkboxes",
    icon: "checkSquare",
    keywords: "task todo checkbox checklist",
    run: insert({ type: "bulletList", content: [{ type: "listItem", attrs: { checked: false }, content: [p()] }] }),
  },
  { id: "quote", label: "Quote", hint: "Quoted text", icon: "message", keywords: "blockquote quote citation", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { id: "math", label: "Math", hint: "LaTeX formula", icon: "sigma", keywords: "math latex katex equation formula", run: insert({ type: "mathBlock" }) },
  { id: "divider", label: "Divider", hint: "Horizontal line", icon: "minus", keywords: "hr divider rule separator line", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  {
    id: "kbd",
    label: "Keyboard key",
    hint: "Like ⌘ K",
    icon: "laptop",
    keywords: "kbd key shortcut keyboard",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertContent({ type: "text", text: "Ctrl K", marks: [{ type: "kbd" }] }).run();
      const to = e.state.selection.from;
      e.chain().setTextSelection({ from: to - 6, to }).run();
    },
  },
];

/**
 * Blocks only a page (a Markdrop document in the block editor) offers: a toggle written the way
 * pages write it (`:::details{summary="…"}`), an H1, and the embed and mention of a Markdrop item.
 * Empty, the embed and the mention open the page's picker.
 */
export const PAGE_ONLY_ITEMS: BlockItem[] = [
  { id: "h1", label: "Heading 1", hint: "Big section title", icon: "heading", keywords: "h1 title heading", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  {
    id: "toggle",
    label: "Toggle",
    hint: "Collapsible section",
    icon: "chevronRight",
    keywords: "toggle details collapse accordion faq",
    run: insert({ type: "details", attrs: { label: null, attributes: { summary: "More details" } }, content: [p()] }),
  },
  ...([1, 2, 3] as const).map(
    (level): BlockItem => ({
      id: `toggle-h${level}`,
      label: `Toggle heading ${level}`,
      hint: "A heading that hides what's under it",
      icon: "chevronRight",
      keywords: `toggle heading h${level} collapse section`,
      run: insert({ type: "details", attrs: { label: null, attributes: { summary: "", heading: String(level) } }, content: [p()] }),
    }),
  ),
  {
    id: "subpage",
    label: "Page",
    hint: "A sub-page inside this one",
    icon: "doc",
    keywords: "page sub-page subpage child new nested",
    run: insert({ type: "directiveLeaf", attrs: { name: "page", attributes: {} } }),
  },
  {
    id: "bookmark",
    label: "Bookmark",
    hint: "A link with its preview",
    icon: "link",
    keywords: "bookmark link preview url card web",
    run: insert({ type: "directiveLeaf", attrs: { name: "bookmark", attributes: {} } }),
  },
  {
    id: "web-embed",
    label: "Web embed",
    hint: "YouTube, Loom, Figma, Google Maps…",
    icon: "globe",
    keywords: "embed web youtube loom figma maps codepen vimeo iframe video",
    run: insert({ type: "directiveLeaf", attrs: { name: "embed", attributes: {} } }),
  },
  ...([2, 3, 4, 5] as const).map(
    (n): BlockItem => ({
      id: `columns-${n}`,
      label: `${n} columns`,
      hint: n === 2 ? "Blocks side by side (or drag one beside another)" : "Blocks side by side",
      icon: "columns",
      keywords: `columns column layout side grid split ${n}`,
      run: (e, r) => insertColumns(e, n, r),
    }),
  ),
  {
    id: "button",
    label: "Button",
    hint: "Inserts a saved set of blocks",
    icon: "plus",
    keywords: "button template snippet repeat insert",
    run: insert({ type: "button", attrs: { label: null, attributes: { label: "Add a task" } }, content: [{ type: "bulletList", content: [{ type: "listItem", attrs: { checked: false }, content: [p()] }] }] }),
  },
  { id: "page-video", label: "Video", hint: "Upload a video", icon: "film", keywords: "video upload movie recording mp4 screencast", run: (e, r) => uploadMedia(e, r, "video") },
  { id: "page-audio", label: "Audio", hint: "Upload a recording", icon: "music", keywords: "audio sound music podcast mp3 upload voice", run: (e, r) => uploadMedia(e, r, "audio") },
  { id: "page-file", label: "File", hint: "Upload a PDF, sheet or any file", icon: "upload", keywords: "file upload attachment pdf document sheet zip", run: (e, r) => uploadMedia(e, r, "file") },
  {
    id: "mermaid",
    label: "Diagram",
    hint: "Mermaid: flowcharts, sequences",
    icon: "listTree",
    keywords: "mermaid diagram flowchart chart graph sequence",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertContent({ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: "graph TD\n  A[Start] --> B[Finish]" }] }).run();
    },
  },
  { id: "toc", label: "Table of contents", hint: "The page's headings, kept up to date", icon: "list", keywords: "toc table contents outline headings", run: insert({ type: "directiveLeaf", attrs: { name: "toc", attributes: {} } }) },
  { id: "breadcrumb", label: "Breadcrumb", hint: "Where this page sits", icon: "chevronRight", keywords: "breadcrumb path parent location", run: insert({ type: "directiveLeaf", attrs: { name: "breadcrumb", attributes: {} } }) },
  {
    id: "date",
    label: "Date",
    hint: "Today, as a date chip",
    icon: "calendar",
    keywords: "date today tomorrow day calendar when due",
    run: (e, r) => {
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      e.chain().focus().deleteRange(r).insertContent([{ type: "mention", attrs: { name: "date", label: iso, attributes: {} } }, { type: "text", text: " " }]).run();
    },
  },
  {
    id: "person",
    label: "Person",
    hint: "Mention someone in the workspace",
    icon: "user",
    keywords: "person people mention member user at",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertContent({ type: "mention", attrs: { name: "person", label: "", attributes: {} } }).run();
    },
  },
  {
    id: "page-embed",
    label: "Embed",
    hint: "A file or page from Markdrop",
    icon: "layers",
    keywords: "embed markdrop file pdf video image html page document artifact",
    run: insert({ type: "directiveLeaf", attrs: { name: "markdrop", attributes: {} } }),
  },
  {
    id: "mention",
    label: "Mention",
    hint: "Link a Markdrop item inline",
    icon: "link",
    keywords: "mention link markdrop page document file at",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertContent({ type: "mention", attrs: { label: "", attributes: {} } }).run();
    },
  },
];

/**
 * The page's "/" menu, in order: text and headings, lists, toggle, callouts, quote, code, table,
 * divider, image, embed, mention, math. Guides-only blocks (private sections, steps, tabs, cards,
 * API endpoints, videos and clips of a docs site, other sites' embeds) aren't offered.
 */
export const PAGE_BLOCKS = [
  "text", "h1", "h2", "h3", "tasks", "bullets", "numbers", "toggle", "toggle-h1", "toggle-h2", "toggle-h3",
  "subpage", "callout-note", "callout-tip", "callout-warning", "callout-danger",
  "quote", "divider", "code", "table", "image", "page-video", "page-audio", "page-file", "page-embed", "mention", "bookmark", "web-embed",
  "columns-2", "columns-3", "columns-4", "columns-5", "math", "mermaid", "toc", "breadcrumb", "button", "date", "person",
] as const;

const ALL_ITEMS = [...BLOCK_ITEMS, ...PAGE_ONLY_ITEMS];

/** The items for a block set (ids, in order); every Guides block when no set is given. */
export function itemsFor(ids?: readonly string[] | null): BlockItem[] {
  if (!ids) return BLOCK_ITEMS;
  const byId = new Map(ALL_ITEMS.map((it) => [it.id, it]));
  return ids.map((id) => byId.get(id)).filter((x): x is BlockItem => !!x);
}

/** Items matching a query: label prefix first, then any keyword or label word. */
export function filterItems(query: string, items: BlockItem[] = BLOCK_ITEMS): BlockItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored = items.map((it) => {
    const label = it.label.toLowerCase();
    const words = `${label} ${it.keywords}`.split(/\s+/);
    const score = label.startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : `${label} ${it.keywords}`.includes(q) ? 2 : 3;
    return { it, score };
  }).filter((x) => x.score < 3);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.it);
}
