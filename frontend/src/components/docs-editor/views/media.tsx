"use client";

/**
 * Atom blocks edited through small forms: the figure (an image with caption, alt text and an
 * optional dark-theme version), and the one-line directives ::video, ::clip, ::embed and ::api.
 */
import { useEffect, useId, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Button, Icon, IconButton, Input, Spinner, Switch, useToast } from "@/components/ui";
import { darkVariantPath, uploadUrl, useHost } from "../host";
import { createProbe } from "../core/assetProbe.mjs";
import { cx, TextField, withAttr } from "./shared";
import { MarkdropView } from "./markdrop";
import { PageEmbedView } from "./pageItems";
import { PageLeafView } from "./pageLeaves";
import { ImageLightbox, downloadImage } from "./Lightbox";
import { cleanAttrs } from "../core/attrs.mjs";
import { suggestedAlts } from "../menus/aiAlt";

/** "✦ Alt text suggested": AI described the image; shown until someone edits the description. */
function AltSuggested({ onReview }: { onReview: () => void }) {
  return (
    <button type="button" contentEditable={false} className="dxe-altsug" onClick={onReview} title="AI described this image. Check the alt text.">
      <Icon name="sparkle" size={12} aria-hidden /> Alt text suggested
    </button>
  );
}

/* ── A page's image: resize handles, alignment, full screen, download, replace ── */

type Align = "left" | "center" | "right";

function AlignIcon({ a }: { a: Align }) {
  // Three lines, the short ones placed like the image would be.
  const x = a === "left" ? 2 : a === "center" ? 5 : 8;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M2 2.5h12" />
      <rect x={x} y="5.5" width="6" height="5" rx="1" />
      <path d="M2 13.5h12" />
    </svg>
  );
}

function PageFigure({ src, size, alt, title, battrs, selected, readOnly, busy, canUpload, onAttrs, onReplace, onDelete, onAlt, altOpen, altId, altEditor, altSuggested }: {
  src: string;
  /** Its size in pixels when known: the image keeps its room while it loads (nothing below jumps). */
  size?: { width: number; height: number } | null;
  alt: string;
  title: string | null;
  battrs: Record<string, string> | null;
  selected: boolean;
  readOnly: boolean;
  busy: boolean;
  canUpload: boolean;
  onAttrs: (a: Record<string, unknown>) => void;
  onReplace: () => void;
  onDelete: () => void;
  onAlt: () => void;
  altOpen: boolean;
  altId: string;
  altEditor: React.ReactNode;
  altSuggested?: boolean;
}) {
  const [full, setFull] = useState(false);
  const [live, setLive] = useState<number | null>(null); // width (%) while dragging
  const box = useRef<HTMLDivElement>(null);
  const sizeLabel = useRef<HTMLSpanElement>(null);
  const width = live ?? (battrs?.width ? parseFloat(battrs.width) : 100);
  const align = (battrs?.align as Align | undefined) ?? "center";
  const set = (patch: Record<string, string | null>) => onAttrs({ battrs: cleanAttrs({ ...(battrs ?? {}), ...patch }) });
  const commitWidth = (w: number) => set({ width: w >= 99.5 ? null : `${Math.round(w)}%` });

  const startResize = (side: "l" | "r") => (e: React.PointerEvent) => {
    if (readOnly || e.button !== 0) return;
    const el = box.current;
    const column = el?.parentElement;
    if (!el || !column) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const total = column.getBoundingClientRect().width;
    const start = el.getBoundingClientRect().width;
    const x0 = e.clientX;
    // Centred images grow on both sides, so a pixel of pointer is two of width.
    const k = align === "center" ? 2 : 1;
    let w = (start / total) * 100;
    // Every frame, straight to the box's style (no React render per pointer move): 60 fps.
    let raf = 0;
    const paint = () => {
      raf = 0;
      el.style.setProperty("--pb-w", `${w}%`);
      if (sizeLabel.current) sizeLabel.current.textContent = `${Math.round(w)}%`;
    };
    setLive(w);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) * (side === "r" ? 1 : -1) * k;
      w = Math.max(15, Math.min(100, ((start + dx) / total) * 100));
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cancelAnimationFrame(raf);
      setLive(null);
      commitWidth(w);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const keyResize = (side: "l" | "r") => (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const grow = (e.key === "ArrowRight") === (side === "r");
    commitWidth(Math.max(15, Math.min(100, width + (grow ? 5 : -5))));
  };

  return (
    <NodeViewWrapper className={cx("dxe-block dxe-figure dxe-figure--sized", selected && "dxe-selected")} data-bid={battrs?.id}>
      <div ref={box} className="dxe-figure__box" data-align={align} data-resizing={live !== null ? "" : undefined} style={{ "--pb-w": `${width}%` } as React.CSSProperties}>
        <div className="dx-fig__frame dxe-figure__frame" data-drag-handle="">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src || undefined} alt={alt} width={size?.width} height={size?.height} className="dx-fig__img" draggable={false} loading="lazy" decoding="async" onDoubleClick={() => setFull(true)} />
        </div>
        {live !== null && <span ref={sizeLabel} className="dxe-figure__size">{Math.round(live)}%</span>}
        {!readOnly && (
          <>
            <button type="button" contentEditable={false} className="dxe-figure__handle dxe-figure__handle--l" aria-label="Resize the image (left edge)" onPointerDown={startResize("l")} onKeyDown={keyResize("l")} />
            <button type="button" contentEditable={false} className="dxe-figure__handle dxe-figure__handle--r" aria-label="Resize the image (right edge)" onPointerDown={startResize("r")} onKeyDown={keyResize("r")} />
          </>
        )}
        <div contentEditable={false} className="dxe-figure__over" role="toolbar" aria-label="Image">
          {!readOnly &&
            (["left", "center", "right"] as const).map((a) => (
              <button key={a} type="button" className="dxe-figure__obtn" aria-label={`Align ${a}`} title={`Align ${a}`} aria-pressed={align === a} onClick={() => set({ align: a === "center" ? null : a })}>
                <AlignIcon a={a} />
              </button>
            ))}
          {!readOnly && <span className="dxe-figure__osep" aria-hidden />}
          <button type="button" className="dxe-figure__obtn" aria-label="View full screen" title="View full screen" onClick={() => setFull(true)}>
            <Icon name="expand" size={15} />
          </button>
          <button type="button" className="dxe-figure__obtn" aria-label="Download" title="Download" onClick={() => void downloadImage(src, alt || title || "image")}>
            <Icon name="download" size={15} />
          </button>
          {!readOnly && canUpload && (
            <button type="button" className="dxe-figure__obtn" aria-label="Replace image" title="Replace" onClick={onReplace} disabled={busy}>
              {busy ? <Spinner size={12} /> : <Icon name="upload" size={15} />}
            </button>
          )}
          {!readOnly && (
            <button type="button" className="dxe-figure__obtn" aria-label={alt ? "Edit alt text" : "Add alt text (missing)"} title="Alt text" aria-expanded={altOpen} aria-controls={altId} onClick={onAlt}>
              <Icon name="type" size={15} />
            </button>
          )}
          {!readOnly && (
            <button type="button" className="dxe-figure__obtn" aria-label="Delete image" title="Delete" onClick={onDelete}>
              <Icon name="trash" size={15} />
            </button>
          )}
        </div>
        <figcaption contentEditable={false} className="dx-fig__cap dxe-figure__cap pb-caption">
          <input value={title ?? ""} placeholder="Add a caption" aria-label="Caption" readOnly={readOnly} onChange={(e) => onAttrs({ title: e.target.value || null })} />
        </figcaption>
      </div>
      {altSuggested && !readOnly && !altOpen && <AltSuggested onReview={onAlt} />}
      {altEditor}
      {full && <ImageLightbox src={src} alt={alt} caption={title} onClose={() => setFull(false)} />}
    </NodeViewWrapper>
  );
}

/* ── Figure ──────────────────────────────────────────────────────────────── */

// Dark versions: each address asked about once per session, two at a time (core/assetProbe.mjs).
const darkProbe = createProbe((url) => new Promise<boolean>((resolve) => {
  if (typeof Image === "undefined") return resolve(false);
  const img = new Image();
  img.onload = () => resolve(true);
  img.onerror = () => resolve(false);
  img.src = url;
}));

function useUpload() {
  const host = useHost();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (file: File, info: { variant: "light" | "dark"; for?: string }) => {
    if (!host.upload) return null;
    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image file (PNG, JPG, WebP, GIF or SVG).");
      return null;
    }
    setBusy(true);
    try {
      return await uploadUrl(host.upload, file, info);
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "The upload failed. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run, can: !!host.upload };
}

function pickFile(onFile: (f: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) onFile(f);
  };
  input.click();
}

export function FigureView({ node, updateAttributes, deleteNode, selected, editor }: ReactNodeViewProps) {
  const host = useHost();
  const up = useUpload();
  const { src, alt, title } = node.attrs as { src: string; alt: string; title: string | null };
  const aiAlt = !!alt && suggestedAlts(editor).get(src) === alt;
  const altLabel = aiAlt ? "✦ Suggested by AI. Alt text: what the image shows, for people who can't see it" : "Alt text: what the image shows, for people who can't see it";
  const [url, setUrl] = useState("");
  const [dark, setDark] = useState<string | null>(null);
  const [showAlt, setShowAlt] = useState(false);
  const altId = useId();

  // Is there a dark-theme version next to the image (x.dark.webp)? Shown as a small thumbnail.
  useEffect(() => {
    setDark(null);
    if (!src || host.darkImages === false) return;
    const d = host.resolveAsset(darkVariantPath(src));
    let live = true;
    void darkProbe.probe(d).then((ok) => {
      if (live && ok) setDark(d);
    });
    return () => {
      live = false;
    };
  }, [src, host]);

  const upload = async (file: File) => {
    const u = await up.run(file, { variant: "light" });
    if (u) updateAttributes({ src: u, alt: alt || file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ") });
  };
  const uploadDark = async (file: File) => {
    const u = await up.run(file, { variant: "dark", for: src });
    if (u) {
      const d = host.resolveAsset(u);
      darkProbe.set(d, true);
      setDark(d);
    }
  };

  if (!src) {
    return (
      <NodeViewWrapper className={cx("dxe-block dxe-figure dxe-figure--empty", selected && "dxe-selected")} data-drag-handle="">
        <div
          contentEditable={false}
          className="dxe-drop"
          onDragOver={(e) => {
            if (up.can && e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            const f = e.dataTransfer.files?.[0];
            if (f && up.can) {
              e.preventDefault();
              e.stopPropagation();
              void upload(f);
            }
          }}
        >
          <Icon name="image" />
          {up.busy ? (
            <Spinner label="Uploading" />
          ) : (
            <>
              {up.can && (
                <Button size="sm" variant="secondary" iconLeft="upload" onClick={() => pickFile(upload)} disabled={host.readOnly}>
                  Upload an image
                </Button>
              )}
              <form
                className="dxe-drop__url"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (url.trim()) updateAttributes({ src: url.trim() });
                }}
              >
                <Input size="sm" placeholder={up.can ? "…or paste an image address" : "Image address (https://… or /docs-assets/…)"} value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Image address" readOnly={host.readOnly} />
                <Button size="sm" variant="ghost" type="submit" disabled={!url.trim()}>
                  Add
                </Button>
              </form>
              <IconButton icon="trash" label="Remove image block" size="sm" onClick={() => deleteNode()} />
            </>
          )}
        </div>
      </NodeViewWrapper>
    );
  }

  if (host.pages) {
    return (
      <PageFigure
        src={host.resolveAsset(src)}
        size={host.pages.assetSize?.(src)}
        alt={alt}
        title={title}
        battrs={(node.attrs.battrs as Record<string, string> | null) ?? null}
        selected={selected}
        readOnly={!!host.readOnly}
        busy={up.busy}
        canUpload={up.can}
        onAttrs={(a) => updateAttributes(a)}
        onReplace={() => pickFile(upload)}
        onDelete={() => deleteNode()}
        altEditor={
          <>
            {showAlt && (
              <div contentEditable={false} id={altId} className="dxe-figure__alt">
                <TextField label={altLabel} wide value={alt} onChange={(v) => updateAttributes({ alt: v })} placeholder="e.g. The Share dialog with Anyone with the link selected" />
              </div>
            )}
          </>
        }
        onAlt={() => setShowAlt(!showAlt)}
        altOpen={showAlt}
        altId={altId}
        altSuggested={aiAlt}
      />
    );
  }

  return (
    <NodeViewWrapper className={cx("dxe-block dxe-figure", selected && "dxe-selected")}>
      <figure className="dx-fig not-prose">
        <div className="dx-fig__frame dxe-figure__frame" data-drag-handle="">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={host.resolveAsset(src)} alt={alt} className="dx-fig__img" draggable={false} loading="lazy" decoding="async" />
          {dark && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dark} alt="" className="dxe-figure__dark" title="Dark-theme version" />
          )}
        </div>
        <figcaption contentEditable={false} className="dx-fig__cap dxe-figure__cap">
          <input value={title ?? ""} placeholder="Add a caption" aria-label="Caption" readOnly={host.readOnly} onChange={(e) => updateAttributes({ title: e.target.value || null })} />
        </figcaption>
      </figure>
      {!host.readOnly && (
        <div contentEditable={false} className="dxe-figure__tools">
          <Button size="sm" variant="ghost" iconLeft="edit" aria-expanded={showAlt} aria-controls={altId} onClick={() => setShowAlt(!showAlt)}>
            Alt text{alt ? "" : " (missing)"}
          </Button>
          {up.can && (
            <>
              <Button size="sm" variant="ghost" iconLeft="upload" onClick={() => pickFile(upload)} loading={up.busy}>
                Replace
              </Button>
              {host.darkImages !== false && (
                <Button size="sm" variant="ghost" iconLeft="moon" onClick={() => pickFile(uploadDark)} title="Shown instead in the dark theme">
                  {dark ? "Replace dark version" : "Add dark version"}
                </Button>
              )}
            </>
          )}
          <IconButton icon="trash" label="Delete image" size="sm" onClick={() => deleteNode()} />
        </div>
      )}
      {aiAlt && !host.readOnly && !showAlt && <AltSuggested onReview={() => setShowAlt(true)} />}
      {showAlt && (
        <div contentEditable={false} id={altId} className="dxe-figure__alt">
          <TextField label={altLabel} wide value={alt} onChange={(v) => updateAttributes({ alt: v })} placeholder="e.g. The Share dialog with Anyone with the link selected" />
        </div>
      )}
    </NodeViewWrapper>
  );
}

/* ── ::video / ::clip / ::embed / ::api (::markdrop: views/markdrop.tsx) ──── */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function LeafView(props: ReactNodeViewProps) {
  // ::markdrop{src=…}: a Markdrop file, with its own picker and preview (views/markdrop.tsx).
  if ((props.node.attrs.name as string) === "markdrop") return <MarkdropLeaf {...props} />;
  return <PageOrGuideLeaf {...props} />;
}

/** A page draws its own blocks (bookmark, toc, breadcrumb, sub-page, web embed); a guide its forms. */
function PageOrGuideLeaf(props: ReactNodeViewProps) {
  const host = useHost();
  if (host.pages) return <PageLeafView {...props} fallback={<DirectiveLeafForm {...props} />} />;
  return <DirectiveLeafForm {...props} />;
}

/** A page (EditorHost.pages) embeds by slug with its own picker; a guide uses the Markdrop file block. */
function MarkdropLeaf(props: ReactNodeViewProps) {
  const host = useHost();
  return host.pages ? <PageEmbedView {...props} /> : <MarkdropView {...props} />;
}

function DirectiveLeafForm({ node, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
  const host = useHost();
  const listId = useId();
  const name = node.attrs.name as string;
  const a = (node.attrs.attributes ?? {}) as Record<string, string>;
  const set = (k: string, v: string) => updateAttributes({ attributes: withAttr(a, k, v) });
  const ro = host.readOnly;
  const del = !ro && <IconButton icon="trash" label={`Delete ${name}`} size="sm" className="dxe-leaf__del" onClick={() => deleteNode()} />;

  if (name === "video") {
    return (
      <NodeViewWrapper className={cx("dxe-block dxe-leaf", selected && "dxe-selected")} data-drag-handle="">
        <figure className="dx-video not-prose" contentEditable={false}>
          <div className="dx-video__frame dxe-leaf__frame">
            <span className="dx-video__play" aria-hidden>
              <Icon name="film" />
            </span>
            <span className="dx-video__soon">{a.title || "Video"}</span>
            {a.duration && <span className="dx-video__chip">{a.duration}</span>}
            {del}
          </div>
          <div className="dxe-form">
            <TextField label="Video id (videos.json)" value={a.id ?? ""} onChange={(v) => set("id", v.trim())} placeholder="publish-first-document" mono readOnly={ro} />
            <TextField label="Title" value={a.title ?? ""} onChange={(v) => set("title", v)} placeholder="What the video shows" readOnly={ro} />
            <TextField label="Length" value={a.duration ?? ""} onChange={(v) => set("duration", v.trim())} placeholder="0:45" readOnly={ro} />
          </div>
        </figure>
      </NodeViewWrapper>
    );
  }

  if (name === "clip") {
    return (
      <NodeViewWrapper className={cx("dxe-block dxe-leaf", selected && "dxe-selected")} data-drag-handle="">
        <figure className="dx-video not-prose" contentEditable={false}>
          <div className="dx-video__frame dxe-leaf__frame dxe-leaf__frame--short">
            <span className="dx-video__play" aria-hidden>
              <Icon name="play" />
            </span>
            <span className="dx-video__soon">{a.alt || "Clip: a short silent loop"}</span>
            {del}
          </div>
          <div className="dxe-form">
            <TextField label="File (without extension)" wide value={a.src ?? ""} onChange={(v) => set("src", v.trim())} placeholder="/docs-assets/page/clip-name" mono readOnly={ro} />
            <TextField label="Alt text" wide value={a.alt ?? ""} onChange={(v) => set("alt", v)} placeholder="What happens in the clip" readOnly={ro} />
            <TextField label="Caption" value={a.caption ?? ""} onChange={(v) => set("caption", v)} readOnly={ro} />
            <Field2>
              <Switch label="Has a dark version" checked={a.theme === "both"} disabled={ro} onChange={(e) => set("theme", e.target.checked ? "both" : "")} />
            </Field2>
          </div>
        </figure>
      </NodeViewWrapper>
    );
  }

  if (name === "embed") {
    return (
      <NodeViewWrapper className={cx("dxe-block dxe-leaf", selected && "dxe-selected")} data-drag-handle="">
        <figure className="dx-embed not-prose" contentEditable={false}>
          <figcaption className="dx-embed__bar">
            <Icon name="globe" />
            <span className="dx-embed__title">{a.title || a.src || "Embedded page"}</span>
            {del}
          </figcaption>
          <div className="dxe-form">
            <TextField label="Page address" wide value={a.src ?? ""} onChange={(v) => set("src", v.trim())} placeholder="https://…" mono readOnly={ro} />
            <TextField label="Title" value={a.title ?? ""} onChange={(v) => set("title", v)} readOnly={ro} />
          </div>
        </figure>
      </NodeViewWrapper>
    );
  }

  // ::api{op="METHOD /path"}: a placeholder for the operation's reference, filled in when published.
  const [method, ...rest] = (a.op ?? "").split(" ");
  const path = rest.join(" ");
  const ops = host.operations;
  return (
    <NodeViewWrapper className={cx("dxe-block dxe-leaf dxe-api", selected && "dxe-selected")} data-drag-handle="">
      <div contentEditable={false} className="dxe-api__card">
        <div className="dxe-api__head">
          <Icon name="server" />
          {a.op ? (
            <>
              <span className={cx("dxe-api__method", `dxe-api__method--${(method || "").toLowerCase()}`)}>{METHODS.includes(method) ? method : "API"}</span>
              <code className="dxe-api__path">{path || a.op}</code>
            </>
          ) : (
            <span className="dxe-api__empty">API endpoint: type its method and path below</span>
          )}
          {del}
        </div>
        <div className="dxe-form">
          <TextField label="Operation (METHOD /path)" wide value={a.op ?? ""} onChange={(v) => set("op", v)} placeholder="GET /v1/documents/{id}" mono readOnly={ro} list={ops.length ? listId : undefined} />
          {ops.length > 0 && (
            <datalist id={listId}>
              {ops.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.summary}
                </option>
              ))}
            </datalist>
          )}
          <TextField label="Title (optional)" value={a.title ?? ""} onChange={(v) => set("title", v)} readOnly={ro} />
        </div>
        <p className="dxe-api__note">Readers see this operation&apos;s parameters, request and responses, from the API reference.</p>
      </div>
    </NodeViewWrapper>
  );
}

function Field2({ children }: { children: React.ReactNode }) {
  return <div className="dxe-field dxe-field--switch">{children}</div>;
}

