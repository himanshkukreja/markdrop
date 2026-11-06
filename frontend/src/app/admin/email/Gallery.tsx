"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, SegmentedControl, cx } from "@/components/ui";
import { LoadingBlock, isUnauthorized, useOnUnauthorized } from "../shared";
import { emailApi, type GalleryEntry, type GalleryItem } from "./api";
import { Section } from "./bits";

/**
 * Admin → Email → Templates: every email and Slack message Markdrop sends, rendered by the real
 * builders from fixtures (backend services/message_gallery.py). Nothing is sent from here.
 *
 * Emails: light, dark (the client's dark mode, as Apple Mail and Outlook apply it) and "Gmail
 * inverted" (Gmail's apps invert colours on their own), at desktop and phone width, plus the plain-text
 * part. Slack messages: light and dark, desktop and phone.
 */

type Theme = "light" | "dark" | "inverted";
type Width = "desktop" | "phone";

const WIDTH: Record<Width, number> = { desktop: 680, phone: 390 };

/** The email as a client in dark mode shows it: its prefers-color-scheme rules always on. */
function forceDark(html: string) {
  return html.replace(/@media \(prefers-color-scheme: dark\)/g, "@media all");
}

function Frame({ html, width, inverted, title }: { html: string; width: number; inverted?: boolean; title: string }) {
  const [h, setH] = useState(600);
  return (
    <div className="overflow-x-auto">
      <iframe
        title={title}
        srcDoc={html}
        sandbox="allow-same-origin"
        className="mx-auto block rounded-lg border border-border bg-white"
        style={{ width, height: h, maxWidth: "100%", filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
        onLoad={(e) => {
          const d = (e.target as HTMLIFrameElement).contentDocument;
          if (d) setH(Math.max(240, d.documentElement.scrollHeight + 4));
        }}
      />
    </div>
  );
}

export default function Gallery({ token }: { token: string }) {
  const onUnauthorized = useOnUnauthorized();
  const [entries, setEntries] = useState<GalleryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [item, setItem] = useState<GalleryItem | null>(null);
  const [theme, setTheme] = useState<Theme>("light");
  const [width, setWidth] = useState<Width>("desktop");
  const [view, setView] = useState<"html" | "text" | "blocks">("html");

  useEffect(() => {
    emailApi.gallery(token).then((r) => {
      setEntries(r.entries);
      setCurrent((c) => c ?? r.entries[0]?.id ?? null);
    }).catch((e) => (isUnauthorized(e) ? onUnauthorized() : setError(e instanceof Error ? e.message : "Request failed")));
  }, [token, onUnauthorized]);

  useEffect(() => {
    if (!current) return;
    let live = true;
    setItem(null);
    emailApi.galleryItem(token, current).then((r) => { if (live) setItem(r); })
      .catch((e) => (isUnauthorized(e) ? onUnauthorized() : setError(e instanceof Error ? e.message : "Request failed")));
    return () => { live = false; };
  }, [token, current, onUnauthorized]);

  const groups = useMemo(() => {
    const out: { group: string; items: GalleryEntry[] }[] = [];
    for (const e of entries ?? []) {
      const g = out.find((x) => x.group === e.group);
      if (g) g.items.push(e);
      else out.push({ group: e.group, items: [e] });
    }
    return out;
  }, [entries]);

  if (error && !entries) return <Alert tone="danger" title="Couldn't load the gallery">{error}</Alert>;
  if (!entries) return <LoadingBlock label="Loading the gallery" minHeight={240} />;

  const isSlack = item?.kind === "slack";
  const html = !item ? "" : isSlack ? (theme === "light" ? item.html_light! : item.html_dark!)
    : theme === "dark" ? forceDark(item.html!) : item.html!;

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <nav aria-label="Messages" className="flex flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
        {groups.map((g) => (
          <div key={g.group}>
            <p className="mb-1 text-eyebrow uppercase text-text-muted">{g.group}</p>
            <ul className="flex flex-col">
              {g.items.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => { setCurrent(e.id); setView("html"); }}
                    aria-current={current === e.id ? "true" : undefined}
                    className={cx("md-focus w-full rounded-md px-2.5 py-1.5 text-left text-caption",
                      current === e.id ? "bg-surface-inset font-semibold text-text" : "text-text-secondary hover:bg-surface-inset")}
                  >
                    {e.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <Section
        label={item ? `${item.group}` : "Message"}
        title={item?.name ?? "Loading…"}
        actions={
          <div className="flex flex-wrap gap-2">
            <SegmentedControl<Theme> size="sm" aria-label="Theme" value={theme} onChange={setTheme}
              options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" },
                ...(isSlack ? [] : [{ value: "inverted" as Theme, label: "Gmail inverted" }])]} />
            <SegmentedControl<Width> size="sm" aria-label="Width" value={width} onChange={setWidth}
              options={[{ value: "desktop", label: "Desktop" }, { value: "phone", label: "Phone" }]} />
          </div>
        }
      >
        {!item ? <LoadingBlock label="Rendering" minHeight={320} /> : (
          <div className="flex flex-col gap-4 px-4 pb-5 sm:px-5">
            <p className="text-caption text-text-secondary">{item.note}</p>
            {isSlack ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption">
                <dt className="text-text-muted">Notification text</dt><dd className="break-words text-text">{item.text}</dd>
                <dt className="text-text-muted">Blocks</dt><dd className="text-text">{item.blocks} of 50</dd>
              </dl>
            ) : (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption">
                {item.subject && <><dt className="text-text-muted">Subject</dt><dd className="break-words font-semibold text-text">{item.subject}</dd></>}
                {item.preheader && <><dt className="text-text-muted">Preheader</dt><dd className="break-words text-text">{item.preheader}</dd></>}
                {item.sender && <><dt className="text-text-muted">From</dt><dd className="break-words text-text">{item.sender}</dd></>}
                <dt className="text-text-muted">Size</dt>
                <dd className="text-text">{Math.round((item.bytes ?? 0) / 102.4) / 10} KB{" "}
                  {(item.bytes ?? 0) > 102 * 1024 ? <Badge tone="danger">Gmail clips past 102 KB</Badge> : null}</dd>
              </dl>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant={view === "html" ? "secondary" : "ghost"} onClick={() => setView("html")}>Preview</Button>
              {!isSlack && item.text && <Button size="sm" variant={view === "text" ? "secondary" : "ghost"} onClick={() => setView("text")}>Plain text</Button>}
              {isSlack && <Button size="sm" variant={view === "blocks" ? "secondary" : "ghost"} onClick={() => setView("blocks")}>Block Kit JSON</Button>}
            </div>
            {view === "html" ? (
              <Frame key={`${item.id}:${theme}`} html={html} width={WIDTH[width]} inverted={theme === "inverted"} title={item.name} />
            ) : (
              <pre tabIndex={0} aria-label={view === "text" ? "Plain-text part" : "Block Kit"}
                className="max-h-[720px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-inset p-3 font-mono text-caption text-text-secondary">
                {view === "text" ? item.text : JSON.stringify(item.message, null, 2)}
              </pre>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
