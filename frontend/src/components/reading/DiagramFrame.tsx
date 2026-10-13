"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Button, Dialog, Skeleton } from "@/components/ui";
import { useTheme } from "@/lib/theme";
import { CodeBlock } from "./CodeBlock";

/* ── Mermaid: lazy, one instance, renders serialised ───────────────────────── */

type Mermaid = typeof import("mermaid").default;
let mermaidReady: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  return (mermaidReady ??= import("mermaid").then((m) => m.default));
}

// mermaid.initialize is global: run initialize + render as one unit so two diagrams rendering at
// once (or a theme switch mid-render) never mix configurations.
let queue: Promise<unknown> = Promise.resolve();
// A job that never settles must not block every later diagram: each one gets 15s.
function serial<T>(job: () => Promise<T>): Promise<T> {
  const timed = () =>
    Promise.race([job(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Diagram render timed out")), 15000))]);
  const run = queue.then(timed, timed);
  queue = run.catch(() => undefined);
  return run;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let renderSeq = 0;

/* ── Diagram type and caption ──────────────────────────────────────────────── */

const TYPES: [RegExp, string][] = [
  [/^(flowchart|graph)\b/, "Flowchart"],
  [/^sequenceDiagram\b/, "Sequence diagram"],
  [/^classDiagram/, "Class diagram"],
  [/^stateDiagram/, "State diagram"],
  [/^erDiagram\b/, "Entity relationship diagram"],
  [/^journey\b/, "User journey"],
  [/^gantt\b/, "Gantt chart"],
  [/^pie\b/, "Pie chart"],
  [/^quadrantChart\b/, "Quadrant chart"],
  [/^requirementDiagram\b/, "Requirement diagram"],
  [/^gitGraph\b/, "Git graph"],
  [/^C4\w*/, "C4 diagram"],
  [/^mindmap\b/, "Mind map"],
  [/^timeline\b/, "Timeline"],
  [/^sankey/, "Sankey diagram"],
  [/^xychart/, "XY chart"],
  [/^block/, "Block diagram"],
  [/^packet/, "Packet diagram"],
  [/^kanban\b/, "Kanban board"],
  [/^architecture/, "Architecture diagram"],
  [/^radar/, "Radar chart"],
  [/^treemap/, "Treemap"],
];

/** Strips front matter, `%%{init}%%` directives and `%%` comments. */
function body(code: string): string[] {
  let lines = code.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) lines = lines.slice(end + 1);
  }
  return lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
}

/** "Flowchart", "Sequence diagram"… ("Diagram" when unknown). */
export function diagramType(code: string): string {
  const first = body(code)[0] ?? "";
  return TYPES.find(([re]) => re.test(first))?.[1] ?? "Diagram";
}

/** The author's caption: front-matter `title:`, else `accTitle:`, else a `title` line (gantt, pie…). */
export function diagramTitle(code: string): string | null {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(code.trimStart());
  const fromFm = fm && /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]);
  if (fromFm) return fromFm[1];
  const acc = /^\s*accTitle\s*:\s*(.+)$/m.exec(code);
  if (acc) return acc[1].trim();
  const t = /^\s*(?:pie\s+)?title\s+(.+)$/m.exec(code);
  return t ? t[1].trim() : null;
}

/* ── Theme variables from computed tokens ─────────────────────────────────── */

let ctx2d: CanvasRenderingContext2D | null | undefined;
/** Any CSS colour composited over `ground` → an opaque "#rrggbb" mermaid's colour lib can parse. */
function solid(color: string, ground: string): string {
  ctx2d ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx2d) return color;
  ctx2d.globalCompositeOperation = "copy";
  ctx2d.fillStyle = ground || "#000";
  ctx2d.fillRect(0, 0, 1, 1);
  ctx2d.globalCompositeOperation = "source-over";
  ctx2d.fillStyle = color || ground;
  ctx2d.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx2d.getImageData(0, 0, 1, 1).data;
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Mermaid `base` themeVariables read from the tokens in effect at `el` (so a ThemeScope island
 * gets its own theme). REVAMP_PLAN 5.4: primaryColor = surface-raised, primaryBorderColor =
 * border-strong, primaryTextColor = text, lineColor = text-muted, clusterBkg = surface-inset,
 * noteBkgColor = accent-soft (composited to an opaque colour), fontFamily = Manrope.
 */
export function mermaidThemeVariables(el: Element): Record<string, string | boolean> {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const bg = solid(v("--bg"), "#000");
  const surface = solid(v("--surface"), bg);
  const c = (name: string, ground = surface) => solid(v(name), ground);
  const raised = c("--surface-raised");
  const inset = c("--surface-inset");
  const borderStrong = c("--border-strong");
  const border = c("--border");
  const text = c("--text");
  const secondary = c("--text-secondary");
  const muted = c("--text-muted");
  const accentText = c("--accent-text");
  const accentSoft = c("--accent-soft");
  const danger = c("--danger");
  const dangerSoft = c("--danger-soft");
  const font = v("--font-sans") || "Manrope, ui-sans-serif, system-ui, sans-serif";
  const chart = [1, 2, 3, 4, 5, 6].map((n) => c(`--chart-${n}`));
  const pies = Object.fromEntries(chart.map((col, i) => [`pie${i + 1}`, col]));
  return {
    darkMode: luminance(surface) < 0.2,
    background: surface,
    fontFamily: font,
    fontSize: "14px",
    primaryColor: raised,
    primaryBorderColor: borderStrong,
    primaryTextColor: text,
    secondaryColor: inset,
    secondaryBorderColor: borderStrong,
    secondaryTextColor: text,
    tertiaryColor: inset,
    tertiaryBorderColor: border,
    tertiaryTextColor: text,
    mainBkg: raised,
    nodeBorder: borderStrong,
    nodeTextColor: text,
    textColor: text,
    titleColor: text,
    lineColor: muted,
    defaultLinkColor: muted,
    arrowheadColor: muted,
    clusterBkg: inset,
    clusterBorder: borderStrong,
    edgeLabelBackground: surface,
    labelBackground: surface,
    noteBkgColor: accentSoft,
    noteTextColor: text,
    noteBorderColor: accentText,
    actorBkg: raised,
    actorBorder: borderStrong,
    actorTextColor: text,
    actorLineColor: muted,
    signalColor: muted,
    signalTextColor: text,
    labelBoxBkgColor: raised,
    labelBoxBorderColor: borderStrong,
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: inset,
    activationBorderColor: borderStrong,
    sequenceNumberColor: surface,
    labelColor: text,
    altBackground: inset,
    attributeBackgroundColorOdd: raised,
    attributeBackgroundColorEven: inset,
    sectionBkgColor: inset,
    altSectionBkgColor: surface,
    sectionBkgColor2: inset,
    taskBkgColor: raised,
    taskBorderColor: borderStrong,
    taskTextColor: text,
    taskTextLightColor: text,
    taskTextDarkColor: text,
    taskTextOutsideColor: text,
    taskTextClickableColor: accentText,
    activeTaskBkgColor: accentSoft,
    activeTaskBorderColor: accentText,
    doneTaskBkgColor: inset,
    doneTaskBorderColor: border,
    critBkgColor: dangerSoft,
    critBorderColor: danger,
    gridColor: border,
    todayLineColor: accentText,
    ...pies,
    pieTitleTextColor: text,
    pieSectionTextColor: text,
    pieLegendTextColor: secondary,
    pieStrokeColor: surface,
    pieOuterStrokeColor: border,
    pieOpacity: "0.85",
  };
}

/* ── The frame ─────────────────────────────────────────────────────────────── */

export interface DiagramFrameProps {
  /** Mermaid source. */
  code: string;
  /** Caption override (default: the diagram's own title, if any). */
  caption?: string;
  className?: string;
}

type Rendered = { svg: string; id: string };

/**
 * A Mermaid diagram (REVAMP_PLAN 7.6 "DiagramFrame"): a figure on `surface` with a border,
 * `radius-xl` and 24px padding; a figcaption naming the diagram type (plus the author's title);
 * loading = a 100%×180 Skeleton with "Rendering diagram"; error = a warning Alert above the source
 * as a CodeBlock; toolbar "View source" + "Open larger" (Dialog xl), always in the tab order.
 *
 * Mermaid stays lazy (dynamic import) and `securityLevel: "strict"`. The theme is `base` with
 * variables read from the computed tokens, and the diagram re-renders (debounced 100ms) when the
 * resolved theme changes. Only this component re-renders: the surrounding markdown (and KaTeX)
 * is untouched. The previous SVG stays up until the new one is ready, so nothing jumps.
 */
export function DiagramFrame({ code, caption, className }: DiagramFrameProps) {
  const { resolved } = useTheme();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [large, setLarge] = useState(false);
  const lastSig = useRef("");
  const ranOnce = useRef(false);
  const base = useId().replace(/[^a-zA-Z0-9]/g, "");
  const sourceId = `${base}-source`;
  const kind = useMemo(() => diagramType(code), [code]);
  const title = caption ?? diagramTitle(code);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let cancelled = false;
    const run = () => {
      const themeVariables = mermaidThemeVariables(el);
      const sig = code + "\u0000" + JSON.stringify(themeVariables);
      if (sig === lastSig.current) return;
      const id = `mmd-${base}-${++renderSeq}`;
      serial(async () => {
        const mermaid = await loadMermaid();
        // Measure labels with Manrope, but never wait long for it.
        await Promise.race([document.fonts?.ready, wait(1000)]);
        mermaid.initialize({
          startOnLoad: false,
          // Diagrams come from user markdown: 'strict' escapes labels and disables click handlers.
          securityLevel: "strict",
          theme: "base",
          themeVariables,
          fontFamily: String(themeVariables.fontFamily),
          // A parse failure rejects render() and we show the source; no injected error graphic.
          suppressErrorRendering: true,
        });
        return mermaid.render(id, code);
      })
        .then(({ svg }) => {
          if (cancelled) return;
          lastSig.current = sig;
          setFailed(false);
          setRendered({ svg, id });
        })
        .catch(() => {
          if (cancelled) return;
          lastSig.current = sig;
          setFailed(true);
        });
    };
    // First paint renders at once; theme switches wait 100ms (the toggle's own frame settles first).
    if (!ranOnce.current) {
      ranOnce.current = true;
      run();
      return () => {
        cancelled = true;
      };
    }
    const t = setTimeout(run, 100);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [code, resolved, base]);

  // The dialog shows its own copy: rename the ids so markers and scoped styles stay unique.
  const largeSvg = useMemo(() => (rendered ? rendered.svg.split(rendered.id).join(`${rendered.id}-lg`) : ""), [rendered]);

  if (failed) {
    return (
      <div ref={wrapRef} className={["md-diagram-error not-prose", className].filter(Boolean).join(" ")}>
        <Alert tone="warning">This diagram has a syntax error, so it&apos;s shown as source.</Alert>
        <CodeBlock code={code} language="mermaid" />
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={["md-diagram-wrap not-prose", className].filter(Boolean).join(" ")}>
      <figure className="md-diagram" data-source={showSource ? "" : undefined}>
        <div className="md-diagram__head">
          <figcaption className="md-diagram__caption">
            <span className="md-diagram__kind">{kind}</span>
            {title && <span className="md-diagram__title">{title}</span>}
          </figcaption>
          <div className="md-diagram__tools no-print">
            <Button variant="ghost" size="sm" iconLeft="code" aria-expanded={showSource} aria-controls={sourceId} onClick={() => setShowSource((s) => !s)}>
              <span className="md-diagram__btn-label">{showSource ? "Hide source" : "View source"}</span>
            </Button>
            <Button variant="ghost" size="sm" iconLeft="expand" aria-haspopup="dialog" onClick={() => setLarge(true)}>
              <span className="md-diagram__btn-label">Open larger</span>
            </Button>
          </div>
        </div>
        {rendered ? (
          <div className="md-diagram__canvas" dangerouslySetInnerHTML={{ __html: rendered.svg }} />
        ) : (
          <div className="md-diagram__loading">
            <Skeleton variant="rect" width="100%" height={180} />
            <span className="md-diagram__loading-text">Rendering diagram</span>
          </div>
        )}
        <div id={sourceId} hidden={!showSource} className="md-diagram__source">
          {showSource && <CodeBlock code={code} language="mermaid" />}
        </div>
      </figure>
      <Dialog open={large} onClose={() => setLarge(false)} title={title ?? kind} size="xl" bodyClassName="md-diagram-dialog">
        {largeSvg ? (
          <div className="md-diagram__canvas md-diagram__canvas--large" dangerouslySetInnerHTML={{ __html: largeSvg }} />
        ) : (
          <div className="md-diagram__loading">
            <Skeleton variant="rect" width="100%" height={240} />
            <span className="md-diagram__loading-text">Rendering diagram</span>
          </div>
        )}
      </Dialog>
    </div>
  );
}
