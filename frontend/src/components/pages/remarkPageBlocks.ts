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
    const visit = (node: MdNode, parent: MdNode | null, index: number) => {
      switch (node.type) {
        case "containerDirective": {
          const name = node.name ?? "";
          if (CALLOUTS.has(name)) {
            set(node, "div", { dataPb: "callout", dataKind: CALLOUT_KIND[name] ?? name, dataLabel: takeLabel(node) || attr(node, "title"), dataIcon: attr(node, "icon"), dataColor: attr(node, "color") });
          } else if (name === "details") {
            const label = takeLabel(node) || attr(node, "summary") || attr(node, "title") || "Details";
            const heading = /^[123]$/.test(attr(node, "heading") ?? "") ? attr(node, "heading") : undefined;
            set(node, "details", { dataPb: "details", dataLabel: label, dataHeading: heading });
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
      node.children?.forEach((c, i) => visit(c, node, i));
    };
    visit(tree, null, 0);
  };
}

/** A leaf directive's `[label]` (remark-directive keeps it as the leaf's children). */
function takeLeafLabel(node: MdNode): string | undefined {
  const t = textOf(node).trim();
  return t || undefined;
}
