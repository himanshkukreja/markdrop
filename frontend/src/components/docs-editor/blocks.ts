import type { Editor, Range, JSONContent } from "@tiptap/core";

/**
 * Commands the editor provides on `editor.storage.dxeServices` (VisualEditor sets them), so this
 * module stays free of runtime imports (the tests load it in Node).
 */
interface BlockServices {
  insertColumns?: (e: Editor, n: number, r: Range) => void;
  uploadMedia?: (e: Editor, r: Range, kind: "video" | "audio" | "file") => void;
  openEmoji?: (e: Editor, r: Range) => void;
}
const svc = (e: Editor) => (e.storage as unknown as { dxeServices?: BlockServices }).dxeServices ?? {};
const insertColumns = (e: Editor, n: number, r: Range) => svc(e).insertColumns?.(e, n, r);
const uploadMedia = (e: Editor, r: Range, kind: "video" | "audio" | "file") => svc(e).uploadMedia?.(e, r, kind);
const openEmoji = (e: Editor, r: Range) => svc(e).openEmoji?.(e, r);

/** The "/" menu's sections, in order. */
export type BlockGroup = "basic" | "media" | "markdrop" | "docs" | "advanced" | "inline";
export const GROUPS: ReadonlyArray<readonly [BlockGroup, string]> = [
  ["basic", "Basic blocks"],
  // Guides only (steps, tabs, cards…): right after the basics, the studio's everyday blocks.
  ["docs", "Guide blocks"],
  ["media", "Media"],
  ["markdrop", "Markdrop"],
  ["advanced", "Advanced"],
  ["inline", "Inline"],
];
export const GROUP_LABEL: Record<BlockGroup, string> = Object.fromEntries(GROUPS) as Record<BlockGroup, string>;

/** One entry of the "/" menu. */
export interface BlockItem {
  id: string;
  label: string;
  /** The one-line description under the label. */
  hint: string;
  icon: string;
  /** Shown instead of the icon (an emoji). */
  glyph?: string;
  /** A short text tile instead of the icon ("H1", "Aa"). */
  tile?: string;
  /** Other words it is found by. */
  keywords: string;
  /** The menu's section (none: Basic blocks). */
  group?: BlockGroup;
  /** The Markdown typed for it at the start of a line, shown on the right ("##", "[]"). */
  shortcut?: string;
  /** Only offered when searching: a variant of a block the list shows once. */
  searchOnly?: boolean;
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

/** Every Guides block, in the order the menu lists them (sections: see GROUPS). */
export const BLOCK_ITEMS: BlockItem[] = [
  { id: "text", label: "Text", hint: "Plain paragraph", icon: "lines", tile: "Aa", keywords: "paragraph p plain", group: "basic", run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { id: "h2", label: "Heading 2", hint: "Section title", icon: "heading", tile: "H2", keywords: "h2 heading title section", group: "basic", shortcut: "##", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", hint: "Smaller section title", icon: "heading", tile: "H3", keywords: "h3 heading subheading title", group: "basic", shortcut: "###", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  {
    id: "tasks",
    label: "To-do list",
    hint: "Track tasks with checkboxes",
    icon: "checkSquare",
    keywords: "task todo to-do checkbox checklist",
    group: "basic",
    run: insert({ type: "bulletList", content: [{ type: "listItem", attrs: { checked: false }, content: [p()] }] }),
  },
  { id: "bullets", label: "Bulleted list", hint: "A simple list", icon: "list", keywords: "ul bullet list unordered", group: "basic", shortcut: "-", run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { id: "numbers", label: "Numbered list", hint: "A list in order", icon: "list", tile: "1.", keywords: "ol numbered ordered list", group: "basic", shortcut: "1.", run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { id: "quote", label: "Quote", hint: "Quoted text", icon: "message", tile: "“", keywords: "blockquote quote citation", group: "basic", shortcut: ">", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { id: "divider", label: "Divider", hint: "A line between sections", icon: "minus", keywords: "hr divider rule separator line", group: "basic", shortcut: "---", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  ...CALLOUTS.map(
    ([kind, label, icon, hint]): BlockItem => ({
      id: `callout-${kind}`,
      label: kind === "note" ? "Callout" : `${label} callout`,
      hint: kind === "note" ? "Make a note stand out" : hint,
      icon,
      keywords: `callout admonition alert ${kind} ${label} note tip warning danger`,
      group: "basic",
      // The callout's own icon button switches between them; searching finds each.
      searchOnly: kind !== "note",
      run: insert({ type: "callout", attrs: { kind }, content: [p()] }),
    }),
  ),
  { id: "steps", label: "Steps", hint: "A numbered how-to", icon: "list", keywords: "steps procedure howto numbered", group: "docs", run: insert({ type: "steps", content: [h(3), p(), h(3), p()] }) },
  {
    id: "tabs",
    label: "Tabs",
    hint: "macOS · Windows · Linux",
    icon: "columns",
    keywords: "tabs os platform language switch",
    group: "docs",
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
    group: "docs",
    run: insert({
      type: "cards",
      content: [
        { type: "card", attrs: { label: null, attributes: { icon: "doc" } }, content: [p()] },
        { type: "card", attrs: { label: null, attributes: { icon: "doc" } }, content: [p()] },
      ],
    }),
  },
  { id: "details", label: "Details", hint: "A collapsible section", icon: "chevronRight", keywords: "details collapse toggle accordion faq", group: "docs", run: insert({ type: "details", attrs: { label: "More details" }, content: [p()] }) },
  { id: "private", label: "Private section", hint: "Only some readers see it", icon: "lock", keywords: "private section restricted members customers password lock access", group: "docs", run: insert({ type: "private", attrs: { label: null, attributes: { access: "members" } }, content: [p()] }) },
  { id: "api", label: "API endpoint", hint: "A card linking to an endpoint page", icon: "server", keywords: "api endpoint openapi operation rest", group: "docs", run: insert({ type: "directiveLeaf", attrs: { name: "api", attributes: {} } }) },
  { id: "image", label: "Image", hint: "Light and dark versions", icon: "image", keywords: "image picture screenshot figure photo", group: "media", run: insert({ type: "figure", attrs: { src: "", alt: "", title: null } }) },
  { id: "video", label: "Video", hint: "Upload or Markdrop link", icon: "film", keywords: "video recording screencast", group: "media", run: insert({ type: "directiveLeaf", attrs: { name: "video", attributes: {} } }) },
  { id: "clip", label: "Clip", hint: "A short silent loop", icon: "play", keywords: "clip loop gif animation", group: "media", run: insert({ type: "directiveLeaf", attrs: { name: "clip", attributes: {} } }) },
  { id: "embed", label: "Web embed", hint: "A page from another site", icon: "globe", keywords: "embed iframe page web site", group: "media", run: insert({ type: "directiveLeaf", attrs: { name: "embed", attributes: {} } }) },
  {
    id: "markdrop",
    label: "Markdrop file",
    hint: "Interactive HTML, PDF, video",
    icon: "layers",
    keywords: "markdrop file embed html demo prototype calculator interactive pdf video website zip site upload artifact",
    group: "markdrop",
    run: insert({ type: "directiveLeaf", attrs: { name: "markdrop", attributes: {} } }),
  },
  {
    id: "table",
    label: "Table",
    hint: "Rows and columns",
    icon: "table",
    keywords: "table grid rows columns",
    group: "advanced",
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  { id: "code", label: "Code", hint: "With a title and copy button", icon: "code", keywords: "code snippet fence pre", group: "advanced", shortcut: "```", run: (e, r) => e.chain().focus().deleteRange(r).setCodeBlock().run() },
  { id: "math", label: "Equation", hint: "A LaTeX formula", icon: "sigma", keywords: "math latex katex equation formula", group: "advanced", run: insert({ type: "mathBlock" }) },
  {
    id: "kbd",
    label: "Keyboard key",
    hint: "Like ⌘ K",
    icon: "laptop",
    keywords: "kbd key shortcut keyboard",
    group: "inline",
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
  { id: "h1", label: "Heading 1", hint: "Big section title", icon: "heading", tile: "H1", keywords: "h1 title heading", group: "basic", shortcut: "#", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  {
    id: "toggle",
    label: "Toggle list",
    hint: "Hide and show what's inside",
    icon: "chevronRight",
    keywords: "toggle details collapse accordion faq",
    group: "basic",
    run: insert({ type: "details", attrs: { label: null, attributes: { summary: "More details" } }, content: [p()] }),
  },
  ...([1, 2, 3] as const).map(
    (level): BlockItem => ({
      id: `toggle-h${level}`,
      label: `Toggle heading ${level}`,
      hint: "A heading that hides what's under it",
      icon: "chevronRight",
      tile: `▸H${level}`,
      keywords: `toggle heading h${level} collapse section`,
      group: "basic",
      run: insert({ type: "details", attrs: { label: null, attributes: { summary: "", heading: String(level) } }, content: [p()] }),
    }),
  ),
  {
    id: "subpage",
    label: "Sub-page",
    hint: "A page inside this one",
    icon: "doc",
    keywords: "page sub-page subpage child new nested",
    group: "markdrop",
    run: insert({ type: "directiveLeaf", attrs: { name: "page", attributes: {} } }),
  },
  {
    id: "bookmark",
    label: "Bookmark",
    hint: "A link with its preview",
    icon: "link",
    keywords: "bookmark link preview url card web",
    group: "media",
    run: insert({ type: "directiveLeaf", attrs: { name: "bookmark", attributes: {} } }),
  },
  {
    id: "web-embed",
    label: "Web embed",
    hint: "YouTube, Loom, Figma, Google Maps…",
    icon: "globe",
    keywords: "embed web youtube loom figma maps codepen vimeo iframe video",
    group: "media",
    run: insert({ type: "directiveLeaf", attrs: { name: "embed", attributes: {} } }),
  },
  ...([2, 3, 4, 5] as const).map(
    (n): BlockItem => ({
      id: `columns-${n}`,
      label: n === 2 ? "Columns" : `${n} columns`,
      hint: n === 2 ? "Blocks side by side (or drag one beside another)" : `${n} blocks side by side`,
      icon: "columns",
      keywords: `columns column layout side grid split ${n}`,
      group: "advanced",
      searchOnly: n > 2,
      run: (e, r) => insertColumns(e, n, r),
    }),
  ),
  {
    id: "button",
    label: "Button",
    hint: "Inserts a saved set of blocks",
    icon: "plus",
    keywords: "button template snippet repeat insert",
    group: "advanced",
    run: insert({ type: "button", attrs: { label: null, attributes: { label: "Add a task" } }, content: [{ type: "bulletList", content: [{ type: "listItem", attrs: { checked: false }, content: [p()] }] }] }),
  },
  { id: "page-video", label: "Video", hint: "Upload a video", icon: "film", keywords: "video upload movie recording mp4 screencast", group: "media", run: (e, r) => uploadMedia(e, r, "video") },
  { id: "page-audio", label: "Audio", hint: "Upload a recording", icon: "music", keywords: "audio sound music podcast mp3 upload voice", group: "media", run: (e, r) => uploadMedia(e, r, "audio") },
  { id: "page-file", label: "File", hint: "Upload a PDF, sheet or any file", icon: "upload", keywords: "file upload attachment pdf document sheet zip", group: "media", run: (e, r) => uploadMedia(e, r, "file") },
  {
    id: "mermaid",
    label: "Mermaid diagram",
    hint: "Flowcharts and sequences",
    icon: "listTree",
    keywords: "mermaid diagram flowchart chart graph sequence",
    group: "advanced",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertContent({ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: "graph TD\n  A[Start] --> B[Finish]" }] }).run();
    },
  },
  { id: "toc", label: "Table of contents", hint: "The page's headings, kept up to date", icon: "list", keywords: "toc table contents outline headings", group: "advanced", run: insert({ type: "directiveLeaf", attrs: { name: "toc", attributes: {} } }) },
  { id: "breadcrumb", label: "Breadcrumb", hint: "Where this page sits", icon: "chevronRight", keywords: "breadcrumb path parent location", group: "advanced", run: insert({ type: "directiveLeaf", attrs: { name: "breadcrumb", attributes: {} } }) },
  {
    id: "date",
    label: "Date",
    hint: "Today, as a date chip",
    icon: "calendar",
    keywords: "date today tomorrow day calendar when due",
    group: "inline",
    run: (e, r) => {
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      e.chain().focus().deleteRange(r).insertContent([{ type: "mention", attrs: { name: "date", label: iso, attributes: {} } }, { type: "text", text: " " }]).run();
    },
  },
  {
    id: "person",
    label: "Mention a person",
    hint: "Someone in the workspace",
    icon: "user",
    keywords: "person people mention member user at",
    group: "inline",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertContent({ type: "mention", attrs: { name: "person", label: "", attributes: {} } }).run();
    },
  },
  {
    id: "emoji",
    label: "Emoji",
    hint: "Search for an emoji",
    icon: "sparkle",
    glyph: "😀",
    keywords: "emoji smiley icon face",
    group: "inline",
    shortcut: ":",
    run: (e, r) => openEmoji(e, r),
  },
  {
    id: "page-embed",
    label: "Embed an item",
    hint: "A file or page from Markdrop",
    icon: "layers",
    keywords: "embed markdrop file pdf video image html page document artifact",
    group: "markdrop",
    run: insert({ type: "directiveLeaf", attrs: { name: "markdrop", attributes: {} } }),
  },
  {
    id: "mention",
    label: "Mention an item",
    hint: "Link a Markdrop page or file inline",
    icon: "link",
    keywords: "mention link markdrop page document file at",
    group: "markdrop",
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertContent({ type: "mention", attrs: { label: "", attributes: {} } }).run();
    },
  },
];

/**
 * The page's "/" menu, in order within each section (GROUPS): text, headings, lists, toggles,
 * quote, divider, callout; media; Markdrop items; advanced blocks; inline chips. Guides-only blocks
 * (private sections, steps, tabs, cards, API endpoints, videos and clips of a docs site, other
 * sites' embeds) aren't offered.
 */
export const PAGE_BLOCKS = [
  "text", "h1", "h2", "h3", "tasks", "bullets", "numbers", "toggle", "toggle-h1", "toggle-h2", "toggle-h3",
  "quote", "divider", "callout-note", "callout-tip", "callout-warning", "callout-danger",
  "image", "page-video", "page-audio", "page-file", "bookmark", "web-embed",
  "page-embed", "mention", "subpage",
  "table", "columns-2", "columns-3", "columns-4", "columns-5", "code", "math", "mermaid", "toc", "breadcrumb", "button",
  "person", "date", "emoji",
] as const;

/** Markdown shortcuts only pages have (pageKeys.ts), shown in the page's menu. */
const PAGE_SHORTCUTS: Record<string, string> = { tasks: "[]", math: "$$" };

const ALL_ITEMS = [...BLOCK_ITEMS, ...PAGE_ONLY_ITEMS];

/** The items for a block set (ids, in order); every Guides block when no set is given. */
export function itemsFor(ids?: readonly string[] | null): BlockItem[] {
  if (!ids) return BLOCK_ITEMS;
  const byId = new Map(ALL_ITEMS.map((it) => [it.id, it]));
  return ids
    .map((id) => byId.get(id))
    .filter((x): x is BlockItem => !!x)
    .map((it) => (PAGE_SHORTCUTS[it.id] && !it.shortcut ? { ...it, shortcut: PAGE_SHORTCUTS[it.id] } : it));
}

/** The menu before any typing: section by section (GROUPS), without the search-only variants. */
export function orderItems(items: BlockItem[]): BlockItem[] {
  const rank = new Map(GROUPS.map(([g], i) => [g, i]));
  return items
    .filter((it) => !it.searchOnly)
    .map((it, i) => ({ it, i, g: rank.get(it.group ?? "basic") ?? 0 }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.it);
}

/**
 * How well `q` (lower case) matches `text` as an in-order subsequence: null when it doesn't; else
 * the gaps between the matched letters (fewer is better; a jump to a word's start costs less).
 */
function fuzzy(q: string, text: string): number | null {
  let at = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    const i = text.indexOf(ch, at);
    if (i < 0) return null;
    if (last >= 0 && i > last + 1) gaps += i === 0 || text[i - 1] === " " || text[i - 1] === "-" ? 0.5 : 1;
    last = i;
    at = i + 1;
  }
  return gaps;
}

/**
 * Items matching a query, best first: the label (its start, then a word in it), the shortcut, an
 * alias, the description, then the letters in order (`/tdl` → To-do list). With no query, the
 * sectioned list (orderItems).
 */
export function filterItems(query: string, items: BlockItem[] = BLOCK_ITEMS): BlockItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return orderItems(items);
  const ordered = [...orderItems(items), ...items.filter((it) => it.searchOnly)];
  const scored = ordered
    .map((it, i) => {
      const label = it.label.toLowerCase();
      const keys = it.keywords.toLowerCase();
      const hint = it.hint.toLowerCase();
      const words = keys.split(/\s+/);
      let score: number;
      // The label first ("/columns" → Columns before Table, whose keywords say "columns").
      if (label.startsWith(q)) score = 0;
      else if (it.shortcut && it.shortcut === q) score = 0.25;
      else if (label.split(/[\s-]+/).some((w) => w.startsWith(q))) score = 0.5;
      else if (words.some((w) => w.startsWith(q))) score = 1;
      else if (label.includes(q)) score = 1.5;
      else if (keys.includes(q) || hint.split(/\s+/).some((w) => w.startsWith(q))) score = 2;
      else if (q.length < 2) score = Infinity;
      else {
        const f = fuzzy(q, label);
        const k = f === null ? fuzzy(q, keys) : null;
        score = f !== null ? 3 + Math.min(f, 9) / 10 : k !== null && k <= q.length ? 4 + k / 10 : hint.includes(q) ? 5 : Infinity;
      }
      return { it, i, score };
    })
    .filter((x) => x.score !== Infinity);
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.it);
}
