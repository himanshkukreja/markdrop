"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import type { ComponentProps } from "react";
import { useState } from "react";

// Extend the default sanitize schema to allow className on span and pre,
// which rehype-highlight needs to apply syntax highlighting token classes.
const sanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // rehype-highlight wraps tokens in <span class="hljs-...">
    span: [["className", /^hljs-/]],
    // allow language class on <code> blocks (e.g. language-ts)
    code: [["className", /^language-/]],
  },
};

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
  function getText() {
    // Walk the children to extract raw text content
    function extract(node: React.ReactNode): string {
      if (typeof node === "string") return node;
      if (typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(extract).join("");
      if (node && typeof node === "object" && "props" in node) {
        return extract((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
      }
      return "";
    }
    return extract(children);
  }

  return (
    <div className="relative group overflow-x-auto">
      <pre {...props} style={{ margin: 0 }}>{children}</pre>
      <CopyCodeButton getText={getText} />
    </div>
  );
}

export default function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert break-words overflow-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Order matters: highlight FIRST, then sanitize (so classes aren't stripped)
        rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
        components={{ pre: Pre }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
