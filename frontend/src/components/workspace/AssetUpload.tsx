"use client";

import { useId, useRef, useState } from "react";
import { Button, Icon, Spinner, cx } from "@/components/ui";
import type { LogoWell } from "./BrandTile";
import styles from "./BrandTile.module.css";

/**
 * Drop-or-pick upload for a workspace favicon or logo.
 *
 * Replaces asking for a URL. A URL field looks cheaper to build but pushes the
 * hard part onto the customer: they need somewhere to host the file, that host
 * has to stay up forever, and if it serves the image without CORS or over plain
 * HTTP the branding quietly breaks on someone else's browser. Uploading makes
 * the asset ours to keep serving.
 *
 * The preview here is a local object URL, so it appears instantly and still
 * shows something if the network upload is slow. The thumbnail sits on the
 * chosen logo well (D38), so a dark logo is checked against the ground it gets.
 */
export default function AssetUpload({
  label,
  hint,
  value,
  shape = "square",
  well = null,
  disabled,
  locked,
  onUpload,
  onClear,
}: {
  label: string;
  hint: string;
  value: string | null;
  shape?: "square" | "wide";
  well?: LogoWell;
  disabled?: boolean;
  /** Non-admins: focusable but inert (aria-disabled), so the reason can be read. */
  locked?: boolean;
  onUpload: (file: File) => Promise<void>;
  onClear: () => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  const off = disabled || locked;
  const shown = localPreview || value;

  async function handle(file: File | undefined) {
    if (!file || off) return;
    setError("");
    // Checked again on the server, which is where it counts. Doing it here too
    // means a 4 MB screenshot fails instantly instead of after the upload.
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file: PNG, JPEG, WebP or GIF.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Images must be under 2 MB. Export a smaller version and try again.");
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalPreview(url);
    setBusy(true);
    try {
      await onUpload(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Try again.");
      setLocalPreview(null);
    } finally {
      setBusy(false);
      // Revoked after the hosted URL has taken over, or the tab leaks a blob
      // for every image the user tried.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  const wellCls = well === "light" ? styles.light : well === "dark" ? styles.dark : well === "checker" ? styles.checker : styles.auto;

  return (
    <div className="md-field min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span id={`${uid}-label`} className="md-field__label">{label}</span>
        {shown && !off && !busy && (
          <Button
            variant="link"
            size="sm"
            onClick={async () => {
              setLocalPreview(null);
              setError("");
              try { await onClear(); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't remove it. Try again."); }
            }}
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            Remove
          </Button>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!off) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          handle(e.dataTransfer.files?.[0]);
        }}
        onClick={() => !off && inputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={off || undefined}
        aria-labelledby={`${uid}-label ${uid}-text`}
        aria-describedby={`${uid}-hint${error ? ` ${uid}-err` : ""}`}
        aria-busy={busy || undefined}
        onKeyDown={(e) => {
          if (off) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={cx("md-dropzone relative min-w-0", over && "md-dropzone--over", off && "hover:border-border-strong hover:bg-surface")}
      >
        {/* A logo is usually a wide wordmark, so it gets a landscape well; a
            favicon is square by definition. Both are padded, because an image
            flush against its container reads as cropped. */}
        <span
          className={cx(
            "grid shrink-0 place-items-center overflow-hidden rounded-md border border-border p-1.5",
            shown ? wellCls : "bg-surface-inset",
            shape === "wide" ? "h-14 w-28" : "size-14",
          )}
        >
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="" className="max-h-full max-w-full object-contain" />
          ) : (
            <Icon name="image" className="text-text-muted" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div id={`${uid}-text`} className="md-dropzone__text">
            {busy ? "Uploading…" : shown ? "Drop a new image to replace" : "Drop an image or click to choose"}
          </div>
          <div id={`${uid}-hint`} className="md-dropzone__hint">{hint}</div>
        </div>

        {busy && (
          <span className="absolute inset-0 grid place-items-center rounded-[inherit] bg-surface/60" aria-hidden>
            <Spinner />
          </span>
        )}
      </div>

      {error && (
        <div id={`${uid}-err`} className="md-field__error" role="alert">
          <Icon name="alertCircle" /> {error}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          handle(e.target.files?.[0]);
          // Reset, so picking the same file twice still fires a change event.
          e.target.value = "";
        }}
      />
    </div>
  );
}
