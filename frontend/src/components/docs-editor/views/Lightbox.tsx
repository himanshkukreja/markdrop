"use client";

/**
 * An image full screen (a page's image block, in the editor and for readers): the image fitted to
 * the window, its caption, Download and Close. Esc, a click outside the image or Close shut it, and
 * focus goes back where it was.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui";

/** Saves an image: through a blob when the server allows it, else opened in a new tab. */
export async function downloadImage(src: string, name: string) {
  const file = (name || "image").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "image";
  try {
    const r = await fetch(src, { mode: "cors" });
    if (!r.ok) throw new Error(String(r.status));
    const blob = await r.blob();
    const ext = (blob.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/\+.*/, "");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = /\.[a-z0-9]{2,4}$/i.test(file) ? file : `${file}.${ext}`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    window.open(src, "_blank", "noopener");
  }
}

export function ImageLightbox({ src, alt, caption, onClose }: { src: string; alt: string; caption?: string | null; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const back = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key, true);
      document.body.style.overflow = overflow;
      back?.focus?.({ preventScroll: true });
    };
  }, [onClose]);
  useEffect(() => {
    if (mounted) close.current?.focus();
  }, [mounted]);
  if (!mounted) return null;
  return createPortal(
    <div className="dxe-lightbox" role="dialog" aria-modal="true" aria-label={alt || "Image"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dxe-lightbox__bar">
        <button type="button" className="dxe-lightbox__btn" onClick={() => void downloadImage(src, alt || caption || "image")}>
          <Icon name="download" size={16} aria-hidden /> Download
        </button>
        <button ref={close} type="button" className="dxe-lightbox__btn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} aria-hidden />
        </button>
      </div>
      <figure className="dxe-lightbox__fig" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="dxe-lightbox__img" />
        {caption && <figcaption className="dxe-lightbox__cap">{caption}</figcaption>}
      </figure>
    </div>,
    document.body,
  );
}
