"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createDocument } from "@/lib/api";
import MarkdownPreview from "@/components/MarkdownPreview";

type Mode = "write" | "split" | "preview";

const MODES: { id: Mode; label: string }[] = [
  { id: "write",   label: "Write"   },
  { id: "split",   label: "Split"   },
  { id: "preview", label: "Preview" },
];

const MAX_CHARS = 20_000;

export default function Home() {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<Mode>("write");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  function syncScroll() {
    const ta = textareaRef.current;
    const pv = previewRef.current;
    if (!ta || !pv) return;
    const ratio = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
    pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
  }

  async function handlePublish() {
    if (!content.trim()) return;
    setLoading(true);
    setError("");
    try {
      const doc = await createDocument(title, content);
      sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret);
      router.push(`/${doc.slug}?new=1&secret=${encodeURIComponent(doc.edit_secret)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const remaining = MAX_CHARS - content.length;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">

      {/* Print-only content */}
      <div className="hidden print-only">
        {title && <h1 className="text-2xl font-bold mb-4">{title}</h1>}
        <MarkdownPreview content={content} />
      </div>

      {/* Top bar */}
      <div className="no-print flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 shrink-0">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Document title (optional)"
          maxLength={200}
          className="flex-1 bg-transparent border-b border-gray-200 dark:border-gray-700 focus:border-blue-500 dark:focus:border-blue-500 outline-none py-1 text-base sm:text-lg font-semibold text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 transition-colors"
        />
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs tabular-nums ${remaining < 1000 ? "text-amber-500" : "text-gray-400 dark:text-gray-500"}`}>
            {remaining.toLocaleString()} left
          </span>
          <button
            onClick={() => window.print()}
            disabled={!content.trim()}
            className="hidden sm:inline-flex px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-gray-700 dark:text-gray-300"
          >
            Export PDF
          </button>
          <button
            onClick={handlePublish}
            disabled={loading || !content.trim()}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-colors"
          >
            {loading ? "Publishing..." : "Publish"}
          </button>
        </div>
      </div>

      {/* Mode tab bar — on mobile, hide Split (unusable on small screens) */}
      <div className="no-print flex items-center gap-1 border-b border-gray-200 dark:border-gray-800 shrink-0">
        {MODES.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={`${id === "split" ? "hidden sm:block" : ""} px-3 sm:px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
              mode === id
                ? "border-blue-500 text-blue-500 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Write */}
      {mode === "write" && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste your markdown here..."
          className="no-print flex-1 min-h-0 w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 sm:p-4 font-mono text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500 transition-colors"
          autoFocus
          maxLength={MAX_CHARS}
        />
      )}

      {/* Split — side-by-side on sm+, write-only on mobile */}
      {mode === "split" && (
        <div className="no-print flex gap-3 flex-1 min-h-0">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onScroll={syncScroll}
            placeholder="Paste your markdown here..."
            className="w-1/2 h-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 font-mono text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500 transition-colors overflow-y-auto"
            autoFocus
            maxLength={MAX_CHARS}
          />
          <div
            ref={previewRef}
            className="w-1/2 h-full overflow-y-auto bg-gray-50/50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-5"
          >
            {content.trim() ? (
              <MarkdownPreview content={content} />
            ) : (
              <p className="text-gray-400 dark:text-gray-600 text-sm">Preview will appear here as you type.</p>
            )}
          </div>
        </div>
      )}

      {/* Preview */}
      {mode === "preview" && (
        <div className="no-print flex-1 min-h-0 overflow-y-auto bg-gray-50/50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-3 sm:p-6">
          {content.trim() ? (
            <MarkdownPreview content={content} />
          ) : (
            <p className="text-gray-400 dark:text-gray-600 text-sm">Nothing to preview yet. Switch to Write and add some markdown.</p>
          )}
        </div>
      )}

      {/* Bottom hint / error */}
      <div className="no-print shrink-0 flex items-center gap-3">
        {error && <p className="text-red-500 text-sm">{error}</p>}
        <span className="text-xs text-gray-400 dark:text-gray-500">
          No login required. Your document gets a shareable link instantly.
        </span>
      </div>
    </div>
  );
}
