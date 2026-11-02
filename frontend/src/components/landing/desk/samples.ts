/**
 * The five files on the landing page's desk (frontend/scripts/landing-samples/: the real sample
 * files, fictional Acme content). Each drops into a link card that mounts Markdrop's real renderer:
 * the document renderer (MarkdownPreview, Mermaid included) for the Markdown, and for the others the
 * real viewer pages under /landing-demo/ (the artifact Worker's own PDF / spreadsheet / video
 * viewers, and the HTML file itself), framed in a sandbox like Markdrop's file viewer.
 *
 * `slug` is the markdrop.in address the coordinator publishes each sample at (marketingFlags
 * SAMPLE_SLUGS); the card links it only once it is listed in SAMPLE_SLUGS_PUBLISHED.
 */
export type FileId = "md" | "html" | "pdf" | "video" | "sheet";

/** Where the card lands on the desktop desk: over the object's own corner of the mat. */
export type Slot = "left" | "center" | "right";

export interface DeskFile {
  id: FileId;
  /** The file's name on the desk tag. */
  name: string;
  slug: string;
  /** What kind of thing it is, for the card's label and announcements. */
  kind: string;
  /** The card's footer line. */
  note: string;
  slot: Slot;
  /** The real render: "markdown" mounts MarkdownPreview; otherwise a sandboxed frame of `frame`. */
  render: "markdown" | "frame";
  /** Viewer page per theme (`{theme}` is replaced by light | dark), under /landing-demo/. */
  frame?: string;
  /** Lay the frame out at this CSS width and scale it down to the card (a desktop page in a small card). */
  frameWidth?: number;
  /** The card's poster: a screenshot of that same render (public/landing-desk/posters/<id>[.dark].webp). */
  posterDark: boolean;
}

export const DESK_FILES: readonly DeskFile[] = [
  {
    id: "md",
    name: "notes.md",
    slug: "launch-notes",
    kind: "Markdown document",
    note: "Markdown with a Mermaid diagram, a table and code. No account needed.",
    slot: "left",
    render: "markdown",
    posterDark: true,
  },
  {
    id: "html",
    name: "launch.html",
    slug: "acme-pricing-calculator",
    kind: "HTML page",
    note: "A working page, running in a sandbox. Pick a plan, drag the seats.",
    slot: "center",
    render: "frame",
    frame: "/landing-demo/acme-pricing-calculator.html",
    frameWidth: 780,
    posterDark: false,
  },
  {
    id: "pdf",
    name: "deck.pdf",
    slug: "acme-deck",
    kind: "PDF",
    note: "Scroll the pages, zoom, select the text. Nothing to download.",
    slot: "right",
    render: "frame",
    frame: "/landing-demo/pdf.{theme}.html",
    posterDark: true,
  },
  {
    id: "video",
    name: "demo.mp4",
    slug: "product-demo",
    kind: "Video",
    note: "Plays in the browser, up to 2 GB. Replace it, keep the link.",
    slot: "center",
    render: "frame",
    frame: "/landing-demo/video.html",
    posterDark: false,
  },
  {
    id: "sheet",
    name: "budget.xlsx",
    slug: "budget-2026",
    kind: "Spreadsheet",
    note: "Every tab, in the browser. Summary, Headcount, Tools.",
    slot: "right",
    render: "frame",
    frame: "/landing-demo/sheet.{theme}.html",
    posterDark: true,
  },
];

export const fileById = (id: FileId): DeskFile => DESK_FILES.find((f) => f.id === id) ?? DESK_FILES[0];

/** The Markdown sample, as the card fetches it (copied from scripts/landing-samples by build-demo). */
export const MARKDOWN_SRC = "/landing-demo/files/launch-notes.md";
