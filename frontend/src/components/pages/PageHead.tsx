"use client";

/**
 * A page's head: the cover (full width of the paper: a gallery cover or an image, with its focal
 * point), the icon (an emoji or an uploaded image) and the title, in the page's column.
 *
 * Editing: hovering the head shows "Add icon" / "Add cover" (their space is kept, so nothing
 * moves); hovering the cover shows Change cover, Reposition and Remove. Reposition: drag the image
 * up or down (or ↑/↓), then Save position; the image follows the pointer each frame without a
 * React render (the focal point is written once, on Save).
 *
 * Auto covers: while one is being picked for a new page (`coverPending`) the cover's place holds a
 * quiet shimmer; a cover that arrives after the page is on screen fades in once its image has
 * loaded. An automatic cover says so ("Auto") among its tools; Remove is one click, and a removed
 * cover is never added back.
 */
import { useEffect, useRef, useState } from "react";
import { Icon, cx } from "@/components/ui";
import dynamic from "next/dynamic";

// The picker (and its emoji list) loads when someone edits a page's icon, never for readers.
const EmojiPicker = dynamic(() => import("@/components/docs-editor/views/EmojiPicker").then((m) => m.EmojiPicker), { ssr: false, loading: () => null });
// So does the cover gallery.
const CoverPicker = dynamic(() => import("./CoverGallery").then((m) => m.CoverGallery), { ssr: false, loading: () => null });
import { coverStyle, type PageProps } from "./pageProps";
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
  /** Auto covers: one is being picked for this page right now. */
  coverPending?: boolean;
  /** The cover on the page was picked automatically. */
  coverAuto?: boolean;
  /** "Pick for me" in the cover picker: a cover chosen for the page (`gallery:<id>`), or null. */
  suggestCover?: (() => Promise<string | null>) | null;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function PageHead({ title, props, resolve, edit, top, below, coverPending = false, coverAuto = false, suggestCover = null }: PageHeadProps) {
  const [iconOpen, setIconOpen] = useState<"icon" | "add" | null>(null);
  const [coverOpen, setCoverOpen] = useState<"cover" | "add" | null>(null);
  const [moving, setMoving] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const posRef = useRef(props.coverY);
  const style = coverStyle(props.cover, resolve);
  const ro = !edit || edit.readOnly;
  // A cover that appears after the page is on screen (an auto cover landing) fades in when loaded.
  const shown = useRef<{ mounted: boolean; cover: string | null }>({ mounted: false, cover: props.cover });
  const [fade, setFade] = useState<string | null>(null);
  useEffect(() => {
    const was = shown.current;
    if (was.mounted && !was.cover && props.cover) setFade(props.cover);
    shown.current = { mounted: true, cover: props.cover };
  }, [props.cover]);
  const fadeIn = !!style?.image && fade === props.cover;

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
    <div className={cx("pb-head", (style || coverPending) && "pb-head--cover", props.icon && "pb-head--icon", !ro && "pb-head--edit")}>
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
            <img
              ref={(el) => {
                imgRef.current = el;
                // Already in the cache: no load event to wait for.
                if (el && fadeIn && el.complete && el.naturalWidth) el.dataset.loaded = "";
              }}
              src={style.image}
              alt=""
              className="pb-cover-img__img"
              style={{ objectPosition: `50% ${props.coverY}%` }}
              draggable={false}
              decoding="async"
              data-fade={fadeIn ? "" : undefined}
              onLoad={(e) => { e.currentTarget.dataset.loaded = ""; }}
            />
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
                  {coverAuto && (
                    <span className="pb-headbtn pb-headbtn--note" title="Picked for this page automatically. Change it or remove it anytime; a removed cover isn't added back.">
                      <Icon name="sparkle" size={14} aria-hidden /> Auto
                    </span>
                  )}
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
          {coverOpen === "cover" && edit && <CoverPicker current={props.cover} onPick={pickCover} onUpload={(f) => void uploadTo(f, "cover")} onSuggest={suggestCover ?? undefined} onClose={() => setCoverOpen(null)} />}
        </div>
      )}
      {!style && coverPending && <div className="pb-cover-img pb-cover-img--pending" aria-hidden />}
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
        {/* Always there (empty for readers), so the title sits at the same height for everyone. */}
        <div className={cx("pb-head__add", (iconOpen === "add" || coverOpen === "add") && "pb-head__add--on")} aria-hidden={ro || undefined}>
          {!ro && !props.icon && (
              <span className="pb-head__iconwrap">
                <button type="button" className="pb-headbtn pb-headbtn--quiet md-focus" onClick={() => setIconOpen("add")}>
                  <Icon name="sparkle" size={16} aria-hidden /> Add icon
                </button>
                {iconPicker("add")}
              </span>
            )}
            {!ro && !style && !coverPending && (
              <span className="pb-head__iconwrap">
                <button type="button" className="pb-headbtn pb-headbtn--quiet md-focus" onClick={() => setCoverOpen("add")}>
                  <Icon name="image" size={16} aria-hidden /> Add cover
                </button>
                {coverOpen === "add" && <CoverPicker current={props.cover} onPick={pickCover} onUpload={(f) => void uploadTo(f, "cover")} onSuggest={suggestCover ?? undefined} onClose={() => setCoverOpen(null)} />}
              </span>
            )}
        </div>
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
              // Grows with its text: CSS field-sizing where the browser has it (exactly the
              // reader's h1 height), else measured.
              if (el && !(typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) {
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
