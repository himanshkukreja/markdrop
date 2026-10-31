"use client";

/**
 * Atom blocks edited through small forms: the figure (an image with caption, alt text and an
 * optional dark-theme version), and the one-line directives ::video, ::clip, ::embed and ::api.
 */
import { useEffect, useId, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Button, Icon, IconButton, Input, Spinner, Switch, useToast } from "@/components/ui";
import { darkVariantPath, uploadUrl, useHost } from "../host";
import { cx, TextField, withAttr } from "./shared";

/* ── Figure ──────────────────────────────────────────────────────────────── */

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

export function FigureView({ node, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
  const host = useHost();
  const up = useUpload();
  const { src, alt, title } = node.attrs as { src: string; alt: string; title: string | null };
  const [url, setUrl] = useState("");
  const [dark, setDark] = useState<string | null>(null);
  const [showAlt, setShowAlt] = useState(false);
  const altId = useId();

  // Is there a dark-theme version next to the image (x.dark.webp)? Shown as a small thumbnail.
  useEffect(() => {
    setDark(null);
    if (!src) return;
    const d = host.resolveAsset(darkVariantPath(src));
    const img = new Image();
    img.onload = () => setDark(d);
    img.src = d;
    return () => {
      img.onload = null;
    };
  }, [src, host]);

  const upload = async (file: File) => {
    const u = await up.run(file, { variant: "light" });
    if (u) updateAttributes({ src: u, alt: alt || file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ") });
  };
  const uploadDark = async (file: File) => {
    const u = await up.run(file, { variant: "dark", for: src });
    if (u) setDark(host.resolveAsset(u));
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

  return (
    <NodeViewWrapper className={cx("dxe-block dxe-figure", selected && "dxe-selected")}>
      <figure className="dx-fig not-prose">
        <div className="dx-fig__frame dxe-figure__frame" data-drag-handle="">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={host.resolveAsset(src)} alt={alt} className="dx-fig__img" draggable={false} />
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
              <Button size="sm" variant="ghost" iconLeft="moon" onClick={() => pickFile(uploadDark)} title="Shown instead in the dark theme">
                {dark ? "Replace dark version" : "Add dark version"}
              </Button>
            </>
          )}
          <IconButton icon="trash" label="Delete image" size="sm" onClick={() => deleteNode()} />
        </div>
      )}
      {showAlt && (
        <div contentEditable={false} id={altId} className="dxe-figure__alt">
          <TextField label="Alt text: what the image shows, for people who can't see it" wide value={alt} onChange={(v) => updateAttributes({ alt: v })} placeholder="e.g. The Share dialog with Anyone with the link selected" />
        </div>
      )}
    </NodeViewWrapper>
  );
}

/* ── ::video / ::clip / ::embed / ::api ──────────────────────────────────── */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function LeafView({ node, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
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

