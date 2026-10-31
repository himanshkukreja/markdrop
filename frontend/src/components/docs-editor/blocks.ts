import type { Editor, Range, JSONContent } from "@tiptap/core";

/** One entry of the "/" menu. */
export interface BlockItem {
  id: string;
  label: string;
  hint: string;
  icon: string;
  keywords: string;
  /** Inserts the block in place of the typed "/query" range. */
  run: (editor: Editor, range: Range) => void;
}

const p = (): JSONContent => ({ type: "paragraph" });
const h = (level: number): JSONContent => ({ type: "heading", attrs: { level } });

function insert(content: JSONContent | JSONContent[]) {
  return (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).insertContent(content).run();
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
  { id: "image", label: "Image", hint: "Light and dark versions", icon: "image", keywords: "image picture screenshot figure photo", run: insert({ type: "figure", attrs: { src: "", alt: "", title: null } }) },
  { id: "video", label: "Video", hint: "Upload or Markdrop link", icon: "film", keywords: "video recording screencast", run: insert({ type: "directiveLeaf", attrs: { name: "video", attributes: {} } }) },
  { id: "clip", label: "Clip", hint: "Short silent loop", icon: "play", keywords: "clip loop gif animation", run: insert({ type: "directiveLeaf", attrs: { name: "clip", attributes: {} } }) },
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

/** Items matching a query: label prefix first, then any keyword or label word. */
export function filterItems(query: string): BlockItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCK_ITEMS;
  const scored = BLOCK_ITEMS.map((it) => {
    const label = it.label.toLowerCase();
    const words = `${label} ${it.keywords}`.split(/\s+/);
    const score = label.startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : `${label} ${it.keywords}`.includes(q) ? 2 : 3;
    return { it, score };
  }).filter((x) => x.score < 3);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.it);
}
