"use client";

/**
 * One changelog entry: the title, the one-line summary (feeds, cards, link previews) and the
 * details in the guide's own page editor (TipTap, the same blocks as a page), with the entry's
 * facts beside them: date, kind, area, products and versions, highlights, an image or video, a
 * "Try it" link, related pages and its address. Saved with Save (or ⌘S / Ctrl+S); a save names the
 * rev it was made on, so two people never overwrite each other silently. Readers see it after the
 * next publish.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Alert, Badge, Button, Checkbox, ConfirmDialog, CopyButton, Field, Icon, IconButton, Input, Kbd, RowMenu, SegmentedControl, Spinner, Textarea, cx, useToast,
} from "@/components/ui";
import { DocsEditor, preloadDocsEditor, type UploadImage } from "@/components/docs-editor";
import {
  createEntry, deleteEntry, duplicateEntry, getEntry, saveEntry,
  type ChangeKind, type ChangelogEntry, type ChangelogOverview, type EntryInput,
} from "@/lib/docsChangelog";
import { DocsApiError, assetPreviewUrl, docsErrorMessage, primaryAddress, uploadAsset, type PageSummary } from "@/lib/docsSites";
import { firstName, timeAgo } from "../format";
import { liveUrl, usePublishState } from "../PublishState";
import SiteBar from "../SiteBar";
import { useSite } from "../SiteContext";
import { useLeaveGuard } from "../useLeaveGuard";
import { KIND_ICON, KIND_LABEL, LIMITS, STATUS_LABEL, entryProblems, knownAreas, longDate, slugFromTitle, todayIso, type DraftFields, type ModelEntry } from "./model";
import { MediaPicker, PagesPicker } from "./pickers";

interface Draft {
  title: string;
  summary: string;
  date: string;
  slug: string;
  kind: ChangeKind;
  area: string;
  products: string[];
  versions: Record<string, string>;
  highlights: string[];
  image: string;
  video: string;
  alt: string;
  tryLabel: string;
  tryHref: string;
  docs: string[];
  body: string;
}

const blank = (): Draft => ({
  title: "", summary: "", date: todayIso(), slug: "", kind: "new", area: "", products: [], versions: {}, highlights: [],
  image: "", video: "", alt: "", tryLabel: "", tryHref: "", docs: [], body: "",
});

function fromEntry(e: ChangelogEntry): Draft {
  return {
    title: e.title, summary: e.summary, date: e.date, slug: e.slug, kind: e.kind, area: e.area === "General" ? "" : e.area,
    products: [...e.products], versions: { ...e.versions }, highlights: [...e.highlights],
    image: e.media?.image ?? "", video: e.media?.video ?? "", alt: e.media?.alt ?? "",
    tryLabel: e.try?.label ?? "", tryHref: e.try?.href ?? "", docs: [...e.docs], body: e.body,
  };
}

function toInput(d: Draft, isNew: boolean): EntryInput {
  return {
    ...(d.slug || !isNew ? { slug: d.slug || undefined } : {}),
    title: d.title, summary: d.summary, date: d.date, kind: d.kind, area: d.area.trim() || "General",
    products: d.products, versions: Object.fromEntries(Object.entries(d.versions).filter(([k, v]) => d.products.includes(k) && v.trim()).map(([k, v]) => [k, v.trim()])),
    highlights: d.highlights.map((h) => h.trim()).filter(Boolean),
    media: { ...(d.image ? { image: d.image } : {}), ...(d.video ? { video: d.video } : {}), ...((d.image || d.video) && d.alt.trim() ? { alt: d.alt.trim() } : {}) },
    try: d.tryHref.trim() ? { label: d.tryLabel.trim() || "Try it", href: d.tryHref.trim() } : null,
    docs: d.docs, body: d.body,
  };
}

/** The draft as the preview's model entry. */
export function draftAsModel(d: Draft, id: string, status: ModelEntry["status"]): ModelEntry {
  return {
    id, slug: d.slug || slugFromTitle(d.title) || id, date: d.date, title: d.title, kind: d.kind, area: d.area.trim() || "General",
    products: d.products, versions: d.versions, summary: d.summary, highlights: d.highlights.filter((h) => h.trim()), status,
    try: d.tryHref ? { label: d.tryLabel || "Try it", href: d.tryHref } : null, docs: d.docs, body: d.body,
  };
}
export type EntryDraft = Draft;

const isMac = () => typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);

export function EntryEditor({ entryId, overview, pages, onClose, onSaved, onDeleted, onOpen, onPreview }: {
  /** An entry's id, or "new". */
  entryId: string;
  overview: ChangelogOverview;
  pages: PageSummary[];
  onClose: () => void;
  onSaved: (e: ChangelogEntry, created: boolean) => void;
  onDeleted: (id: string) => void;
  onOpen: (id: string) => void;
  onPreview: (draft: Draft, id: string, status: ModelEntry["status"]) => void;
}) {
  const { site, canEdit } = useSite();
  const { refreshSoon } = usePublishState();
  const toast = useToast();
  const uid = useId();
  const isNew = entryId === "new";
  const [entry, setEntry] = useState<ChangelogEntry | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft>(blank);
  const [saved, setSaved] = useState<string>(() => JSON.stringify(blank()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{ name: string; at: string | null } | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [picker, setPicker] = useState<"image" | "video" | null>(null);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { preloadDocsEditor(); }, []);

  useEffect(() => {
    let on = true;
    setLoadError("");
    setConflict(null);
    setError("");
    setShowProblems(false);
    if (isNew) {
      const d = blank();
      setEntry(null);
      setDraft(d);
      setSaved(JSON.stringify(d));
      window.setTimeout(() => titleRef.current?.focus(), 50);
      return;
    }
    setEntry(null);
    getEntry(site.id, entryId)
      .then((e) => {
        if (!on) return;
        const d = fromEntry(e);
        setEntry(e);
        setDraft(d);
        setSaved(JSON.stringify(d));
      })
      .catch((e) => on && setLoadError(docsErrorMessage(e)));
    return () => { on = false; };
  }, [site.id, entryId, isNew]);

  const dirty = JSON.stringify(draft) !== saved;
  const leaveGuard = useLeaveGuard(dirty && canEdit, "this entry");
  const set = useCallback(<K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v })), []);

  const problemInput: DraftFields = { ...draft, versions: draft.versions };
  const problems = entryProblems(problemInput);
  const hasProblems = Object.keys(problems).length > 0;
  const shown = (k: keyof DraftFields) => (showProblems || (k !== "title" && k !== "summary") ? problems[k] : undefined);

  const save = useCallback(async (force = false) => {
    if (!canEdit || busy) return;
    if (hasProblems) {
      setShowProblems(true);
      setError("Fix the fields marked below, then save.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const input = toInput(draft, isNew);
      const out = isNew ? await createEntry(site.id, input) : await saveEntry(site.id, entryId, input, force ? undefined : entry?.rev);
      const d = fromEntry(out);
      setEntry(out);
      setDraft(d);
      setSaved(JSON.stringify(d));
      setConflict(null);
      refreshSoon();
      onSaved(out, isNew);
      toast.success(isNew ? "Entry created. Readers see it after you publish." : "Saved. Readers see it after you publish.");
    } catch (e) {
      if (e instanceof DocsApiError && e.status === 409 && typeof e.info.rev === "number") {
        setConflict({ name: firstName(String(e.info.updated_by_name || "Someone")), at: (e.info.updated_at as string) ?? null });
      } else {
        setError(docsErrorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }, [canEdit, busy, hasProblems, draft, isNew, site.id, entryId, entry?.rev, refreshSoon, onSaved, toast]);

  // ⌘S / Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const loadTheirs = async () => {
    try {
      const e = await getEntry(site.id, entryId);
      const d = fromEntry(e);
      setEntry(e);
      setDraft(d);
      setSaved(JSON.stringify(d));
      setConflict(null);
    } catch (err) {
      setError(docsErrorMessage(err));
    }
  };

  const onUploadImage = useCallback<UploadImage>(async (file, info) => (
    await uploadAsset(site.id, file, info.variant === "dark" ? { variant: "dark", for: info.for } : undefined)
  ).url, [site.id]);
  const resolveAssetUrl = useCallback((src: string) => assetPreviewUrl(site.id, src) ?? src, [site.id]);

  const products = overview.settings.products;
  const areas = useMemo(() => knownAreas(overview.entries), [overview.entries]);
  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const status: ModelEntry["status"] = entry ? entry.status : "new";
  const host = primaryAddress(site);
  const live = site.status === "live" && status !== "new";
  const permalink = `${liveUrl(host)}/changelog/${entry?.slug ?? draft.slug}`;
  const readOnly = !canEdit;

  if (loadError) {
    return (
      <>
        <SiteBar section="changelog" />
        <main id="main" className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-10">
          <Alert tone="danger" title="We couldn't open this entry" actions={<Button size="sm" variant="secondary" onClick={onClose}>All entries</Button>}>{loadError}</Alert>
        </main>
      </>
    );
  }
  const loading = !isNew && !entry;

  const statusBadge = isNew ? (
    <Badge size="sm" icon="edit">New entry</Badge>
  ) : entry ? (
    <Badge size="sm" tone={status === "published" ? "success" : status === "changed" ? "info" : "neutral"} dot>{STATUS_LABEL[status]}</Badge>
  ) : null;

  const saveState = !canEdit ? null : busy ? (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted" aria-live="polite"><Spinner size={11} /> Saving…</span>
  ) : dirty ? (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted"><Icon name="edit" size={13} /> Unsaved changes</span>
  ) : entry ? (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted" title={entry.updated_at ? `Saved ${timeAgo(entry.updated_at)}` : undefined}><Icon name="checkCircle" size={13} /> Saved</span>
  ) : null;

  return (
    <>
      <SiteBar
        section="changelog"
        preview={false}
        crumb={<>Changelog › {draft.title || (isNew ? "New entry" : "Untitled")}</>}
        status={saveState}
        actions={
          <>
            <Button variant="ghost" size="sm" iconLeft="eye" disabled={loading} onClick={() => onPreview(draft, entry?.id ?? "draft", status)}>
              <span className="max-sm:hidden">Preview</span><span className="sm:hidden md-visually-hidden">Preview</span>
            </Button>
            {canEdit && (
              <Button variant={dirty || isNew ? "primary" : "secondary"} size="sm" iconLeft="check" loading={busy} disabled={loading || (!dirty && !isNew)} onClick={() => void save()}
                title={`Save (${isMac() ? "⌘" : "Ctrl+"}S)`}>
                {isNew ? "Create entry" : "Save"}
              </Button>
            )}
          </>
        }
      />
      {leaveGuard}
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 pb-20 pt-5 outline-none sm:px-6 sm:pt-7">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" iconLeft="arrowLeft" onClick={onClose}>All entries</Button>
          {statusBadge}
          {entry && entry.updated_by_name && (
            <span className="text-[12px] text-text-muted">Last saved by {firstName(entry.updated_by_name)} {timeAgo(entry.updated_at)}</span>
          )}
          {entry && canEdit && (
            <span className="ml-auto">
              <RowMenu
                label="Entry actions"
                items={[
                  { label: "Preview", icon: "eye", onClick: () => onPreview(draft, entry.id, status) },
                  { label: "Duplicate", icon: "copy", onClick: () => void duplicateEntry(site.id, entry.id).then((d) => { refreshSoon(); toast.success("Duplicated. You're editing the copy."); onSaved(d, true); onOpen(d.id); }).catch((e) => toast.error(docsErrorMessage(e))) },
                  ...(live ? [{ label: "Open on the guide", icon: "external", href: permalink, external: true }] : []),
                  { label: "Delete", icon: "trash", danger: true, separated: true, onClick: () => setDeleting(true) },
                ]}
              />
            </span>
          )}
        </div>

        {conflict && (
          <Alert tone="warning" title={`${conflict.name} saved this entry${conflict.at ? ` ${timeAgo(conflict.at)}` : ""}`}
            actions={<><Button size="sm" variant="secondary" onClick={() => void loadTheirs()}>Load their version</Button><Button size="sm" variant="ghost" onClick={() => void save(true)}>Keep mine</Button></>}>
            Your changes aren&apos;t saved. Load their version (yours are dropped), or keep yours and replace theirs.
          </Alert>
        )}
        {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

        {loading ? (
          <div className="flex min-h-[40vh] items-center justify-center" aria-busy="true"><Spinner size={20} label="Loading the entry" /></div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
            <section aria-label="Entry" className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor={`${uid}-title`} className="md-visually-hidden">Title</label>
                <Textarea
                  ref={titleRef}
                  id={`${uid}-title`}
                  rows={1}
                  value={draft.title}
                  readOnly={readOnly}
                  maxLength={LIMITS.title + 20}
                  placeholder="What shipped? (Dark mode, Faster exports…)"
                  onChange={(e) => set("title", e.target.value.replace(/\n/g, " "))}
                  onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                  invalid={!!shown("title")}
                  className="ph-sensitive ph-mask !min-h-0 resize-none !border-transparent !bg-transparent !px-0 !text-[30px] !font-bold !leading-[38px] tracking-[-0.02em] !shadow-none focus-visible:!outline-none"
                  aria-describedby={shown("title") ? `${uid}-title-e` : undefined}
                />
                {shown("title") && <p id={`${uid}-title-e`} className="text-[12px] text-danger">{shown("title")}</p>}
              </div>
              <Field
                label="Summary"
                htmlFor={`${uid}-sum`}
                error={shown("summary")}
                hint={<span className="flex justify-between gap-3"><span>One line: the release cards, RSS and link previews show it.</span><span className="tabular-nums">{draft.summary.length}/{LIMITS.summary}</span></span>}
              >
                <Input id={`${uid}-sum`} value={draft.summary} readOnly={readOnly} maxLength={LIMITS.summary + 20} placeholder="Northwind now follows your system's light or dark setting." onChange={(e) => set("summary", e.target.value)} className="ph-sensitive ph-mask" />
              </Field>
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-semibold text-text">Details <span className="font-normal text-text-muted">(optional)</span></span>
                  <span className="text-[12px] text-text-muted">The entry&apos;s own page and “Read more”. Type <Kbd>/</Kbd> for blocks.</span>
                </div>
                <div className="min-h-[280px] rounded-xl border border-border bg-surface px-3 py-3 sm:px-5">
                  <DocsEditor
                    key={entry?.id ?? "new"}
                    className="ph-no-capture dxe-root--guides"
                    aria-label="Details of this entry"
                    value={draft.body}
                    onChange={(md) => set("body", md)}
                    showHeader={false}
                    showModeSwitch
                    onUploadImage={canEdit ? onUploadImage : undefined}
                    resolveAssetUrl={resolveAssetUrl}
                    readOnly={readOnly}
                    placeholder="What changed, why it matters and how to use it. Type / for callouts, steps, images, code…"
                    flagImages
                  />
                </div>
                {shown("body") && <p className="text-[12px] text-danger">{shown("body")}</p>}
              </div>
            </section>

            <aside aria-label="About this entry" className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-[124px]">
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Date" htmlFor={`${uid}-date`} error={shown("date")}>
                    <Input id={`${uid}-date`} type="date" value={draft.date} readOnly={readOnly} min="2000-01-01" max="2100-12-31" onChange={(e) => set("date", e.target.value)} />
                  </Field>
                  <Field label="Area" htmlFor={`${uid}-area`} error={shown("area")}>
                    <Input id={`${uid}-area`} value={draft.area} readOnly={readOnly} maxLength={LIMITS.area + 10} placeholder="General" list={`${uid}-areas`} onChange={(e) => set("area", e.target.value)} className="ph-sensitive ph-mask" />
                  </Field>
                  <datalist id={`${uid}-areas`}>{areas.map((a) => <option key={a} value={a} />)}</datalist>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span id={`${uid}-kind`} className="text-[13px] font-semibold text-text">Kind</span>
                  <SegmentedControl<ChangeKind>
                    aria-labelledby={`${uid}-kind`}
                    size="sm"
                    block
                    disabled={readOnly}
                    value={draft.kind}
                    onChange={(k) => set("kind", k)}
                    options={(["new", "improved", "fixed"] as const).map((k) => ({ value: k, label: KIND_LABEL[k], icon: KIND_ICON[k] }))}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-[13px] font-semibold text-text">Products and versions</span>
                  {products.length === 0 ? (
                    <p className="text-[12px] text-text-muted">One product? Skip this. Several (web, mobile, API)? Name them in <strong>Changelog settings</strong>, then say which one changed and the version it needs.</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {products.map((p) => {
                        const on = draft.products.includes(p.id);
                        return (
                          <li key={p.id} className="flex items-center gap-2">
                            <Checkbox
                              className={cx("min-w-0 flex-1 rounded-md px-2 py-1", on && "bg-accent-soft")}
                              checked={on}
                              disabled={readOnly}
                              onChange={() => set("products", on ? draft.products.filter((x) => x !== p.id) : [...draft.products, p.id])}
                              label={<span className="ph-sensitive ph-mask truncate">{p.label}</span>}
                            />
                            <Input aria-label={`${p.label} version`} size="sm" mono value={draft.versions[p.id] ?? ""} placeholder="Version" disabled={!on || readOnly}
                              onChange={(e) => set("versions", { ...draft.versions, [p.id]: e.target.value })} wrapClassName="w-[110px] shrink-0" />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {shown("versions") && <p className="text-[12px] text-danger">{shown("versions")}</p>}
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-[13px] font-semibold text-text">Highlights <span className="font-normal text-text-muted">(optional)</span></span>
                  {draft.highlights.map((h, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Icon name="check" size={14} className="shrink-0 text-success" />
                      <Input aria-label={`Highlight ${i + 1}`} size="sm" value={h} readOnly={readOnly} maxLength={LIMITS.highlight + 10} placeholder="Follows the system by default"
                        onChange={(e) => set("highlights", draft.highlights.map((x, k) => (k === i ? e.target.value : x)))} className="ph-sensitive ph-mask" wrapClassName="min-w-0 flex-1" />
                      {canEdit && <IconButton icon="x" label={`Remove highlight ${i + 1}`} size="sm" onClick={() => set("highlights", draft.highlights.filter((_, k) => k !== i))} />}
                    </div>
                  ))}
                  {shown("highlights") && <p className="text-[12px] text-danger">{shown("highlights")}</p>}
                  {canEdit && draft.highlights.length < LIMITS.highlights && (
                    <div><Button variant="ghost" size="sm" iconLeft="plus" onClick={() => set("highlights", [...draft.highlights, ""])}>Add a highlight</Button></div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
                <span className="text-[13px] font-semibold text-text">Image or video <span className="font-normal text-text-muted">(optional)</span></span>
                {draft.image || draft.video ? (
                  <div className="flex flex-col gap-2">
                    <div className="ph-no-capture overflow-hidden rounded-lg border border-border bg-surface-inset">
                      {draft.video ? (
                        <video src={resolveAssetUrl(draft.video)} poster={draft.image ? resolveAssetUrl(draft.image) : undefined} controls muted playsInline preload="metadata" className="block max-h-[180px] w-full object-contain" aria-label="The entry's video" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={resolveAssetUrl(draft.image)} alt="" className="block max-h-[180px] w-full object-contain" />
                      )}
                    </div>
                    {draft.video && draft.image && <p className="text-[12px] text-text-muted">The image is the video&apos;s poster.</p>}
                    <Field label="Description" htmlFor={`${uid}-alt`} error={shown("alt")} hint="For readers who can't see it.">
                      <Input id={`${uid}-alt`} size="sm" value={draft.alt} readOnly={readOnly} maxLength={LIMITS.alt + 10} placeholder="The Appearance settings in dark mode" onChange={(e) => set("alt", e.target.value)} className="ph-sensitive ph-mask" />
                    </Field>
                    {canEdit && (
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary" size="sm" iconLeft="image" onClick={() => setPicker("image")}>{draft.image ? "Change image" : "Add a poster"}</Button>
                        <Button variant="secondary" size="sm" iconLeft="film" onClick={() => setPicker("video")}>{draft.video ? "Change video" : "Add a video"}</Button>
                        <Button variant="ghost" size="sm" iconLeft="trash" onClick={() => setDraft((d) => ({ ...d, image: "", video: "", alt: "" }))}>Remove</Button>
                      </div>
                    )}
                  </div>
                ) : canEdit ? (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" iconLeft="image" onClick={() => setPicker("image")}>Add an image</Button>
                    <Button variant="secondary" size="sm" iconLeft="film" onClick={() => setPicker("video")}>Add a video</Button>
                  </div>
                ) : <p className="text-[12px] text-text-muted">None. Readers see a generated cover.</p>}
                {!draft.image && !draft.video && <p className="text-[12px] text-text-muted">Without one, the entry gets a cover drawn from its kind and products.</p>}
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
                <span className="text-[13px] font-semibold text-text">Links <span className="font-normal text-text-muted">(optional)</span></span>
                <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
                  <Field label="Try it button" htmlFor={`${uid}-tl`} error={shown("tryLabel")}>
                    <Input id={`${uid}-tl`} size="sm" value={draft.tryLabel} readOnly={readOnly} maxLength={LIMITS.tryLabel + 10} placeholder="Try it" onChange={(e) => set("tryLabel", e.target.value)} className="ph-sensitive ph-mask" />
                  </Field>
                  <Field label="Opens" htmlFor={`${uid}-th`} error={shown("tryHref")}>
                    <Input id={`${uid}-th`} size="sm" value={draft.tryHref} readOnly={readOnly} placeholder="/quickstart or https://…" onChange={(e) => set("tryHref", e.target.value)} className="ph-sensitive ph-mask" />
                  </Field>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-semibold text-text-secondary">Related pages</span>
                  {draft.docs.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {draft.docs.map((id) => {
                        const p = pageById.get(id);
                        return (
                          <li key={id} className="flex items-center gap-2 rounded-md bg-surface-inset px-2 py-1 text-[13px]">
                            <Icon name="doc" size={13} className="shrink-0 text-text-muted" />
                            <span className="ph-sensitive ph-mask min-w-0 flex-1 truncate">{p ? p.title : "A deleted page"}</span>
                            {canEdit && <IconButton icon="x" label={`Remove ${p?.title ?? "this page"}`} size="sm" onClick={() => set("docs", draft.docs.filter((x) => x !== id))} />}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {canEdit && <div><Button variant="ghost" size="sm" iconLeft="plus" onClick={() => setPagesOpen(true)}>{draft.docs.length ? "Change pages" : "Add pages"}</Button></div>}
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
                <Field label="Address" htmlFor={`${uid}-slug`} error={shown("slug")} hint={isNew && !draft.slug ? "Made from the title when you create it." : live ? "Changing it breaks links people saved." : undefined}>
                  <Input id={`${uid}-slug`} size="sm" mono textPrefix="/changelog/" value={draft.slug} readOnly={readOnly} maxLength={LIMITS.slug}
                    placeholder={slugFromTitle(draft.title) || "dark-mode"} onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} className="ph-sensitive ph-mask" />
                </Field>
                {live && entry && (
                  <div className="flex items-center gap-1.5 text-[12px] text-text-muted">
                    <a href={permalink} target="_blank" rel="noopener noreferrer" className="ph-sensitive ph-mask min-w-0 flex-1 truncate font-mono text-accent-text no-underline hover:underline">
                      {host}/changelog/{entry.slug}<span className="md-visually-hidden"> (opens in a new tab)</span>
                    </a>
                    <CopyButton text={permalink} label="Copy link" iconOnly size="sm" announceText="Link copied" />
                  </div>
                )}
                {!isNew && entry && <p className="text-[12px] text-text-muted">{longDate(entry.date)} · {status === "published" ? "Readers see this version." : status === "changed" ? "Readers see the version from the last publish." : "Readers see it after you publish."}</p>}
              </div>
            </aside>
          </div>
        )}
      </main>

      <MediaPicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        siteId={site.id}
        kind={picker ?? "image"}
        onPick={(url) => setDraft((d) => (/\.(mp4|webm)$/i.test(url) ? { ...d, video: url } : { ...d, image: url }))}
      />
      <PagesPicker open={pagesOpen} onClose={() => setPagesOpen(false)} pages={pages} value={draft.docs} onChange={(ids) => set("docs", ids)} />
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete this entry?"
        description={status === "new" ? "It was never published, so readers never saw it." : "Readers keep seeing it until the next publish, then it's gone from the changelog and its feeds."}
        confirmLabel="Delete entry"
        onConfirm={async () => {
          if (!entry) return;
          await deleteEntry(site.id, entry.id);
          setDeleting(false);
          setSaved(JSON.stringify(draft));
          refreshSoon();
          toast.success("Entry deleted.");
          onDeleted(entry.id);
        }}
      />
    </>
  );
}

export default EntryEditor;
