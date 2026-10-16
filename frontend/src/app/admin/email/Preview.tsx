"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Icon, Input, SegmentedControl, Spinner, cx } from "@/components/ui";
import { LoadingBlock, isUnauthorized, useOnUnauthorized } from "../shared";
import { emailApi, type MergeTagInfo, type RecipientPreview, type Rendered } from "./api";
import { Section, useDebounced } from "./bits";

/**
 * The email exactly as a recipient gets it: the backend renders it with the same function it
 * sends with (only the tracking token differs: "preview", which is never recorded), shown in an
 * iframe with an empty sandbox (no scripts, no same-origin, no navigation), at its real width and
 * scaled down to fit.
 */

type View = "html" | "text" | "data";
type Width = "desktop" | "mobile";

export function ScaledFrame({ html, frameWidth, height, title }: { html: string; frameWidth: number; height: number; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = w ? Math.min(1, w / frameWidth) : 1;
  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-lg border border-border bg-surface-inset" style={{ height: Math.round(height * scale) }}>
      {w > 0 && (
        <iframe
          title={title}
          sandbox=""
          srcDoc={html}
          className="absolute top-0 block border-0"
          style={{
            width: frameWidth, height, left: scale < 1 ? 0 : Math.max(0, (w - frameWidth) / 2),
            transform: `scale(${scale})`, transformOrigin: "top left",
          }}
        />
      )}
    </div>
  );
}

export function RecipientPicker({ token, as, setAs }: { token: string; as: RecipientPreview | null; setAs: (r: RecipientPreview | null) => void }) {
  const onUnauthorized = useOnUnauthorized();
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 300);
  const [list, setList] = useState<RecipientPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    emailApi.recipients(token, dq)
      .then((r) => { if (!cancelled) { setList(r.recipients); setError(null); } })
      .catch((e) => { if (isUnauthorized(e)) onUnauthorized(); else if (!cancelled) setError(e instanceof Error ? e.message : "Search failed"); });
    return () => { cancelled = true; };
  }, [token, dq, open, onUnauthorized]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-eyebrow uppercase text-text-muted" id="preview-as-label">Preview as</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" variant={as ? "secondary" : "primary"} aria-pressed={!as} onClick={() => setAs(null)}>Sample data</Button>
        {as && (
          <span className="inline-flex min-h-8 min-w-0 max-w-full items-center gap-2 rounded-full border border-accent bg-accent-soft px-3 text-caption">
            <Icon name="user" size={14} />
            <span className="truncate font-medium text-text">{as.name || as.email}</span>
            {as.name && <span className="hidden truncate font-mono text-micro text-text-secondary sm:inline">{as.email}</span>}
          </span>
        )}
      </div>
      <Input
        type="search"
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        placeholder="Search an account by name or email, or type any address"
        aria-labelledby="preview-as-label"
        prefix="search"
      />
      {open && list && list.length > 0 && (
        <ul className="flex max-h-56 min-w-0 flex-col overflow-y-auto rounded-lg border border-border" aria-label="Recipients">
          {list.map((r) => (
            <li key={r.email} className="border-b border-border last:border-0">
              <button
                type="button"
                onClick={() => { setAs(r); setOpen(false); }}
                className={cx("md-focus flex min-h-11 w-full min-w-0 items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-surface-hover", as?.email === r.email && "bg-surface-hover")}
              >
                <span className="min-w-0">
                  <span className="block truncate text-body text-text">{r.name || "—"}</span>
                  <span className="block truncate font-mono text-micro text-text-secondary">{r.email}</span>
                </span>
                <span className="shrink-0 text-micro text-text-muted">{r.meta}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && list && list.length === 0 && <p className="text-caption text-text-secondary">No accounts match. Type a full address to preview with empty merge data.</p>}
      {error && <p className="text-caption text-danger">{error}</p>}
    </div>
  );
}

export function EmailPreview({
  rendered, loading, error, compact, tags, layout, label, children, onRetry,
}: {
  rendered: Rendered | null; loading: boolean; error: string | null; compact?: boolean; tags: MergeTagInfo[];
  layout: "blocks" | "raw"; label?: string; children?: React.ReactNode; onRetry?: () => void;
}) {
  const [view, setView] = useState<View>("html");
  const [width, setWidth] = useState<Width>("desktop");
  const subject = rendered?.subject || "(no subject)";
  return (
    <Section
      id={compact ? "email-live-preview" : "email-preview"}
      label={label ?? (compact ? "Live preview" : "Preview")}
      title={rendered ? subject : "Rendering…"}
      actions={loading && rendered ? <Spinner size={14} label="Updating the preview" /> : undefined}
      bodyClassName="flex flex-col gap-3"
    >
      {children}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<View>
          size="sm"
          aria-label="Preview format"
          value={view}
          onChange={setView}
          options={[{ value: "html", label: "HTML" }, { value: "text", label: "Plain text" }, { value: "data", label: "Merge data" }]}
        />
        {view === "html" && (
          <SegmentedControl<Width>
            size="sm"
            aria-label="Preview width"
            value={width}
            onChange={setWidth}
            options={[{ value: "desktop", label: "Desktop", icon: "monitor" }, { value: "mobile", label: "Mobile", icon: "phone" }]}
          />
        )}
      </div>
      <p className="min-w-0 break-words text-caption text-text-secondary">
        <span className="text-text-muted">Preheader · </span>
        {layout === "raw" ? "inside the template HTML" : rendered?.preheader || "—"}
        {rendered && (
          <>
            <span className="text-text-muted"> · as </span>
            <span className="text-text">{rendered.as.source === "sample" ? "sample data" : rendered.as.email}</span>
          </>
        )}
      </p>
      {error && !rendered ? (
        <Alert tone="danger" title="Couldn't render the email" actions={onRetry ? <Button size="sm" variant="secondary" iconLeft="refresh" onClick={onRetry}>Retry</Button> : undefined}>{error}</Alert>
      ) : !rendered ? (
        <LoadingBlock label="Rendering the email" minHeight={compact ? 420 : 560} className="rounded-lg border border-border bg-surface-inset" />
      ) : view === "html" ? (
        <ScaledFrame
          html={rendered.html}
          frameWidth={width === "mobile" ? 375 : 640}
          height={compact ? 760 : 900}
          title={`Email preview, ${width} width: ${subject}`}
        />
      ) : view === "text" ? (
        <pre className="max-h-[720px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-inset p-3 font-mono text-caption text-text-secondary" tabIndex={0} aria-label="Plain-text version">
          {rendered.text}
        </pre>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-caption">
            <caption className="md-visually-hidden">Merge data</caption>
            <tbody>
              {tags.map((t) => (
                <tr key={t.tag} className="border-b border-border last:border-0">
                  <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-mono font-normal text-accent-text">{`{{${t.tag}}}`}</th>
                  <td className="break-all px-3 py-2 text-text">
                    {rendered.vars[t.tag] || <span className="text-text-muted">(empty · fallback used)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && rendered && <Alert tone="warning">Showing the last good render: {error}</Alert>}
      <p className="text-micro text-text-muted">
        Pixel and click links here use the “preview” token, which is never recorded. Images load from their real URLs.
        {rendered && rendered.as.source === "custom" && <> <Badge size="sm" tone="neutral" className="ml-1">No account · empty merge data</Badge></>}
      </p>
    </Section>
  );
}
