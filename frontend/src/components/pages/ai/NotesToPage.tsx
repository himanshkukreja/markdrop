"use client";

/**
 * New page › Start from notes: paste notes, pick a shape (Auto, Meeting notes, Project brief,
 * Spec, Weekly update, Retro; the ones the page templates already have use their ids), and AI
 * drafts a structured page with that shape's headings. The draft streams into a preview drawn by
 * the reader's renderer (redrawn at most once a frame); Stop keeps what's written. The gallery's
 * Create page makes the page from the draft through the usual create call (POST /pages, content).
 */
import { useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Icon, Textarea, cx } from "@/components/ui";
import { cleanAiMarkdown } from "@/lib/pages-ai/sseCore.mjs";
import { streamNotes } from "@/lib/pages-ai/client";
import { PageRenderer } from "../PageRenderer";
import "./pageAi.css";

/** The shapes offered (ids the notes endpoint takes; meeting-notes and prd are page templates). */
export const NOTE_TEMPLATES: Array<{ id: string | null; label: string; icon: string }> = [
  { id: null, label: "Auto", icon: "sparkle" },
  { id: "meeting-notes", label: "Meeting notes", icon: "calendar" },
  { id: "project-brief", label: "Project brief", icon: "flag" },
  { id: "prd", label: "Spec", icon: "clipboard" },
  { id: "weekly-update", label: "Weekly update", icon: "chart" },
  { id: "retro", label: "Retro", icon: "history" },
];

const MAX_NOTES = 20_000;

/** A draft's first `# Title` line, as the page's title (and the body without it). */
export function splitDraftTitle(md: string): { title: string | null; body: string } {
  const m = /^\s*#\s+(.+?)\s*#*\s*\n+/.exec(md);
  if (!m) return { title: null, body: md };
  return { title: m[1].slice(0, 200), body: md.slice(m[0].length) };
}

export interface NotesDraft {
  /** The page's Markdown so far ("" before a draft). */
  markdown: string;
  streaming: boolean;
  /** A finished (or stopped) draft that can be created. */
  ready: boolean;
}

export function NotesToPage({ title, workspace, onDraft, disabled }: { title: string; workspace?: string | null; onDraft: (d: NotesDraft) => void; disabled?: boolean }) {
  const [notes, setNotes] = useState("");
  const [template, setTemplate] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "streaming" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const ctrl = useRef<AbortController | null>(null);
  const buf = useRef("");
  const raf = useRef(0);
  const preview = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const uid = useId();

  useEffect(() => () => {
    ctrl.current?.abort();
    cancelAnimationFrame(raf.current);
  }, []);

  useEffect(() => {
    onDraft({ markdown: cleanAiMarkdown(text, phase === "streaming"), streaming: phase === "streaming", ready: phase === "ready" && !!text.trim() });
  }, [text, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // The preview follows the newest line while it writes (unless scrolled up to read).
  useEffect(() => {
    const p = preview.current;
    if (phase === "streaming" && p && stick.current) p.scrollTop = p.scrollHeight;
  }, [text, phase]);

  const draft = () => {
    if (!notes.trim()) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    buf.current = "";
    stick.current = true;
    setText("");
    setError("");
    setPhase("streaming");
    streamNotes(
      { notes: notes.slice(0, MAX_NOTES), template, title: title.trim() || null, workspace },
      {
        signal: c.signal,
        onDelta: (t, reset) => {
          buf.current = reset ? t : buf.current + t;
          if (!raf.current) {
            raf.current = requestAnimationFrame(() => {
              raf.current = 0;
              setText(buf.current);
            });
          }
        },
      },
    ).then(
      (full) => {
        if (ctrl.current !== c) return;
        cancelAnimationFrame(raf.current);
        raf.current = 0;
        const md = cleanAiMarkdown(full || buf.current);
        setText(md);
        if (md) setPhase("ready");
        else {
          setPhase("error");
          setError("The draft came back empty. Try again.");
        }
      },
      (e: unknown) => {
        if (ctrl.current !== c || (e instanceof Error && e.name === "AbortError")) return;
        cancelAnimationFrame(raf.current);
        raf.current = 0;
        setPhase("error");
        setError(e instanceof Error && e.message ? e.message : "AI couldn't draft that just now. Try again.");
      },
    );
  };

  const stop = () => {
    ctrl.current?.abort();
    ctrl.current = null;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const md = cleanAiMarkdown(buf.current);
    setText(md);
    setPhase(md ? "ready" : "idle");
  };

  const shown = cleanAiMarkdown(text, phase === "streaming");
  const { title: drafted, body } = splitDraftTitle(shown);
  const busy = phase === "streaming";

  return (
    <div className="pb-notes">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-n`} className="text-caption-strong text-text">Your notes</label>
        <Textarea
          id={`${uid}-n`}
          className="pb-notes__text ph-mask"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={"Paste meeting notes, a brain dump, bullet points…\n\nAI turns them into a structured page. Nothing is created until you press Create page."}
          maxLength={MAX_NOTES}
          rows={6}
          disabled={disabled || busy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              draft();
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-caption-strong text-text" id={`${uid}-t`}>Shape it as</span>
        <div className="pb-notes__shapes" role="radiogroup" aria-labelledby={`${uid}-t`}>
          {NOTE_TEMPLATES.map((t) => (
            <button key={t.label} type="button" role="radio" aria-checked={template === t.id} className="pb-notes__shape md-focus" disabled={busy} onClick={() => setTemplate(t.id)}>
              <Icon name={t.icon} size={14} aria-hidden /> {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pb-notes__go">
        {busy ? (
          <Button variant="secondary" size="sm" iconLeft="stop" onClick={stop}>Stop</Button>
        ) : (
          <Button variant={phase === "ready" ? "secondary" : "primary"} size="sm" iconLeft={phase === "ready" ? "refresh" : "sparkle"} disabled={!notes.trim() || disabled} onClick={draft}>
            {phase === "ready" || phase === "error" ? "Draft again" : "Draft the page"}
          </Button>
        )}
        <span className="pb-notes__hint">{busy ? <span className="pb-notes__writing">Writing</span> : phase === "ready" ? "Check the draft, then create the page. You can edit everything after." : "Your notes go to Anthropic's Claude to draft the page."}</span>
      </div>
      {error && <Alert tone="warning">{error}</Alert>}
      {(busy || phase === "ready") && (
        <div className="flex flex-col gap-2">
          <span className="text-caption-strong text-text">Draft</span>
          <div
            ref={preview}
            className={cx("pb-template-preview pb-notes__preview ph-no-capture", busy && "pb-notes__preview--live")}
            aria-busy={busy || undefined}
            aria-label="The drafted page"
            onScroll={(e) => {
              const p = e.currentTarget;
              stick.current = p.scrollHeight - p.scrollTop - p.clientHeight < 24;
            }}
          >
            {shown.trim() ? (
              <>
                <p className="pb-notes__title ph-mask" dir="auto">{title.trim() || drafted || "Untitled"}</p>
                <PageRenderer slug="" content={body} embeds={{}} />
              </>
            ) : (
              <div className="pb-notes__skeleton" aria-hidden><span /><span /><span /><span /></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
