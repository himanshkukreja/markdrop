"use client";

import { useEffect, useRef, useState } from "react";
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

  // Fire onChange on mount so parent state is always in sync with displayed defaults
  useEffect(() => { handleChange(date, hour); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectClass = "text-xs bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-md px-2 py-1 text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] outline-none focus:border-blue-500 transition-colors cursor-pointer";

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
  const [readPassword, setReadPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
        readPassword: readPassword || undefined,
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

  const inputClass = "text-xs bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-md px-2 py-1 text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] outline-none focus:border-blue-500 transition-colors";

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
          className="flex-1 bg-transparent border-b border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] focus:border-blue-500 dark:focus:border-blue-500 outline-none py-1 text-base sm:text-lg font-semibold text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] placeholder-gray-400 dark:placeholder-gray-600 transition-colors"
        />
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs tabular-nums ${remaining < 1000 ? "text-amber-500" : "text-gray-400 dark:text-gray-500"}`}>
            {remaining.toLocaleString()} left
          </span>
          <button
            onClick={() => window.print()}
            disabled={!content.trim()}
            className="hidden sm:inline-flex px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
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
        {/* Custom slug + password row */}
        <div className="flex items-center gap-2">
          {/* Custom URL — 50% */}
          <div className="flex-1 flex items-center gap-1.5 bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-1.5 focus-within:border-blue-500 transition-colors min-w-0">
            <span className="text-xs text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d] shrink-0">markdrop.in/</span>
            <input
              type="text"
              value={customSlug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="custom-url"
              maxLength={50}
              className="flex-1 bg-transparent outline-none text-xs font-mono text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] placeholder-gray-400 dark:placeholder-gray-600 min-w-0"
            />
            {slugError && <span className="text-xs text-red-500 shrink-0">{slugError}</span>}
          </div>
          <span className="text-gray-300 dark:text-gray-700 vscode:text-[#3c3c3c] shrink-0 select-none">·</span>
          {/* Password — 50% */}
          <div className="flex-1 flex items-center gap-1.5 bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-1.5 focus-within:border-blue-500 transition-colors min-w-0">
            <svg className="w-3 h-3 text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d] shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
            </svg>
            <input
              type={showPassword ? "text" : "password"}
              value={readPassword}
              onChange={(e) => setReadPassword(e.target.value)}
              placeholder="password (optional)"
              maxLength={100}
              className="flex-1 bg-transparent outline-none text-xs text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] placeholder-gray-400 dark:placeholder-gray-600 min-w-0"
            />
            {readPassword && (
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d] hover:text-gray-600 dark:hover:text-gray-300 vscode:hover:text-[#d4d4d4] transition-colors shrink-0"
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Expiry row */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] shrink-0">Expires</label>
          <select
            value={expiresIn}
            onChange={(e) => {
              const val = e.target.value as ExpiresIn;
              setExpiresIn(val);
              if (val === "custom") {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                setCustomExpiresAt(`${tomorrow.toISOString().slice(0, 10)}T12:00:00`);
              } else {
                setCustomExpiresAt("");
              }
            }}
            className={inputClass}
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

      {/* Mode tab bar */}
      <div className="no-print flex items-center gap-1 border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] shrink-0">
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
        <div className="no-print shrink-0 rounded-t-lg overflow-hidden border border-b-0 border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c]">
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
          className="no-print flex-1 min-h-0 w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-b-lg rounded-t-none p-3 sm:p-4 font-mono text-sm text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] placeholder-gray-400 dark:placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500 transition-colors"
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
            className="w-1/2 h-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-b-lg rounded-t-none p-4 font-mono text-sm text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] placeholder-gray-400 dark:placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500 transition-colors overflow-y-auto"
            autoFocus
            maxLength={MAX_CHARS}
          />
          <div
            ref={previewRef}
            className="w-1/2 h-full overflow-y-auto bg-gray-50/50 dark:bg-gray-900/50 vscode:bg-[#252526] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg p-5"
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
        <div className="no-print flex-1 min-h-0 overflow-y-auto bg-gray-50/50 dark:bg-gray-900/50 vscode:bg-[#252526] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg p-3 sm:p-6">
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
