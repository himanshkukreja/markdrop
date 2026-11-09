"use client";

/**
 * Export a page: Markdown, Word, HTML or PDF.
 *
 *   Markdown  portable .md (callouts as labelled quotes, columns one after another, chips as text,
 *             embeds as links); with images or sub-pages, a .zip (page.md + images/, a folder per
 *             sub-page). Made by the server, which checks who may export and what they can open.
 *   HTML      one self-contained file in the page's look, images inside it (server-made too).
 *   Word      a .docx made by the server (one page; images as their alt text).
 *   PDF       this browser prints the page (PrintPages), light, without the app around it.
 *
 * Comments (Track C): someone who can see the page's comments may include them — Markdown as a Comments
 * appendix, Word as margin comments or footnotes, PDF as numbered notes in the margin or at the end
 * (PrintPages + components/comments/insights/printComments.ts). Not in HTML.
 *
 * Sub-pages: only the ones this reader can open. Readers export only when the page allows it
 * (`allow_export`, set by its editors in the page's ⋯ menu); DocumentView hides Export otherwise.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import { Alert, Button, Dialog, Icon, Progress, SegmentedControl, Switch, useToast } from "@/components/ui";
import { getExportThreads, takeExportPreset, type ExportThreadDto } from "@/lib/commentsInsights";
import { track } from "@/lib/track";
import type { AssetUrl, Crumb } from "@/lib/pages";
import { readPageProps } from "../pageProps";
import { ExportFailed, exportFileName, fetchExport, formatBytes, hasPageImages, saveBlob } from "./exportApi";
import type { PrintPage } from "./PrintPages";
import "./export.css";

const PrintPages = dynamic(() => import("./PrintPages").then((m) => m.PrintPages), { ssr: false, loading: () => null });

export type ExportFormat = "markdown" | "word" | "html" | "pdf";
export type CommentStyle = "margin" | "footnotes";

const FORMATS: Array<{ id: ExportFormat; name: string; ext: string; icon: string; blurb: string }> = [
  { id: "markdown", name: "Markdown", ext: ".md", icon: "doc", blurb: "Any Markdown app, Git or wiki" },
  { id: "word", name: "Word", ext: ".docx", icon: "lines", blurb: "Word, Pages or Google Docs" },
  { id: "html", name: "HTML", ext: ".html", icon: "globe", blurb: "One file for any browser" },
  { id: "pdf", name: "PDF", ext: ".pdf", icon: "printer", blurb: "Print-ready, from your browser" },
];

const MAX_PDF_PAGES = 50;

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  title: string | null;
  /** The page's Markdown as this reader has it (the PDF prints it; images are looked for in it). */
  content: string;
  assets: Record<string, AssetUrl> | null;
  crumbs: Crumb[];
  /** Readable sub-pages (the page read's children_count). */
  childrenCount: number;
  /** Can this person edit the page (they may always export, and see whether readers may). */
  canEdit: boolean;
  secret?: string | null;
  viewer?: string | null;
}

type Phase = { kind: "idle" } | { kind: "working"; received: number; total: number | null; label: string } | { kind: "printing"; pages: PrintPage[] } | { kind: "error"; message: string };

async function collectSubpages(root: PrintPage, limit: number, onCount: (n: number) => void): Promise<PrintPage[]> {
  const { getPage, listChildren } = await import("@/lib/pages");
  const out: PrintPage[] = [];
  let level: Array<{ slug: string; crumbs: Crumb[] }> = [{ slug: root.slug, crumbs: [...root.crumbs, { slug: root.slug, title: root.title }] }];
  for (let depth = 0; depth < 8 && level.length && out.length < limit; depth++) {
    const next: typeof level = [];
    for (const parent of level) {
      const kids = await listChildren(parent.slug).catch(() => []);
      for (const k of kids) {
        if (out.length >= limit) break;
        const doc = await getPage(k.slug).catch(() => null);
        if (!doc || doc.encrypted || doc.kind === "artifact") continue;
        const content = doc.content ?? "";
        const canEdit = !!(doc as { can?: { edit?: boolean } | null }).can?.edit;
        if (!canEdit && readPageProps(content).allowExport === false) continue;
        out.push({ slug: k.slug, title: doc.title ?? k.title, content, assets: doc.assets ?? null, crumbs: parent.crumbs });
        onCount(out.length);
        next.push({ slug: k.slug, crumbs: [...parent.crumbs, { slug: k.slug, title: doc.title ?? k.title }] });
      }
    }
    level = next;
  }
  return out;
}

export function ExportDialog({ open, onClose, slug, title, content, assets, crumbs, childrenCount, canEdit, secret, viewer }: ExportDialogProps) {
  const toast = useToast();
  const [preset] = useState(() => takeExportPreset());
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [subpages, setSubpages] = useState(false);
  // Comments: offered when this reader can see the page's comments and there are some.
  const [threads, setThreads] = useState<ExportThreadDto[] | null>(null);
  const [withComments, setWithComments] = useState(!!preset?.comments);
  const [commentStyle, setCommentStyle] = useState<CommentStyle>("margin");
  const [openOnly, setOpenOnly] = useState(false);
  const images = useMemo(() => hasPageImages(content), [content]);
  const [withImages, setWithImages] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  const groupId = useId();
  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  const readersMay = readPageProps(content).allowExport;

  useEffect(() => {
    if (!open) {
      abort.current?.abort();
      setPhase({ kind: "idle" });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    getExportThreads(slug, "all").then((t) => { if (live) setThreads(t); }).catch(() => { if (live) setThreads([]); });
    return () => { live = false; };
  }, [open, slug]);

  const commentCount = threads?.length ?? 0;
  const openCount = threads?.filter((t) => t.status === "open").length ?? 0;
  const commentsOffered = commentCount > 0 && format !== "html";
  const comments = commentsOffered && withComments && (!openOnly || openCount > 0);
  const zip = format === "markdown" && (subpages || (images && withImages));
  const busy = phase.kind === "working" || phase.kind === "printing";
  const fileName = format === "pdf" ? null : format === "word" ? exportFileName(title, "docx")
    : exportFileName(title, zip || (format === "html" && subpages) ? "zip" : format === "html" ? "html" : "md");

  const what =
    format === "markdown"
      ? zip
        ? subpages
          ? "A .zip: page.md with an images folder, and a folder for each sub-page you can open."
          : "A .zip: page.md and an images folder it links to."
        : images
          ? "One .md file. Its images stay links on Markdrop; turn on images to get a .zip."
          : "One .md file, ready for GitHub, Obsidian, VS Code or another wiki."
      : format === "word"
        ? comments
          ? commentStyle === "margin"
            ? "A Word document, with the comments in the margin next to the words they're about."
            : "A Word document, with each comment as a footnote after the words it's about."
          : "A Word document of this page. Images show as their descriptions."
      : format === "html"
        ? subpages
          ? "A .zip with an HTML file for each page, linked to each other."
          : "One .html file with its images inside. Opens anywhere, even offline."
        : subpages
          ? "Your browser's print dialog with this page and its sub-pages, each from a new sheet. Choose Save as PDF."
          : "Your browser's print dialog, with the page laid out for paper. Choose Save as PDF.";
  const commentsWhat = !comments ? null
    : format === "markdown" ? "The comments go in a Comments section at the end."
      : format === "pdf" ? (commentStyle === "margin" ? "Comments print as numbered notes in the margin." : "Comments print as numbered notes at the end.")
        : null;

  function onCardKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const n = (i + delta + FORMATS.length) % FORMATS.length;
    setFormat(FORMATS[n]!.id);
    cards.current[n]?.focus();
  }

  async function run() {
    track("page_export", { format, subpages, comments });
    if (format === "pdf") {
      let printThreads: ExportThreadDto[] | undefined;
      if (comments) {
        try {
          printThreads = await getExportThreads(slug, openOnly ? "open" : "all");
        } catch {
          setPhase({ kind: "error", message: "Couldn't read the comments. Try again, or print without them." });
          return;
        }
      }
      const root: PrintPage = { slug, title, content, assets, crumbs, comments: printThreads ? { threads: printThreads, style: commentStyle } : undefined };
      let pages = [root];
      if (subpages && childrenCount > 0) {
        setPhase({ kind: "working", received: 0, total: null, label: "Gathering sub-pages…" });
        try {
          const kids = await collectSubpages(root, MAX_PDF_PAGES - 1, (n) => setPhase({ kind: "working", received: n, total: null, label: `Gathering sub-pages… ${n}` }));
          pages = [root, ...kids];
        } catch {
          setPhase({ kind: "error", message: "Couldn't read the sub-pages. Try again, or print this page alone." });
          return;
        }
      }
      setPhase({ kind: "printing", pages });
      return;
    }
    const kind = format === "html" ? "html" : format === "word" ? "docx" : zip ? "zip" : "md";
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase({ kind: "working", received: 0, total: null, label: "Preparing your export…" });
    try {
      const blob = await fetchExport(slug, {
        kind,
        subpages: format === "word" ? false : subpages,
        comments: comments ? (format === "markdown" ? "footnotes" : commentStyle) : null,
        commentStatus: openOnly ? "open" : "all",
        secret,
        signal: ctrl.signal,
        onProgress: (received, total) => setPhase({ kind: "working", received, total, label: "Downloading…" }),
      });
      saveBlob(blob, fileName!);
      toast.success(`Exported “${fileName}”`);
      onClose();
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setPhase({ kind: "error", message: e instanceof ExportFailed ? e.message : "The export didn't work. Try again." });
    }
  }

  const printed = () => {
    // The layer goes when the print dialog closes (afterprint); a browser that never says so gets
    // a minute (the layer is invisible on screen meanwhile).
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("afterprint", finish);
      window.clearTimeout(timer);
      setPhase({ kind: "idle" });
      onClose();
    };
    window.addEventListener("afterprint", finish);
    const timer = window.setTimeout(finish, 60_000);
    window.print();
  };

  const primary = format === "pdf" ? "Print to PDF…" : format === "word" ? "Download .docx"
    : `Download ${zip || (format === "html" && subpages) ? ".zip" : format === "html" ? ".html" : ".md"}`;

  return (
    <>
      <Dialog
        open={open}
        onClose={() => {
          abort.current?.abort();
          onClose();
        }}
        title="Export page"
        description={<span className="pbx-desc ph-sensitive ph-mask" dir="auto">{title?.trim() || "Untitled"}</span>}
        glyph={<Icon name="download" />}
        className="pbx-dialog"
        footer={
          <>
            {canEdit && (
              <span className="pbx-foot-note">
                <Icon name={readersMay ? "eye" : "lock"} size={14} aria-hidden />
                {readersMay ? "Readers can export this page too" : "Only editors can export this page"}
              </span>
            )}
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void run()} loading={busy} iconLeft={format === "pdf" ? "printer" : "download"}>
              {primary}
            </Button>
          </>
        }
      >
        <div className="pbx">
          <div role="radiogroup" aria-labelledby={`${groupId}-l`} className="pbx-formats">
            <span id={`${groupId}-l`} className="md-visually-hidden">Format</span>
            {FORMATS.map((f, i) => (
              <button
                key={f.id}
                ref={(el) => {
                  cards.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={format === f.id}
                tabIndex={format === f.id ? 0 : -1}
                className="pbx-card md-focus"
                data-format={f.id}
                disabled={busy}
                onClick={() => setFormat(f.id)}
                onKeyDown={(e) => onCardKey(e, i)}
              >
                <span className="pbx-card__tile" aria-hidden>
                  <Icon name={f.icon} size={18} />
                </span>
                <span className="pbx-card__name">
                  {f.name} <span className="pbx-card__ext">{f.ext}</span>
                </span>
                <span className="pbx-card__blurb">{f.blurb}</span>
                <span className="pbx-card__check" aria-hidden>
                  <Icon name="check" size={12} />
                </span>
              </button>
            ))}
          </div>

          <div className="pbx-options">
            {childrenCount > 0 && format !== "word" && (
              <div className="pbx-option">
                <Switch label="Include sub-pages" checked={subpages} disabled={busy} onChange={() => setSubpages(!subpages)} />
                <span className="pbx-option__hint">
                  {childrenCount === 1 ? "1 page inside" : `${childrenCount} pages inside`}, and the pages inside them. Only the ones you can open.
                </span>
              </div>
            )}
            {format === "markdown" && images && !subpages && (
              <div className="pbx-option">
                <Switch label="Include images" checked={withImages} disabled={busy} onChange={() => setWithImages(!withImages)} />
                <span className="pbx-option__hint">Saves a .zip with the page&apos;s images next to it.</span>
              </div>
            )}
            {commentsOffered && (
              <div className="pbx-option" data-testid="export-comments">
                <Switch label="Include comments" checked={withComments} disabled={busy} onChange={() => setWithComments(!withComments)} />
                <span className="pbx-option__hint">
                  {commentCount === 1 ? "1 thread" : `${commentCount} threads`}{openCount !== commentCount ? `, ${openCount} open` : ""}
                  {subpages && format !== "word" ? ". This page's comments only." : "."}
                </span>
                {withComments && (
                  <div className="pbx-option__more">
                    {format !== "markdown" && (
                      <SegmentedControl<CommentStyle>
                        size="sm"
                        aria-label="Where the comments go"
                        value={commentStyle}
                        onChange={setCommentStyle}
                        disabled={busy}
                        options={[
                          { value: "margin", label: format === "word" ? "Margin comments" : "Margin notes" },
                          { value: "footnotes", label: format === "word" ? "Footnotes" : "Notes at the end" },
                        ]}
                      />
                    )}
                    <Switch label="Open threads only" checked={openOnly} disabled={busy || openCount === 0} onChange={() => setOpenOnly(!openOnly)} />
                  </div>
                )}
              </div>
            )}
          </div>

          <p className="pbx-what" aria-live="polite">
            <Icon name="info" size={14} aria-hidden /> <span>{what}{commentsWhat ? ` ${commentsWhat}` : ""}</span>
          </p>

          {phase.kind === "working" && (
            <Progress
              className="pbx-progress"
              label={phase.label}
              indeterminate={!phase.total}
              value={phase.total ? phase.received : 0}
              max={phase.total ?? 100}
              meta={phase.received && format !== "pdf" ? formatBytes(phase.received) : undefined}
            />
          )}
          {phase.kind === "printing" && <Progress className="pbx-progress" label="Laying out the pages for print…" indeterminate />}
          {phase.kind === "error" && (
            <Alert tone="danger" className="pbx-error" onDismiss={() => setPhase({ kind: "idle" })}>
              {phase.message}
            </Alert>
          )}
        </div>
      </Dialog>
      {phase.kind === "printing" && <PrintPages pages={phase.pages} viewer={viewer} onReady={printed} />}
    </>
  );
}

export default ExportDialog;
