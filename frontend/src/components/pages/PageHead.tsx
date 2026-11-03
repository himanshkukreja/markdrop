"use client";

/**
 * A page's head: the cover (a gallery gradient or an image, with its focal point), the icon (an
 * emoji or an uploaded image) and the title. Read only on the page; in the editor, "Add icon",
 * "Add cover", the emoji picker, "Change cover", "Reposition" (drag up or down) and "Remove".
 */
import { useEffect, useRef, useState } from "react";
import { Button, Icon, Input, cx } from "@/components/ui";
import { EmojiPicker } from "@/components/docs-editor/views/EmojiPicker";
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
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [onClose]);
  return (
    <div ref={ref} className="pb-coverpick" role="dialog" aria-label="Choose a cover">
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
  /** Shown above the title (breadcrumbs). */
  top?: React.ReactNode;
}

export function PageHead({ title, props, resolve, edit, top }: PageHeadProps) {
  const [iconOpen, setIconOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [moving, setMoving] = useState<number | null>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const style = coverStyle(props.cover, resolve);
  const ro = !edit || edit.readOnly;
  const y = moving ?? props.coverY;

  const startMove = (e: React.PointerEvent) => {
    if (!edit) return;
    const el = coverRef.current;
    if (!el) return;
    e.preventDefault();
    const start = e.clientY;
    const from = props.coverY;
    const h = el.getBoundingClientRect().height || 1;
    const move = (ev: PointerEvent) => setMoving(Math.max(0, Math.min(100, Math.round(from - ((ev.clientY - start) / h) * 100))));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const next = Math.max(0, Math.min(100, Math.round(from - ((ev.clientY - start) / h) * 100)));
      setMoving(null);
      edit.onProps({ coverY: next });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const uploadTo = async (f: File, key: "icon" | "cover") => {
    if (!edit) return;
    const src = await edit.upload(f);
    edit.onProps(key === "icon" ? { icon: src } : { cover: src, coverY: 50 });
    setIconOpen(false);
    setCoverOpen(false);
  };

  return (
    <div className={cx("pb-head", style && "pb-head--cover", props.icon && "pb-head--icon")}>
      {style && (
        <div
          ref={coverRef}
          className={cx("pb-cover-img", moving !== null && "pb-cover-img--moving")}
          style={style.image ? { backgroundImage: `url("${style.image.replace(/"/g, "%22")}")`, backgroundPosition: `center ${y}%` } : { background: style.background }}
          role="img"
          aria-label="Page cover"
          onPointerDown={moving !== null ? undefined : undefined}
        >
          {!ro && (
            <div className="pb-cover-img__tools">
              <button type="button" className="pb-headbtn" onClick={() => setCoverOpen(true)}>Change cover</button>
              {style.image && (
                <button type="button" className="pb-headbtn" onPointerDown={startMove} title="Drag up or down">
                  Reposition
                </button>
              )}
              <button type="button" className="pb-headbtn" onClick={() => edit!.onProps({ cover: null, coverY: 50 })}>Remove</button>
            </div>
          )}
          {coverOpen && edit && <CoverPicker onPick={(v) => { edit.onProps({ cover: v, coverY: 50 }); setCoverOpen(false); }} onUpload={(f) => void uploadTo(f, "cover")} onClose={() => setCoverOpen(false)} />}
        </div>
      )}
      <div className="pb-head__body">
        {top}
        {props.icon && (
          <div className="pb-head__icon">
            <button type="button" className="pb-head__iconbtn" disabled={ro} aria-label="Change icon" onClick={() => setIconOpen(true)}>
              <PageIconGlyph icon={props.icon} resolve={resolve} size={72} />
            </button>
            {iconOpen && edit && (
              <EmojiPicker onPick={(e) => { edit.onProps({ icon: e }); setIconOpen(false); }} onRemove={() => { edit.onProps({ icon: null }); setIconOpen(false); }} onUpload={(f) => void uploadTo(f, "icon")} onClose={() => setIconOpen(false)} />
            )}
          </div>
        )}
        {!ro && (!props.icon || !style) && (
          <div className="pb-head__add">
            {!props.icon && (
              <span className="pb-head__iconwrap">
                <button type="button" className="pb-headbtn pb-headbtn--quiet" onClick={() => setIconOpen(true)}>
                  <Icon name="sparkle" size={14} /> Add icon
                </button>
                {iconOpen && edit && <EmojiPicker onPick={(e) => { edit.onProps({ icon: e }); setIconOpen(false); }} onUpload={(f) => void uploadTo(f, "icon")} onClose={() => setIconOpen(false)} />}
              </span>
            )}
            {!style && (
              <span className="pb-head__iconwrap">
                <button type="button" className="pb-headbtn pb-headbtn--quiet" onClick={() => setCoverOpen(true)}>
                  <Icon name="image" size={14} /> Add cover
                </button>
                {coverOpen && edit && <CoverPicker onPick={(v) => { edit.onProps({ cover: v, coverY: 50 }); setCoverOpen(false); }} onUpload={(f) => void uploadTo(f, "cover")} onClose={() => setCoverOpen(false)} />}
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
              if (e.key === "Enter") {
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
      </div>
    </div>
  );
}
