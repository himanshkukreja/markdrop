"use client";

/**
 * A streamed answer, rendered as Markdown on the client: GFM only, no raw HTML (react-markdown
 * drops it without rehype-raw), no images, links only as the answer gives them (docs pages open
 * in-app, other http(s) links in a new tab, anything else is plain text). Citation markers
 * ([S3]) become small numbered superscript buttons; the number is the source's `n`, which is the
 * order the answer first cites it, so numbers are right while streaming too.
 */
import { useRouter } from "next/navigation";
import { memo, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent } from "mdast";
import { CodeBlock } from "@/components/reading/CodeBlock";
import { cx } from "@/components/ui";
import type { Source } from "./api";
import { docsPath, goToSource } from "./cite";

const CITE = /\[(S\d{1,3})\]/g;
const HAS_CITE = /\[S\d{1,3}\]/;
const CITE_HREF = "#dx-cite-";

/** id → n: from the sources once they arrive, else by first appearance (the server's order). */
export function citationNumbers(answer: string, sources: Source[]): Map<string, number> {
  const map = new Map<string, number>();
  if (sources.length) {
    for (const s of sources) map.set(s.id.toUpperCase(), s.n);
    return map;
  }
  for (const m of answer.matchAll(CITE)) {
    const id = m[1].toUpperCase();
    if (!map.has(id)) map.set(id, map.size + 1);
  }
  return map;
}

/** The answer as plain Markdown for the clipboard: [S3] → [1], plus a numbered source list. */
export function answerForCopy(answer: string, sources: Source[]): string {
  const nums = citationNumbers(answer, sources);
  const body = answer.replace(CITE, (_, id: string) => (nums.has(id.toUpperCase()) ? `[${nums.get(id.toUpperCase())}]` : "")).trim();
  if (!sources.length) return body;
  const list = [...sources].sort((a, b) => a.n - b.n).map((s) => `${s.n}. ${s.page_title && s.section ? `${s.page_title} › ${s.section}` : s.title}: ${s.url}`);
  return `${body}\n\nSources:\n${list.join("\n")}`;
}

/** remark plugin: [S3] in text → a link node the `a` component turns into a citation button. */
function remarkCitations() {
  const visit = (node: { children?: RootContent[] | PhrasingContent[] }) => {
    if (!node.children) return;
    const out: RootContent[] = [];
    for (const child of node.children as RootContent[]) {
      if (child.type === "text" && HAS_CITE.test(child.value)) {
        let last = 0;
        for (const m of child.value.matchAll(CITE)) {
          const at = m.index ?? 0;
          if (at > last) out.push({ type: "text", value: child.value.slice(last, at) });
          out.push({ type: "link", url: CITE_HREF + m[1].toUpperCase(), children: [{ type: "text", value: m[1] }] });
          last = at + m[0].length;
        }
        if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
        continue;
      }
      if (child.type !== "link" && child.type !== "code" && child.type !== "inlineCode" && "children" in child) visit(child as { children: RootContent[] });
      out.push(child);
    }
    (node as { children: RootContent[] }).children = out;
  };
  return (tree: Root) => visit(tree);
}

function safeHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

type AProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };

interface Props {
  answer: string;
  sources: Source[];
  siteUrl: string;
  /** Called after a citation or source opens (the phone sheet closes itself). */
  onNavigate?: () => void;
  className?: string;
}

function AnswerImpl({ answer, sources, siteUrl, onNavigate, className }: Props) {
  const router = useRouter();
  const nums = useMemo(() => citationNumbers(answer, sources), [answer, sources]);
  const byId = useMemo(() => new Map(sources.map((s) => [s.id.toUpperCase(), s])), [sources]);

  const components = useMemo<Components>(() => {
    function A({ node: _n, href, children }: AProps) {
      const h = typeof href === "string" ? href : "";
      if (h.startsWith(CITE_HREF)) {
        const id = h.slice(CITE_HREF.length);
        const n = nums.get(id);
        if (!n) return null;
        const src = byId.get(id);
        const label = src ? `Source ${n}: ${src.page_title && src.section ? `${src.page_title}, ${src.section}` : src.title}` : `Source ${n}`;
        return (
          <sup className="dx-cite">
            <button
              type="button"
              className="dx-cite__btn"
              aria-label={label}
              title={src ? label : undefined}
              disabled={!src}
              onClick={() => {
                if (!src) return;
                onNavigate?.();
                if (!goToSource(src.url, router.push, siteUrl)) window.open(src.url, "_blank", "noopener,noreferrer");
              }}
            >
              {n}
            </button>
          </sup>
        );
      }
      const safe = safeHref(h);
      if (!safe) return <span>{children}</span>;
      const local = docsPath(safe, siteUrl);
      if (local)
        return (
          <a
            href={local}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onNavigate?.();
              goToSource(safe, router.push, siteUrl);
            }}
          >
            {children}
          </a>
        );
      return (
        <a href={safe} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    function Pre({ children }: { children?: React.ReactNode }) {
      const child = Array.isArray(children) ? children[0] : children;
      const props = ((child as React.ReactElement<{ className?: string; children?: React.ReactNode }>)?.props ?? {}) as { className?: string; children?: React.ReactNode };
      const lang = /(?:^|\s)language-([^\s]+)/.exec(props.className ?? "")?.[1];
      const code = String(Array.isArray(props.children) ? props.children.join("") : props.children ?? "").replace(/\n$/, "");
      return <CodeBlock code={code} language={lang} />;
    }
    return {
      a: A,
      pre: Pre,
      img: ({ alt }) => (alt ? <span>{String(alt)}</span> : null),
      h1: ({ children }) => <p className="dx-answer__h">{children}</p>,
      h2: ({ children }) => <p className="dx-answer__h">{children}</p>,
      h3: ({ children }) => <p className="dx-answer__h">{children}</p>,
      table: ({ children }) => (
        <div className="dx-answer__table">
          <table className="md-table">{children}</table>
        </div>
      ),
    };
  }, [nums, byId, router, siteUrl, onNavigate]);

  return (
    <div className={cx("prose md-prose md-prose--compact dx-answer", className)}>
      <Markdown remarkPlugins={[remarkGfm, remarkCitations]} components={components} skipHtml>
        {answer}
      </Markdown>
    </div>
  );
}

export const Answer = memo(AnswerImpl);
