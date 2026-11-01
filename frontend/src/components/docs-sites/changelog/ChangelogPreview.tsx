"use client";

/**
 * The changelog as readers will see it, in the guide's SAVED design (Design › Save design): the
 * engine's own hub (frontend/src/docs/client/Changelog.tsx ChangelogHub, Spotlight) and its styles
 * (changelog.css, docs.css, themes.css), inside a root that carries the guide's theme tokens
 * (guideTheme.ts), as the editor's DraftPreview does for a page. Entries are the drafts: what the
 * next publish would show. Bodies render with the engine's Markdown pipeline; images and videos
 * come through the studio's asset previews. Links stay in the preview (an entry opens its page).
 */
import { useEffect, useId, useMemo, type CSSProperties, type MouseEvent } from "react";
import "@/docs/docs.css";
import "@/docs/themes.css";
import "@/docs/changelog.css";
import { Icon, SegmentedControl } from "@/components/ui";
import { ChangelogHub, DocsUpdated, Spotlight, type HubEntry } from "@/docs/client/Changelog";
import { presetName, type SiteTheme } from "@/lib/docsSites";
import { guideLook } from "../guideTheme";
import { PREVIEW_FONTS_HREF } from "../presets";
import { PreviewMarkdown } from "../editor/DraftPreview";

export interface PreviewMedia {
  image?: string;
  video?: string;
  alt?: string;
}

export interface ChangelogPreviewProps {
  theme: SiteTheme;
  /** Newest first, in the hub's shape (model.ts toHub). */
  entries: HubEntry[];
  bodies: Record<string, string>;
  media: Record<string, PreviewMedia>;
  title: string;
  description?: string;
  next: Array<{ title: string; body?: string; area?: string }>;
  /** The guide's address (https://…), for the copied links and feeds. */
  siteUrl: string;
  /** The hub, or one entry's page (by its slug). */
  view: { kind: "hub" } | { kind: "entry"; id: string };
  onView: (v: ChangelogPreviewProps["view"]) => void;
  dark: boolean;
  onDark: (dark: boolean) => void;
  resolveAsset: (src: string) => string;
  /** A note above the preview ("Sample entries", "Your drafts"). */
  note?: React.ReactNode;
}

function MediaView({ m, title, resolve }: { m: PreviewMedia; title: string; resolve: (src: string) => string }) {
  if (m.video) {
    return (
      <figure className="dxc-figure">
        <video src={resolve(m.video)} poster={m.image ? resolve(m.image) : undefined} controls playsInline preload="metadata" aria-label={m.alt || title} style={{ width: "100%", display: "block" }} />
      </figure>
    );
  }
  if (!m.image) return null;
  return (
    <figure className="dxc-figure">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={resolve(m.image)} alt={m.alt ?? ""} loading="lazy" decoding="async" />
    </figure>
  );
}

export function ChangelogPreview(p: ChangelogPreviewProps) {
  const { theme, entries, dark } = p;
  const scopeId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const look = useMemo(() => guideLook(theme, dark, `[data-dx-preview="${scopeId}"]`), [theme, dark, scopeId]);
  const forced = theme.mode === "light" || theme.mode === "dark";

  useEffect(() => {
    if (document.querySelector("link[data-docs-preview-fonts]")) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = PREVIEW_FONTS_HREF;
    l.dataset.docsPreviewFonts = "";
    document.head.appendChild(l);
  }, []);

  const media = useMemo(
    () => Object.fromEntries(entries.filter((e) => p.media[e.id]?.image || p.media[e.id]?.video).map((e) => [e.id, <MediaView key={e.id} m={p.media[e.id]!} title={e.title} resolve={p.resolveAsset} />])),
    [entries, p.media, p.resolveAsset],
  );
  const bodies = useMemo(
    () => Object.fromEntries(entries.filter((e) => p.bodies[e.id]?.trim()).map((e) => [e.id, <PreviewMarkdown key={e.id} markdown={p.bodies[e.id]!} resolveAsset={p.resolveAsset} className="dxc-prose" />])),
    [entries, p.bodies, p.resolveAsset],
  );

  // Every link stays in the preview: an entry's page opens here, "All releases" goes back to the
  // hub, an address elsewhere opens in a new tab, and a page of the guide does nothing (the
  // editor's Preview shows pages).
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !e.currentTarget.contains(a)) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    e.preventDefault();
    const m = /^\/changelog\/([^/?#]+)/.exec(href);
    if (m) p.onView({ kind: "entry", id: decodeURIComponent(m[1]!) });
    else if (/^\/changelog\/?(?:[?#].*)?$/.test(href)) p.onView({ kind: "hub" });
    else if (/^https:\/\//.test(href)) window.open(href, "_blank", "noopener,noreferrer");
  };

  const current = p.view.kind === "entry" ? entries.find((e) => e.id === (p.view as { id: string }).id) : undefined;
  const i = current ? entries.indexOf(current) : -1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
        <span className="min-w-0 flex-1">
          {p.note ?? <>Your drafts, in the saved design: <strong className="text-text">{presetName(theme.preset)}{"data-custom" in look.attrs ? ", customised" : ""}</strong>.</>}
        </span>
        <SegmentedControl
          size="sm"
          aria-label="What to preview"
          value={p.view.kind}
          onChange={(v: string) => (v === "hub" ? p.onView({ kind: "hub" }) : entries[0] && p.onView({ kind: "entry", id: current?.id ?? entries[0].id }))}
          options={[{ value: "hub", label: "Changelog" }, { value: "entry", label: "Entry page", disabled: !entries.length }]}
        />
        {!forced && (
          <SegmentedControl
            size="sm"
            aria-label="Light or dark"
            value={dark ? "dark" : "light"}
            onChange={(v: string) => p.onDark(v === "dark")}
            options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          />
        )}
      </div>
      <div data-theme={dark ? "dark" : "light"} className="contents">
        {look.css && <style dangerouslySetInnerHTML={{ __html: look.css }} />}
        {/* The panel is narrower than the window the hub's breakpoints measure: one column, no "Jump to" rail. */}
        <style dangerouslySetInnerHTML={{ __html: `[data-dx-preview="${scopeId}"] .dxc{grid-template-columns:minmax(0,760px)}[data-dx-preview="${scopeId}"] .dxc-rail{display:none}[data-dx-preview="${scopeId}"] .dxc-page{padding-left:20px;padding-right:20px}` }} />
        <div
          className="dx-root ph-no-capture overflow-hidden rounded-xl border"
          {...look.attrs}
          data-dx-preview={scopeId}
          data-theme={dark ? "dark" : "light"}
          data-testid="changelog-preview"
          style={{ ...(look.vars as CSSProperties), ["--dx-header-h" as string]: "0px", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-sans)", borderColor: "var(--border)" } as CSSProperties}
          onClickCapture={onClickCapture}
        >
          {p.view.kind === "hub" || !current ? (
            <div className="dxc-page" style={{ paddingBottom: 40 }}>
              <ChangelogHub
                title={p.title || "Changelog"}
                description={p.description || undefined}
                entries={entries}
                media={media}
                bodies={bodies}
                siteUrl={p.siteUrl}
                next={p.next}
              />
            </div>
          ) : (
            <div className="dxc-page dxc-page--entry" style={{ paddingBottom: 40 }}>
              <div className="dxc-entry">
                <a href="/changelog" className="dxc-back">
                  <Icon name="arrowLeft" />
                  All releases
                </a>
                <Spotlight e={current} media={media[current.id]} siteUrl={p.siteUrl} permalink />
                {p.bodies[current.id]?.trim() && (
                  <section className="dxc-entry__body" aria-label="Details">
                    <PreviewMarkdown markdown={p.bodies[current.id]!} resolveAsset={p.resolveAsset} className="dxc-prose dxc-prose--page" />
                  </section>
                )}
                <DocsUpdated docs={current.docs} />
                <nav aria-label="More releases" className="dxc-pn">
                  {entries[i - 1] ? (
                    <a href={`/changelog/${entries[i - 1]!.id}`} className="dxc-pn__link dxc-pn__link--newer">
                      <span className="dxc-pn__dir"><Icon name="arrowLeft" />Newer release</span>
                      <strong className="dxc-pn__title">{entries[i - 1]!.title}</strong>
                    </a>
                  ) : <span className="dxc-pn__spacer" />}
                  {entries[i + 1] ? (
                    <a href={`/changelog/${entries[i + 1]!.id}`} className="dxc-pn__link dxc-pn__link--older">
                      <span className="dxc-pn__dir">Older release<Icon name="arrowRight" /></span>
                      <strong className="dxc-pn__title">{entries[i + 1]!.title}</strong>
                    </a>
                  ) : <span className="dxc-pn__spacer" />}
                </nav>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ChangelogPreview;
