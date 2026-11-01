"use client";

/**
 * The entry editor's two pickers: an image or video from the guide's own files (or a new upload),
 * and the related pages (the guide's pages, searchable). Both are dialogs; keyboard first.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Dialog, EmptyState, Icon, Input, SegmentedControl, Skeleton, cx } from "@/components/ui";
import { changelogMedia, type ChangelogMediaItem } from "@/lib/docsChangelog";
import { assetPreviewUrl, docsErrorMessage, uploadAsset, type PageSummary } from "@/lib/docsSites";
import { formatBytes } from "../format";

const ACCEPT = { image: "image/png,image/jpeg,image/webp,image/gif,image/avif", video: "video/mp4,video/webm" } as const;

export function MediaPicker({ open, onClose, siteId, kind, onPick }: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  kind: "image" | "video";
  onPick: (url: string) => void;
}) {
  const [items, setItems] = useState<ChangelogMediaItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"image" | "video">(kind);
  const file = useRef<HTMLInputElement>(null);
  const uid = useId();

  useEffect(() => {
    if (!open) return;
    setTab(kind);
    setItems(null);
    setError("");
    changelogMedia(siteId).then((r) => setItems(r.items)).catch((e) => setError(docsErrorMessage(e)));
  }, [open, siteId, kind]);

  const shown = (items ?? []).filter((m) => m.kind === tab);

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError("");
    try {
      const up = await uploadAsset(siteId, f);
      onPick(up.url);
      onClose();
    } catch (e) {
      setError(docsErrorMessage(e, "The upload didn't go through. Try again."));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={tab === "image" ? "Choose an image" : "Choose a video"}
      description="From this guide's files, or upload a new one (up to 25 MB). Readers see it at the top of the entry."
      footer={
        <>
          <input ref={file} type="file" accept={ACCEPT[tab]} className="hidden" onChange={(e) => void upload(e.target.files?.[0])} aria-hidden tabIndex={-1} />
          <Button variant="secondary" iconLeft="upload" loading={busy} onClick={() => file.current?.click()}>Upload {tab === "image" ? "an image" : "a video"}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SegmentedControl
          size="sm"
          aria-label="Kind of file"
          value={tab}
          onChange={setTab}
          options={[{ value: "image", label: "Images", icon: "image" }, { value: "video", label: "Videos", icon: "film" }]}
        />
        {error && <Alert tone="danger">{error}</Alert>}
        {!items && !error && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-busy="true" aria-label="Loading files">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="rect" height={110} />)}
          </div>
        )}
        {items && !shown.length && (
          <EmptyState
            icon={tab === "image" ? "image" : "film"}
            title={tab === "image" ? "No images yet" : "No videos yet"}
            description={tab === "image" ? "Upload a screenshot of what changed." : "Upload a short MP4 or WebM clip of the change."}
          />
        )}
        {shown.length > 0 && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" id={`${uid}-l`} aria-label={`${tab === "image" ? "Images" : "Videos"} in this guide`}>
            {shown.map((m) => {
              const src = assetPreviewUrl(siteId, m.url) ?? m.url;
              return (
                <li key={m.url}>
                  <button
                    type="button"
                    onClick={() => { onPick(m.url); onClose(); }}
                    className="md-focus group flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface text-left hover:border-accent"
                  >
                    <span className="ph-no-capture grid h-[104px] w-full place-items-center overflow-hidden bg-surface-inset">
                      {m.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={src} alt="" loading="lazy" className="size-full object-cover" />
                      ) : (
                        <video src={src} muted preload="metadata" className="size-full object-cover" aria-hidden />
                      )}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 px-2.5 py-2 text-[12px] text-text-secondary">
                      <Icon name={m.kind === "image" ? "image" : "film"} size={13} className="shrink-0" />
                      <span className="ph-sensitive ph-mask min-w-0 flex-1 truncate" title={m.name}>{m.name}</span>
                      {m.size ? <span className="shrink-0 text-text-muted">{formatBytes(m.size)}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

export function PagesPicker({ open, onClose, pages, value, onChange, max = 10 }: {
  open: boolean;
  onClose: () => void;
  pages: PageSummary[];
  value: string[];
  onChange: (ids: string[]) => void;
  max?: number;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>(value);
  useEffect(() => {
    if (open) {
      setPicked(value);
      setQ("");
    }
  }, [open, value]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return pages.filter((p) => !t || `${p.title} ${p.path}`.toLowerCase().includes(t));
  }, [pages, q]);
  const toggle = (id: string) => setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= max ? s : [...s, id]));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Related pages"
      description={`The pages this change touched. Readers see them under “Docs updated” (at most ${max}).`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { onChange(picked); onClose(); }}>Use {picked.length === 1 ? "1 page" : `${picked.length} pages`}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input type="search" prefix="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages" aria-label="Search pages" />
        <ul className="flex max-h-[46vh] flex-col overflow-y-auto rounded-lg border border-border">
          {shown.map((p) => (
            <li key={p.id} className={cx("border-b border-border px-3 py-2 last:border-b-0", picked.includes(p.id) && "bg-accent-soft")}>
              <Checkbox
                checked={picked.includes(p.id)}
                disabled={!picked.includes(p.id) && picked.length >= max}
                onChange={() => toggle(p.id)}
                label={<span className="ph-sensitive ph-mask font-semibold text-text">{p.title || "Untitled"}</span>}
                description={<span className="ph-sensitive ph-mask font-mono text-[12px]">{p.path}{p.hidden ? " · hidden" : ""}</span>}
              />
            </li>
          ))}
          {!shown.length && <li className="px-3 py-6 text-center text-[13px] text-text-muted">No pages match “{q.trim()}”.</li>}
        </ul>
      </div>
    </Dialog>
  );
}
