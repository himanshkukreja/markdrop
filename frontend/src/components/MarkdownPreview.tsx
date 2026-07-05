"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { useEffect, useId, useState } from "react";
// KaTeX styles + fonts are bundled by the Next build (imported from a client
// component so they only load on pages that render markdown). See globals.css
// for the small dark-theme / overflow tweaks layered on top.
import "katex/dist/katex.min.css";

// Extend the default sanitize schema to allow the class names our rehype
// plugins depend on. Order in the pipeline is: highlight → sanitize → katex,
// so sanitize must PRESERVE the `math-inline` / `math-display` / `language-math`
// placeholder classes (added by remark-math) for rehype-katex to find them
// afterwards. KaTeX-generated markup runs after sanitize and is trusted (it is
// produced by KaTeX from the math source, not raw user HTML).
const sanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // rehype-highlight wraps tokens in <span class="hljs-...">
    span: [["className", /^hljs-/]],
    // language-* for fenced blocks (incl. language-mermaid), hljs for highlighted
    // blocks, and the remark-math placeholder classes so KaTeX can render them.
    code: [["className", /^language-/, "hljs", /^hljs-/, "math-inline", "math-display"]],
  },
};

/** Extract the raw text content of react-markdown children. */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as ReactElement<{ children?: ReactNode }>).props.children);
  }
  return "";
}

function hasClass(node: ReactNode, cls: string): boolean {
  if (node && typeof node === "object" && "props" in node) {
    const className = (node as ReactElement<{ className?: string }>).props.className;
    return typeof className === "string" && className.split(/\s+/).includes(cls);
  }
  return false;
}

// ── Mermaid diagrams (client-only; mermaid.js is dynamically imported) ────────────

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

/** Load + initialize mermaid once, on the client. */
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      // Both selectable themes (dark, vscode) use a dark canvas, so the dark
      // mermaid theme reads correctly on either. securityLevel 'strict' escapes
      // labels — important since diagrams come from user markdown.
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        // Don't let mermaid inject its built-in "Syntax error" bomb graphic into
        // the DOM on a parse failure — render() still rejects, and our .catch()
        // below shows the raw source as the fallback instead.
        suppressErrorRendering: true,
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const rawId = useId();

  useEffect(() => {
    let cancelled = false;
    // A valid selector id (useId contains ":" which mermaid can't query).
    const id = "mmd-" + rawId.replace(/[^a-zA-Z0-9]/g, "");
    loadMermaid()
      .then((mermaid) => mermaid.render(id, code))
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, rawId]);

  if (failed) {
    // Fall back to the raw source so nothing is lost on a syntax error.
    return (
      <pre className="overflow-x-auto">
        <code>{code}</code>
      </pre>
    );
  }
  if (svg === null) {
    return <div className="not-prose my-4 text-sm text-gray-400">Rendering diagram…</div>;
  }
  return (
    <div
      className="not-prose my-4 flex justify-center overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// ── Code fences: copy button + mermaid interception ──────────────────────────────

function CopyCodeButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const text = getText();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      className="no-print absolute top-2 right-2 px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
      aria-label="Copy code"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function Pre({ children, ...props }: ComponentProps<"pre">) {
  // A ```mermaid fence renders as a diagram (no <pre> wrapper / copy button) —
  // the <code> child is turned into <MermaidDiagram> by the code override below.
  if (hasClass(children, "language-mermaid")) {
    return <>{children}</>;
  }

  return (
    <div className="relative group overflow-x-auto">
      <pre {...props} style={{ margin: 0 }}>{children}</pre>
      <CopyCodeButton getText={() => extractText(children)} />
    </div>
  );
}

// A CSS colour token, on its own, inside an inline `code` span → we prepend a
// swatch (matches GitHub's Color Reference behaviour). Regex-validated, so the
// value is safe to hand to an inline `style` background.
const COLOR_RE =
  /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgb\(\s*[\d.]+%?(?:\s*[,\s]\s*[\d.]+%?){2}\s*\)|rgba\(\s*[\d.]+%?(?:\s*[,\s]\s*[\d.]+%?){2,3}\s*[,/]?\s*[\d.]*%?\s*\)|hsla?\(\s*[\d.]+(?:deg)?(?:\s*[,\s]\s*[\d.]+%?){2,3}\s*[,/]?\s*[\d.]*%?\s*\))$/i;

function Code({ className, children, ...props }: ComponentProps<"code">) {
  if (typeof className === "string" && className.split(/\s+/).includes("language-mermaid")) {
    return <MermaidDiagram code={extractText(children).replace(/\n$/, "")} />;
  }
  // Inline colour swatch (only for a bare inline code span — not fenced blocks).
  if (!className) {
    const value = extractText(children).trim();
    if (COLOR_RE.test(value)) {
      return (
        <code className={className} {...props}>
          <span
            className="not-prose inline-block align-[-0.1em] mr-1 h-[0.85em] w-[0.85em] rounded-[3px] border border-black/25 dark:border-white/25"
            style={{ backgroundColor: value }}
          />
          {children}
        </code>
      );
    }
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

export default function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert break-words overflow-x-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        // Order matters: highlight FIRST, then sanitize (so hljs/math classes
        // aren't stripped), then katex LAST (renders the preserved math nodes;
        // its trusted output is intentionally not re-sanitized).
        rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
        components={{ pre: Pre, code: Code }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
