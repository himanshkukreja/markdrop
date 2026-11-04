"use client";

/**
 * The cover picker: Markdrop's own covers by category (Paper, Duotone, Lines, Shapes, Calm), an
 * upload, or an image link, and "Pick for me" (the same pick new pages get: auto covers). Opens on
 * the category of the page's current cover. Closes on Escape or a click outside. The covers
 * themselves: public/page-covers (pageProps COVER_GALLERY).
 */
import { useEffect, useRef, useState } from "react";
import { Button, Icon, Input, cx } from "@/components/ui";
import { COVER_CATEGORIES, COVER_GALLERY, coverThumbUrl, galleryCover, type CoverCategory } from "./pageProps";
import "./CoverGallery.css";

type Tab = CoverCategory | "Upload" | "Link";

export interface CoverGalleryProps {
  /** The page's cover now (`gallery:<id>`, `asset:<id>` or a link), to mark and open on. */
  current?: string | null;
  onPick: (cover: string) => void;
  onUpload?: (f: File) => void;
  /** "Pick for me": a cover chosen for the page (`gallery:<id>`), or null when it couldn't. */
  onSuggest?: () => Promise<string | null>;
  onClose: () => void;
  className?: string;
}

export function CoverGallery({ current, onPick, onUpload, onSuggest, onClose, className }: CoverGalleryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const chosen = galleryCover(current ?? null);
  const tabs: Tab[] = [...COVER_CATEGORIES, ...(onUpload ? (["Upload"] as const) : []), "Link"];
  const [tab, setTab] = useState<Tab>(chosen?.category ?? COVER_CATEGORIES[0]);
  const [url, setUrl] = useState(current && /^https:\/\//.test(current) ? current : "");
  const [bad, setBad] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestFailed, setSuggestFailed] = useState(false);

  const suggest = async () => {
    if (!onSuggest || suggesting) return;
    setSuggesting(true);
    setSuggestFailed(false);
    try {
      const c = await onSuggest();
      if (c) onPick(c);
      else setSuggestFailed(true);
    } catch {
      setSuggestFailed(true);
    } finally {
      setSuggesting(false);
    }
  };

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  // ←/→ move between tabs (and focus the new one), like any tab list.
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = tabs.indexOf(tab);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next);
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  };

  const submitLink = (e: React.FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (/^https:\/\/\S+$/.test(v)) onPick(v);
    else setBad(true);
  };

  const takeFile = (f: File | undefined | null) => {
    if (f && onUpload && f.type.startsWith("image/")) onUpload(f);
  };

  return (
    <div ref={ref} className={cx("pb-coverpick pb-covergal", className)} role="dialog" aria-label="Choose a cover" contentEditable={false}>
      <div ref={tabsRef} className="pb-covergal__tabs" role="tablist" aria-label="Covers" onKeyDown={onTabKey}>
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            data-tab={t}
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            className={cx("pb-covergal__tab md-focus", tab === t && "pb-covergal__tab--on")}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="pb-covergal__panel" role="tabpanel" aria-label={tab}>
        <div className="pb-covergal__grid pb-covergal__sizer" aria-hidden>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <span key={i} className="pb-covergal__item">
              <span className="pb-covergal__thumb" />
              <span className="pb-covergal__name">&nbsp;</span>
            </span>
          ))}
        </div>
        {tab === "Upload" ? (
          <label
            className={cx("pb-covergal__drop md-focus", dragging && "pb-covergal__drop--over")}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); takeFile(e.dataTransfer.files?.[0]); }}
          >
            <Icon name="upload" size={18} />
            <span className="pb-covergal__droptitle">Upload an image</span>
            <span className="pb-covergal__hint">or drop one here. Wide images work best: 1500 × 480 or larger.</span>
            <input type="file" accept="image/*" className="md-visually-hidden" onChange={(e) => takeFile(e.target.files?.[0])} />
          </label>
        ) : tab === "Link" ? (
          <form className="pb-covergal__link" onSubmit={submitLink}>
            <Input
              size="sm"
              iconPrefix="link"
              placeholder="https://…"
              value={url}
              invalid={bad}
              autoFocus
              onChange={(e) => { setUrl(e.target.value); setBad(false); }}
              aria-label="Image link"
            />
            <Button size="sm" type="submit" disabled={!url.trim()}>
              Use link
            </Button>
            <span className={cx("pb-covergal__hint", bad && "pb-covergal__hint--bad")}>
              {bad ? "That isn't an https:// address." : "Any image on the web that starts with https://"}
            </span>
          </form>
        ) : (
          <div className="pb-covergal__grid">
            {COVER_GALLERY.filter((c) => c.category === tab).map((c) => {
              const on = chosen?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={cx("pb-covergal__item md-focus", on && "pb-covergal__item--on")}
                  aria-pressed={on}
                  title={c.name}
                  onClick={() => onPick(`gallery:${c.id}`)}
                >
                  <span className="pb-covergal__thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={coverThumbUrl(c.id)} alt="" width={384} height={123} loading="lazy" decoding="async" draggable={false} />
                    {on && (
                      <span className="pb-covergal__check" aria-hidden>
                        <Icon name="check" size={12} />
                      </span>
                    )}
                  </span>
                  <span className="pb-covergal__name">{c.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {onSuggest && (
        <div className="pb-covergal__foot">
          <button
            type="button"
            className={cx("pb-covergal__auto md-focus", suggesting && "pb-covergal__auto--busy")}
            onClick={() => void suggest()}
            disabled={suggesting}
          >
            <Icon name="sparkle" size={14} aria-hidden />
            {suggesting ? "Picking…" : "Pick for me"}
          </button>
          <span className={cx("pb-covergal__foothint", suggestFailed && "pb-covergal__foothint--bad")} aria-live="polite">
            {suggestFailed ? "Couldn't pick one right now. Try again." : "A cover for what this page is about"}
          </span>
        </div>
      )}
    </div>
  );
}
