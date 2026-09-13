"use client";

import { useRef, useState } from "react";

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
 * shows something if the network upload is slow.
 */
export default function AssetUpload({
  label,
  hint,
  value,
  shape = "square",
  disabled,
  onUpload,
  onClear,
}: {
  label: string;
  hint: string;
  value: string | null;
  shape?: "square" | "wide";
  disabled?: boolean;
  onUpload: (file: File) => Promise<void>;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  const shown = localPreview || value;

  async function handle(file: File | undefined) {
    if (!file || disabled) return;
    setError("");
    // Checked again on the server, which is where it counts. Doing it here too
    // means a 4 MB screenshot fails instantly instead of after the upload.
    if (!file.type.startsWith("image/")) {
      setError("That needs to be an image file.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Images must be under 2 MB.");
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalPreview(url);
    setBusy(true);
    try {
      await onUpload(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setLocalPreview(null);
    } finally {
      setBusy(false);
      // Revoked after the hosted URL has taken over, or the tab leaks a blob
      // for every image the user tried.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{label}</span>
        {shown && !disabled && (
          <button
            type="button"
            onClick={() => {
              setLocalPreview(null);
              onClear();
            }}
            className="text-[11px] text-gray-400 hover:text-red-500 transition-colors"
          >
            Remove
          </button>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          handle(e.dataTransfer.files?.[0]);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={`group relative flex items-center gap-3 rounded-xl border border-dashed px-3 py-3 transition-all ${
          disabled
            ? "opacity-60 cursor-not-allowed border-gray-200 dark:border-gray-800"
            : over
              ? "border-blue-500 bg-blue-500/5 cursor-pointer"
              : "border-gray-300 dark:border-gray-700 hover:border-blue-400 hover:bg-blue-500/[0.03] cursor-pointer"
        }`}
      >
        {/* A logo is usually a wide wordmark, so it gets a landscape well with
            room to breathe; a favicon is square by definition. Both are padded,
            because an image flush against its container reads as cropped even
            when `object-contain` has not cropped anything. The light backdrop is
            what makes a dark logo visible at all — most brand marks are dark
            ink meant for white paper. */}
        <div
          className={`shrink-0 grid place-items-center rounded-lg overflow-hidden p-1.5
            bg-white/90 dark:bg-white/[0.07] ring-1 ring-black/5 dark:ring-white/10 ${
            shape === "wide" ? "w-32 h-16" : "w-14 h-14"
          }`}
        >
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="" className="max-w-full max-h-full object-contain" />
          ) : (
            <svg
              className="w-5 h-5 text-gray-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-gray-700 dark:text-gray-300">
            {busy ? "Uploading…" : shown ? "Replace image" : "Drop an image or click to choose"}
          </p>
          <p className="text-[11px] text-gray-400 leading-snug mt-0.5">{hint}</p>
        </div>

        {busy && (
          <span className="absolute inset-0 rounded-xl bg-white/50 dark:bg-black/30 grid place-items-center">
            <span className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          </span>
        )}
      </div>

      {error && <p className="text-[11px] text-red-500 mt-1.5">{error}</p>}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          handle(e.target.files?.[0]);
          // Reset, so picking the same file twice still fires a change event.
          e.target.value = "";
        }}
      />
    </div>
  );
}
