"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createDocument, ExpiresIn } from "@/lib/api";
import * as e2e from "@/lib/e2e";
import { MAX_CHARS } from "@/lib/limits";
import { DIAGRAM_SAMPLE, DIAGRAM_SAMPLE_PARAM } from "@/lib/samples";
import MarkdownPreview from "@/components/MarkdownPreview";
import MarkdownToolbar from "@/components/MarkdownToolbar";
import PublishBar from "@/components/new/PublishBar";
import { type PublishTargetValue } from "@/lib/useWorkspaceTargets";
import { shareToWorkspace } from "@/lib/workspaces";

type Mode = "write" | "split" | "preview";

const MODES: { id: Mode; label: string }[] = [
  { id: "write",   label: "Write"   },
  { id: "split",   label: "Split"   },
  { id: "preview", label: "Preview" },
];

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

export default function NewDocumentPage() {
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
  const [encrypt, setEncrypt] = useState(false);
  const [slugError, setSlugError] = useState("");

  // Pre-fill from a sample when arriving via /new?sample=diagrams — and open in
  // split view so a first-time user sees the source next to its rendered output.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("sample");
    if (param === DIAGRAM_SAMPLE_PARAM) {
      setTitle(DIAGRAM_SAMPLE.title);
      setContent(DIAGRAM_SAMPLE.content);
      setMode("split");
    }
  }, []);

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

  const [target, setTarget] = useState<PublishTargetValue>({ workspaceId: null, folderId: null });

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
      // Seal before anything leaves the tab. `body` is what the API stores; the
      // key exists only here and, in a moment, in the fragment of the link.
      let body = content;
      let keyFragment = "";
      let encodedKey = "";
      if (encrypt) {
        const key = await e2e.generateKey();
        body = await e2e.seal(key, { title: title.trim() || null, content });
        encodedKey = await e2e.exportKey(key);
        keyFragment = `#k=${encodedKey}`;
      }

      const doc = await createDocument(title, body, {
        customSlug: customSlug || undefined,
        expiresIn,
        customExpiresAt: expiresIn === "custom" ? new Date(customExpiresAt).toISOString() : undefined,
        readPassword: readPassword || undefined,
        encrypted: encrypt || undefined,
      });
      // Keep the secret in sessionStorage only — never in the URL (it would
      // leak via history, referrer headers and server logs).
      sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret);

      // Share as a second step rather than a field on create: sharing is the
      // library's rule to enforce (owner-only, role-checked), and duplicating it
      // into the create path would be a second place for it to drift. A failure
      // here must not lose the document, which is already published — so it
      // surfaces as a warning on a page the author is about to land on.
      if (target.workspaceId && doc.id) {
        try {
          await shareToWorkspace(target.workspaceId, doc.id, target.folderId);
        } catch {
          setError("Published, but couldn't add it to the workspace. You can share it from your dashboard.");
        }
      }
      // Keep a copy on this device so losing the link isn't automatically fatal.
      // Still never leaves the browser — see lib/e2e.ts.
      if (encodedKey) e2e.rememberKey(doc.slug, encodedKey);
      // The fragment survives a client-side push and is never sent to a server,
      // which is the whole reason the key travels there.
      router.push(`/${doc.slug}?new=1${keyFragment}`);
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
            className="inline-flex px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
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

      {/* Publish options — one row of chips, each opening a popover (a bottom
          sheet on a phone). Replaces a stack that took roughly a third of the
          page before anyone had typed anything. */}
      <PublishBar
        target={target}
        onTarget={setTarget}
        customSlug={customSlug}
        onSlug={handleSlugChange}
        slugError={slugError}
        password={readPassword}
        onPassword={setReadPassword}
        encrypt={encrypt}
        onEncrypt={setEncrypt}
        encryptSupported={e2e.isSupported()}
        expiresIn={expiresIn}
        onExpiresIn={(v) => {
          const val = v as ExpiresIn;
          setExpiresIn(val);
          if (val === "custom") {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            setCustomExpiresAt(`${tomorrow.toISOString().slice(0, 10)}T12:00:00`);
          } else {
            setCustomExpiresAt("");
          }
        }}
        customDatePicker={<CustomDatePicker onChange={setCustomExpiresAt} />}
        disabled={loading}
      />

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
