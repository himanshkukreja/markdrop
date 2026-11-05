"use client";

/**
 * Every piece of DocumentView's state, effect and handler, moved here verbatim
 * (R12 split) so the screens in this folder only render. Nothing in this file
 * draws anything. Guardrails: design/REVAMP_BUILD.md §5.0, and the inventory
 * in the S1 report — each effect below carries the comment that explains it.
 */

import { useCallback, useEffect, useLayoutEffect, useState, useRef } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { useQueryFlags } from "@/lib/useQueryFlags";
import * as e2e from "@/lib/e2e";
import { ApiError, createDocument, updateDocument, updateDocumentSettings, getDocument, claimDocument, recordEvent, reportDocument, getGoogleDocsStatus, connectGoogleDocs, exportToGoogleDocs, copyDocument, liveSocketUrl, type DeniedInfo } from "@/lib/api";
import { MAX_CHARS } from "@/lib/limits";
import { HANDOFF_FRAGMENT, HANDOFF_NONE_FRAGMENT } from "@/lib/hosts";
import { isPrimaryHost } from "@/components/tenant/hosts";
import {
  consumeHandoffToken,
  forgetSessionToken,
  peekHandoffToken,
  startSilentHandoff,
  usableSessionToken,
} from "@/components/tenant/handoff";
import { useAuth } from "@/contexts/AuthContext";
import { track } from "@/lib/track";
import { useReadDepth } from "@/lib/readDepth";
import { engagementOptedOut, useAuthSettled, useDocEngagement } from "@/lib/engage";
import { getAccess, type AccessState } from "@/lib/access";
import { shortcutsEnabled } from "@/lib/shortcuts";
import { usePresenceChannel } from "@/lib/presence";
import { announce } from "@/lib/navBus";
import { readPageProps } from "@/components/pages/pageProps";
import { pageFieldsOf, type DocumentViewProps, type PageFields } from "./types";
import { preloadView, viewKindOf } from "./preload";
import { OPENING_ATTR, type OpeningKind } from "@/lib/opening";

// Before paint on the client (the server has no layout; React 19 doesn't warn about it there).
const useBeforePaint = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export type ViewMode = "write" | "split" | "preview";
/**
 * "unsupported": this browser has no WebCrypto (old, or plain http) — not the same as a wrong key.
 * "password": the document also needs its password, asked for here and checked only in this browser.
 */
export type DecryptState = "plain" | "working" | "ok" | "nokey" | "failed" | "unsupported" | "password";
/** Where the key that opened the document came from. */
export type KeySource = "link" | "device" | "pasted";

export function useDocumentViewer({
  slug,
  title: initialTitle,
  content: initialContent,
  url,
  createdAt: initialCreatedAt,
  expiresAt: initialExpiresAt,
  views: initialViews,
  editSecret: initialSecret,
  isPasswordProtected = false,
  signInUrl = null,
  syncedWithVscode = false,
  encrypted: encryptedProp = false,
  readTicket: initialReadTicket = null,
  rev: initialRev = null,
  gate = null,
  page: initialPage = null,
}: DocumentViewProps) {
  const router = useRouter();
  // A page (block editor): breadcrumbs, sub-pages, page images. Every read refreshes it.
  const [page, setPage] = useState<PageFields | null>(initialPage);
  // The live socket's messages, for the page editor while it's open (it follows `appended` and
  // `changed` itself; the reader below ignores them while editing).
  const liveListeners = useRef(new Set<(msg: Record<string, unknown>) => void>());
  const subscribeLive = useCallback((fn: (msg: Record<string, unknown>) => void) => {
    liveListeners.current.add(fn);
    return () => { liveListeners.current.delete(fn); };
  }, []);
  // Encrypted, as far as anyone knows yet. The server render can't tell for a gated document (its
  // read is refused), so a client read that turns up an envelope switches this on (adoptDoc).
  const [encrypted, setEncrypted] = useState(encryptedProp);
  // The same, for callbacks created before the switch (adoptDoc runs from several effects).
  const encryptedRef = useRef(encryptedProp);
  // Sign-in has to come back to the exact address the reader was refused at —
  // on a workspace's own domain that is not `/${slug}`.
  const pathname = usePathname();

  // Where "Sign in" goes. Supplied by the route when the reader is on a
  // workspace's own domain, because that host rewrites *every* path to the
  // document route and has no `/login` — a relative link would 404 at the exact
  // moment they were trying to identify themselves.
  //
  // Decided by the server, not sniffed from `window` after mount: the anchor is
  // then right in the HTML itself, rather than briefly wrong and corrected once
  // hydration runs.
  const signInHref =
    signInUrl || `/login?next=${encodeURIComponent(pathname || `/${slug}`)}`;
  // Not useSearchParams: on a prerendered route that would stop this whole view
  // being server-rendered at all. See lib/useQueryFlags.
  const { ready: flagsReady, has: hasFlag } = useQueryFlags();
  const isNew = hasFlag("new");
  const startInEdit = hasFlag("edit");
  const startCopy = hasFlag("copy");
  const startGoogleSync = hasFlag("gsync");
  const { user, loading: authLoading, openAuthModal, refresh: refreshAuth } = useAuth();

  // Claim-to-account state
  const [claimSecret, setClaimSecret] = useState<string | null>(initialSecret || null);
  const [claimed, setClaimed] = useState(false);
  const [claimMsg, setClaimMsg] = useState("");
  // Whether some account owns the document, from the reads made here. The server render's
  // `isOwned` can't say for a document behind a password (that read is refused), so without this
  // a signed-in owner holding the edit secret was asked to save their own document to their account.
  const [docOwned, setDocOwned] = useState(false);
  const viewBeaconSent = useRef(false);
  const editOpened = useRef(false);
  // The document's read ticket (§2.7): every beacon and the live socket carry it, or the API
  // ignores them for anything an anonymous visitor couldn't read. Each read replaces it.
  const [readTicket, setReadTicket] = useState<string | null>(initialReadTicket);
  // Who's viewing (lib/presence): the signed-in reader's presence ticket, from any read made here
  // with their session. Dropped when they sign out, so the socket says hello as anonymous again.
  const [presenceTicket, setPresenceTicket] = useState<string | null>(null);
  const presence = usePresenceChannel(user ? presenceTicket : null);

  // Google Docs sync state — populated once we confirm the viewer owns this doc
  const [isOwner, setIsOwner] = useState(false);
  // What the signed-in read said this reader may do (`can`, §7). On a workspace's own domain it is
  // the only source (the sharing state lives on markdrop.in), and it is what unlocks the editor there.
  const [docCan, setDocCan] = useState<import("@/lib/access").DocCan | null>(null);
  // The signed-in user the ownership check below has answered for. Engagement waits for it, so the
  // owner never sends a beacon in the moment before we know it's them.
  const [ownerCheckedFor, setOwnerCheckedFor] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [gConnected, setGConnected] = useState(false);
  const [googleDocUrl, setGoogleDocUrl] = useState<string | null>(null);
  const [googleDocStale, setGoogleDocStale] = useState(false);
  const [gBusy, setGBusy] = useState(false);
  const [gError, setGError] = useState<string | null>(null);
  const [gNeedsReconnect, setGNeedsReconnect] = useState(false);

  // "Save a copy" (import someone else's doc into your account) state
  const [showCopy, setShowCopy] = useState(false);
  const [copyBusy, setCopyBusy] = useState<null | "plain" | "google">(null);
  const [copyError, setCopyError] = useState("");

  // Abuse report state
  const [showShare, setShowShare] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportDone, setReportDone] = useState(false);

  // Report dialog (REVAMP_PLAN 7.6): a category, prefixed into the same free-text
  // `reason` the API already takes, so nothing changes server-side.
  const [reportCategory, setReportCategory] = useState("");
  const [reportError, setReportError] = useState("");
  async function submitReport() {
    setReportBusy(true);
    setReportError("");
    try {
      const reason = [reportCategory, reportReason.trim()].filter(Boolean).join(": ");
      await reportDocument(slug, reason || undefined);
      setReportDone(true);
    } catch {
      setReportError("The report didn't send. Try again.");
    } finally {
      setReportBusy(false);
    }
  }

  // Source the edit secret from sessionStorage (set by the publish flow) rather
  // than the URL — so it never leaks via history/referrer/server logs. Seeds the
  // editor unlock and, for password-protected docs, bypasses the read-password gate.
  useEffect(() => {
    if (claimSecret || typeof window === "undefined") return;
    const stored = sessionStorage.getItem(`secret:${slug}`);
    if (!stored) return;
    setClaimSecret(stored);
    setSecretInput(stored);
    setSecretUnlocked(true);
    if (isPasswordProtected) {
      getDocument(slug, undefined, stored)
        .then((doc) => {
          adoptDoc(doc);
          setPwdLocked(false);
        })
        .catch(() => {})
        .finally(() => setPwdFetching(false));
    }
  }, [slug, claimSecret, isPasswordProtected]);

  async function handleClaim() {
    if (!claimSecret) return;
    setClaimMsg("");
    try {
      await claimDocument(slug, claimSecret);
      setClaimed(true);
      setClaimMsg("Saved to your account.");
    } catch (e) {
      setClaimMsg(e instanceof Error ? e.message : "Could not claim");
    }
  }

  async function handleGoogleExport() {
    if (!docId) return;
    setGBusy(true);
    setGError(null);
    setGNeedsReconnect(false);
    try {
      const result = await exportToGoogleDocs(docId);
      track("google_docs_export", { from: "document" });
      setGoogleDocUrl(result.google_doc_url);
      setGoogleDocStale(false);
    } catch (err) {
      if (err instanceof Error && err.name === "ReconnectRequired") {
        setGNeedsReconnect(true);
        setGError(err.message);
      } else {
        setGError(err instanceof Error ? err.message : "Export to Google Docs failed");
      }
    } finally {
      setGBusy(false);
    }
  }

  function requestCopy() {
    if (!user) {
      // Google sign-in leaves the page and comes back on `next`, without the fragment.
      e2e.stashPendingKey();
      // Not signed in: open the shared sign-in modal right here (no page nav).
      // Email sign-in resumes the copy in-place; Google redirects and resumes
      // on return via ?copy=1.
      openAuthModal({
        title: "Sign in to save a copy",
        message:
          "Saving a copy adds this document to your Markdrop account so you can edit it, track views, and sync it to Google Docs. Sign in or create a free account to continue.",
        next: `/${slug}?copy=1`,
        onSuccess: () => { setCopyError(""); setShowCopy(true); },
      });
      return;
    }
    setCopyError("");
    setShowCopy(true);
  }

  async function handleCopy(withGoogle: boolean) {
    setCopyBusy(withGoogle ? "google" : "plain");
    setCopyError("");
    try {
      // Pass the unlocked password so the server can read a protected source;
      // the copy itself is always created without a password.
      const cachedPwd = isPasswordProtected
        ? sessionStorage.getItem(`pwd:${slug}`) || undefined
        : undefined;
      const copy = await copyDocument(slug, cachedPwd);

      if (withGoogle && !gConnected) {
        // Not connected yet: start the opt-in Google connect flow, returning to
        // the new (owned) copy with ?gsync=1 so the export fires automatically
        // once connected (no manual "Sync" click needed).
        await connectGoogleDocs(`/${copy.slug}?gsync=1`);
        return;
      }
      if (withGoogle && copy.id) {
        // Best-effort sync; if it fails (e.g. reconnect needed) the copy still
        // exists, so send them to it — the doc page surfaces the sync/reconnect UI.
        try {
          await exportToGoogleDocs(copy.id);
        } catch {
          /* fall through to the redirect below */
        }
      }
      router.push(`/${copy.slug}`);
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : "Could not save a copy");
      setCopyBusy(null);
    }
  }

  // ── Save a copy of an encrypted document (client-side) ──────────────────────
  const [showEncCopy, setShowEncCopy] = useState(false);
  const [encCopyBusy, setEncCopyBusy] = useState<null | "encrypted" | "plain">(null);
  const [encCopyError, setEncCopyError] = useState("");

  /**
   * The server can't copy an encrypted document (it can't read it), so this browser does: the
   * decrypted text it already holds is sealed under a brand-new key — or published as plain text,
   * by choice — and opened with its new link. Like publishing, this browser keeps the new key.
   */
  async function handleEncryptedCopy(plain: boolean) {
    if (!readable) return;
    setEncCopyBusy(plain ? "plain" : "encrypted");
    setEncCopyError("");
    try {
      const title = displayTitle;
      const content = displayContent;
      let body = content;
      let encoded = "";
      if (!plain) {
        const key = e2e.generateKey();
        body = await e2e.seal(key, { title: title || null, content });
        encoded = e2e.exportKey(key);
      }
      const doc = await createDocument(plain ? title || "" : "", body, { encrypted: !plain || undefined });
      try { sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret); } catch { /* storage blocked */ }
      track("doc_copied", { encrypted: !plain, from_encrypted: true });
      if (encoded) e2e.rememberKey(doc.slug, encoded);
      router.push(`/${doc.slug}?new=1${encoded ? `#k=${encoded}` : ""}`);
    } catch (e) {
      setEncCopyError(e instanceof e2e.TooLargeError || e instanceof Error ? e.message : "Couldn't make the copy. Try again.");
      setEncCopyBusy(null);
    }
  }

  // ── "How this is protected" ─────────────────────────────────────────────────
  const [showProtection, setShowProtection] = useState(false);

  // ── Remote images in an encrypted document ──────────────────────────────────
  // An image from another site tells that site the reader's IP address and that the document was
  // opened, so they wait for the reader's click. Remembered per document for this tab only.
  const [remoteImagesOk, setRemoteImagesOk] = useState(false);
  useEffect(() => {
    try { setRemoteImagesOk(sessionStorage.getItem(`md_remote_images:${slug}`) === "1"); } catch { /* storage off */ }
  }, [slug]);
  const allowRemoteImages = useCallback(() => {
    setRemoteImagesOk(true);
    try { sessionStorage.setItem(`md_remote_images:${slug}`, "1"); } catch { /* storage off */ }
  }, [slug]);

  async function handleGoogleReconnect() {
    try {
      await connectGoogleDocs(`/${slug}`);
    } catch (err) {
      setGError(err instanceof Error ? err.message : "Could not start Google reconnect");
    }
  }

  // Set when a password unlock reveals the document is actually an artifact —
  // the anonymous SSR fetch 401s, so kind isn't known until then.
  const [artifactDoc, setArtifactDoc] = useState<import("@/lib/api").DocumentResponse | null>(null);

  /**
   * Adopt a freshly fetched document into view state.
   *
   * Returns true when it was an artifact and has been handed off to
   * ArtifactView. Every path that resolves a document must go through this:
   * an artifact's `content` is only a filename stand-in, so rendering it as
   * markdown shows a title and nothing else.
   */
  function adoptDoc(doc: import("@/lib/api").DocumentResponse, opts?: { created?: boolean }): boolean {
    if (doc.read_ticket) setReadTicket(doc.read_ticket);
    if (doc.presence_ticket) setPresenceTicket(doc.presence_ticket);
    if (doc.is_owned || doc.is_owner) setDocOwned(true);
    // An old slug of a renamed document (the signed-in retry of a gated page): go to the current
    // one, keeping the query and the #k= key. The server render redirects the anonymous case.
    if (doc.moved && doc.slug && doc.slug !== slug) {
      // On a workspace's own domain a document lives at `/<folders…>/<slug>` (B-N5).
      const folders = !isPrimaryHost(window.location.host) && Array.isArray(doc.folder_path)
        ? doc.folder_path.filter((s): s is string => typeof s === "string" && s.length > 0)
        : [];
      const target = [...folders, doc.slug].map(encodeURIComponent).join("/");
      // A key this browser kept for the old address follows the document.
      e2e.moveRememberedKey(slug, doc.slug);
      router.replace(`/${target}${window.location.search}${window.location.hash}`);
      return true;
    }
    if (doc.kind === "artifact") {
      setArtifactDoc(doc);
      setPwdLocked(false);
      return true;
    }
    // The rev that goes with this exact content: a save sends it back as base_rev.
    setDocRev(typeof doc.rev === "number" ? doc.rev : null);
    setPage(pageFieldsOf(doc as unknown as Record<string, unknown>));
    setServerPassword(!!doc.is_password_protected);
    if (doc.encrypted) {
      // A gated document only now turns out to be encrypted: from here on it is
      // handled as one (decryption, editing, analytics off).
      if (!encryptedRef.current) {
        encryptedRef.current = true;
        setEncrypted(true);
        setDisplayTitle(null);
        setDisplayContent("");
        setDecryptState("working");
      }
      // Hand it to the decryption effect instead. `doc.title` is null on the
      // wire for these — the real one is sealed inside the envelope.
      setSealed(doc.content);
    } else {
      setDisplayTitle(doc.title);
      setDisplayContent(doc.content);
    }
    if (opts?.created !== false) setDisplayCreatedAt(doc.created_at);
    setDisplayExpiresAt(doc.expires_at);
    setDisplayViews(doc.views);
    return false;
  }

  // Live display state. For an encrypted document these start empty rather than
  // holding the envelope: nothing should be able to render ciphertext as
  // markdown, not even for one frame before the key arrives.
  const [displayTitle, setDisplayTitle] = useState(encrypted ? null : initialTitle);
  const [displayContent, setDisplayContent] = useState(encrypted ? "" : initialContent);
  const [displayCreatedAt, setDisplayCreatedAt] = useState(initialCreatedAt);
  const [displayExpiresAt, setDisplayExpiresAt] = useState(initialExpiresAt);
  const [displayViews, setDisplayViews] = useState(initialViews);
  const [vscodeSynced, setVscodeSynced] = useState(syncedWithVscode);

  // ── End-to-end decryption ──────────────────────────────────────────────────
  //
  // The envelope arrives over the wire like any other content; the key does not,
  // and never has. It comes out of the URL fragment, which the browser keeps to
  // itself — or out of this browser's own store, or a link the reader pastes
  // (parsed here, never sent). One effect gathers the candidate keys; another
  // opens whatever envelope is currently in hand with them, so a live update
  // from another tab or the editor re-decrypts on its own.
  const [cryptoKey, setCryptoKey] = useState<e2e.DocKey | null>(null);
  const [keyFragment, setKeyFragment] = useState<string | null>(null);
  const [keySource, setKeySource] = useState<KeySource | null>(null);
  // Keys to try, best first: the link's (or a pasted one), then this browser's.
  const [candidates, setCandidates] = useState<{ link: string | null; device: string | null; pasted: boolean } | null>(null);
  // The link's own key didn't open this version, but the one this browser kept did.
  const [linkKeyStale, setLinkKeyStale] = useState(false);
  const [rotated, setRotated] = useState<string | null>(null);
  // The document's own password just changed in this tab ("set" or "removed").
  const [passwordChange, setPasswordChange] = useState<"set" | "removed" | null>(null);
  // Read after mount: localStorage doesn't exist during the server render, and
  // deriving this during render would desync the two.
  const [deviceKeySaved, setDeviceKeySaved] = useState(false);
  const [sealed, setSealed] = useState<string | null>(encrypted ? initialContent : null);
  const [decryptState, setDecryptState] = useState<DecryptState>(encrypted ? "working" : "plain");
  // Why it didn't open (decryptState "failed"): "key", "altered", "malformed".
  const [decryptReason, setDecryptReason] = useState<e2e.DecryptReason | null>(null);
  // Version and mode of the envelope that opened, for "How this is protected".
  const [opened, setOpened] = useState<{ version: 1 | 2; mode: "key" | "password" } | null>(null);
  // The document's password, once typed. Memory only: never stored, never sent.
  const [e2ePassword, setE2EPassword] = useState<string | null>(null);
  const [e2ePwdError, setE2EPwdError] = useState("");
  const [e2ePwdErrorKey, setE2EPwdErrorKey] = useState(0);
  const [e2ePwdChecking, setE2EPwdChecking] = useState(false);
  // The password set on the publish screen a moment ago (this tab, memory only), for "Copy password".
  const [publishedPassword, setPublishedPassword] = useState<string | null>(null);
  // A key stashed for the trip through sign-in, to put back in the address bar
  // once any handoff fragment has been dealt with.
  const [restoreToBar, setRestoreToBar] = useState<string | null>(null);
  // The rev of the content in hand (base_rev on save) and whether the server
  // also checks a (legacy) read password.
  const [docRev, setDocRev] = useState<number | null>(initialRev);
  const [serverPassword, setServerPassword] = useState(isPasswordProtected && gate !== "signin");

  // Once per mounted view: the stash and the handed-over password are single use, and an effect
  // re-run (Strict Mode, or a suspended lazy child re-showing this view) must not lose them.
  const keysGathered = useRef(false);
  useEffect(() => {
    if (!encrypted || keysGathered.current) return;
    keysGathered.current = true;
    if (!e2e.isSupported()) {
      // Not "failed": nothing is wrong with the key or the document, this
      // browser just can't run the decryption (REVAMP_PLAN 7.6 "Unsupported").
      setDecryptState("unsupported");
      return;
    }
    // Just published with a password in this tab: don't ask for what was just typed.
    const handed = e2e.takeHandedOverPassword(slug);
    if (handed) {
      setE2EPassword(handed);
      setPublishedPassword(handed);
    }
    // Back from sign-in: the key waited in this tab's sessionStorage, because
    // /login and the workspace handoff both drop the fragment.
    const pending = e2e.restorePendingKey();
    const inLink = e2e.readKeyFromFragment();
    if (pending && !inLink) setRestoreToBar(pending);
    // The link first, then whatever this browser kept for this document. The
    // second is what makes "I lost the link" survivable at all.
    const link = inLink ?? pending;
    const device = e2e.recallKey(slug);
    if (!link && !device) {
      setDecryptState("nokey");
      return;
    }
    setCandidates({ link, device, pasted: false });
  }, [encrypted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every candidate key, in the order to try: the one already working first.
  const keyOrder = useCallback((): string[] => {
    const out: string[] = [];
    for (const k of [keyFragment, candidates?.link ?? null, candidates?.device ?? null]) {
      if (k && !out.includes(k)) out.push(k);
    }
    return out;
  }, [keyFragment, candidates]);

  useEffect(() => {
    if (!encrypted || !candidates || sealed === null) return;
    let cancelled = false;
    const needsPassword = e2e.requiresPassword(sealed);
    if (needsPassword && !e2ePassword) {
      setDecryptState("password");
      return;
    }
    // Only fall back to the "decrypting" screen when there is nothing on it yet.
    // A live update re-decrypts in place; blanking the page for it would be a
    // flash of nothing every time someone else typed. A password check keeps
    // its own screen up, busy, rather than flashing to "Decrypting…".
    setDecryptState((prev) => (prev === "ok" || prev === "password" ? prev : "working"));
    if (needsPassword) setE2EPwdChecking(true);
    (async () => {
      let last: unknown = null;
      for (const encoded of keyOrder()) {
        let key: e2e.DocKey;
        try {
          key = e2e.importKey(encoded);
        } catch (err) {
          last = err;
          continue;
        }
        try {
          const result = await e2e.unseal(key, sealed, { password: e2ePassword });
          if (cancelled) return;
          const fromLink = encoded === candidates.link;
          setCryptoKey(key);
          setKeyFragment(encoded);
          setKeySource(fromLink ? (candidates.pasted ? "pasted" : "link") : "device");
          setLinkKeyStale(!fromLink && !!candidates.link);
          setDisplayTitle(result.title);
          setDisplayContent(result.content);
          setOpened({ version: result.version, mode: result.mode });
          setDecryptReason(null);
          setE2EPwdError("");
          setE2EPwdChecking(false);
          setDecryptState("ok");
          // Readers keep a key only when they asked to. A key this browser
          // already keeps is brought up to date with the one that works.
          const kept = e2e.recallKey(slug);
          if (kept && kept !== encoded) e2e.rememberKey(slug, encoded);
          setDeviceKeySaved(e2e.hasRememberedKey(slug));
          return;
        } catch (err) {
          last = err;
          // Only a wrong key (or password) is worth trying the next key for.
          if (!(err instanceof e2e.DecryptError) || (err.reason !== "key" && err.reason !== "password")) break;
        }
      }
      if (cancelled) return;
      setE2EPwdChecking(false);
      const reason: e2e.DecryptReason = last instanceof e2e.DecryptError ? last.reason : "malformed";
      if (reason === "unsupported") {
        setDecryptState("unsupported");
        return;
      }
      if (reason === "password" || reason === "password-required") {
        setE2EPassword(null);
        setE2EPwdError(
          decryptState === "ok"
            ? "This document was updated and that password no longer opens it. If the owner changed the password or issued a new key, ask them for the new one."
            : "That password doesn't open it. Check it with whoever shared the link — passwords are case-sensitive."
        );
        setE2EPwdErrorKey((n) => n + 1);
        setDecryptState("password");
        return;
      }
      setDecryptReason(reason);
      setDecryptState("failed");
    })();
    return () => {
      cancelled = true;
    };
  }, [encrypted, candidates, sealed, e2ePassword, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from sign-in with a stashed key: put it back in the address bar, but
  // only after a handoff fragment (#mdt=…) has been taken and stripped.
  useEffect(() => {
    if (!restoreToBar || typeof window === "undefined") return;
    const hash = window.location.hash;
    if (hash && hash !== "#") return; // a handoff is still in the bar; wait for it to go
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#k=${restoreToBar}`);
    setRestoreToBar(null);
  });

  useEffect(() => {
    if (encrypted) setDeviceKeySaved(e2e.hasRememberedKey(slug));
  }, [encrypted, slug, keyFragment, rotated]);

  /** The password prompt (client-side; the server never sees it). */
  function submitE2EPassword(value: string) {
    if (!value) return;
    setE2EPwdError("");
    setE2EPassword(value);
  }

  /**
   * "Have the full link? Paste it here": the key is parsed out locally and put
   * in the address bar with replaceState — no navigation, no request.
   */
  function applyPastedLink(text: string): string | null {
    const key = e2e.keyFromPastedLink(text);
    if (!key) return "That doesn't contain a key. The full link ends in #k= followed by 43 letters and numbers.";
    try {
      const hashAt = text.indexOf("#");
      const before = (hashAt >= 0 ? text.slice(0, hashAt) : "").trim();
      if (before) {
        const u = new URL(/^https?:\/\//i.test(before) ? before : `https://${before}`);
        const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
        if (last && last !== slug) return "That link is for a different document.";
      }
    } catch {
      /* not a URL: a bare key or a fragment, fine */
    }
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#k=${key}`);
    setDecryptReason(null);
    setDecryptState("working");
    setKeyFragment(null);
    setCandidates((c) => ({ link: key, device: c?.device ?? e2e.recallKey(slug), pasted: true }));
    return null;
  }

  // A new link pasted into the address bar for the same page only changes the fragment: the
  // browser doesn't reload, so pick the key up here ("ask them for the new link" has to work).
  useEffect(() => {
    if (!encrypted) return;
    const onHash = () => {
      const key = e2e.readKeyFromFragment();
      if (!key || key === keyFragment) return;
      setDecryptReason(null);
      setKeyFragment(null);
      setCandidates((c) => ({ link: key, device: c?.device ?? e2e.recallKey(slug), pasted: false }));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [encrypted, keyFragment, slug]);

  /** Readers opt in to keeping the key on this device (decision 3). */
  function rememberOnDevice() {
    if (!keyFragment) return;
    e2e.rememberKey(slug, keyFragment);
    setDeviceKeySaved(true);
  }
  function forgetOnDevice() {
    e2e.forgetKey(slug);
    setDeviceKeySaved(false);
  }

  /**
   * Keep the key through a trip to sign in (`/login?next=…`, the workspace
   * handoff, Google). This tab only, single use, never a query string.
   */
  // Not only once the document is known to be encrypted: a gated one (private, or behind the old
  // server password) can't say so until after sign-in. A `#k=` in the address is reason enough;
  // without one, stashPendingKey does nothing.
  const stashKeyForSignIn = useCallback(() => {
    e2e.stashPendingKey();
  }, []);

  // Any sign-in link on this page drops the fragment on its way out: catch the
  // click (capture phase, before navigation) and stash the key first.
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      const a = (ev.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.href || "";
      if (/\/(login|signup|auth)(\/|\?|$)/.test(href) || (signInUrl && href.startsWith(signInUrl.split("?")[0]!))) {
        e2e.stashPendingKey();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [signInUrl]);

  /**
   * Whether the text itself can be changed — settings still can be, without a key.
   *
   * Deliberately requires a *finished* decrypt, not merely a key. Holding the
   * key and having the plaintext are milliseconds apart, and in that window the
   * editor would open on an empty document: same trap as having no key at all,
   * just harder to reproduce.
   */
  const canEditContent = !encrypted || (!!cryptoKey && decryptState === "ok");

  /** The link that actually opens this document — for an encrypted one, key and all. */
  const shareUrl = encrypted && keyFragment ? e2e.withKey(url, keyFragment) : url;
  const readable = !encrypted || decryptState === "ok";

  // View state
  const [showRaw, setShowRaw] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [secretInput, setSecretInput] = useState(initialSecret || "");
  const [secretUnlocked, setSecretUnlocked] = useState(!!initialSecret);
  const [secretError, setSecretError] = useState("");

  // Editor state
  const [editTitle, setEditTitle] = useState(initialTitle || "");
  const [editContent, setEditContent] = useState(initialContent);
  const [viewMode, setViewMode] = useState<ViewMode>("write");
  // Edit options: password + expiry
  const [editRemovePassword, setEditRemovePassword] = useState(false);
  const [editNewPassword, setEditNewPassword] = useState("");
  const [editShowPassword, setEditShowPassword] = useState(false);
  const [editExpiresIn, setEditExpiresIn] = useState<import("@/lib/api").ExpiresIn | "">("");
  const [rotateKey, setRotateKey] = useState(false);
  // Encrypted documents: the password that opens them, set in this browser. null = keep as it is,
  // "" = remove it, anything else = the new password (re-sealed on Save; we can't reset it).
  const [editE2EPassword, setEditE2EPassword] = useState<string | null>(null);
  // A save refused because the document moved on (409): the reader decides what next.
  const [saveConflict, setSaveConflict] = useState(false);
  const [reloadingLatest, setReloadingLatest] = useState(false);
  const [editCustomExpiresAt, setEditCustomExpiresAt] = useState("");

  // Save / delete state
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Password gate state — skip gate immediately if owner has edit secret
  const [pwdLocked, setPwdLocked] = useState(isPasswordProtected && !initialSecret);
  // True from the very first client render when there is something to try, so
  // the reader sees "opening…" rather than a denial that is about to be undone.
  // `false` on the server, which has no storage to look in — that is also the
  // only value the prerendered HTML can honestly carry.
  const [pwdFetching, setPwdFetching] = useState(isPasswordProtected && !!initialSecret);
  // Raised once per mounted view, never again. Every `true` needs a fetch that is going to put it
  // back, and this one's is the signed-in retry below. "On mount" is not "once": when something
  // lazily loaded first renders here (the Published panel on ?new=1, the editor, a dialog) it
  // suspends, React hides this view, and on showing it again re-runs every effect with the state
  // kept. Raising the flag a second time then, with the retry long finished and nothing left to
  // clear it, left a published password document on the loading skeleton for good.
  const fetchHinted = useRef(false);
  // Up from that raise until the signed-in retry has answered: the retry is what opens the item. A
  // ref, not state: the owner check below reads it the moment its own read answers, and React may
  // commit that answer before the raise (an effect's update can land in a later render than a
  // fetch's), which painted the framed reader between the cover and full screen (fix/open-flash).
  const retryOpening = useRef(false);
  // Whether this browser has decided what a gated page shows. Until it has, the page shows
  // "Opening…" rather than the gate: the server render is anonymous, so its gate is the right
  // answer only for a reader with no session anywhere, and printing it first put "This document is
  // private" in front of every signed-in reader (and in front of the silent check's round trip on
  // a workspace's domain) for as long as hydration took. Decided once per mounted view, below.
  const [gateDecided, setGateDecided] = useState(!isPasswordProtected || !!initialSecret);
  useEffect(() => {
    if (fetchHinted.current) return;
    fetchHinted.current = true;
    if (!isPasswordProtected) return;
    // usableSessionToken also drops a tenant token that has expired, before anything reads it.
    if (peekHandoffToken() || usableSessionToken()) {
      retryOpening.current = true;
      setPwdFetching(true);
      // The listing said what it is opening: fetch that view's code alongside the read.
      void preloadView(document.documentElement.getAttribute(OPENING_ATTR) as OpeningKind | null);
    }
    setGateDecided(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [pwdInput, setPwdInput] = useState("");
  const [pwdError, setPwdError] = useState("");
  // Bumped per wrong attempt so the gate re-plays its shake for a repeated error.
  const [pwdErrorKey, setPwdErrorKey] = useState(0);
  const [pwdUnlocking, setPwdUnlocking] = useState(false);
  const [pwdVisible, setPwdVisible] = useState(false);
  // Set when the retry ran *with* a token and was still refused. That is a
  // different fact from "nobody is signed in", and it needs a different screen:
  // telling someone to sign in when they already are is how a working link
  // starts looking broken.
  const [accessDenied, setAccessDenied] = useState(false);
  // What the denied answer said about asking the owner for access (the gate's Request access).
  const [deniedInfo, setDeniedInfo] = useState<DeniedInfo | null>(null);

  // Immersive mode: the document fills the viewport with all app chrome hidden,
  // so a published page reads as the content itself rather than as something in
  // a Markdrop box. Escape exits, and the framed view stays one key away.
  //
  // Derived from props alone, deliberately. The server render has no search
  // params, so seeding this from ?new/?edit would make the server and client
  // disagree about the very first paint. Props-only means the prerendered HTML
  // is already full-bleed, and a reader never sees the boxed view flash past
  // while the page hydrates.
  const [immersive, setImmersive] = useState(
    () => !isPasswordProtected && !encrypted && !!initialContent.trim() && initialPage?.editor !== "blocks"
  );
  const decided = useRef(false);

  /**
   * Immersive ↔ framed (REVAMP_PLAN 6.2): a View Transition morphs the reading
   * column (`view-transition-name: reading-column`) where the browser has them
   * and motion is allowed; everywhere else the switch is instant. Neither path
   * touches the URL, so `#k=` is never at risk.
   */
  // Full screen the reader asked for (the button, F), as opposed to the automatic one on opening.
  const askedFullScreen = useRef(false);
  const toggleImmersive = useCallback((next: boolean) => {
    if (next) askedFullScreen.current = true;
    const doc = typeof document !== "undefined"
      ? (document as Document & { startViewTransition?: (cb: () => void) => unknown })
      : null;
    const reduced = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!doc?.startViewTransition || reduced) {
      setImmersive(next);
      return;
    }
    doc.startViewTransition(() => flushSync(() => setImmersive(next)));
  }, []);

  // Reader-only. The editor needs the chrome, a gated document has nothing to
  // show yet, and an artifact found behind the password gate runs its own
  // immersive mode — letting both lock body scroll would fight over restoring it.
  const showImmersive = immersive && !editing && !pwdLocked && !pwdFetching && !artifactDoc;

  // Once hydrated, the search params are readable and the decision can be made
  // properly. It runs exactly once — a ref, not a dependency guard — so a doc
  // still immerses after its password unlock resolves, while an explicit Esc is
  // never undone by a later re-render.
  //
  // Publishing is the one flow that must *not* be full-bleed: the edit secret is
  // shown once and lives in the chrome, so covering it would lose it for good.
  // Same for the flags that open a chrome-level panel.
  // Before paint: a gated document opening for a signed-in reader goes from the opening cover straight
  // to full screen, never one frame of the framed reader in between (fix/open-flash).
  useBeforePaint(() => {
    if (decided.current || !flagsReady) return;
    // Not resolved yet — wait rather than deciding on a transient state. An
    // encrypted document waits for its key too: if the key is missing or wrong,
    // the explanation belongs next to the chrome, not alone on a blank screen.
    if (editing || pwdLocked || pwdFetching || artifactDoc) return;
    if (encrypted && decryptState !== "ok") return;
    decided.current = true;
    const chromeFlow = isNew || startInEdit || startCopy || startGoogleSync;
    // A page (block editor) opens framed: its breadcrumbs, page tree and Edit live in the chrome.
    setImmersive(!chromeFlow && !!displayContent.trim() && page?.editor !== "blocks");
  }, [editing, pwdLocked, pwdFetching, artifactDoc, isNew, startInEdit, startCopy, startGoogleSync, displayContent, encrypted, decryptState, flagsReady]);

  useEffect(() => {
    if (!showImmersive) return;
    // An open overlay swallows its own Escape (the DS layer stack stops it at the
    // document), and anything that already handled it marks it defaultPrevented.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) toggleImmersive(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [showImmersive]);

  // Live socket state (the "Live" badge) and a counter bumped on every live
  // update, so the view can show "Updated just now" and highlight what changed.
  const [live, setLive] = useState(false);
  const [liveUpdate, setLiveUpdate] = useState(0);

  // Scroll sync refs for split view
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const writeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // How far readers get and how long they read (lib/readDepth.ts). Only while
  // the document is actually on screen: not locked, not being edited.
  const readRef = useRef<HTMLDivElement>(null);
  useReadDepth(slug, readRef, readable && !editing && !artifactDoc && !(isPasswordProtected && pwdLocked), readTicket);

  // Creator analytics (lib/engage.ts): sections read, copies, links, time. Never for the owner:
  // with a signed-in user it waits until the ownership check has answered for them.
  const ownerKnown = !authLoading && (!user || ownerCheckedFor === user.id);
  const onCodeCopy = useDocEngagement(
    slug,
    readRef,
    readable && !editing && !artifactDoc && !(isPasswordProtected && pwdLocked) && ownerKnown && !isOwner,
    { encrypted, ticket: readTicket },
  );

  // Fire a single view beacon from the browser so the real visitor IP (not
  // Vercel's SSR server) drives the view count + geography. After auth has
  // settled (or 1.5 s), so it carries the session token and the owner's own view isn't counted.
  const authSettled = useAuthSettled(authLoading);
  useEffect(() => {
    if (viewBeaconSent.current || !authSettled) return;
    if (isPasswordProtected && pwdLocked) return; // wait until unlocked
    viewBeaconSent.current = true;
    recordEvent(slug, "view", readTicket, { optOut: engagementOptedOut() });
  }, [pwdLocked, isPasswordProtected, slug, authSettled]); // eslint-disable-line react-hooks/exhaustive-deps

  // If logged in, detect ownership so the owner can edit without the secret
  // (and view their own password-protected doc without the read password). We
  // also capture the doc id + Google Docs link here to drive the sync button.
  useEffect(() => {
    if (!user) {
      // Signed out (or never signed in): drop any owner-only state so the
      // Google Docs actions disappear immediately, without a page reload.
      setIsOwner(false);
      setDocId(null);
      setGoogleDocUrl(null);
      setGoogleDocStale(false);
      setPresenceTicket(null);
      setDocCan(null);
      return;
    }
    let cancelled = false;
    const uid = user.id;
    getDocument(slug)
      .then((doc) => {
        if (cancelled) return;
        if (doc.presence_ticket) setPresenceTicket(doc.presence_ticket);
        if (doc.is_owned || doc.is_owner) setDocOwned(true);
        setDocCan(doc.can ?? null);
        // A signed-in read: its page fields (breadcrumbs, page images) are this reader's.
        if (doc.kind !== "artifact" && !doc.encrypted) setPage(pageFieldsOf(doc as unknown as Record<string, unknown>));
        // …and so is a page's Markdown: the anonymous server render leaves out the names of the
        // people it mentions and the labels of items, which this reader may be allowed to see.
        if (doc.kind !== "artifact" && !doc.encrypted && (doc as { editor?: string }).editor === "blocks" && typeof doc.content === "string") {
          setDisplayContent(doc.content);
          setDocRev(typeof doc.rev === "number" ? doc.rev : null);
        }
        setOwnerCheckedFor(uid);
        if (!doc.is_owner) return;
        setIsOwner(true);
        setDocId(doc.id ?? null);
        setGoogleDocUrl(doc.google_doc_url ?? null);
        setGoogleDocStale(!!doc.google_doc_stale);
        // Only unlock/refresh display state on first detection — don't clobber
        // edits the user may have unlocked via secret.
        if (!secretUnlocked) {
          setSecretUnlocked(true);
          // A gated item the signed-in retry is opening: that read hands over (the cover, then the
          // item full screen). Unlocking here as well, a beat earlier, showed the framed reader in
          // between, and then the cover again.
          if (!retryOpening.current) {
            setPwdLocked(false);
            adoptDoc(doc);
          }
        }
      })
      .catch(() => { if (!cancelled) setOwnerCheckedFor(uid); });
    return () => { cancelled = true; };
  }, [user, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether the account has Google Docs connected (gates the sync button).
  useEffect(() => {
    if (!user) { setGConnected(false); return; }
    let cancelled = false;
    getGoogleDocsStatus()
      .then((s) => { if (!cancelled) setGConnected(!!(s.configured && s.connected)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user]);

  // Live updates: refresh the page when the document changes elsewhere (a VS
  // Code sync push or an in-app edit). A lightweight WebSocket receives a
  // "changed" ping, then we refetch through the normal authorized read path.
  // Additive + best-effort: if the socket never connects, the page behaves
  // exactly as before (manual reload). An in-progress edit is never clobbered.
  const editingRef = useRef(editing);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isPasswordProtected && pwdLocked) return; // wait until unlocked
    // A file found behind the password has its own socket (ArtifactView): one tab, one viewer.
    if (artifactDoc) return;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let backoff = 3000;

    function connect() {
      try {
        ws = new WebSocket(liveSocketUrl(slug, readTicket));
      } catch {
        return;
      }
      const sock = ws;
      ws.onopen = () => { setLive(true); backoff = 3000; presence.channel.attach(sock); };
      ws.onmessage = (ev) => {
        let msg: { type?: string } | null = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        // Who's viewing: the presence channel takes its own messages.
        if (msg && presence.channel.handle(msg)) return;
        // The page editor, while open, follows `changed` and `appended` itself.
        if (msg && liveListeners.current.size) liveListeners.current.forEach((fn) => fn(msg as Record<string, unknown>));
        // An AI app appended blocks (MCP append_blocks): readers re-read like any change.
        if (msg?.type === "appended") msg = { type: "changed" };
        // Deleted, expired or renamed away: the page itself has to answer now (404 or a redirect).
        if (msg?.type === "gone") { if (!editingRef.current) window.location.reload(); return; }
        // Who may read it narrowed: the server closes this socket and the old ticket stops
        // working. Re-read through the normal path — still allowed gives a fresh ticket (and a
        // reconnect); refused means the page must show the gate instead of the old content.
        const narrowed = msg?.type === "access";
        if ((msg?.type !== "changed" && !narrowed) || (editingRef.current && !narrowed)) return;
        const cachedPwd = isPasswordProtected
          ? sessionStorage.getItem(`pwd:${slug}`) || undefined
          : undefined;
        getDocument(slug, cachedPwd, claimSecret || undefined)
          .then((doc) => {
            // A rename (or a page's new icon) shows in the rail and page trees, in every tab.
            if (!doc.encrypted && doc.title != null) {
              announce("md:pages-change", { slug, title: doc.title, ...((doc as { editor?: string | null }).editor === "blocks" ? { icon: readPageProps(doc.content ?? "").icon } : {}) });
            }
            if (adoptDoc(doc, { created: false })) return;
            setLiveUpdate((n) => n + 1);
            setVscodeSynced(!!doc.vscode_synced);
            if (doc.is_owner) setGoogleDocStale(!!doc.google_doc_stale);
          })
          .catch(() => { if (narrowed) window.location.reload(); });
      };
      ws.onclose = () => {
        setLive(false);
        presence.channel.detach();
        // Reconnect while the page is open, backing off 3s → 30s.
        if (!closed) {
          retry = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30000);
        }
      };
    }
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
      presence.channel.detach();
      setLive(false);
    };
  }, [slug, isPasswordProtected, pwdLocked, claimSecret, readTicket, !!artifactDoc]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open the editor directly when arriving via ?edit=1 (owner/secret ready).
  // An encrypted document waits for its decryption to finish (or to fail for good): opening on the
  // moment before would put an empty document in the editor.
  const decryptSettled = !encrypted || decryptState === "ok" || decryptState === "nokey" || decryptState === "failed" || decryptState === "unsupported";
  useEffect(() => {
    if (startInEdit && secretUnlocked && !editOpened.current && !pwdLocked && decryptSettled) {
      editOpened.current = true;
      handleEditClick();
    }
  }, [startInEdit, secretUnlocked, pwdLocked, decryptSettled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resume "Save a copy" after a sign-in redirect (?copy=1), once we know the
  // viewer isn't the owner and the content is unlocked. Opens the modal once.
  const copyAutoOpened = useRef(false);
  useEffect(() => {
    if (startCopy && user && !isOwner && !pwdLocked && !copyAutoOpened.current) {
      copyAutoOpened.current = true;
      setShowCopy(true);
    }
  }, [startCopy, user, isOwner, pwdLocked]);

  // Resume Google export after the connect redirect (?gsync=1): once we know
  // the viewer owns this (new) doc and Google is connected, and it isn't linked
  // yet, push it to Google Docs automatically — no manual "Sync" click needed.
  const gSyncAuto = useRef(false);
  useEffect(() => {
    if (startGoogleSync && isOwner && gConnected && docId && !googleDocUrl && !gBusy && !gSyncAuto.current) {
      gSyncAuto.current = true;
      handleGoogleExport();
    }
  }, [startGoogleSync, isOwner, gConnected, docId, googleDocUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set document.title to just the clean name before printing so the
  // save-as filename in the print dialog is "{title}" or "{slug}" rather
  // than the full "{title} — Markdrop" page title.
  useEffect(() => {
    const cleanName = displayTitle || slug;
    const savedTitle = document.title;
    function beforePrint() { document.title = cleanName; }
    function afterPrint()  { document.title = savedTitle; }
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint",  afterPrint);
    return () => {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint",  afterPrint);
    };
  }, [displayTitle, slug]);

  // A completed handoff arrives with the token on the fragment. Take it before
  // anything else runs, so the retry below is already carrying it — otherwise
  // the first thing a reader sees after signing in is the gate they just came
  // back from. Stored for this origin only, and stripped from the address bar
  // straight away so it is not left sitting in a URL people copy and paste.
  const [handoffDone, setHandoffDone] = useState(false);
  /** The signed-in retry below: which read is the latest (an older one's answer is dropped). */
  const retryGen = useRef(0);
  //
  // Only a tenant token minted for this very host, and never on markdrop.in
  // (`consumeHandoffToken`): a fragment is attacker-controllable, and taking any
  // token from it let a crafted link swap the reader's session (login CSRF).
  // A refused token is still stripped from the address bar.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith(`#${HANDOFF_NONE_FRAGMENT}=`)) {
      // The silent check came back empty-handed: show the gate as it is.
      history.replaceState(history.state, "", window.location.pathname + window.location.search);
      setHandoffDone(true);
      return;
    }
    if (!hash.startsWith(`#${HANDOFF_FRAGMENT}=`)) {
      // A gated page on a workspace's own domain, with no live session for this origin (none
      // yet, or a tenant token that has expired: usableSessionToken drops those): the reader may
      // well be signed in on markdrop.in already (they usually came from there). Ask it quietly
      // before showing "Sign in" to someone who already is. Members, and readers who said yes to
      // this site before, come straight back signed in; everyone else comes straight back to the
      // gate. No screen is ever shown on the way. At most once per page every couple of minutes
      // (startSilentHandoff), so it can never loop.
      if (isPasswordProtected && signInUrl && !usableSessionToken()) {
        if (startSilentHandoff(signInUrl)) {
          // Still on this page until the navigation commits, so this runs first.
          stashKeyForSignIn(); // the handoff comes back on #mdt=…, without the key
          setPwdFetching(true); // "Opening…", not a Sign in screen that is about to vanish
          return;
        }
      }
      setHandoffDone(true);
      return;
    }
    const token = consumeHandoffToken();
    setHandoffDone(true);
    // The header (Site or Tenant) reads the session from AuthContext, which
    // loaded before the token existed. Without this it stays signed out until
    // a reload.
    if (token) refreshAuth().catch(() => {});
  }, []);

  // On mount: the server render is deliberately anonymous so it can be cached,
  // which means it hits the gate for *everyone* — including the people who were
  // given access by name and are signed in right now. Retry once from the
  // browser, where the token exists. Whoever the reader turns out to be, the
  // API decides; this only stops us showing a locked door to someone holding
  // the key.
  useEffect(() => {
    if (!handoffDone) return;
    if (!pwdLocked && !pwdFetching) return;
    if (typeof window === "undefined") return;
    if (!usableSessionToken()) {
      // The session seen a moment ago is gone: AuthContext dropped it when /auth/me refused it
      // (this view can hydrate after the app shell, so that check may have answered first). Ask
      // markdrop.in for a fresh one on a workspace's domain, or show the gate; never leave the
      // "Opening…" raised above with nothing left to lower it.
      retryOpening.current = false; // no retry: the owner check may open it
      if (initialSecret) return; // the edit-secret read owns pwdFetching
      if (pwdLocked && startSilentHandoff(signInUrl)) {
        stashKeyForSignIn();
        return;
      }
      setPwdFetching(false);
      return;
    }
    // Only the latest read answers, and a read always answers unless a newer one has started. A
    // cleanup must not silence it: when this effect runs again (StrictMode's double run in dev, or a
    // suspended part re-running effects on show) and returns early, nothing else would lower
    // "Opening…".
    const gen = ++retryGen.current;
    const cancelled = () => gen !== retryGen.current;
    let leaving = false;
    setPwdFetching(true);
    getDocument(slug)
      .then(async (doc) => {
        // The view's own code first, so the opening cover hands straight over to it.
        await preloadView(viewKindOf(doc));
        if (cancelled()) return;
        adoptDoc(doc);
        setPwdLocked(false);
      })
      .catch((e) => {
        if (cancelled()) return;
        // The token itself was not accepted: the API answered as it answers a stranger (a 401
        // "sign in"; a workspace domain's token refused outright has no gate header). A signed-in
        // reader the document isn't shared with gets a 404, never a 401, so this is not a denial
        // and must not say "you don't have access". On a workspace's domain the token is dead:
        // drop it and ask markdrop.in for a fresh one (once; startSilentHandoff guards the loop).
        const tokenRefused = e instanceof ApiError && e.status === 401
          && (e.message === "SIGNIN_REQUIRED" || gate === "signin");
        if (tokenRefused && !isPrimaryHost(window.location.host)) {
          forgetSessionToken();
          refreshAuth().catch(() => {});
          if (startSilentHandoff(signInUrl)) {
            leaving = true;
            stashKeyForSignIn();
            return;
          }
        }
        // A password gate is not a denial either: they simply have not typed it yet.
        // Anything else, with a token in hand, means this account was checked and refused.
        const needsPassword = e instanceof Error && e.message === "PASSWORD_REQUIRED";
        const denied = !needsPassword && !tokenRefused;
        setAccessDenied(denied);
        setDeniedInfo(null);
        if (denied) void loadRequestState();
        setPwdLocked(true);
      })
      .finally(() => {
        if (cancelled() || leaving) return;
        retryOpening.current = false;
        setPwdFetching(false);
      });
  }, [handoffDone]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * "No dead ends": once the page is denied, ask whether this account may request access. The read
   * itself never says (that would tell strangers the document exists); `…/access-requests/mine`
   * does, for the signed-in caller only. A workspace's own domain holds a read-only tenant token, so
   * there the gate links to the markdrop.in page, where the request can be made.
   */
  async function loadRequestState() {
    if (typeof window !== "undefined" && !isPrimaryHost(window.location.host)) {
      setDeniedInfo({ canRequest: true, pending: false, ownerFirstName: null, requestUrl: `https://markdrop.in/${encodeURIComponent(slug)}` });
      return;
    }
    try {
      const { myAccessRequest } = await import("@/lib/me");
      const r = await myAccessRequest(slug);
      setDeniedInfo({ canRequest: r.can_request_access || r.request_pending, pending: r.request_pending, ownerFirstName: null });
    } catch {
      // No request option (or an older server): the plain "ask the owner" gate stays.
    }
  }

  // On mount: auto-unlock if owner (has edit secret) or cached password
  useEffect(() => {
    if (!isPasswordProtected) return;
    // Owner bypass: edit secret skips the read password gate
    if (initialSecret) {
      getDocument(slug, undefined, initialSecret)
        .then((doc) => { adoptDoc(doc); })
        .catch(() => {
          // Secret invalid — fall back to showing the password gate
          setPwdLocked(true);
        })
        .finally(() => {
          setPwdFetching(false);
        });
      return;
    }
    // Returning visitor: try sessionStorage cached password
    const cached = sessionStorage.getItem(`pwd:${slug}`);
    if (cached) {
      getDocument(slug, cached)
        .then((doc) => {
          adoptDoc(doc);
          setPwdLocked(false);
        })
        .catch(() => {
          sessionStorage.removeItem(`pwd:${slug}`);
        });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handlePasswordUnlock(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!pwdInput.trim()) return;
    setPwdUnlocking(true);
    setPwdError("");
    try {
      const doc = await getDocument(slug, pwdInput);
      sessionStorage.setItem(`pwd:${slug}`, pwdInput);
      adoptDoc(doc);
      setPwdLocked(false);
    } catch (e) {
      if (e instanceof Error && e.message === "WRONG_PASSWORD") {
        setPwdError("That password didn't open it. Check it with whoever shared the link.");
        setPwdErrorKey((k) => k + 1);
      } else {
        setPwdError("Something went wrong. Try again.");
      }
    } finally {
      setPwdUnlocking(false);
    }
  }

  function syncScroll() {
    const ta = textareaRef.current;
    const pv = previewRef.current;
    if (!ta || !pv) return;
    const ratio = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
    pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
  }

  function handleEditClick() {
    setEditTitle(displayTitle || "");
    setEditContent(displayContent);
    setViewMode("write");
    setSaveError("");
    setSecretError("");
    setEditRemovePassword(false);
    setEditNewPassword("");
    setEditShowPassword(false);
    setEditExpiresIn("");
    setEditCustomExpiresAt("");
    setRotateKey(false);
    setEditE2EPassword(null);
    setSaveConflict(false);
    setEditing(true);
  }

  function handleCancelEdit() {
    setEditing(false);
    setShowDeleteConfirm(false);
    setSaveError("");
    setSecretError("");
    // Only forget a secret the reader typed for this attempt. An owner (signed
    // in) or an author whose secret is in this tab's sessionStorage was unlocked
    // by who they are, and Cancel used to lock them out of their own document
    // until a reload (REVAMP_BUILD R13 "Cancel re-locks owners").
    if (!initialSecret && !isOwner && !claimSecret) {
      setSecretUnlocked(false);
      setSecretInput("");
    }
  }

  function handleUnlock(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!secretInput.trim()) {
      setSecretError("Enter your edit secret.");
      return;
    }
    setSecretError("");
    setSecretUnlocked(true);
    handleEditClick();
  }

  /** Settings a save carries (password, expiry), in the API's terms. */
  function settingsPayload() {
    return {
      readPassword: editNewPassword || undefined,
      removePassword: editRemovePassword,
      expiresIn: editExpiresIn || undefined,
      customExpiresAt: editExpiresIn === "custom" ? editCustomExpiresAt : undefined,
    };
  }

  /** Re-read after a refused save: the newest version, re-decrypted with the key in hand. */
  async function reloadLatest() {
    setReloadingLatest(true);
    try {
      const cachedPwd = isPasswordProtected ? sessionStorage.getItem(`pwd:${slug}`) || undefined : undefined;
      const doc = await getDocument(slug, cachedPwd, claimSecret || secretInput || undefined);
      adoptDoc(doc, { created: false });
      setSaveConflict(false);
      setSaveError("");
      if (!encrypted) {
        // Plain text: the newest version goes into the editor (theirs is in the copy button).
        setEditTitle(doc.title || "");
        setEditContent(doc.content);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Couldn't load the latest version. Try again.");
    } finally {
      setReloadingLatest(false);
    }
  }

  async function handleSave() {
    if (canEditContent && !editContent.trim()) return;
    // Write's textarea stops at the limit; Preview can't, so say it here rather than let the server refuse.
    if (canEditContent && editContent.length > MAX_CHARS) {
      setSaveConflict(false);
      setSaveError(`It's ${(editContent.length - MAX_CHARS).toLocaleString()} characters over the ${MAX_CHARS.toLocaleString()} limit. Shorten it to save.`);
      return;
    }
    setSaving(true);
    setSaveError("");
    setSaveConflict(false);
    try {
      // ── No key: settings only, through PATCH …/settings. The stored envelope
      // is never sent back — resending a copy read earlier would overwrite a
      // newer version (or undo a key rotation made in another tab).
      if (encrypted && !canEditContent) {
        const s = settingsPayload();
        if (!s.removePassword && !s.expiresIn) {
          setSaveError("Nothing to save. Without the key only the expiry and the old server password can change here.");
          return;
        }
        const doc = await updateDocumentSettings(slug, {
          removePassword: s.removePassword || undefined,
          expiresIn: s.expiresIn,
          customExpiresAt: s.customExpiresAt,
        }, secretInput || undefined);
        if (typeof doc.rev === "number") setDocRev(doc.rev);
        setServerPassword(!!doc.is_password_protected);
        setDisplayExpiresAt(doc.expires_at);
        fetch("/api/revalidate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        }).catch(() => {});
        setEditing(false);
        return;
      }

      let body = editContent;
      let nextKey: e2e.DocKey | null = null;
      let nextEncoded = "";
      // The password the new version needs: unchanged, removed ("") or new.
      const nextPassword = editE2EPassword === null ? e2ePassword : editE2EPassword || null;
      if (encrypted && cryptoKey) {
        // A new key (rotation) gives the document a new link. The old one stops
        // opening this version — which is the point — though it can't un-read
        // what someone already read, or a copy someone saved.
        nextKey = rotateKey ? e2e.generateKey() : cryptoKey;
        if (rotateKey) nextEncoded = e2e.exportKey(nextKey);
        // Same key or new, always a fresh salt and nonce (lib/e2e.ts). Re-saving
        // a v1 document writes v2 under the same link key, so its link holds.
        body = await e2e.seal(nextKey, { title: editTitle.trim() || null, content: editContent }, { password: nextPassword });
      }
      const s = settingsPayload();
      const doc = await updateDocument(slug, editTitle, body, secretInput, {
        // An encrypted document never gets a new server password (its password
        // is the one above); an old one can only be removed.
        readPassword: encrypted ? undefined : s.readPassword,
        removePassword: s.removePassword,
        expiresIn: s.expiresIn,
        customExpiresAt: s.customExpiresAt,
        encrypted: encrypted || undefined,
        baseRev: docRev,
      });
      if (typeof doc.rev === "number") setDocRev(doc.rev);
      setServerPassword(!!doc.is_password_protected);
      setDisplayTitle(editTitle || null);
      setDisplayContent(editContent);
      if (encrypted) {
        setE2EPassword(nextPassword);
        if (nextKey && nextEncoded) {
          setCryptoKey(nextKey);
          setKeyFragment(nextEncoded);
          setKeySource("link");
          setLinkKeyStale(false);
          setCandidates({ link: nextEncoded, device: null, pasted: false });
          // The publisher's browser keeps the key, as it did when publishing.
          e2e.rememberKey(slug, nextEncoded);
          // Put the new key in the address bar so a refresh — or a copy straight
          // out of it — still opens the document.
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#k=${nextEncoded}`);
          setRotated(e2e.withKey(url, nextEncoded));
        }
        if (editE2EPassword !== null && (editE2EPassword || e2ePassword)) setPasswordChange(editE2EPassword ? "set" : "removed");
        setSealed(body);
      }
      // Drop the cached render so the next visitor doesn't get the previous
      // ciphertext — which, after a rotation, the old link would still open.
      // Best-effort: a failure here costs freshness, not correctness.
      fetch("/api/revalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      }).catch(() => {});
      setDisplayExpiresAt(doc.expires_at);
      setEditing(false);
      // The edit bumped the document's rev, so any linked Google Doc is now
      // behind — flip the sync affordance to "Sync changes" without a reload.
      if (googleDocUrl) setGoogleDocStale(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone (or another tab) saved since this editor opened. Nothing was
        // written; the text typed here is still in the editor.
        setSaveConflict(true);
        setSaveError(
          encrypted
            ? "This document was changed somewhere else since you opened it, so nothing was saved. Load the latest version, then make your change again. If the owner issued a new key, this key won't open the latest version."
            : "This document was changed somewhere else since you opened it, so nothing was saved. Copy your text, load the latest version, then make your change again."
        );
      } else {
        setSaveError(e instanceof Error ? e.message : "Failed to save");
      }
    } finally {
      setSaving(false);
    }
  }


  /** The delete dialog (components/trash) moved it to Trash and toasts Undo; leave the page. */
  function handleDelete() {
    setDeleting(false);
    setShowDeleteConfirm(false);
    // The cached anonymous render would keep serving the deleted document for
    // up to a minute (REVAMP_BUILD §5.0 "Purges": add delete).
    fetch("/api/revalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    }).catch(() => {});
    router.push("/new");
  }

  const remaining = MAX_CHARS - editContent.length;
  const activeTextareaRef = viewMode === "split" ? textareaRef : writeTextareaRef;
  // Who can open it, for the Details "Access" card and to offer Share to
  // resharers as well as owners (REVAMP_PLAN 7.6). Signed-in readers only; the
  // server decides `can_share`, a refusal just hides the card.
  const [access, setAccess] = useState<AccessState | null>(null);
  // A workspace's own domain (2026-11-04): its tenant session reads the sharing state and shares
  // with specific people (the Share dialog's people-only mode); who can open it in general is still
  // managed on markdrop.in. `docCan` (the read's flags) answers the rest there.
  const onTenantHost = typeof window !== "undefined" && !isPrimaryHost(window.location.host);
  const loadAccess = useCallback(() => {
    getAccess(slug).then(setAccess).catch(() => setAccess(null));
  }, [slug]);
  useEffect(() => {
    if (!user || pwdLocked || pwdFetching) { setAccess(null); return; }
    loadAccess();
  }, [user, pwdLocked, pwdFetching, loadAccess]);
  const canShare = isOwner || !!access?.can_share;

  // P3: members (on a non-private document in their workspace) and editor grantees edit with
  // their session, no edit secret. The server says so as `your_role: "editor"` and enforces it on
  // save. Re-applied after Cancel (which re-locks secret-only sessions).
  const sessionEditor = !!user && (access?.can
    ? access.can.edit && !access.can.settings
    : access?.your_role === "editor" || (onTenantHost && !!docCan?.edit && !isOwner));
  useEffect(() => {
    if (sessionEditor && !secretUnlocked) setSecretUnlocked(true);
  }, [sessionEditor, secretUnlocked]);
  // Password, expiry, key rotation and delete stay with the owner (or the edit secret's holder) —
  // on markdrop.in only: a workspace's own domain edits the text, never the settings.
  const canEditSettings = (isOwner || !!secretInput.trim()) && !onTenantHost;

  // `F` returns to full screen from the framed reader (REVAMP_PLAN 7.6 "Keys").
  // Single-key shortcuts never fire while typing or while a dialog is open, nor when they're
  // turned off in Settings › Account (read at keypress, so the switch applies at once).
  useEffect(() => {
    if (showImmersive || editing || pwdLocked || pwdFetching || artifactDoc || !readable || !displayContent.trim()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "f" && e.key !== "F") return;
      if (!shortcutsEnabled()) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      e.preventDefault();
      toggleImmersive(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showImmersive, editing, pwdLocked, pwdFetching, artifactDoc, readable, displayContent, toggleImmersive]);

  return {
    page,
    setPage,
    subscribeLive,
    setDocRev,
    setDisplayContent,
    setDisplayTitle,
    presence,
    access,
    encrypted,
    applyPastedLink,
    allowRemoteImages,
    encCopyBusy,
    encCopyError,
    handleEncryptedCopy,
    remoteImagesOk,
    setShowEncCopy,
    setShowProtection,
    showEncCopy,
    showProtection,
    publishedPassword,
    passwordChange,
    setPasswordChange,
    decryptReason,
    docRev,
    e2ePassword,
    e2ePwdChecking,
    e2ePwdError,
    e2ePwdErrorKey,
    editE2EPassword,
    forgetOnDevice,
    linkKeyStale,
    opened,
    reloadLatest,
    reloadingLatest,
    rememberOnDevice,
    saveConflict,
    sealed,
    serverPassword,
    setEditE2EPassword,
    stashKeyForSignIn,
    submitE2EPassword,
    loadAccess,
    canShare,
    canEditSettings,
    sessionEditor,
    docCan,
    onTenantHost,
    live,
    liveUpdate,
    toggleImmersive,
    reportCategory,
    setReportCategory,
    reportError,
    setReportError,
    pwdErrorKey,
    setPwdError,
    accessDenied,
    deniedInfo,
    activeTextareaRef,
    adoptDoc,
    artifactDoc,
    readTicket,
    canEditContent,
    claimed,
    claimMsg,
    claimSecret,
    docOwned,
    ownerKnown,
    copyBusy,
    copyError,
    cryptoKey,
    decryptState,
    deleting,
    deviceKeySaved,
    displayContent,
    displayCreatedAt,
    displayExpiresAt,
    displayTitle,
    displayViews,
    docId,
    editContent,
    editCustomExpiresAt,
    editExpiresIn,
    editing,
    editNewPassword,
    editRemovePassword,
    editShowPassword,
    editTitle,
    gBusy,
    gConnected,
    gError,
    gNeedsReconnect,
    googleDocStale,
    googleDocUrl,
    handleCancelEdit,
    handleClaim,
    handleCopy,
    handleDelete,
    handleEditClick,
    handleGoogleExport,
    handleGoogleReconnect,
    handlePasswordUnlock,
    handleSave,
    handleUnlock,
    immersive,
    askedFullScreen,
    isNew,
    isOwner,
    keyFragment,
    keySource,
    previewRef,
    pwdError,
    // "Opening…" also while this browser hasn't decided yet whether the gate is the answer (the
    // server render and the first client render, see `gateDecided`).
    pwdFetching: pwdFetching || (pwdLocked && !gateDecided),
    pwdInput,
    pwdLocked,
    pwdUnlocking,
    pwdVisible,
    readable,
    readRef,
    onCodeCopy,
    remaining,
    reportBusy,
    reportDone,
    reportReason,
    requestCopy,
    rotated,
    rotateKey,
    saveError,
    saving,
    secretError,
    secretInput,
    secretUnlocked,
    setSecretInput,
    setDeviceKeySaved,
    setEditContent,
    setEditCustomExpiresAt,
    setEditExpiresIn,
    setEditing,
    setEditNewPassword,
    setEditRemovePassword,
    setEditShowPassword,
    setEditTitle,
    setGError,
    setGNeedsReconnect,
    setImmersive,
    setPwdInput,
    setPwdVisible,
    setReportDone,
    setReportReason,
    setRotateKey,
    setShowCopy,
    setShowDeleteConfirm,
    setShowRaw,
    setShowReport,
    setShowShare,
    setViewMode,
    shareUrl,
    showCopy,
    showDeleteConfirm,
    showImmersive,
    showRaw,
    showReport,
    showShare,
    signInHref,
    startCopy,
    startGoogleSync,
    startInEdit,
    submitReport,
    syncScroll,
    textareaRef,
    viewMode,
    vscodeSynced,
    writeTextareaRef,
    user,
  };
}
