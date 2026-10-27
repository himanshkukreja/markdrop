"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FileIcon,
  Icon,
  Input,
  Meter,
  Progress,
  Tabs,
  Textarea,
  cx,
} from "@/components/ui";
import { DropZone } from "@/components/kit/DropZone";
import { BrowserFrame } from "@/components/kit/BrowserFrame";
import { PublishSettings } from "@/components/kit/PublishSettings";
import {
  DEFAULT_PUBLISH_SETTINGS,
  PHONE_QUERY,
  toApiExpiry,
  useMediaQuery,
  type PublishField,
  type PublishSettingsValue,
  type PublishWorkspace,
} from "@/components/kit/publish-utils";
import { formatBytes } from "@/components/ArtifactBadge";
import { slugifyFilename, titleFromFilename } from "@/lib/slugify";
import ArtifactPreview, { previewIsPaper } from "./ArtifactPreview";
import { consumePending, savePending } from "./pendingUpload";
import { useAuth } from "@/contexts/AuthContext";
import {
  getArtifactStatus,
  pasteHtmlArtifact,
  uploadArtifact,
  type ArtifactStatus,
  type ExpiresIn,
} from "@/lib/api";
import { useWorkspaceTargets } from "@/lib/useWorkspaceTargets";
import { shareToWorkspace } from "@/lib/workspaces";
import { track } from "@/lib/track";

type Tab = "paste" | "upload";

/**
 * D5: the Paste HTML tab stays hidden (the paste endpoint 500s until F5 ships, and stays hidden
 * after). The paste path is kept only so a draft saved with it before sign-in still publishes.
 */
const PASTE_TAB = false;

const ACCEPT =
  ".html,.htm,.pdf,.docx,.csv,.xlsx,.xls,.json,.txt,.zip,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.mov,.webm,.ogv,.mp3,.m4a,.wav,.ogg";
const SLUG_PATTERN = /^[a-zA-Z0-9_-]*$/;
const VIDEO_EXT = ["mp4", "mov", "webm", "ogv"];
const AUDIO_EXT = ["mp3", "m4a", "wav", "ogg"];

/** sessionStorage flag the artifact viewer reads on ?new=1 (workspace share failed). */
const WS_FAIL_KEY = (slug: string) => `md_ws_share_failed:${slug}`;

/** What the dropzone promises, in the order of the board. Names drive the FileIcon tint. */
const KINDS = [
  { label: "HTML", note: "Live web page", name: "page.html", mime: "text/html" },
  { label: "PDF", note: "Readable pages", name: "a.pdf", mime: "application/pdf" },
  { label: "Excel, CSV", note: "Sheet with tabs", name: "a.xlsx", mime: "" },
  { label: "Word", note: "Formatted document", name: "a.docx", mime: "" },
  { label: "Images", note: "Full-size view", name: "a.png", mime: "image/png" },
  { label: "Video", note: "Plays in place", name: "a.mp4", mime: "video/mp4" },
  { label: "Zipped site", note: "Multi-page site", name: "a.zip", mime: "application/zip" },
];

/** How a chosen file will be presented, so the file row can say so up front. */
function describeFile(f: File): string {
  const ext = f.name.toLowerCase().split(".").pop() || "";
  if (["html", "htm"].includes(ext)) return "a web page";
  if (ext === "pdf") return "a readable PDF";
  if (["xlsx", "xls", "csv"].includes(ext)) return "a spreadsheet";
  if (ext === "docx") return "a document";
  if (ext === "zip") return "a multi-page site";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "an image";
  if (VIDEO_EXT.includes(ext)) return "a playable video";
  if (AUDIO_EXT.includes(ext)) return "playable audio";
  return "";
}

// Video and audio share the larger media ceiling (max_video_bytes).
const isVideo = (f: File) =>
  [...VIDEO_EXT, ...AUDIO_EXT].includes(f.name.toLowerCase().split(".").pop() || "");
const isZip = (f: File | null) => !!f && f.name.toLowerCase().endsWith(".zip");

function expiresFromApi(expiresIn: string, at?: string | null): PublishSettingsValue["expires"] {
  if (expiresIn === "custom" && at) return { at };
  return expiresIn === "1d" || expiresIn === "7d" || expiresIn === "30d" ? expiresIn : "never";
}

export default function UploadArtifactPage() {
  const router = useRouter();
  const { user, loading: authLoading, openAuthModal } = useAuth();

  const [tab, setTab] = useState<Tab>("upload");
  const [status, setStatus] = useState<ArtifactStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [statusTry, setStatusTry] = useState(0);
  const [html, setHtml] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [settings, setSettings] = useState<PublishSettingsValue>(DEFAULT_PUBLISH_SETTINGS);
  const [slugError, setSlugError] = useState("");
  const [fileError, setFileError] = useState("");
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<{ tone: "danger" | "warning"; title?: string; text: string } | null>(null);
  const pickInput = useRef<HTMLInputElement>(null);
  // Phones get the compact upload tile (MobileCreate 4: one big tap target), not the resting fan.
  const isPhone = useMediaQuery(PHONE_QUERY);

  const ws = useWorkspaceTargets(settings.target);
  const workspaces: PublishWorkspace[] = ws.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    host: w.primary_host ?? null,
    folders: w.id === settings.target.workspaceId ? ws.folders.map((f) => ({ id: f.id, name: f.name, path: f.path })) : undefined,
  }));

  useEffect(() => {
    let cancelled = false;
    setStatusError(false);
    getArtifactStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatusError(true); });
    return () => { cancelled = true; };
  }, [user, statusTry]);

  // Restore a draft left behind by the sign-in prompt. consumePending() deletes
  // as it reads and ignores anything stale, so this fires at most once and a
  // later visit to /upload is always a clean form.
  const restoreTried = useRef(false);
  useEffect(() => {
    if (authLoading || !user || restoreTried.current) return;
    restoreTried.current = true;
    consumePending().then((d) => {
      if (!d) return;
      setTab(d.tab);
      setHtml(d.html);
      setFile(d.file);
      setTitle(d.title);
      setSettings((s) => ({
        ...s,
        slug: d.customSlug,
        password: d.readPassword || null,
        expires: expiresFromApi(d.expiresIn, d.customExpiresAt),
        access: d.accessLevel ?? s.access,
        target: d.target ?? s.target,
      }));
      // Anything they typed is theirs — don't let the filename prefill stomp it.
      setTitleTouched(true);
      setSlugTouched(true);
      setRestored(true);
    });
  }, [authLoading, user]);

  function pickFile(f: File | null) {
    if (!f) return;
    // Video has its own ceiling; gating every type on the document limit would
    // refuse a recording the server would have accepted.
    const cap = (isVideo(f) && status?.max_video_bytes) || status?.max_file_bytes || 0;
    if (status && cap && f.size > cap) {
      setFileError(`That file is ${formatBytes(f.size)} — the limit is ${formatBytes(cap)}.`);
      return;
    }
    setFileError("");
    setError(null);
    setFile(f);
    // Prefill from the filename so the published link reads like the file
    // instead of a random slug — but never overwrite something typed by hand.
    if (!titleTouched) setTitle(titleFromFilename(f.name));
    if (!slugTouched) {
      const derived = slugifyFilename(f.name);
      // Under 3 chars the server would reject it; leave it blank and let the
      // server pick instead of showing an error on a field they never touched.
      setSettings((s) => ({ ...s, slug: derived.length >= 3 ? derived : "" }));
      setSlugError("");
    }
  }

  function onSettings(next: PublishSettingsValue, field: PublishField) {
    if (field === "slug") {
      if (!SLUG_PATTERN.test(next.slug)) return;
      setSlugTouched(true);
      setSlugError(next.slug && next.slug.length < 3 ? "Use at least 3 characters." : "");
    }
    setSettings(next);
  }

  async function publish() {
    const { expiresIn, customExpiresAt } = toApiExpiry(settings.expires);
    const accessLevel = settings.access;
    const target = settings.target;
    if (!user) {
      // Google's flow navigates away and back, so hold everything they've
      // entered. Saved only here — pressing Publish is the one moment we know
      // the draft is worth keeping.
      await savePending({
        tab, html, file, title, customSlug: settings.slug,
        expiresIn, readPassword: settings.password ?? "",
        customExpiresAt: customExpiresAt ?? null, accessLevel, target,
      });
      openAuthModal({
        title: "Sign in to publish an artifact",
        message:
          "Artifacts are stored against your account so you can manage and delete them, and so we can keep quotas fair. Sign in or create a free account to continue.",
        next: "/upload",
      });
      return;
    }
    if (settings.slug && settings.slug.length < 3) return setSlugError("Use at least 3 characters.");

    setBusy(true);
    setError(null);
    setSlugError("");
    setProgress(0);
    const opts = {
      customSlug: settings.slug || undefined,
      expiresIn: expiresIn as ExpiresIn,
      customExpiresAt,
      readPassword: settings.password || undefined,
      accessLevel,
    };
    try {
      const doc =
        tab === "paste"
          ? await pasteHtmlArtifact(html, title, opts)
          : await uploadArtifact(file!, title, { ...opts, onProgress: setProgress });
      sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret);
      track("artifact_uploaded", { source: tab, access: accessLevel, workspace: !!target.workspaceId });
      // Share as a second step — see the same note in /new. The artifact is
      // already published; a sharing failure must not read as an upload failure,
      // so it rides to the viewer on a flag and shows in the published panel.
      if (target.workspaceId && doc.id) {
        try {
          await shareToWorkspace(target.workspaceId, doc.id, target.folderId);
        } catch {
          try { sessionStorage.setItem(WS_FAIL_KEY(doc.slug), "1"); } catch {}
        }
      }
      router.push(`/${doc.slug}?new=1`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setBusy(false);
      setProgress(0);
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setError({ tone: "warning", title: "You're offline", text: "Your file and settings are still here. Publish again when you're back online." });
      } else if (/This URL is (already taken|reserved)/i.test(msg)) {
        setSlugError(/reserved/i.test(msg) ? "That link is reserved. Choose another." : "That link is taken. Choose another.");
      } else if (/rate limit|too many/i.test(msg)) {
        setError({ tone: "warning", title: "Too many uploads in a short time", text: "Wait a minute, then publish again. Everything you picked is still here." });
      } else {
        setError({ tone: "danger", text: msg || "Something went wrong. Try again." });
      }
    }
  }

  const canPublish = tab === "paste" ? html.trim().length > 0 : !!file;
  const limits = status
    ? `Up to ${formatBytes(status.max_file_bytes)}` +
      (status.max_video_bytes ? ` · ${formatBytes(status.max_video_bytes)} for video and audio` : "")
    : null;
  const uploading = busy && tab === "upload" && progress < 100;
  const linkUrl = { host: "markdrop.in", slug: settings.slug || "your-link" };

  if (status && !status.configured) {
    return (
      <div className="mx-auto flex w-full max-w-app flex-1 items-center justify-center py-16">
        <EmptyState
          icon="upload"
          title="Artifacts aren't enabled yet"
          description="Artifact hosting is still being set up on this server. Markdown publishing works as normal in the meantime."
          actions={<Button href="/new" variant="primary" iconRight="arrowRight">Publish markdown instead</Button>}
        />
      </div>
    );
  }

  const fileRow = file && (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface p-3 sm:flex-row sm:items-center sm:gap-3 sm:p-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-lg border border-border bg-surface-inset">
          <FileIcon name={file.name} mime={file.type} size={24} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 dir="auto" className="m-0 min-w-0 truncate text-h4 text-text">{file.name}</h2>
            {busy ? (
              <Badge tone="info" size="sm" dot className="shrink-0">{uploading ? "Uploading" : "Publishing"}</Badge>
            ) : (
              <Badge tone="success" size="sm" icon="check" className="shrink-0">Ready</Badge>
            )}
          </div>
          <span className="text-caption text-text-muted">
            {formatBytes(file.size)}
            {describeFile(file) && ` · Will render as ${describeFile(file)}`}
          </span>
        </div>
      </div>
      {!busy && (
        <div className="-ml-2 flex shrink-0 items-center gap-1 sm:ml-0">
          <Button variant="ghost" size="sm" iconLeft="upload" className="max-sm:min-h-11" onClick={() => pickInput.current?.click()}>
            Choose another
          </Button>
          <Button variant="ghost" size="sm" iconLeft="trash" className="max-sm:min-h-11" onClick={() => setFile(null)}>
            Remove
          </Button>
        </div>
      )}
    </div>
  );

  const paper = previewIsPaper(tab === "paste" ? null : file, tab === "paste" ? html : undefined);
  const preview = (
    <section aria-labelledby="upload-preview" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="upload-preview" className="m-0 text-h4 text-text">Preview</h2>
        <span className="text-caption text-text-muted">
          {busy ? "This is what readers will see at the link" : "Rendered here in your browser — nothing uploaded yet"}
        </span>
      </div>
      <BrowserFrame
        url={linkUrl}
        urlIcon="globe"
        title={title.trim() || undefined}
        actions={<Badge size="sm" variant="outline">Not published</Badge>}
        paper={paper}
        bodyClassName="h-80 sm:h-[26rem]"
        aria-label="Preview of the page"
      >
        {tab === "paste" ? <ArtifactPreview html={html} bare /> : <ArtifactPreview file={file} bare />}
      </BrowserFrame>
      {paper && (
        <p className="m-0 flex items-start gap-1.5 text-caption text-text-muted">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          <span>Previewed in a sandboxed frame. Scripts in your page run with no access to Markdrop or your account.</span>
        </p>
      )}
    </section>
  );

  const emptyPreview = (
    <BrowserFrame url={linkUrl} urlIcon="globe" actions={<span className="text-caption text-text-muted">Preview</span>} bodyClassName="h-56 sm:h-64" aria-label="Where your file will render">
      <div className="grid h-full place-items-center p-4">
        <EmptyState icon="eye" title="Your file renders here" description="See it the way readers will, before anything uploads." />
      </div>
    </BrowserFrame>
  );

  const action = (
    <div
      className={cx(
        "flex flex-col gap-3",
        // Phones: one sticky dock at the bottom, above the home indicator (MobileCreate 4–5).
        "fixed inset-x-0 bottom-0 z-(--z-sticky) border-t border-border bg-surface px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]",
        "lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:p-0",
      )}
    >
      {busy && tab === "upload" && file && (
        <div aria-live="polite" className="flex flex-col gap-1">
          {uploading ? (
            <Progress
              value={progress}
              showValue
              label={`Uploading ${file.name}`}
              valueText={`${progress}%`}
            />
          ) : (
            <Progress
              indeterminate
              tone="success"
              label={isZip(file) ? "Unpacking site…" : "Publishing…"}
            />
          )}
          {uploading && (
            <span className="text-caption tabular-nums text-text-muted">
              {formatBytes((file.size * progress) / 100)} of {formatBytes(file.size)}. Keep this tab open until it finishes.
            </span>
          )}
        </div>
      )}
      <Button
        variant="primary"
        size="lg"
        block
        onClick={publish}
        loading={busy}
        disabled={!busy && !canPublish}
        aria-disabled={busy || undefined}
        iconRight={busy ? undefined : "arrowRight"}
      >
        {busy ? (uploading ? "Uploading…" : "Publishing…") : user || authLoading ? "Publish" : "Sign in and publish"}
      </Button>
      <p className="m-0 flex items-start gap-1.5 text-caption text-text-muted">
        <Icon name="shield" size={14} className="mt-0.5 shrink-0" />
        <span>
          {canPublish ? "" : "Choose a file to publish. "}Rendered on a separate domain, so a published page can never reach your account.
        </span>
      </p>
    </div>
  );

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 pb-40 lg:pb-10">
      <input
        ref={pickInput}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          pickFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />

      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pt-2 sm:pt-6">
        <div className="flex min-w-0 max-w-2xl flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-eyebrow uppercase text-text-muted">Artifacts</span>
            <Badge tone="warning" size="sm" upper>New</Badge>
          </div>
          <h1 className="m-0 text-h1 text-text">Publish a file, get a page</h1>
          <p className="m-0 text-body-lg text-text-secondary">
            Drop in an HTML page, PDF, spreadsheet, Word doc, video or zipped site. You get one link that{" "}
            <strong className="font-semibold text-text">renders</strong> it, instead of downloading it.
          </p>
        </div>
        <Button href="/new" variant="ghost" iconLeft="lines" className="hidden sm:inline-flex">
          Write markdown instead
        </Button>
      </header>

      {!authLoading && !user && (
        <Alert tone="info" title="Artifacts need a free account">
          Fill everything in — it&apos;ll still be here after you sign in.
        </Alert>
      )}

      {restored && (
        <Alert tone="success" live onDismiss={() => setRestored(false)}>
          Signed in — everything you had is still here. Publish when you&apos;re ready.
        </Alert>
      )}

      {statusError && (
        <Alert
          tone="danger"
          title="Couldn't reach Markdrop"
          actions={<Button variant="secondary" size="sm" iconLeft="refresh" onClick={() => setStatusTry((n) => n + 1)}>Try again</Button>}
        >
          File limits and your storage didn&apos;t load. Check your connection and try again.
        </Alert>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-8">
        {/* Left: the file and its preview. */}
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            {PASTE_TAB ? (
              <Tabs
                variant="pill"
                size="sm"
                aria-label="How to add your page"
                value={tab}
                onChange={(v) => setTab(v as Tab)}
                items={[
                  { value: "upload", label: "Upload a file", icon: "upload" },
                  { value: "paste", label: "Paste HTML", icon: "code" },
                ]}
              />
            ) : (
              <span className="text-body-strong text-text">{tab === "paste" ? "Your page" : "Your file"}</span>
            )}
            {limits && <span className="text-caption text-text-muted">{limits}</span>}
          </div>

          {tab === "paste" ? (
            <>
              <Field label="HTML" hint={`${formatBytes(new Blob([html]).size)} · Rendered on a separate domain when published.`}>
                <Textarea
                  mono
                  rows={12}
                  value={html}
                  onChange={(e) => setHtml(e.target.value)}
                  spellCheck={false}
                  disabled={busy}
                  placeholder={"<!doctype html>\n<html>\n  <body>\n    <h1>Hello</h1>\n  </body>\n</html>"}
                />
              </Field>
              {html.trim() && preview}
            </>
          ) : file ? (
            <>
              {fileRow}
              {preview}
            </>
          ) : (
            <>
              <DropZone
                onFiles={(files) => pickFile(files[0] ?? null)}
                accept={ACCEPT}
                multiple={false}
                art={isPhone ? "tile" : "fan"}
                title="Drag a file here, or click to browse"
                dragTitle="Drop to add it"
                caption="One file per page. A zipped site opens at its index.html."
                chooseLabel="Choose a file"
                disabled={busy}
                className="min-h-50 sm:min-h-60"
              />
              {fileError && (
                <p role="alert" className="m-0 flex items-center gap-1.5 text-caption text-danger">
                  <Icon name="alert" size={14} />
                  {fileError}
                </p>
              )}
              <section aria-labelledby="upload-kinds" className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h2 id="upload-kinds" className="m-0 text-eyebrow uppercase text-text-muted">What you can publish</h2>
                  <span className="text-caption text-text-muted">Each one renders in the browser, not as a download</span>
                </div>
                <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4 xl:grid-cols-7">
                  {KINDS.map((k) => (
                    <li key={k.label} className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface p-3">
                      <FileIcon name={k.name} mime={k.mime} size={18} />
                      <span className="text-body-strong text-text">{k.label}</span>
                      <span className="text-caption text-text-muted">{k.note}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <div className="hidden lg:block">{emptyPreview}</div>
            </>
          )}
          {file && fileError && (
            <p role="alert" className="m-0 flex items-center gap-1.5 text-caption text-danger">
              <Icon name="alert" size={14} />
              {fileError}
            </p>
          )}
        </div>

        {/* Right: the publish card. Sticky on desktop. */}
        <div className="min-w-0 lg:col-span-5">
          <Card
            className="lg:sticky lg:top-20"
            title="Publish"
            description={file || html.trim() ? "Settings for this link. Readers see the title in the tab." : "Fill these in now or after you pick a file."}
          >
            <div className="flex flex-col gap-5">
              <Field label="Title" hint="Shown in the browser tab and in link previews.">
                <Input
                  value={title}
                  onChange={(e) => { setTitleTouched(true); setTitle(e.target.value); }}
                  placeholder="Taken from the file name"
                  maxLength={200}
                  dir="auto"
                  disabled={busy}
                />
              </Field>

              <PublishSettings
                layout="rows"
                eyebrow={null}
                kind="page"
                value={settings}
                onChange={onSettings}
                signedIn={!!user}
                workspaces={workspaces}
                fields={["slug", "target", "access", "password", "expires"]}
                hostPrefix="markdrop.in/"
                errors={slugError ? { slug: slugError } : undefined}
                disabled={busy}
              />

              {user && status && status.quota_bytes > 0 && (
                <Meter
                  label="Storage"
                  value={status.used_bytes}
                  max={status.quota_bytes}
                  threshold={0.9}
                  meta={`${formatBytes(status.used_bytes)} of ${formatBytes(status.quota_bytes)} used`}
                  valueText={`${formatBytes(status.used_bytes)} of ${formatBytes(status.quota_bytes)} storage used`}
                />
              )}

              {error && (
                <Alert tone={error.tone} title={error.title}>
                  {error.text}
                </Alert>
              )}

              {action}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
