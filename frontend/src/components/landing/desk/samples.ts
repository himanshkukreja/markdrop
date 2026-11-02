/**
 * The five files on the landing page's hero desk (frontend/scripts/landing-samples/: the real sample
 * files, fictional Acme content). Dropping one shows it on the laptop's screen with Markdrop's real
 * renderer: the document renderer (MarkdownPreview, Mermaid included) for the Markdown, and for the
 * others the real viewer pages under /landing-demo/ (the artifact Worker's own PDF / spreadsheet /
 * video viewers, and the HTML file itself), framed in a sandbox like Markdrop's file viewer.
 *
 * `slug` is the markdrop.in address each sample is published at (marketingFlags SAMPLE_SLUGS); the
 * address bar links it only once it is listed in SAMPLE_SLUGS_PUBLISHED.
 */
export type FileId = "md" | "html" | "pdf" | "video" | "sheet";

export interface DeskFile {
  id: FileId;
  /** The file's name on the desk. */
  name: string;
  slug: string;
  /** What kind of thing it is, for announcements. */
  kind: string;
  /** The real render: "markdown" mounts MarkdownPreview; otherwise a sandboxed frame of `frame`. */
  render: "markdown" | "frame";
  /** Viewer page per theme (`{theme}` is replaced by light | dark), under /landing-demo/. */
  frame?: string;
}

export const DESK_FILES: readonly DeskFile[] = [
  {
    id: "md",
    name: "notes.md",
    slug: "launch-notes",
    kind: "Markdown document",
    render: "markdown",
  },
  {
    id: "html",
    name: "launch.html",
    slug: "workflows-launch",
    kind: "HTML page",
    render: "frame",
    frame: "/landing-demo/launch-dashboard.html?theme={theme}",
  },
  {
    id: "pdf",
    name: "deck.pdf",
    slug: "acme-deck",
    kind: "PDF",
    render: "frame",
    frame: "/landing-demo/pdf.{theme}.html",
  },
  {
    id: "video",
    name: "demo.mp4",
    slug: "product-demo",
    kind: "Video",
    render: "frame",
    frame: "/landing-demo/video.html",
  },
  {
    id: "sheet",
    name: "budget.xlsx",
    slug: "budget-2026",
    kind: "Spreadsheet",
    render: "frame",
    frame: "/landing-demo/sheet.{theme}.html",
  },
];

export const fileById = (id: FileId): DeskFile => DESK_FILES.find((f) => f.id === id) ?? DESK_FILES[0];

/** The Markdown sample, as the laptop fetches it (copied from scripts/landing-samples by build-demo). */
export const MARKDOWN_SRC = "/landing-demo/files/launch-notes.md";
