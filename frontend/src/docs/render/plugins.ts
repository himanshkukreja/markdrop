/**
 * unified plugins for the docs renderer.
 *
 * remarkDocs (after remark-directive): turns the directive nodes into custom elements the
 * component map renders (`docs-callout`, `docs-steps`/`docs-step`, `docs-tabs`/`docs-tab`,
 * `docs-cards`/`docs-card`, `docs-details`, `docs-video`, `docs-clip`, `docs-embed`, `docs-api`,
 * `docs-kbd`), turns a paragraph that is just one image into a `docs-figure` (title → caption),
 * recomputes image alt text the directive syntax cut short ("0:15", see rules.mjs), and reads
 * code-fence meta (`title="…"`, `{2,4-5}`). Only whitelisted attributes are carried over; an
 * unknown directive keeps its content (containers) or reads as the literal text it was. Fence meta
 * also takes a bare `wrap` (```text wrap title="…"): long lines soft-wrap.
 *
 * rehypeDocs (after rehype-highlight): heading ids slugged from the heading's source text exactly
 * like `scanHeadings`, hidden anchors for the page's old heading ids (frontmatter `anchors`), and
 * per-line spans for code blocks that highlight lines.
 */
import { createSlugger, headingSourceText } from "@/components/reading/slug";
import { CALLOUTS, CONTAINER_DIRECTIVES } from "../markdown";
import { aliasNodes, aliasesByTarget, fixImageAlts, hasWrapFlag, parserOptions } from "./rules.mjs";

/* ── mdast ───────────────────────────────────────────────────────────────── */

interface MdNode {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  children?: MdNode[];
  value?: string;
  depth?: number;
  url?: string;
  alt?: string | null;
  title?: string | null;
  lang?: string | null;
  meta?: string | null;
  data?: { hName?: string; hProperties?: Record<string, unknown>; directiveLabel?: boolean; [k: string]: unknown };
  position?: unknown;
}

function textOf(n: MdNode): string {
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(textOf).join("");
}

/** Removes and returns a container's `[label]` (remark-directive stores it as a first paragraph). */
function takeLabel(node: MdNode): string | undefined {
  const first = node.children?.[0];
  if (first && first.type === "paragraph" && first.data?.directiveLabel) {
    node.children!.shift();
    return textOf(first).trim();
  }
  return undefined;
}

function set(node: MdNode, hName: string, hProperties: Record<string, unknown> = {}) {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(hProperties)) if (v !== undefined && v !== null && v !== "") props[k] = v;
  node.data = { ...(node.data ?? {}), hName, hProperties: props };
}

const attr = (n: MdNode, k: string) => {
  const v = n.attributes?.[k];
  return typeof v === "string" ? v : undefined;
};

/** `{2,4-5}` → "2,4,5" (a sorted, de-duplicated list; ranges capped at 2000 lines). */
export function parseLineRanges(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i <= 2000; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

function codeMeta(node: MdNode) {
  const meta = node.meta ?? "";
  if (!meta) return;
  const title = /\btitle=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
  const hl = /\{([\d,\s-]+)\}/.exec(meta);
  const props: Record<string, unknown> = { ...(node.data?.hProperties ?? {}) };
  if (title) props.dataTitle = title[1] ?? title[2] ?? title[3];
  if (hl) {
    const lines = parseLineRanges(hl[1]);
    if (lines.length) props.dataHl = lines.join(",");
  }
  if (hasWrapFlag(meta)) props.dataWrap = "true";
  node.data = { ...(node.data ?? {}), hProperties: props };
}

function transformContainer(node: MdNode) {
  const name = node.name ?? "";
  if (CALLOUTS[name]) {
    set(node, "docs-callout", { kind: name, label: takeLabel(node) });
    return;
  }
  switch (name) {
    case "steps": {
      takeLabel(node);
      const kids = node.children ?? [];
      const firstHeading = kids.find((k) => k.type === "heading");
      const depth = firstHeading?.depth ?? 3;
      const out: MdNode[] = [];
      let current: MdNode | null = null;
      let n = 0;
      for (const k of kids) {
        if (k.type === "heading" && k.depth === depth) {
          current = { type: "docsStep", children: [k], data: { hName: "docs-step", hProperties: { n: String(++n) } } };
          out.push(current);
        } else if (current) current.children!.push(k);
        else out.push(k);
      }
      node.children = out;
      set(node, "docs-steps");
      return;
    }
    case "tabs": {
      takeLabel(node);
      const tabs = (node.children ?? []).filter((k) => k.type === "containerDirective" && k.name === "tab");
      const labels = tabs.map((t, i) => {
        const label = takeLabel(t) || `Option ${i + 1}`;
        set(t, "docs-tab", { label });
        return label;
      });
      node.children = tabs;
      set(node, "docs-tabs", { sync: attr(node, "sync"), labels: JSON.stringify(labels) });
      return;
    }
    case "cards": {
      takeLabel(node);
      set(node, "docs-cards");
      return;
    }
    case "card": {
      set(node, "docs-card", { label: takeLabel(node), href: attr(node, "href"), icon: attr(node, "icon") });
      return;
    }
    case "details": {
      set(node, "docs-details", { label: takeLabel(node) || "Details" });
      return;
    }
    case "tab": {
      if (node.data?.hName === "docs-tab") return; // already labelled by its tabs parent
      set(node, "docs-tab", { label: takeLabel(node) });
      return;
    }
    default:
      // Unknown container: keep its content, label included, in a plain block.
      set(node, "div");
  }
}

/** A paragraph holding one image and nothing else (whitespace aside): a block figure. */
function loneImage(node: MdNode): MdNode | undefined {
  const kids = (node.children ?? []).filter((k) => !(k.type === "text" && !(k.value ?? "").trim()));
  return kids.length === 1 && kids[0].type === "image" ? kids[0] : undefined;
}

function transform(node: MdNode, parent: MdNode | null, index: number) {
  const img = node.type === "paragraph" ? loneImage(node) : undefined;
  if (img) {
    set(node, "docs-figure", { src: img.url, alt: img.alt ?? "", caption: img.title ?? undefined });
    node.children = [];
    return;
  }
  if (node.type === "containerDirective") transformContainer(node);
  else if (node.type === "leafDirective") {
    if (node.name === "video") {
      set(node, "docs-video", { vid: attr(node, "id"), label: attr(node, "title") || textOf(node).trim(), duration: attr(node, "duration") });
      node.children = [];
    } else if (node.name === "clip") {
      set(node, "docs-clip", { src: attr(node, "src"), alt: attr(node, "alt") || textOf(node).trim(), caption: attr(node, "caption"), theme: attr(node, "theme") });
      node.children = [];
    } else if (node.name === "embed") {
      set(node, "docs-embed", { src: attr(node, "src"), label: attr(node, "title") || textOf(node).trim() });
      node.children = [];
    } else if (node.name === "api") {
      // ::api[label]{op="GET /v1/things/{id}"}: a card for that operation (DocsMarkdown ApiOp).
      set(node, "docs-api", { op: attr(node, "op"), label: textOf(node).trim() });
      node.children = [];
    } else if (parent) {
      // Unknown leaf: show what was written rather than dropping it silently.
      parent.children![index] = { type: "paragraph", children: [{ type: "text", value: `::${node.name}` }, ...(node.children ?? [])] };
    }
  } else if (node.type === "textDirective") {
    if (node.name === "kbd") set(node, "docs-kbd");
    else if (parent) {
      // "10:30", "Note:this": a colon followed by a word is just text.
      const label = node.children?.length ? [{ type: "text", value: "[" }, ...node.children, { type: "text", value: "]" }] : [];
      parent.children!.splice(index, 1, { type: "text", value: `:${node.name}` }, ...(label as MdNode[]));
    }
  } else if (node.type === "code") codeMeta(node);
  const kids = node.children;
  if (kids) for (let i = 0; i < kids.length; i++) transform(kids[i], node, i);
}

/**
 * `this` is the processor (unified attachers run bound to it): its data holds the parser
 * extensions, read when the transformer runs so every plugin has registered its own.
 */
export function remarkDocs(this: unknown) {
  const processor = this as { data?: () => unknown } | undefined;
  return (tree: MdNode, file?: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : null;
    if (source !== null) fixImageAlts(tree, source, parserOptions(typeof processor?.data === "function" ? processor.data() : undefined));
    transform(tree, null, 0);
  };
}

export const KNOWN_CONTAINERS: readonly string[] = CONTAINER_DIRECTIVES;

/* ── hast ────────────────────────────────────────────────────────────────── */

interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function hText(n: HNode): string {
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(hText).join("");
}

/** Splits highlighted code into one `<span class="dx-line">` per line (tokens re-wrapped per line). */
function splitCodeLines(code: HNode, highlight: Set<number>) {
  type Seg = { text: string; chain: HNode[] };
  const lines: Seg[][] = [[]];
  const visit = (n: HNode, chain: HNode[]) => {
    if (n.type === "text") {
      (n.value ?? "").split("\n").forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1].push({ text: part, chain });
      });
    } else if (n.type === "element") (n.children ?? []).forEach((c) => visit(c, [...chain, n]));
  };
  (code.children ?? []).forEach((c) => visit(c, []));
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  code.children = lines.map((segs, i) => ({
    type: "element",
    tagName: "span",
    properties: { className: ["dx-line"], ...(highlight.has(i + 1) ? { dataHl: "" } : {}) },
    children: segs.map((s) =>
      s.chain.reduceRight<HNode>((inner, el) => ({ type: "element", tagName: el.tagName, properties: { ...el.properties }, children: [inner] }), { type: "text", value: s.text }),
    ),
  }));
}

export interface RehypeDocsOptions {
  /**
   * Old heading ids → current ones (frontmatter `anchors`). Each old id becomes an empty, hidden
   * anchor at the start of its heading, so `#old-id` still scrolls to it. Unknown targets are ignored.
   */
  anchors?: Record<string, string>;
}

export function rehypeDocs(options: RehypeDocsOptions = {}) {
  const aliases = aliasesByTarget(options.anchors);
  return (tree: HNode, file?: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : null;
    const slug = createSlugger();
    const ids = new Set<string>();
    const walk = (n: HNode) => {
      if (n.type === "element") {
        if (/^h[1-4]$/.test(n.tagName ?? "") && !n.properties?.id) {
          const s = n.position?.start.offset, e = n.position?.end.offset;
          const text = source !== null && s !== undefined && e !== undefined ? headingSourceText(source.slice(s, e)) : hText(n).trim();
          const id = slug(text);
          n.properties = { ...n.properties, id };
          ids.add(id);
          if (aliases.has(id)) n.children = [...aliasNodes(aliases, id, ids), ...(n.children ?? [])];
        }
        if (n.tagName === "code" && typeof n.properties?.dataHl === "string") {
          splitCodeLines(n, new Set(String(n.properties.dataHl).split(",").map(Number)));
        }
      }
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}
