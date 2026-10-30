"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, ImmersiveExit, MarkdropLoader, Progress, Spinner, cx, type MenuEntry } from "@/components/ui";
import { SiteHeader } from "@/components/shell/SiteHeader";
import { TenantFooter, TenantHeader, useTenant } from "@/components/tenant";
import { PublishedPanel, type PublishedAccess } from "@/components/kit/PublishedPanel";
import AccessGate from "@/components/access/AccessGate";
import ShareDialog from "@/components/access/ShareDialog";
import { artifactFileRenderer } from "@/components/ArtifactBadge";
import { useQueryFlags } from "@/lib/useQueryFlags";
import { useTheme } from "@/lib/theme";
import { useAuth } from "@/contexts/AuthContext";
import { getAccess, removePerson } from "@/lib/access";
import { purgeDocument } from "@/lib/workspaces";
import { signInUrlFor } from "@/lib/hosts";

/** The path part of this page's URL, for the tenant sign-in return trip (/login 404s there). */
function tenantPathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}
import {
  ApiError,
  changeSlug,
  deleteDocument,
  getDocument,
  recordEvent,
  replaceArtifactFile,
  updateArtifactSettings,
  type ArtifactRenderer,
  liveSocketUrl,
} from "@/lib/api";
import { ArtifactBar } from "./artifact/ArtifactBar";
import { ArtifactSettingsDrawer, type ArtifactSettingsState } from "./artifact/ArtifactSettingsDrawer";
import { ArtifactVersions } from "./artifact/ArtifactVersions";
import { FrameCover } from "./artifact/FrameCover";
import { ReportDialog } from "./artifact/ReportDialog";
import { basePathOf, isPaper, linkPrefixOf, themedFrameSrc } from "./artifact/frame";
import { useAnalyticsDoc } from "@/lib/useAnalyticsDoc";
import { engageKindFor, engagementOptedOut, useArtifactEngagement, useAuthSettled } from "@/lib/engage";

/**
 * Viewer for kind="artifact" documents.
 *
 * The file itself renders inside an iframe pointed at the artifact origin — a
 * different registrable site from markdrop.in. That's what stops user-authored
 * HTML from reading the session token out of localStorage. `allow-same-origin`
 * looks alarming but is correct here: it means same-origin with the *artifact*
 * host, not with us, so the viewers can fetch their own bytes while remaining
 * unable to touch anything of ours.
 */
const SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

/** sessionStorage flag /upload leaves when the workspace share after publishing failed. */
const WS_FAIL_KEY = (slug: string) => `md_ws_share_failed:${slug}`;

interface Props {
  slug: string;
  title: string | null;
  url: string;
  createdAt: string;
  views?: number;
  isPasswordProtected?: boolean;
  mime: string;
  renderer: ArtifactRenderer;
  typeLabel: string;
  sizeBytes: number;
  originalFilename: string | null;
  artifactUrl: string | null;
  downloadUrl: string | null;
  /** A video's poster frame (API `poster_url`), shown by the player before it plays. */
  posterUrl?: string | null;
  /** Opaque analytics reference (API `ref`); never the slug. */
  docRef?: string | null;
  /**
   * Viewer chrome policy, set only when this is being served from a workspace's
   * own domain — the API refuses to apply it anywhere else. "none" hides the
   * control that leaves immersive mode, which is what turns this page into a
   * plain CDN response rather than something wearing a viewer UI.
   */
  viewerChrome?: "full" | "minimal" | "none";
  /** The document's `read_ticket` (beacons + live socket, access policy §2.7). */
  readTicket?: string | null;
  /** The live file version (API `file_version`), sent as `ver` with the analytics beacons. */
  fileVersion?: number | null;
}

const EMPTY_SETTINGS: ArtifactSettingsState = {
  title: "",
  slug: "",
  password: "",
  removePassword: false,
  expiry: "",
  customExpiresAt: null,
  file: null,
};

export default function ArtifactView({
  slug,
  title: initialTitle,
  url,
  createdAt,
  views: initialViews,
  isPasswordProtected = false,
  mime,
  renderer: initialRenderer,
  typeLabel: initialTypeLabel,
  sizeBytes: initialSize,
  originalFilename,
  artifactUrl: initialArtifactUrl,
  downloadUrl: initialDownloadUrl,
  posterUrl: initialPosterUrl = null,
  docRef = null,
  viewerChrome = "full",
  readTicket: initialReadTicket = null,
  fileVersion: initialFileVersion = null,
}: Props) {
  useAnalyticsDoc({ ref: docRef, kind: "artifact", access: isPasswordProtected ? "protected" : "public" });
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  // Workspace domain: its own header/footer and a neutral loader, never Markdrop chrome.
  const tenant = useTenant();
  // undefined on the server and during hydration; the iframe waits for it (see frameSrc).
  const { resolved } = useTheme();
  // Not useSearchParams: on a prerendered route that would stop this whole view
  // being server-rendered at all. See lib/useQueryFlags.
  const { has: hasFlag } = useQueryFlags();
  const isNew = hasFlag("new");

  const [title, setTitle] = useState(initialTitle);
  const [artifactUrl, setArtifactUrl] = useState(initialArtifactUrl);
  const artifactUrlRef = useRef(initialArtifactUrl);
  const [downloadUrl, setDownloadUrl] = useState(initialDownloadUrl);
  const [posterUrl, setPosterUrl] = useState(initialPosterUrl);
  const [renderer, setRenderer] = useState(initialRenderer);
  const [typeLabel, setTypeLabel] = useState(initialTypeLabel);
  const [sizeBytes, setSizeBytes] = useState(initialSize);
  const [views, setViews] = useState(initialViews);
  const [isOwner, setIsOwner] = useState(false);
  // The signed-in user the ownership check has answered for; engagement waits for it (never the owner).
  const [ownerCheckedFor, setOwnerCheckedFor] = useState<string | null>(null);
  const [fileVersion, setFileVersion] = useState<number | null>(initialFileVersion);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // `can.replace` from the server (Q6): editors and workspace members on a non-private file may
  // swap the bytes, but only the owner reaches the rest of the settings.
  const [canReplace, setCanReplace] = useState(false);
  // `can.edit`: the title, for an editor in the Replace file drawer. `can.share`: the owner, or
  // someone added to it while the owner lets people share it on.
  const [canEditTitle, setCanEditTitle] = useState(false);
  const [canShare, setCanShare] = useState(false);
  // The viewer's own grant on the file, when they were added to it: offers "Remove me".
  const [ownGrantEmail, setOwnGrantEmail] = useState<string | null>(null);
  // Bumped after a replace, so the Versions list shows the new version.
  const [versionsKey, setVersionsKey] = useState(0);
  const [docId, setDocId] = useState<string | null>(null);
  // Immersive mode: the artifact fills the viewport with all app chrome hidden,
  // so a published page reads as the content itself rather than something in a
  // box. Escape exits, and body scroll is locked while it's open.
  // Initial state, not an effect: everyone lands immersive anyway, and flipping
  // it after the first commit mounts the framed iframe for one render — long
  // enough to start a fetch that is then thrown away when it unmounts. Derived
  // purely from props, so the server and client agree on the first paint.
  const [immersive, setImmersive] = useState(!!initialArtifactUrl);
  const [downloading, setDownloading] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  // Owner settings drawer (file-only for a non-owner who may replace the file)
  const [showEdit, setShowEdit] = useState(false);
  const [edit, setEdit] = useState<ArtifactSettingsState>(EMPTY_SETTINGS);
  const [eProgress, setEProgress] = useState(0);
  const [eBusy, setEBusy] = useState(false);
  const [eError, setEError] = useState("");
  const [protectedNow, setProtectedNow] = useState(isPasswordProtected);

  function openEdit() {
    setEdit({ ...EMPTY_SETTINGS, title: title || "", slug });
    setEProgress(0);
    setEError("");
    setShowEdit(true);
  }

  async function saveEdit() {
    if (edit.expiry === "custom" && !edit.customExpiresAt) {
      setEError("Pick a date and time for the expiry, or choose another option.");
      return;
    }
    if (edit.slug && edit.slug.length < 3) return;
    if (!isOwner && edit.file && /\.zip$/i.test(edit.file.name)) {
      setEError("Only the owner can replace this with a zipped site. Choose a single file instead.");
      return;
    }
    setEBusy(true);
    setEError("");
    try {
      // File first: if it fails there's no point renaming anything.
      if (edit.file) {
        const doc = await replaceArtifactFile(slug, edit.file, setEProgress);
        applyDoc(doc);
        setVersionsKey((k) => k + 1);
      }
      if (!isOwner) {
        // An editor may change the title too; the link, password and expiry are the owner's.
        if (canEditTitle && edit.title !== (title || "")) {
          applyDoc(await updateArtifactSettings(slug, { title: edit.title }), { remount: false });
        }
        purgeDocument(slug);
        setShowEdit(false);
        return;
      }
      const changedSettings =
        edit.title !== (title || "") || !!edit.password || edit.removePassword || !!edit.expiry;
      if (changedSettings) {
        const doc = await updateArtifactSettings(slug, {
          title: edit.title,
          readPassword: edit.password || undefined,
          removePassword: edit.removePassword && !edit.password,
          expiresIn: edit.expiry || undefined,
          customExpiresAt: edit.expiry === "custom" ? edit.customExpiresAt ?? undefined : undefined,
        });
        applyDoc(doc);
        setProtectedNow(!!doc.is_password_protected);
      }
      // The cached anonymous render would keep the old title/file for a minute.
      purgeDocument(slug);
      // Slug last — it changes the URL, so everything else must already be saved.
      if (edit.slug && edit.slug !== slug) {
        await changeSlug(slug, edit.slug);
        purgeDocument(edit.slug);
        router.replace(`${basePathOf(url)}${edit.slug}`);
        return;
      }
      setShowEdit(false);
    } catch (err) {
      setEError(
        err instanceof ApiError && err.status === 507 && !isOwner
          ? "The owner's storage is full, so the file can't be replaced right now. Ask them to free up some space."
          : err instanceof Error
            ? err.message
            : "Couldn't save the changes. Try again."
      );
    } finally {
      setEBusy(false);
      setEProgress(0);
    }
  }

  // Password gate
  const [locked, setLocked] = useState(isPasswordProtected && !initialArtifactUrl);
  const [pwdInput, setPwdInput] = useState("");
  const [pwdVisible, setPwdVisible] = useState(false);
  const [pwdError, setPwdError] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  // Owner + abuse actions
  const [showDelete, setShowDelete] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showLeave, setShowLeave] = useState(false);

  // ?new=1: the floating compact PublishedPanel over the immersive landing.
  const [panelOpen, setPanelOpen] = useState(true);
  const [access, setAccess] = useState<PublishedAccess | null>(null);
  const [wsFailed, setWsFailed] = useState(false);

  const beaconSent = useRef(false);
  // Every beacon and the live socket carry the read ticket (§2.7); each read replaces it.
  const [readTicket, setReadTicket] = useState<string | null>(initialReadTicket);

  // Bumped on every live update. The blob URL is stable now, so React would
  // see an unchanged src and leave the iframe alone; keying on this forces it
  // to remount and re-fetch.
  const [reloadKey, setReloadKey] = useState(0);

  // The artifact lives on another origin and everyone lands immersive, so
  // between mount and the frame's load event the whole viewport is whatever the
  // empty iframe paints. Track the load and cover it with the brand loader
  // instead of letting that blank rectangle be the page.
  const [frameLoading, setFrameLoading] = useState(true);
  // A live-update remount shows a thin indeterminate Progress on the frame edge instead of the
  // full cover: the reader already has the page, and a cover would flash it away.
  const [liveReload, setLiveReload] = useState(false);

  // The frame is mounted only after hydration. Now that this view is genuinely
  // server-rendered, an iframe in the HTML makes the browser begin the fetch and
  // then React begin it again as it adopts the element — two downloads of the
  // same artifact, milliseconds apart. Rendering the cover on the server and the
  // frame on the client keeps it to one, and costs nothing visually: the loader
  // is in the first paint either way.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  function applyDoc(
    doc: Awaited<ReturnType<typeof getDocument>>,
    { remount = true }: { remount?: boolean } = {}
  ) {
    setTitle(doc.title);
    if (doc.read_ticket) setReadTicket(doc.read_ticket);
    // A URL arriving late (password unlock, the owner's authorised re-read) goes immersive in the
    // same render, so the framed iframe never mounts just to be thrown away (one fetch, not two).
    if (doc.artifact_url && !artifactUrlRef.current) setImmersive(true);
    artifactUrlRef.current = doc.artifact_url ?? null;
    setArtifactUrl(doc.artifact_url ?? null);
    // Only force a remount when the bytes may actually have changed. The owner
    // check runs on every mount and would otherwise throw away a frame that is
    // already loading, restarting the fetch and the loader with it.
    if (remount) setReloadKey((k) => k + 1);
    setDownloadUrl(doc.download_url ?? null);
    setPosterUrl(doc.poster_url ?? null);
    if (doc.renderer) setRenderer(doc.renderer);
    if (doc.type_label) setTypeLabel(doc.type_label);
    if (doc.size_bytes) setSizeBytes(doc.size_bytes);
    setViews(doc.views);
    if (typeof doc.file_version === "number") setFileVersion(doc.file_version);
    setLocked(false);
  }

  // Count the view from the browser so the real visitor IP drives geo, matching
  // how markdown documents are counted.
  // After auth has settled (or 1.5 s), so it carries the session token (the owner's own view isn't counted).
  const authSettled = useAuthSettled(authLoading);
  useEffect(() => {
    if (beaconSent.current || locked || !authSettled) return;
    beaconSent.current = true;
    recordEvent(slug, "view", readTicket, { ver: fileVersion, optOut: engagementOptedOut() });
  }, [slug, locked, authSettled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates. The socket carries only a "changed" ping, so we refetch
  // through the normal authorized read path. Failures are no-ops.
  useEffect(() => {
    if (typeof window === "undefined" || locked) return;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function connect() {
      try {
        ws = new WebSocket(liveSocketUrl(slug, readTicket));
      } catch {
        return;
      }
      ws.onmessage = (ev) => {
        let msg: { type?: string } | null = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        // Deleted, expired or renamed away: let the page answer (404 or redirect).
        if (msg?.type === "gone") { window.location.reload(); return; }
        // Narrowed: re-read (fresh ticket, reconnect) or, if refused now, show the gate.
        const narrowed = msg?.type === "access";
        if (msg?.type !== "changed" && !narrowed) return;
        const cachedPwd = isPasswordProtected
          ? sessionStorage.getItem(`pwd:${slug}`) || undefined
          : undefined;
        getDocument(slug, cachedPwd)
          .then((doc) => {
            setLiveReload(true);
            applyDoc(doc);
          })
          .catch(() => { if (narrowed) window.location.reload(); });
      };
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 3000); };
    }
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [slug, locked, isPasswordProtected, readTicket]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cached password from a previous unlock in this tab.
  useEffect(() => {
    if (!isPasswordProtected || !locked) return;
    const cached = sessionStorage.getItem(`pwd:${slug}`);
    if (!cached) return;
    getDocument(slug, cached)
      .then(applyDoc)
      .catch(() => sessionStorage.removeItem(`pwd:${slug}`));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Owner detection — reveals settings and delete, and refreshes the signed URL
  // for a protected artifact the owner is allowed to see without the password.
  useEffect(() => {
    if (!user) {
      setIsOwner(false);
      setCanReplace(false);
      setCanEditTitle(false);
      setCanShare(false);
      setOwnGrantEmail(null);
      return;
    }
    let cancelled = false;
    const uid = user.id;
    getDocument(slug)
      .then((doc) => {
        if (cancelled) return;
        setOwnerCheckedFor(uid);
        setIsOwner(!!doc.is_owner);
        setCanReplace(!!doc.can?.replace);
        setCanEditTitle(!!doc.can?.edit);
        setCanShare(!!doc.is_owner || !!doc.can?.share);
        setDocId(doc.id ?? null);
        if (doc.is_owner && doc.artifact_url) applyDoc(doc, { remount: false });
        // Added to someone else's file? Then they may take themselves off it ("Remove me"). Not on
        // a workspace's own domain, whose session can only read.
        if (!doc.is_owner && !tenant) {
          getAccess(slug)
            .then((s) => {
              if (cancelled) return;
              const me = s.your_email?.toLowerCase() ?? null;
              // your_grant is the role your own email grant gives (null when your access comes from
              // a workspace or the link), so even a viewer, who can't see the grant list, knows.
              const added = !!me && !!s.your_grant;
              setOwnGrantEmail(added ? me : null);
            })
            .catch(() => { if (!cancelled) setOwnGrantEmail(null); });
        } else {
          setOwnGrantEmail(null);
        }
      })
      .catch(() => { if (!cancelled) setOwnerCheckedFor(uid); });
    return () => {
      cancelled = true;
    };
  }, [user, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?new=1: say who can actually open it (the panel's copy is per access level), and pick up a
  // workspace-share failure /upload left behind. Unknown access reads as "link", the default.
  useEffect(() => {
    if (!isNew) return;
    try {
      if (sessionStorage.getItem(WS_FAIL_KEY(slug))) {
        setWsFailed(true);
        sessionStorage.removeItem(WS_FAIL_KEY(slug));
      }
    } catch {}
    let cancelled = false;
    getAccess(slug)
      .then((s) => {
        if (cancelled) return;
        setAccess(
          s.level === "private" ? "private"
            : s.level === "workspace" ? "workspace"
            : s.is_password_protected ? "password"
            : "link"
        );
      })
      .catch(() => { if (!cancelled) setAccess(protectedNow ? "password" : "link"); });
    return () => { cancelled = true; };
  }, [isNew, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everyone lands full-bleed: a published artifact should read as the page
  // itself, not as something sitting in a Markdrop box. The framed view — with
  // the title, counts, owner settings and the Report control — is one Esc away
  // and stays reachable by anyone, which is what keeps abuse reporting possible.
  //
  // This deliberately doesn't wait on the ownership check: ownership isn't
  // knowable at SSR (the server render is always anonymous), so waiting would
  // mean a visible flash of the framed view before going immersive.
  // Still needed for the artifact URL that only arrives later — after a password
  // unlock, or the owner's authorised re-read. Keyed on the URL, so an explicit
  // Esc is not undone by a live update that returns the same one.
  useEffect(() => {
    if (artifactUrl && !locked) setImmersive(true);
  }, [artifactUrl, locked]);

  // A new source means a new load, so the cover goes back up. The timeout is a
  // floor under the worst case: if `load` never fires — a viewer that stalls on
  // a subresource, a blocked fetch — revealing a half-painted artifact beats
  // holding the brand screen over it forever.
  useEffect(() => {
    if (!artifactUrl || locked) return;
    setFrameLoading(true);
    const t = setTimeout(() => {
      setFrameLoading(false);
      setLiveReload(false);
    }, 15000);
    return () => clearTimeout(t);
  }, [artifactUrl, reloadKey, locked, immersive]);

  function exitImmersive() {
    setImmersive(false);
    setPanelOpen(false);
    setLiveReload(false);
    // Land keyboard users at the top of the framed view rather than on <body>.
    requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    if (!immersive) return;
    // An open overlay (Dropdown, Dialog) claims Escape first and marks it handled.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) exitImmersive();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [immersive]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleUnlock(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!pwdInput.trim()) return;
    setUnlocking(true);
    setPwdError("");
    try {
      const doc = await getDocument(slug, pwdInput);
      sessionStorage.setItem(`pwd:${slug}`, pwdInput);
      applyDoc(doc);
    } catch (err) {
      setPwdError(
        err instanceof Error && err.message === "WRONG_PASSWORD"
          ? "That password isn't right. Check it and try again."
          : "Something went wrong. Try again."
      );
    } finally {
      setUnlocking(false);
    }
  }

  async function handleDownload() {
    // download_url, not artifact_url: the latter is a viewer *page* for PDFs,
    // sheets and docs, so downloading it would save the HTML wrapper.
    const src = downloadUrl || artifactUrl;
    if (!src) return;
    if (tenant) {
      // On a workspace's own domain the artifact origin's CORS doesn't list
      // this origin, so the fetch below would fail (after downloading the whole
      // body) and fall back to opening the artifact origin. A Content-Disposition
      // link instead: the Worker answers `?dl=1` as an attachment, so the
      // browser saves the file without leaving the page.
      const u = new URL(downloadUrl || src);
      u.searchParams.set("dl", "1");
      u.searchParams.set("fn", originalFilename || slug);
      const a = document.createElement("a");
      a.href = u.toString();
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    setDownloading(true);
    try {
      // Fetched as a blob rather than linked. The download attribute is ignored
      // cross-origin, so an <a href> here would navigate to the artifact origin —
      // and a top-level visit there trips Chrome's lookalike-domain interstitial.
      const res = await fetch(src);
      if (!res.ok) throw new Error();
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = originalFilename || slug;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch {
      // Last resort: open it rather than silently doing nothing.
      window.open(src, "_blank", "noopener");
    } finally {
      setDownloading(false);
    }
  }

  async function handleDelete() {
    await deleteDocument(slug);
    // The cached anonymous render would keep serving the deleted file for a minute.
    purgeDocument(slug);
    setShowDelete(false);
    router.push("/dashboard");
  }

  async function handleLeave() {
    if (!ownGrantEmail) return;
    await removePerson(slug, ownGrantEmail);
    setShowLeave(false);
    // Back to where shared files are listed; it no longer shows there.
    router.push("/shared");
  }

  // A restored version is a new current file: re-read the document so the page shows it.
  async function handleRestored() {
    purgeDocument(slug);
    try {
      const cachedPwd = isPasswordProtected ? sessionStorage.getItem(`pwd:${slug}`) || undefined : undefined;
      applyDoc(await getDocument(slug, cachedPwd));
    } catch {
      /* the live socket's "changed" ping re-reads it too */
    }
  }

  // Creator analytics (lib/engage.ts): the viewer frame's page / playback events, or time alone.
  let frameOrigin: string | null = null;
  try {
    frameOrigin = artifactUrl ? new URL(artifactUrl).origin : null;
  } catch {
    /* not a URL: no bridge */
  }
  useArtifactEngagement(slug, {
    enabled: !locked && !!artifactUrl && !authLoading && (!user || ownerCheckedFor === user.id) && !isOwner,
    kind: engageKindFor(renderer),
    ver: fileVersion,
    ticket: readTicket,
    frame: frameRef,
    origin: frameOrigin,
  });

  const fileRenderer = artifactFileRenderer(renderer);
  const paper = isPaper(renderer);
  const loadingLabel = `Loading ${typeLabel}…`;
  // Theme on Worker viewer pages (`/v/…`), via the URL API so a signed `?t=` survives. Waits for
  // hydration *and* the resolved theme, so the iframe mounts once with its final src.
  const frameSrc =
    hydrated && resolved && artifactUrl ? themedFrameSrc(artifactUrl, resolved, posterUrl) : null;
  const showCover = frameLoading && !liveReload;
  const showLiveProgress = frameLoading && liveReload;
  const canOpen = !!artifactUrl && !locked;

  const frame = frameSrc && (
    <iframe
      key={reloadKey}
      ref={frameRef}
      src={frameSrc}
      sandbox={SANDBOX}
      // No referrer: the artifact origin never needs to know which page framed it.
      referrerPolicy="no-referrer"
      title={title || originalFilename || slug}
      onLoad={() => {
        setFrameLoading(false);
        setLiveReload(false);
      }}
      // User HTML is written for white: paper + color-scheme light in both themes. Worker viewers
      // follow the app theme they were given.
      style={{ colorScheme: paper ? "light" : resolved }}
      className={cx("block h-full w-full border-0", paper ? "bg-(--qr-ground)" : "bg-bg")}
    />
  );

  const liveProgress = showLiveProgress && (
    <Progress indeterminate size="sm" aria-label="Updating to the latest version" className="absolute inset-x-0 top-0 z-20" />
  );

  const cover = (
    <FrameCover
      show={showCover}
      label={loadingLabel}
      renderer={fileRenderer}
      name={originalFilename ?? ""}
      mime={mime}
      tenant={!!tenant}
    />
  );

  const menu: MenuEntry[] = [];
  if (canShare && !locked) {
    menu.push({ label: "Share", icon: "share", onClick: () => setShowShare(true) });
  }
  if (isOwner) {
    menu.push({ label: "Settings", icon: "settings", onClick: openEdit });
  }
  if (!isOwner && canReplace && !locked) {
    menu.push({ label: "Replace file", icon: "upload", onClick: openEdit });
  }
  if (!isOwner && !locked) {
    menu.push({ label: "Report", icon: "flag", onClick: () => setShowReport(true) });
  }
  if (isOwner) {
    menu.push({ label: "Delete artifact", icon: "trash", danger: true, separated: true, onClick: () => setShowDelete(true) });
  }
  if (!isOwner && ownGrantEmail) {
    menu.push({ label: "Remove me", icon: "x", danger: true, separated: true, onClick: () => setShowLeave(true) });
  }

  const showPanel = isNew && panelOpen && immersive && !!artifactUrl && !locked && access !== null;

  return (
    <>
      {/* The framed view. Inert under the immersive layer so Tab can't wander behind it. */}
      <div className="flex min-h-dvh w-full min-w-0 flex-col" inert={immersive || undefined}>
        {tenant ? <TenantHeader /> : <SiteHeader />}
        <main
          id="main"
          ref={mainRef}
          tabIndex={-1}
          className="mx-auto flex w-full min-w-0 max-w-tool flex-1 flex-col gap-3 px-4 pt-4 pb-24 outline-none sm:px-6 sm:pb-6"
        >
          <ArtifactBar
            slug={slug}
            title={title}
            originalFilename={originalFilename}
            mime={mime}
            renderer={renderer}
            fileRenderer={fileRenderer}
            typeLabel={typeLabel}
            sizeBytes={sizeBytes}
            views={views}
            createdAt={createdAt}
            url={url}
            canOpen={canOpen}
            downloading={downloading}
            onDownload={handleDownload}
            onExpand={() => setImmersive(true)}
            menu={menu}
          />

          {locked ? (
            <AccessGate
              mode="password"
              signInHref={tenant ? signInUrlFor(tenant.host, tenantPathOf(url)) : "/login"}
              value={pwdInput}
              onValue={setPwdInput}
              onSubmit={handleUnlock}
              submitting={unlocking}
              error={pwdError}
              visible={pwdVisible}
              onToggleVisible={() => setPwdVisible((v) => !v)}
            />
          ) : artifactUrl ? (
            /* Not rendered while immersive, even though it would be hidden behind
               the overlay. Two mounted iframes mean the artifact is fetched twice
               for every viewer, and the framed one's load event would clear the
               cover over the immersive one that is still blank. */
            <div
              className={cx(
                "relative isolate h-[calc(100dvh-14rem)] min-h-90 overflow-hidden rounded-xl border border-border sm:h-[calc(100dvh-9.5rem)]",
                paper ? "bg-(--qr-ground)" : "bg-surface-inset",
              )}
            >
              {!immersive && frame}
              {!immersive && liveProgress}
              {cover}
            </div>
          ) : (
            <div className="flex min-h-90 items-center justify-center rounded-xl border border-border">
              {tenant ? (
                <div role="status" className="flex items-center gap-3 text-body text-text-secondary">
                  <Spinner size={20} />
                  <span>Preparing this file…</span>
                </div>
              ) : (
                <MarkdropLoader label="Preparing this artifact…" />
              )}
            </div>
          )}
        </main>
        {tenant && <TenantFooter />}
      </div>

      {immersive && artifactUrl && (
        <div className={cx("fixed inset-0 z-(--z-immersive) isolate", paper ? "bg-(--qr-ground)" : "bg-bg")}>
          {frame}
          {liveProgress}
          {cover}
          {/* Withheld only from anonymous viewers, and only on a domain whose
              owner asked for it. A signed-in visitor keeps the way out, so the
              owner can still reach Report, settings and the framed view. */}
          {!(viewerChrome === "none" && !user) && (
            <ImmersiveExit
              onExit={exitImmersive}
              placement={renderer === "video" ? "top-right" : "bottom-right"}
            />
          )}
        </div>
      )}

      {showPanel && (
        <PublishedPanel
          compact
          url={url}
          shareUrl={url}
          access={access ?? "link"}
          encrypted={false}
          signedIn={!!user}
          isOwner={isOwner}
          workspaceShareFailed={wsFailed}
          onShowDetails={exitImmersive}
          onDismiss={() => setPanelOpen(false)}
        />
      )}

      {(isOwner || canReplace) && (
        <ArtifactSettingsDrawer
          fileOnly={!isOwner}
          titleEditable={canEditTitle}
          savedTitle={title || ""}
          versions={
            // A zipped site keeps no versions; a workspace's own domain session can't reach them.
            renderer !== "bundle" && !tenant ? (
              <ArtifactVersions
                slug={slug}
                canDelete={isOwner}
                disabled={eBusy}
                refreshKey={versionsKey}
                onRestored={handleRestored}
              />
            ) : undefined
          }
          open={showEdit}
          onClose={() => !eBusy && setShowEdit(false)}
          value={edit}
          onChange={setEdit}
          currentSlug={slug}
          linkPrefix={linkPrefixOf(url)}
          protectedNow={protectedNow}
          originalFilename={originalFilename}
          mime={mime}
          fileRenderer={fileRenderer}
          sizeBytes={sizeBytes}
          busy={eBusy}
          progress={eProgress}
          error={eError}
          onSave={saveEdit}
          onDelete={() => {
            setShowEdit(false);
            setShowDelete(true);
          }}
        />
      )}

      <ConfirmDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={handleDelete}
        title="Delete this artifact?"
        body="The file and its link are removed for good, and the space comes back to your storage. This can't be undone."
        confirmLabel="Delete artifact"
      />

      <ConfirmDialog
        open={showLeave}
        onClose={() => setShowLeave(false)}
        onConfirm={handleLeave}
        title="Remove yourself from this file?"
        body="It leaves your Shared with me list. If it's open to anyone with the link you can still open it that way; otherwise you'll need to be added again."
        confirmLabel="Remove me"
      />

      <ReportDialog open={showReport} onClose={() => setShowReport(false)} slug={slug} />

      {showShare && (
        <ShareDialog
          slug={slug}
          title={title || originalFilename || slug}
          kind="artifact"
          documentId={docId}
          onClose={() => setShowShare(false)}
          onChanged={() => purgeDocument(slug)}
        />
      )}
    </>
  );
}
