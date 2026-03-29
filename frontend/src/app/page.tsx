"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createDocument, ExpiresIn } from "@/lib/api";
import MarkdownPreview from "@/components/MarkdownPreview";
import MarkdownToolbar from "@/components/MarkdownToolbar";

type Mode = "write" | "split" | "preview";

const MODES: { id: Mode; label: string }[] = [
  { id: "write",   label: "Write"   },
  { id: "split",   label: "Split"   },
  { id: "preview", label: "Preview" },
];

const MAX_CHARS = 20_000;
const SLUG_PATTERN = /^[a-zA-Z0-9_-]*$/;

// Build date options: today + next 364 days
function buildDateOptions() {
  const options = [];
  const now = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
    const value = d.toISOString().slice(0, 10);
    options.push({ label, value });
  }
  return options;
}

const DATE_OPTIONS = buildDateOptions();

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h).padStart(2, "0"),
  label: new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric", hour12: true }).replace(":00", ""),
}));

function CustomDatePicker({ onChange }: { onChange: (v: string) => void }) {
  const [date, setDate] = useState(DATE_OPTIONS[1].value); // default: tomorrow
  const [hour, setHour] = useState("12");

  function handleChange(newDate: string, newHour: string) {
    const iso = `${newDate}T${newHour}:00:00`;
    onChange(iso);
  }

  const selectClass = "text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-gray-700 dark:text-gray-300 outline-none focus:border-blue-500 transition-colors cursor-pointer";

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={date}
        onChange={(e) => { setDate(e.target.value); handleChange(e.target.value, hour); }}
        className={selectClass}
      >
        {DATE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span className="text-xs text-gray-400">at</span>
      <select
        value={hour}
        onChange={(e) => { setHour(e.target.value); handleChange(date, e.target.value); }}
        className={selectClass}
      >
        {HOUR_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

export default function Home() {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<Mode>("write");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Phase 2 options
  const [customSlug, setCustomSlug] = useState("");
  const [expiresIn, setExpiresIn] = useState<ExpiresIn>("never");
  const [customExpiresAt, setCustomExpiresAt] = useState("");
  const [slugError, setSlugError] = useState("");

  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const writeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  function syncScroll() {
    const ta = textareaRef.current;
    const pv = previewRef.current;
    if (!ta || !pv) return;
    const ratio = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
    pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
  }

  function handleSlugChange(value: string) {
    if (!SLUG_PATTERN.test(value)) return; // reject invalid chars silently
    setCustomSlug(value);
    if (value && value.length < 3) {
      setSlugError("Minimum 3 characters");
    } else {
      setSlugError("");
    }
  }

  async function handlePublish() {
    if (!content.trim()) return;
    if (customSlug && customSlug.length < 3) {
      setSlugError("Minimum 3 characters");
      return;
    }
    if (expiresIn === "custom" && !customExpiresAt) {
      setError("Please pick a custom expiry date.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const doc = await createDocument(title, content, {
        customSlug: customSlug || undefined,
        expiresIn,
        customExpiresAt: expiresIn === "custom" ? new Date(customExpiresAt).toISOString() : undefined,
      });
      sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret);
      router.push(`/${doc.slug}?new=1&secret=${encodeURIComponent(doc.edit_secret)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const remaining = MAX_CHARS - content.length;
  const activeTextareaRef = mode === "split" ? textareaRef : writeTextareaRef;

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

      {/* Publish options */}
      <div className="no-print flex flex-col gap-2 shrink-0">
        {/* Custom slug row */}
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-1.5 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 focus-within:border-blue-500 transition-colors">
            <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">markdrop.in/</span>
            <input
              type="text"
              value={customSlug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="custom-url (optional)"
              maxLength={50}
              className="flex-1 bg-transparent outline-none text-xs font-mono text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 min-w-0"
            />
          </div>
          {slugError && <span className="text-xs text-red-500 shrink-0">{slugError}</span>}
        </div>

        {/* Expiry + public toggle row */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Expires</label>
            <select
              value={expiresIn}
              onChange={(e) => {
                const val = e.target.value as ExpiresIn;
                setExpiresIn(val);
                // Seed a default so publish works without interaction
                if (val === "custom") {
                  const tomorrow = new Date();
                  tomorrow.setDate(tomorrow.getDate() + 1);
                  setCustomExpiresAt(`${tomorrow.toISOString().slice(0, 10)}T12:00:00`);
                } else {
                  setCustomExpiresAt("");
                }
              }}
              className="text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-gray-700 dark:text-gray-300 outline-none focus:border-blue-500 transition-colors cursor-pointer"
            >
              <option value="never">Never</option>
              <option value="1d">1 Day</option>
              <option value="7d">7 Days</option>
              <option value="30d">30 Days</option>
              <option value="custom">Custom…</option>
            </select>
            {expiresIn === "custom" && (
              <CustomDatePicker onChange={setCustomExpiresAt} />
            )}
          </div>

        </div>
      </div>

      {/* Mode tab bar */}
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

      {/* Toolbar — only shown in write/split mode */}
      {mode !== "preview" && (
        <div className="no-print shrink-0 rounded-t-lg overflow-hidden border border-b-0 border-gray-200 dark:border-gray-700">
          <MarkdownToolbar
            textareaRef={activeTextareaRef}
            onChange={setContent}
          />
        </div>
      )}

      {/* Write */}
      {mode === "write" && (
        <textarea
          ref={writeTextareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste or type your markdown here..."
          className="no-print flex-1 min-h-0 w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-b-lg rounded-t-none p-3 sm:p-4 font-mono text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500 transition-colors"
          autoFocus
          maxLength={MAX_CHARS}
        />
      )}

      {/* Split */}
      {mode === "split" && (
        <div className="no-print flex gap-3 flex-1 min-h-0">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onScroll={syncScroll}
            placeholder="Paste or type your markdown here..."
            className="w-1/2 h-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-b-lg rounded-t-none p-4 font-mono text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500 transition-colors overflow-y-auto"
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
        {!error && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            No login required. Your document gets a shareable link instantly.
          </span>
        )}
      </div>
    </div>
  );
}
