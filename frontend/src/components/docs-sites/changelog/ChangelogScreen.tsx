"use client";

/**
 * Guide › Changelog (/guides/<site>/changelog): the guide's release notes. The list, newest month
 * first, each entry with its kind, date and whether readers see it yet; search and filters; the
 * changelog's settings (title, products, Coming next) and where readers find it; a preview in the
 * guide's saved design. ?entry=<id> (or ?entry=new) opens the entry editor (EntryEditor.tsx).
 *
 * The published guide gets /changelog, an entry page each, RSS/JSON/Markdown feeds, link previews,
 * and its entries in search and Ask AI, from the next publish on (backend
 * services/docs_site_changelog.py writes changelog.json).
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { ReadMore } from "@/components/ReadMore";
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, Drawer, EmptyState, Icon, Input, RowMenu, SegmentedControl, Skeleton, cx, useToast,
} from "@/components/ui";
import { useLocationSearch } from "@/components/shell/useLocation";
import {
  deleteEntry, duplicateEntry, getChangelog, getEntry, importReleaseNotes, releaseNotesCandidates,
  type ChangelogEntrySummary, type ChangelogOverview, type ChangelogSettings, type ChangeKind, type ReleaseNotesCandidate,
} from "@/lib/docsChangelog";
import { assetPreviewUrl, docsErrorMessage, listPages, primaryAddress, type PageSummary } from "@/lib/docsSites";
import { firstName, plural, timeAgo } from "../format";
import { opensDark } from "../guideTheme";
import { liveUrl, usePublishState } from "../PublishState";
import SiteBar from "../SiteBar";
import { useSite } from "../SiteContext";
import { EntryEditor, draftAsModel, type EntryDraft } from "./EntryEditor";
import {
  KIND_ICON, KIND_LABEL, NO_FILTER, STATUS_LABEL, filterEntries, longDate, monthGroups, sampleEntries, shortDate, toHub, todayIso,
  type Filter, type ModelEntry,
} from "./model";
import { SettingsDrawer, type SettingsSection } from "./SettingsDrawer";
import type { PreviewMedia } from "./ChangelogPreview";

// The preview draws the engine's hub in the guide's saved design; loaded when opened.
const ChangelogPreview = dynamic(() => import("./ChangelogPreview").then((m) => m.ChangelogPreview), { ssr: false });

const KIND_STYLE: Record<ChangeKind, React.CSSProperties> = {
  new: { background: "var(--accent-soft)", color: "var(--accent-text)" },
  improved: { background: "color-mix(in srgb, var(--cat-share) 13%, transparent)", color: "var(--cat-share)" },
  fixed: { background: "var(--success-soft)", color: "var(--success)" },
};

export function KindChip({ kind, className }: { kind: ChangeKind; className?: string }) {
  return (
    <span className={cx("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-semibold", className)} style={KIND_STYLE[kind]}>
      <Icon name={KIND_ICON[kind]} size={12} />
      {KIND_LABEL[kind]}
    </span>
  );
}

const STATUS_TONE = { published: "success", changed: "info", new: "neutral" } as const;

interface PreviewState {
  entries: ModelEntry[];
  bodies: Record<string, string>;
  media: Record<string, PreviewMedia>;
  view: { kind: "hub" } | { kind: "entry"; id: string };
  sample: boolean;
}

/** What readers get, for the empty state. */
const GETS: Array<{ icon: string; title: string; note: string }> = [
  { icon: "doc", title: "A changelog page", note: "/changelog with every release, newest first, a page per entry, and a Changelog tab in the header." },
  { icon: "wave", title: "RSS and JSON feeds", note: "Readers and their tools subscribe. Each entry gets its own link preview." },
  { icon: "search", title: "Search and Ask AI", note: "Entries show up in the guide's search, and Ask AI answers “what's new since…?”." },
  { icon: "filter", title: "Filters", note: "By kind (New, Improved, Fixed), area, product and version, plus “Coming next”." },
];

export default function ChangelogScreen() {
  const { site, base, canEdit } = useSite();
  const { refreshSoon } = usePublishState();
  const toast = useToast();
  const uid = useId();
  const search = useLocationSearch();
  const entryParam = useMemo(() => new URLSearchParams(search).get("entry"), [search]);
  const [ov, setOv] = useState<ChangelogOverview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [candidates, setCandidates] = useState<ReleaseNotesCandidate[]>([]);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewDark, setPreviewDark] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  const [deleting, setDeleting] = useState<ChangelogEntrySummary | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, p] = await Promise.all([getChangelog(site.id), listPages(site.id)]);
      setOv(o);
      setPages(p.pages);
      setLoadError("");
    } catch (e) {
      setLoadError(docsErrorMessage(e));
    }
    releaseNotesCandidates(site.id).then((r) => setCandidates(r.pages)).catch(() => setCandidates([]));
  }, [site.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPreviewDark(opensDark({ preset: site.settings.theme.preset, mode: site.settings.theme.mode })); }, [site.settings.theme.preset, site.settings.theme.mode]);

  const go = useCallback((entry: string | null) => {
    window.history.pushState(window.history.state, "", entry ? `${base}/changelog?entry=${encodeURIComponent(entry)}` : `${base}/changelog`);
    window.scrollTo({ top: 0 });
  }, [base]);

  const host = primaryAddress(site);
  const siteUrl = liveUrl(host);
  const live = site.status === "live";
  const entries = ov?.entries ?? [];
  const shown = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  const groups = useMemo(() => monthGroups(shown), [shown]);
  const unpublished = entries.filter((e) => e.status !== "published").length;
  const publishedCount = entries.filter((e) => e.status !== "new").length;
  const inUse = useMemo(() => {
    const n: Record<string, number> = {};
    for (const e of entries) for (const p of e.products) n[p] = (n[p] ?? 0) + 1;
    return n;
  }, [entries]);
  const pageList = useMemo(() => pages.map((p) => ({ id: p.id, path: p.path, title: p.title })), [pages]);
  const productLabel = (id: string) => ov?.settings.products.find((p) => p.id === id)?.label ?? id;
  const resolveAsset = useCallback((src: string) => assetPreviewUrl(site.id, src) ?? src, [site.id]);

  // ── Preview ──
  const openPreview = useCallback(async (opts: { sample?: boolean; draft?: { d: EntryDraft; id: string; status: ModelEntry["status"] }; view?: PreviewState["view"] } = {}) => {
    if (opts.sample || !ov) {
      const s = sampleEntries(todayIso());
      setPreview({ entries: s, bodies: {}, media: {}, view: { kind: "hub" }, sample: true });
      return;
    }
    let list: ModelEntry[] = ov.entries.map((e) => ({ ...e }));
    const media: Record<string, PreviewMedia> = Object.fromEntries(ov.entries.filter((e) => e.media.image || e.media.video).map((e) => [e.slug, e.media]));
    let view: PreviewState["view"] = opts.view ?? { kind: "hub" };
    const bodies: Record<string, string> = {};
    if (opts.draft) {
      const m = draftAsModel(opts.draft.d, opts.draft.id, opts.draft.status);
      list = [...list.filter((e) => e.id !== opts.draft!.id), m];
      if (opts.draft.d.image || opts.draft.d.video) media[m.slug] = { image: opts.draft.d.image || undefined, video: opts.draft.d.video || undefined, alt: opts.draft.d.alt || undefined };
      else delete media[m.slug];
      if (m.body?.trim()) bodies[m.slug] = m.body;
      view = { kind: "entry", id: m.slug };
    }
    setPreview({ entries: list, bodies, media, view, sample: false });
    // The details of the newest entries with any (the hub's "Read more").
    const want = ov.entries.filter((e) => e.has_body && e.id !== opts.draft?.id).slice(0, 24);
    const got = await Promise.all(want.map((e) => getEntry(site.id, e.id).then((x) => [x.slug, x.body] as const).catch(() => null)));
    setPreview((p) => p && !p.sample ? { ...p, bodies: { ...Object.fromEntries(got.filter((x): x is readonly [string, string] => !!x)), ...p.bodies } } : p);
  }, [ov, site.id]);

  const hubEntries = useMemo(() => {
    if (!preview) return [];
    const products = preview.sample ? [] : ov?.settings.products ?? [];
    return [...preview.entries]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((e) => toHub(e, products, pageList));
  }, [preview, ov, pageList]);

  // ── Actions ──
  const onSettingsSaved = (s: ChangelogSettings, changed: number) => {
    setOv((o) => o && { ...o, settings: s, settings_published: false });
    refreshSoon();
    toast.success(changed ? `Settings saved. ${plural(changed, "entry", "entries")} no longer name a removed product.` : "Settings saved. Readers see them after you publish.");
    if (changed) void load();
  };

  const duplicate = async (e: ChangelogEntrySummary) => {
    try {
      const d = await duplicateEntry(site.id, e.id);
      refreshSoon();
      toast.success("Duplicated. You're editing the copy.");
      await load();
      go(d.id);
    } catch (err) {
      toast.error(docsErrorMessage(err));
    }
  };

  const importPage = async (c: ReleaseNotesCandidate) => {
    setImporting(c.page_id);
    try {
      const r = await importReleaseNotes(site.id, c.page_id);
      refreshSoon();
      toast.success(`${plural(r.created, "entry", "entries")} added from “${r.page.title}”. Check them, then publish. The page itself is still there.`);
      setCandidates((cs) => cs.filter((x) => x.page_id !== c.page_id));
      await load();
    } catch (err) {
      toast.error(docsErrorMessage(err));
    } finally {
      setImporting(null);
    }
  };

  // ── The entry editor ──
  if (entryParam && ov) {
    return (
      <>
        <EntryEditor
          entryId={entryParam}
          overview={ov}
          pages={pages}
          onClose={() => { go(null); void load(); }}
          onSaved={(e, created) => {
            setOv((o) => o && { ...o, entries: [...o.entries.filter((x) => x.id !== e.id), e] });
            if (created && entryParam === "new") window.history.replaceState(window.history.state, "", `${base}/changelog?entry=${encodeURIComponent(e.id)}`);
          }}
          onDeleted={() => { go(null); void load(); }}
          onOpen={(id) => go(id)}
          onPreview={(d, id, status) => void openPreview({ draft: { d, id, status } })}
        />
        {previewDrawer()}
      </>
    );
  }

  function previewDrawer() {
    return (
      <Drawer
        open={!!preview}
        onClose={() => setPreview(null)}
        width={980}
        title={preview?.sample ? "What readers get" : "Preview"}
        description={preview?.sample ? "An example changelog in your guide's saved design (sample entries)." : "The changelog as the next publish would show it, in the guide's saved design."}
      >
        {preview && (
          <ChangelogPreview
            theme={site.settings.theme}
            entries={hubEntries}
            bodies={preview.bodies}
            media={preview.media}
            title={preview.sample ? "Changelog" : ov?.settings.title || "Changelog"}
            description={preview.sample ? "New features, improvements and fixes, newest first." : ov?.settings.description || undefined}
            next={preview.sample ? [{ title: "Offline mode", area: "Mobile", body: "Read and edit without a connection." }] : ov?.settings.next ?? []}
            siteUrl={siteUrl}
            view={preview.view}
            onView={(v) => setPreview((p) => p && { ...p, view: v })}
            dark={previewDark}
            onDark={setPreviewDark}
            resolveAsset={resolveAsset}
            note={preview.sample ? <>Sample entries (the fictional Northwind app) in <strong className="text-text">your saved design</strong>.</> : undefined}
          />
        )}
      </Drawer>
    );
  }

  const entryHref = (id: string) => `${base}/changelog?entry=${encodeURIComponent(id)}`;
  const empty = ov && entries.length === 0 && ov.removed.length === 0;

  return (
    <>
      <SiteBar
        section="changelog"
        preview={false}
        actions={ov && (
          <>
            {!empty && <Button variant="ghost" size="sm" iconLeft="eye" onClick={() => void openPreview()}><span className="max-sm:md-visually-hidden">Preview</span></Button>}
            <Button variant="ghost" size="sm" iconLeft="settings" onClick={() => setSettingsOpen("page")}><span className="max-sm:md-visually-hidden">Settings</span></Button>
            {canEdit && !empty && <Button variant="secondary" size="sm" iconLeft="plus" onClick={() => go("new")}>New entry</Button>}
          </>
        )}
      />
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 pb-16 pt-6 outline-none sm:px-6 sm:pt-8">
        {loadError && (
          <Alert tone="danger" title="We couldn't load the changelog" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{loadError}</Alert>
        )}
        {!ov && !loadError && (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the changelog">
            <Skeleton width="30%" height={28} />
            <Skeleton width="55%" />
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="rect" height={76} />)}
          </div>
        )}

        {candidates.length > 0 && canEdit && ov && (
          <section aria-label="Release notes found" className="flex flex-col gap-3 rounded-xl border border-accent bg-accent-soft p-4 sm:p-5">
            {candidates.map((c) => (
              <div key={c.page_id} className="flex flex-wrap items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-accent-text" aria-hidden><Icon name="megaphone" size={18} /></span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <strong className="text-text">Your page <span className="ph-sensitive ph-mask">“{c.title}”</span> has {plural(c.entries, "dated release")}</strong>
                  <span className="text-[13px] text-text-secondary">
                    {longDate(c.oldest)} to {longDate(c.newest)}{c.skipped ? ` · ${plural(c.skipped, "section")} without a date stay${c.skipped === 1 ? "s" : ""} on the page` : ""}. Turn them into entries: each heading becomes one, with its text as the details. The page stays as it is.
                  </span>
                </span>
                <span className="flex shrink-0 gap-2">
                  <Button variant="ghost" size="sm" href={`${base}?page=${encodeURIComponent(c.page_id)}`}>Open the page</Button>
                  <Button variant="primary" size="sm" iconLeft="megaphone" loading={importing === c.page_id} onClick={() => void importPage(c)}>Turn into {plural(c.entries, "entry", "entries")}</Button>
                </span>
              </div>
            ))}
          </section>
        )}

        {empty && (
          <section aria-labelledby={`${uid}-empty`} className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
            <div className="flex flex-col gap-5">
              <span className="grid size-12 place-items-center rounded-xl bg-accent-soft text-accent-text" aria-hidden><Icon name="megaphone" size={24} /></span>
              <div className="flex flex-col gap-2">
                <h1 id={`${uid}-empty`} className="text-[28px] font-bold leading-9 tracking-[-0.02em] text-text">Tell readers what&apos;s new</h1>
                <p className="max-w-[54ch] text-body text-text-secondary">
                  Write an entry for each release: what changed, why it matters, a screenshot or clip. Your guide gets a changelog readers can follow. <ReadMore topic="studioChangelog" />
                </p>
              </div>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {GETS.map((g) => (
                  <li key={g.title} className="flex gap-3 rounded-xl border border-border bg-surface p-3.5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-inset text-text-secondary" aria-hidden><Icon name={g.icon} size={16} /></span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <strong className="text-[14px] font-semibold text-text">{g.title}</strong>
                      <span className="text-[13px] leading-5 text-text-secondary">{g.note}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                {canEdit && <Button variant="primary" iconLeft="edit" onClick={() => go("new")}>Write the first entry</Button>}
                <Button variant="secondary" iconLeft="eye" onClick={() => void openPreview({ sample: true })}>See an example</Button>
              </div>
              {!canEdit && <p className="text-[13px] text-text-muted">Editors and admins write the changelog.</p>}
            </div>
            <SampleCard host={host} />
          </section>
        )}

        {ov && !empty && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
            <section aria-labelledby={`${uid}-h`} className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h1 id={`${uid}-h`} className="text-[26px] font-bold leading-8 tracking-[-0.02em] text-text">{ov.settings.title || "Changelog"}</h1>
                <p className="text-body text-text-secondary">
                  {plural(entries.length, "entry", "entries")}
                  {unpublished > 0 ? <> · <strong className="font-semibold text-text">{unpublished} not published yet</strong>: readers see {unpublished === 1 ? "it" : "them"} after you publish.</> : live ? " · all published." : "."}{" "}
                  <ReadMore topic="studioChangelog" />
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="search"
                  size="sm"
                  prefix="search"
                  value={filter.q}
                  onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
                  placeholder="Search entries"
                  aria-label="Search entries"
                  wrapClassName="min-w-[180px] flex-1 sm:max-w-[280px]"
                />
                <SegmentedControl<Filter["kind"]>
                  size="sm"
                  aria-label="Kind"
                  value={filter.kind}
                  onChange={(kind) => setFilter((f) => ({ ...f, kind }))}
                  options={(["all", "new", "improved", "fixed"] as const).map((k) => ({
                    value: k,
                    label: <>{k === "all" ? "All" : KIND_LABEL[k]} <span className="tabular-nums text-text-muted">{k === "all" ? entries.length : entries.filter((e) => e.kind === k).length}</span></>,
                  }))}
                />
                <SegmentedControl<Filter["status"]>
                  size="sm"
                  aria-label="Status"
                  value={filter.status}
                  onChange={(status) => setFilter((f) => ({ ...f, status }))}
                  options={[{ value: "all", label: "Any status" }, { value: "unpublished", label: `Not published (${unpublished})` }]}
                />
              </div>

              {ov.removed.length > 0 && (
                <Alert tone="info" title={`${plural(ov.removed.length, "deleted entry", "deleted entries")} still on the live guide`}>
                  {ov.removed.map((r) => r.title).join(", ")}. They leave the changelog and its feeds at the next publish.
                </Alert>
              )}

              {shown.length === 0 && entries.length > 0 && (
                <EmptyState icon="search" title="No entries match" description="Try other words, or another kind or status."
                  actions={<Button variant="secondary" size="sm" onClick={() => setFilter(NO_FILTER)}>Clear filters</Button>} />
              )}

              {groups.map((g) => (
                <section key={g.key} aria-labelledby={`${uid}-m-${g.key}`} className="flex flex-col gap-2">
                  <h2 id={`${uid}-m-${g.key}`} className="flex items-baseline gap-2 pt-1 text-[15px] font-semibold text-text">
                    {g.label}<span className="text-[12px] font-normal text-text-muted">{plural(g.items.length, "entry", "entries")}</span>
                  </h2>
                  <ul className="ph-no-capture flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
                    {g.items.map((e) => (
                      <li key={e.id} className="group relative flex items-start gap-3 border-b border-border px-3 py-3 last:border-b-0 hover:bg-surface-hover sm:gap-4 sm:px-4">
                        <span className="hidden w-[52px] shrink-0 flex-col items-center rounded-lg border border-border bg-surface py-1 sm:flex" aria-hidden>
                          <span className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">{shortDate(e.date).split(" ")[0]}</span>
                          <span className="text-[18px] font-bold leading-6 text-text tabular-nums">{shortDate(e.date).split(" ")[1]}</span>
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-muted">
                            <KindChip kind={e.kind} />
                            <span className="ph-sensitive ph-mask">{e.area}</span>
                            <span aria-hidden>·</span>
                            <time dateTime={e.date}>{longDate(e.date)}</time>
                            {e.products.map((p) => (
                              <span key={p} className="ph-sensitive ph-mask rounded-full border border-border px-1.5 text-[12px]">{productLabel(p)}{e.versions[p] ? ` ${e.versions[p]}` : ""}</span>
                            ))}
                          </span>
                          <a href={entryHref(e.id)} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; ev.preventDefault(); go(e.id); }}
                            className="md-focus ph-sensitive ph-mask truncate rounded text-[15px] font-semibold text-text no-underline after:absolute after:inset-0 hover:underline">
                            {e.title}
                          </a>
                          <span className="ph-sensitive ph-mask line-clamp-2 text-[13px] leading-5 text-text-secondary">{e.summary}</span>
                          <span className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
                            {(e.media.image || e.media.video) && <span className="inline-flex items-center gap-1"><Icon name={e.media.video ? "film" : "image"} size={12} />{e.media.video ? "Video" : "Image"}</span>}
                            {e.has_body && <span className="inline-flex items-center gap-1"><Icon name="lines" size={12} />Details</span>}
                            {e.highlights.length > 0 && <span className="inline-flex items-center gap-1"><Icon name="check" size={12} />{plural(e.highlights.length, "highlight")}</span>}
                            {e.updated_by_name && <span>Saved by {firstName(e.updated_by_name)} {timeAgo(e.updated_at)}</span>}
                          </span>
                        </span>
                        <span className="relative z-[1] flex shrink-0 items-center gap-1">
                          <Badge size="sm" tone={STATUS_TONE[e.status]} dot className="max-sm:hidden">{e.status === "new" ? "Not published" : e.status === "changed" ? "Changed" : "Published"}</Badge>
                          <RowMenu
                            label={`Actions for ${e.title}`}
                            items={[
                              { label: canEdit ? "Edit" : "Open", icon: canEdit ? "edit" : "eye", onClick: () => go(e.id) },
                              { label: "Preview", icon: "eye", onClick: () => void openPreview({ view: { kind: "entry", id: e.slug } }) },
                              ...(live && e.status !== "new" ? [{ label: "Open on the guide", icon: "external", href: `${siteUrl}/changelog/${e.slug}`, external: true }] : []),
                              ...(canEdit ? [
                                { label: "Duplicate", icon: "copy", onClick: () => void duplicate(e) },
                                { label: "Delete", icon: "trash", danger: true, separated: true, onClick: () => setDeleting(e) },
                              ] : []),
                            ]}
                          />
                        </span>
                        <span className="md-visually-hidden">{STATUS_LABEL[e.status]}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </section>

            <aside aria-label="About the changelog" className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-[124px]">
              <ReadersCard host={host} live={live} published={publishedCount > 0} />
              <section aria-labelledby={`${uid}-next`} className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4">
                <div className="flex items-center gap-2">
                  <h2 id={`${uid}-next`} className="flex flex-1 items-center gap-1.5 text-[14px] font-semibold text-text"><Icon name="clock" size={14} /> Coming next</h2>
                  <Button variant="ghost" size="sm" onClick={() => setSettingsOpen("next")}>{canEdit ? "Edit" : "View"}</Button>
                </div>
                {ov.settings.next.length ? (
                  <ol className="flex flex-col gap-1.5">
                    {ov.settings.next.map((n, i) => (
                      <li key={i} className="flex flex-col rounded-md bg-surface-inset px-2.5 py-1.5">
                        <span className="ph-sensitive ph-mask text-[13px] font-semibold text-text">{n.title}</span>
                        {(n.area || n.body) && <span className="ph-sensitive ph-mask text-[12px] text-text-muted">{[n.area, n.body].filter(Boolean).join(" · ")}</span>}
                      </li>
                    ))}
                  </ol>
                ) : <p className="text-[13px] text-text-muted">Nothing announced. Readers see what you list here above the releases.</p>}
              </section>
              <section aria-labelledby={`${uid}-prod`} className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4">
                <div className="flex items-center gap-2">
                  <h2 id={`${uid}-prod`} className="flex flex-1 items-center gap-1.5 text-[14px] font-semibold text-text"><Icon name="layers" size={14} /> Products</h2>
                  <Button variant="ghost" size="sm" onClick={() => setSettingsOpen("products")}>{canEdit ? "Edit" : "View"}</Button>
                </div>
                {ov.settings.products.length ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {ov.settings.products.map((p) => <li key={p.id}><Badge size="sm">{p.label}</Badge></li>)}
                  </ul>
                ) : <p className="text-[13px] text-text-muted">One product, so entries don&apos;t name one. Add products to give entries versions and a product filter.</p>}
              </section>
              {!ov.settings_published && <p className="flex items-start gap-2 text-[12px] text-text-muted"><Icon name="info" size={13} className="mt-0.5 shrink-0" />The changelog&apos;s settings changed since the last publish.</p>}
            </aside>
          </div>
        )}
      </main>

      {ov && (
        <SettingsDrawer
          open={settingsOpen !== null}
          onClose={() => setSettingsOpen(null)}
          siteId={site.id}
          settings={ov.settings}
          focus={settingsOpen ?? "page"}
          canEdit={canEdit}
          onSaved={onSettingsSaved}
          inUse={inUse}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.title ?? ""}”?`}
        description={deleting?.status === "new" ? "It was never published, so readers never saw it." : "Readers keep seeing it until the next publish, then it's gone from the changelog and its feeds."}
        confirmLabel="Delete entry"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteEntry(site.id, deleting.id);
          setDeleting(null);
          refreshSoon();
          toast.success("Entry deleted.");
          await load();
        }}
      />
      {previewDrawer()}
    </>
  );
}

/** Where readers find the changelog: the page and the feeds (each with Open and Copy). */
function ReadersCard({ host, live, published }: { host: string; live: boolean; published: boolean }) {
  const url = liveUrl(host);
  const rows = [
    { icon: "doc", label: "Changelog page", path: "/changelog" },
    { icon: "wave", label: "RSS feed", path: "/changelog.rss" },
    { icon: "code", label: "JSON Feed", path: "/changelog.json" },
  ];
  const ready = live && published;
  return (
    <section aria-label="Where readers find it" className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4">
      <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-text"><Icon name="globe" size={14} /> Where readers find it</h2>
      {!ready && <p className="text-[13px] text-text-muted">{live ? "After you publish your first entry:" : "Once the guide is published:"}</p>}
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.path} className="flex min-w-0 items-center gap-2 rounded-md bg-surface-inset py-1 pl-2.5 pr-1">
            <Icon name={r.icon} size={13} className="shrink-0 text-text-muted" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[12px] font-semibold text-text-secondary">{r.label}</span>
              {ready ? (
                <a href={`${url}${r.path}`} target="_blank" rel="noopener noreferrer" className="ph-sensitive ph-mask truncate font-mono text-[12px] text-accent-text no-underline hover:underline" title={`${host}${r.path}`}>
                  {host}{r.path}<span className="md-visually-hidden"> (opens in a new tab)</span>
                </a>
              ) : <span className="ph-sensitive ph-mask truncate font-mono text-[12px] text-text-muted">{host}{r.path}</span>}
            </span>
            {ready && <CopyButton text={`${url}${r.path}`} label={`Copy the ${r.label} address`} iconOnly size="sm" announceText="Address copied" />}
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-text-muted">Entries are in the guide&apos;s search and Ask AI too.</p>
    </section>
  );
}

/** The empty state's picture: three sample releases as the list draws them. */
function SampleCard({ host }: { host: string }) {
  const s = sampleEntries(todayIso());
  return (
    <figure aria-label="An example changelog" className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-border bg-surface-inset px-4 py-2.5 text-[12px] text-text-muted">
        <span className="flex gap-1" aria-hidden><span className="size-2 rounded-full bg-border-strong" /><span className="size-2 rounded-full bg-border-strong" /><span className="size-2 rounded-full bg-border-strong" /></span>
        <span className="ph-sensitive ph-mask min-w-0 truncate font-mono">{host}/changelog</span>
      </div>
      <div className="flex flex-col gap-3 p-4 sm:p-5" aria-hidden>
        <span className="text-[12px] font-semibold text-accent-text">Changelog</span>
        <strong className="text-[22px] font-bold leading-7 tracking-[-0.02em] text-text">What&apos;s new in Northwind</strong>
        {s.map((e, i) => (
          <div key={e.id} className={cx("flex flex-col gap-1.5 rounded-xl border border-border p-3", i === 0 && "bg-accent-soft/40")}>
            <span className="flex items-center gap-2 text-[12px] text-text-muted"><KindChip kind={e.kind} />{e.area}<span aria-hidden>·</span>{longDate(e.date)}</span>
            <strong className="text-[14px] font-semibold text-text">{e.title}</strong>
            <span className="line-clamp-2 text-[12px] leading-[18px] text-text-secondary">{e.summary}</span>
          </div>
        ))}
      </div>
      <figcaption className="border-t border-border px-4 py-2.5 text-[12px] text-text-muted">Sample entries · your guide uses its own design</figcaption>
    </figure>
  );
}
