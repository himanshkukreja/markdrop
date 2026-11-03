"use client";

/**
 * A page's head: the cover (full width of the paper: a gallery cover or an image, with its focal
 * point), the icon (an emoji or an uploaded image) and the title, in the page's column.
 *
 * Editing: hovering the head shows "Add icon" / "Add cover" (their space is kept, so nothing
 * moves); hovering the cover shows Change cover, Reposition and Remove. Reposition: drag the image
 * up or down (or ↑/↓), then Save position; the image follows the pointer each frame without a
 * React render (the focal point is written once, on Save).
 */
import { useEffect, useRef, useState } from "react";
import { Icon, Input, cx } from "@/components/ui";
import dynamic from "next/dynamic";

// The picker (and its emoji list) loads when someone edits a page's icon, never for readers.
const EmojiPicker = dynamic(() => import("@/components/docs-editor/views/EmojiPicker").then((m) => m.EmojiPicker), { ssr: false, loading: () => null });
import { COVER_GALLERY, coverStyle, type PageProps } from "./pageProps";
import "./pages.css";

export function PageIconGlyph({ icon, resolve, size = 20, className }: { icon: string | null; resolve: (src: string) => string; size?: number; className?: string }) {
  if (!icon) return null;
  if (/^(asset:|https?:)/.test(icon)) {
    const src = resolve(icon);
    if (!src) return null;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className={cx("pb-iconimg", className)} style={{ width: size, height: size }} />;
  }
  return (
    <span className={cx("pb-emoji", className)} style={{ fontSize: size * 0.9, lineHeight: 1 }} aria-hidden>
      {icon}
    </span>
  );
}

function CoverPicker({ onPick, onUpload, onClose }: { onPick: (v: string) => void; onUpload?: (f: File) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState("");
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="pb-coverpick pb-pop" role="dialog" aria-label="Choose a cover">
      <div className="pb-coverpick__grid">
        {COVER_GALLERY.map((c) => (
          <button key={c.id} type="button" className="pb-coverpick__swatch md-focus" style={{ background: c.css }} aria-label={c.name} title={c.name} onClick={() => onPick(`gallery:${c.id}`)} />
        ))}
      </div>
      <div className="pb-coverpick__row">
        {onUpload && (
          <label className="pb-emojipick__upload md-focus">
            <Icon name="upload" size={14} /> Upload an image
            <input type="file" accept="image/*" className="md-visually-hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
          </label>
        )}
        <form className="pb-coverpick__url" onSubmit={(e) => { e.preventDefault(); if (/^https:\/\//.test(url.trim())) onPick(url.trim()); }}>
          <Input size="sm" placeholder="…or an image link (https://…)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Image link" />
        </form>
      </div>
    </div>
  );
}

export interface PageHeadProps {
  title: string | null;
  props: PageProps;
  resolve: (src: string) => string;
  /** Editing: change the properties and the title. */
  edit?: {
    onProps: (patch: Partial<PageProps>) => void;
    onTitle: (t: string) => void;
    onEnter: () => void;
    upload: (f: File) => Promise<string>;
    readOnly?: boolean;
  } | null;
  /** Shown above the title, in the column (rarely: the top bar carries the breadcrumbs). */
  top?: React.ReactNode;
  /** Shown under the title, in the column (backlinks). */
  below?: React.ReactNode;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function PageHead({ title, props, resolve, edit, top, below }: PageHeadProps) {
  const [iconOpen, setIconOpen] = useState<"icon" | "add" | null>(null);
  const [coverOpen, setCoverOpen] = useState<"cover" | "add" | null>(null);
  const [moving, setMoving] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const posRef = useRef(props.coverY);
  const style = coverStyle(props.cover, resolve);
  const ro = !edit || edit.readOnly;

  // A new focal point from the page (someone else's edit, or Save) when not repositioning.
  useEffect(() => {
    if (!moving) posRef.current = props.coverY;
  }, [props.coverY, moving]);
  // Read only now (someone else took the lock): stop repositioning.
  useEffect(() => {
    if (ro) setMoving(false);
  }, [ro]);

  const paint = (y: number) => {
    posRef.current = y;
    if (imgRef.current) imgRef.current.style.objectPosition = `50% ${y}%`;
  };

  // How far (in %) one pixel of drag moves the image: 1:1 with the pointer while the image overflows.
  const pctPerPx = () => {
    const box = coverRef.current?.getBoundingClientRect();
    const img = imgRef.current;
    if (!box || !img) return 0.5;
    const shown = img.naturalWidth ? (box.width * img.naturalHeight) / img.naturalWidth : box.height * 2;
    const extra = shown - box.height;
    return extra > 4 ? 100 / extra : 0;
  };

  const startDrag = (e: React.PointerEvent) => {
    if (!moving || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const el = coverRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const start = e.clientY;
    const from = posRef.current;
    const k = pctPerPx();
    let raf = 0;
    let want = from;
    const move = (ev: PointerEvent) => {
      want = clamp(from - (ev.clientY - start) * k);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(want); });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      cancelAnimationFrame(raf);
      paint(want);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const savePosition = () => {
    setMoving(false);
    const y = Math.round(posRef.current);
    if (edit && y !== props.coverY) edit.onProps({ coverY: y });
  };
  const cancelPosition = () => {
    setMoving(false);
    paint(props.coverY);
  };

  const uploadTo = async (f: File, key: "icon" | "cover") => {
    if (!edit) return;
    const src = await edit.upload(f);
    edit.onProps(key === "icon" ? { icon: src } : { cover: src, coverY: 50 });
    setIconOpen(null);
    setCoverOpen(null);
  };
  const pickCover = (v: string) => {
    edit?.onProps({ cover: v, coverY: 50 });
    setCoverOpen(null);
  };

  const iconPicker = (where: "icon" | "add") =>
    iconOpen === where && edit ? (
      <EmojiPicker
        onPick={(e) => { edit.onProps({ icon: e }); setIconOpen(null); }}
        onRemove={props.icon ? () => { edit.onProps({ icon: null }); setIconOpen(null); } : undefined}
        onUpload={(f) => void uploadTo(f, "icon")}
        onClose={() => setIconOpen(null)}
      />
    ) : null;

  return (
    <div className={cx("pb-head", style && "pb-head--cover", props.icon && "pb-head--icon", !ro && "pb-head--edit")}>
      {style && (
        <div
          ref={coverRef}
          className={cx("pb-cover-img", moving && "pb-cover-img--moving")}
          style={style.image ? undefined : { background: style.background }}
          role="img"
          aria-label="Page cover"
          onPointerDown={startDrag}
          tabIndex={moving ? 0 : undefined}
          onKeyDown={(e) => {
            if (!moving) return;
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              paint(clamp(posRef.current + (e.key === "ArrowUp" ? -4 : 4)));
            } else if (e.key === "Enter") savePosition();
            else if (e.key === "Escape") cancelPosition();
          }}
        >
          {style.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img ref={imgRef} src={style.image} alt="" className="pb-cover-img__img" style={{ objectPosition: `50% ${props.coverY}%` }} draggable={false} decoding="async" />
          )}
          {moving && <span className="pb-cover-img__hint" aria-live="polite">Drag the image to reposition</span>}
          {!ro && (
            <div className={cx("pb-cover-img__tools", moving && "pb-cover-img__tools--on")}>
              {moving ? (
                <>
                  <button type="button" className="pb-headbtn" onClick={savePosition}>Save position</button>
                  <button type="button" className="pb-headbtn" onClick={cancelPosition}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" className="pb-headbtn" onClick={() => setCoverOpen("cover")}>Change cover</button>
                  {style.image && (
                    <button type="button" className="pb-headbtn" onClick={() => { setMoving(true); requestAnimationFrame(() => coverRef.current?.focus({ preventScroll: true })); }}>
                      Reposition
                    </button>
                  )}
                  <button type="button" className="pb-headbtn" onClick={() => edit!.onProps({ cover: null, coverY: 50 })}>Remove</button>
                </>
              )}
            </div>
          )}
          {coverOpen === "cover" && edit && <CoverPicker onPick={pickCover} onUpload={(f) => void uploadTo(f, "cover")} onClose={() => setCoverOpen(null)} />}
        </div>
      )}
      <div className="pb-col pb-head__body">
        {top}
        {props.icon && (
          <div className="pb-head__icon">
            <button type="button" className="pb-head__iconbtn md-focus" disabled={ro} aria-label="Change icon" onClick={() => setIconOpen("icon")}>
              <PageIconGlyph icon={props.icon} resolve={resolve} size={72} />
            </button>
            {iconPicker("icon")}
          </div>
        )}
        {!ro && (
          <div className={cx("pb-head__add", (iconOpen === "add" || coverOpen === "add") && "pb-head__add--on")}>
            {!props.icon && (
              <span className="pb-head__iconwrap">
                <button type="button" className="pb-headbtn pb-headbtn--quiet md-focus" onClick={() => setIconOpen("add")}>
                  <Icon name="sparkle" size={16} aria-hidden /> Add icon
                </button>
                {iconPicker("add")}
              </span>
            )}
            {!style && (
              <span className="pb-head__iconwrap">
                <button type="button" className="pb-headbtn pb-headbtn--quiet md-focus" onClick={() => setCoverOpen("add")}>
                  <Icon name="image" size={16} aria-hidden /> Add cover
                </button>
                {coverOpen === "add" && <CoverPicker onPick={pickCover} onUpload={(f) => void uploadTo(f, "cover")} onClose={() => setCoverOpen(null)} />}
              </span>
            )}
          </div>
        )}
        {edit ? (
          <textarea
            className="pb-title ph-mask"
            value={title ?? ""}
            placeholder="Untitled"
            aria-label="Page title"
            readOnly={edit.readOnly}
            maxLength={200}
            rows={1}
            dir="auto"
            onChange={(e) => edit.onTitle(e.target.value.replace(/\n/g, " "))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                edit.onEnter();
              }
            }}
            ref={(el) => {
              if (el) {
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }
            }}
          />
        ) : (
          <h1 className="pb-title ph-sensitive ph-mask" dir="auto">
            {title || "Untitled"}
          </h1>
        )}
        {below}
      </div>
    </div>
  );
}
