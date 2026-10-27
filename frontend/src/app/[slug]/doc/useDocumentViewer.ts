"use client";

/**
 * Every piece of DocumentView's state, effect and handler, moved here verbatim
 * (R12 split) so the screens in this folder only render. Nothing in this file
 * draws anything. Guardrails: design/REVAMP_BUILD.md §5.0, and the inventory
 * in the S1 report — each effect below carries the comment that explains it.
 */

import { useCallback, useEffect, useState, useRef } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { useQueryFlags } from "@/lib/useQueryFlags";
import * as e2e from "@/lib/e2e";
import { updateDocument, deleteDocument, getDocument, claimDocument, recordEvent, reportDocument, getGoogleDocsStatus, connectGoogleDocs, exportToGoogleDocs, copyDocument, API_BASE } from "@/lib/api";
import { MAX_CHARS } from "@/lib/limits";
import { HANDOFF_FRAGMENT } from "@/lib/hosts";
import { consumeHandoffToken, peekHandoffToken } from "@/components/tenant/handoff";
import { useAuth } from "@/contexts/AuthContext";
import { track } from "@/lib/track";
import { useReadDepth } from "@/lib/readDepth";
import { getAccess, type AccessState } from "@/lib/access";
import type { DocumentViewProps } from "./types";

export type ViewMode = "write" | "split" | "preview";
/** "unsupported": this browser has no WebCrypto (old, or plain http) — not the same as a wrong key. */
export type DecryptState = "plain" | "working" | "ok" | "nokey" | "failed" | "unsupported";

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
  encrypted = false,
}: DocumentViewProps) {
  const router = useRouter();
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
  const { user, openAuthModal, refresh: refreshAuth } = useAuth();

  // Claim-to-account state
  const [claimSecret, setClaimSecret] = useState<string | null>(initialSecret || null);
  const [claimed, setClaimed] = useState(false);
  const [claimMsg, setClaimMsg] = useState("");
  const viewBeaconSent = useRef(false);
  const editOpened = useRef(false);

  // Google Docs sync state — populated once we confirm the viewer owns this doc
  const [isOwner, setIsOwner] = useState(false);
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
    // An old slug of a renamed document (the signed-in retry of a gated page): go to the current
    // one, keeping the query and the #k= key. The server render redirects the anonymous case.
    if (doc.moved && doc.slug && doc.slug !== slug) {
      router.replace(`/${encodeURIComponent(doc.slug)}${window.location.search}${window.location.hash}`);
      return true;
    }
    if (doc.kind === "artifact") {
      setArtifactDoc(doc);
      setPwdLocked(false);
      return true;
    }
    if (doc.encrypted) {
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
  // itself. Two effects: one turns the fragment into a CryptoKey, the other
  // opens whatever envelope is currently in hand — so a live update from another
  // tab or the editor re-decrypts on its own.
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [keyFragment, setKeyFragment] = useState<string | null>(null);
  const [keySource, setKeySource] = useState<"link" | "device" | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  // Read after mount: localStorage doesn't exist during the server render, and
  // deriving this during render would desync the two.
  const [deviceKeySaved, setDeviceKeySaved] = useState(false);
  const [sealed, setSealed] = useState<string | null>(encrypted ? initialContent : null);
  const [decryptState, setDecryptState] = useState<DecryptState>(encrypted ? "working" : "plain");

  useEffect(() => {
    if (!encrypted) return;
    if (!e2e.isSupported()) {
      // Not "failed": nothing is wrong with the key or the document, this
      // browser just can't run the decryption (REVAMP_PLAN 7.6 "Unsupported").
      setDecryptState("unsupported");
      return;
    }
    // The link first, then whatever this browser saved when it last opened the
    // document. The second is what makes "I lost the link" survivable at all.
    const fromLink = e2e.readKeyFromFragment();
    const raw = fromLink ?? e2e.recallKey(slug);
    if (!raw) {
      setDecryptState("nokey");
      return;
    }
    let cancelled = false;
    setKeyFragment(raw);
    setKeySource(fromLink ? "link" : "device");
    e2e
      .importKey(raw)
      .then((key) => !cancelled && setCryptoKey(key))
      .catch(() => !cancelled && setDecryptState("failed"));
    return () => {
      cancelled = true;
    };
  }, [encrypted]);

  useEffect(() => {
    if (!encrypted || !cryptoKey || sealed === null) return;
    let cancelled = false;
    // Only fall back to the "decrypting" screen when there is nothing on it yet.
    // A live update re-decrypts in place; blanking the page for it would be a
    // flash of nothing every time someone else typed.
    setDecryptState((prev) => (prev === "ok" ? "ok" : "working"));
    e2e
      .unseal(cryptoKey, sealed)
      .then(({ title, content }) => {
        if (cancelled) return;
        setDisplayTitle(title);
        setDisplayContent(content);
        setDecryptState("ok");
        // Only after it demonstrably opens this document — caching a key that
        // doesn't work would just poison later visits.
        if (keyFragment) e2e.rememberKey(slug, keyFragment);
      })
      .catch(() => !cancelled && setDecryptState("failed"));
    return () => {
      cancelled = true;
    };
  }, [encrypted, cryptoKey, sealed, keyFragment, slug]);

  useEffect(() => {
    if (encrypted) setDeviceKeySaved(e2e.hasRememberedKey(slug));
  }, [encrypted, slug, keyFragment, rotated]);

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
  useEffect(() => {
    if (!isPasswordProtected) return;
    if (peekHandoffToken() || localStorage.getItem("markdrop_token")) {
      setPwdFetching(true);
    }
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
    () => !isPasswordProtected && !encrypted && !!initialContent.trim()
  );
  const decided = useRef(false);

  /**
   * Immersive ↔ framed (REVAMP_PLAN 6.2): a View Transition morphs the reading
   * column (`view-transition-name: reading-column`) where the browser has them
   * and motion is allowed; everywhere else the switch is instant. Neither path
   * touches the URL, so `#k=` is never at risk.
   */
  const toggleImmersive = useCallback((next: boolean) => {
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
  useEffect(() => {
    if (decided.current || !flagsReady) return;
    // Not resolved yet — wait rather than deciding on a transient state. An
    // encrypted document waits for its key too: if the key is missing or wrong,
    // the explanation belongs next to the chrome, not alone on a blank screen.
    if (editing || pwdLocked || pwdFetching || artifactDoc) return;
    if (encrypted && decryptState !== "ok") return;
    decided.current = true;
    const chromeFlow = isNew || startInEdit || startCopy || startGoogleSync;
    setImmersive(!chromeFlow && !!displayContent.trim());
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
  useReadDepth(slug, readRef, readable && !editing && !artifactDoc && !(isPasswordProtected && pwdLocked));

  // Fire a single view beacon from the browser so the real visitor IP (not
  // Vercel's SSR server) drives the view count + geography.
  useEffect(() => {
    if (viewBeaconSent.current) return;
    if (isPasswordProtected && pwdLocked) return; // wait until unlocked
    viewBeaconSent.current = true;
    recordEvent(slug, "view");
  }, [pwdLocked, isPasswordProtected, slug]);

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
      return;
    }
    let cancelled = false;
    getDocument(slug)
      .then((doc) => {
        if (cancelled || !doc.is_owner) return;
        setIsOwner(true);
        setDocId(doc.id ?? null);
        setGoogleDocUrl(doc.google_doc_url ?? null);
        setGoogleDocStale(!!doc.google_doc_stale);
        // Only unlock/refresh display state on first detection — don't clobber
        // edits the user may have unlocked via secret.
        if (!secretUnlocked) {
          setSecretUnlocked(true);
          setPwdLocked(false);
          adoptDoc(doc);
        }
      })
      .catch(() => {});
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
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let backoff = 3000;

    function connect() {
      try {
        ws = new WebSocket(`${API_BASE.replace(/^http/, "ws")}/ws/docs/${slug}`);
      } catch {
        return;
      }
      ws.onopen = () => { setLive(true); backoff = 3000; };
      ws.onmessage = (ev) => {
        let msg: { type?: string } | null = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg?.type !== "changed" || editingRef.current) return;
        const cachedPwd = isPasswordProtected
          ? sessionStorage.getItem(`pwd:${slug}`) || undefined
          : undefined;
        getDocument(slug, cachedPwd, claimSecret || undefined)
          .then((doc) => {
            if (adoptDoc(doc, { created: false })) return;
            setLiveUpdate((n) => n + 1);
            setVscodeSynced(!!doc.vscode_synced);
            if (doc.is_owner) setGoogleDocStale(!!doc.google_doc_stale);
          })
          .catch(() => {});
      };
      ws.onclose = () => {
        setLive(false);
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
      setLive(false);
    };
  }, [slug, isPasswordProtected, pwdLocked, claimSecret]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open the editor directly when arriving via ?edit=1 (owner/secret ready).
  useEffect(() => {
    if (startInEdit && secretUnlocked && !editOpened.current && !pwdLocked) {
      editOpened.current = true;
      handleEditClick();
    }
  }, [startInEdit, secretUnlocked, pwdLocked]); // eslint-disable-line react-hooks/exhaustive-deps

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
  //
  // Only a tenant token minted for this very host, and never on markdrop.in
  // (`consumeHandoffToken`): a fragment is attacker-controllable, and taking any
  // token from it let a crafted link swap the reader's session (login CSRF).
  // A refused token is still stripped from the address bar.
  useEffect(() => {
    if (!window.location.hash.startsWith(`#${HANDOFF_FRAGMENT}=`)) { setHandoffDone(true); return; }
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
    if (!localStorage.getItem("markdrop_token")) return;
    let cancelled = false;
    setPwdFetching(true);
    getDocument(slug)
      .then((doc) => {
        if (cancelled) return;
        adoptDoc(doc);
        setPwdLocked(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // A password gate is not a denial — they simply have not typed it yet.
        // Anything else, with a token in hand, means this account was checked
        // and refused.
        const needsPassword = e instanceof Error && e.message === "PASSWORD_REQUIRED";
        setAccessDenied(!needsPassword);
        setPwdLocked(true);
      })
      .finally(() => { if (!cancelled) setPwdFetching(false); });
    return () => { cancelled = true; };
  }, [handoffDone]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function handleSave() {
    if (!editContent.trim()) return;
    setSaving(true);
    setSaveError("");
    try {
      let body = editContent;
      let nextKey: CryptoKey | null = null;
      let nextEncoded = "";
      if (encrypted) {
        if (!cryptoKey) {
          // No key, so the text can't be touched — but expiry, password and
          // deletion don't need one. Hand the stored envelope straight back so
          // the document survives a settings change unchanged. The API requires
          // a content field; this satisfies it without inventing anything.
          if (!sealed) throw new Error("This document can't be saved without its key.");
          body = sealed;
        } else {
          // Rotation issues a brand-new key. Because the ciphertext changes, the
          // old link stops opening the document — which is the point — though it
          // cannot un-read what someone already read.
          nextKey = rotateKey ? await e2e.generateKey() : cryptoKey;
          if (rotateKey) nextEncoded = await e2e.exportKey(nextKey);
          // Same key or new, always a fresh IV: reusing a nonce under one key
          // undoes AES-GCM entirely.
          body = await e2e.seal(nextKey, {
            title: editTitle.trim() || null,
            content: editContent,
          });
        }
      }
      const doc = await updateDocument(slug, editTitle, body, secretInput, {
        readPassword: editNewPassword || undefined,
        removePassword: editRemovePassword,
        expiresIn: editExpiresIn || undefined,
        customExpiresAt: editExpiresIn === "custom" ? editCustomExpiresAt : undefined,
        encrypted: encrypted || undefined,
      });
      if (canEditContent) {
        setDisplayTitle(editTitle || null);
        setDisplayContent(editContent);
      }
      if (encrypted) setSealed(body);
      // Drop the cached render so the next visitor doesn't get the previous
      // ciphertext — which, after a rotation, the old link would still open.
      // Best-effort: a failure here costs freshness, not correctness.
      fetch("/api/revalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      }).catch(() => {});
      if (nextKey && nextEncoded) {
        setCryptoKey(nextKey);
        setKeyFragment(nextEncoded);
        setKeySource("link");
        e2e.rememberKey(slug, nextEncoded);
        // Put the new key in the address bar so a refresh — or a copy straight
        // out of it — still opens the document.
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#k=${nextEncoded}`);
        setRotated(e2e.withKey(url, nextEncoded));
      }
      setDisplayExpiresAt(doc.expires_at);
      setEditing(false);
      // The edit bumped the document's rev, so any linked Google Doc is now
      // behind — flip the sync affordance to "Sync changes" without a reload.
      if (googleDocUrl) setGoogleDocStale(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setSaveError("");
    try {
      await deleteDocument(slug, secretInput);
      // The cached anonymous render would keep serving the deleted document for
      // up to a minute (REVAMP_BUILD §5.0 "Purges": add delete).
      fetch("/api/revalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      }).catch(() => {});
      router.push("/new");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  const remaining = MAX_CHARS - editContent.length;
  const activeTextareaRef = viewMode === "split" ? textareaRef : writeTextareaRef;
  // Who can open it, for the Details "Access" card and to offer Share to
  // resharers as well as owners (REVAMP_PLAN 7.6). Signed-in readers only; the
  // server decides `can_share`, a refusal just hides the card.
  const [access, setAccess] = useState<AccessState | null>(null);
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
  const sessionEditor = !!user && access?.your_role === "editor";
  useEffect(() => {
    if (sessionEditor && !secretUnlocked) setSecretUnlocked(true);
  }, [sessionEditor, secretUnlocked]);
  // Password, expiry, key rotation and delete stay with the owner (or the edit secret's holder).
  const canEditSettings = isOwner || !!secretInput.trim();

  // `F` returns to full screen from the framed reader (REVAMP_PLAN 7.6 "Keys").
  // Single-key shortcuts never fire while typing or while a dialog is open.
  useEffect(() => {
    if (showImmersive || editing || pwdLocked || pwdFetching || artifactDoc || !readable || !displayContent.trim()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "f" && e.key !== "F") return;
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
    access,
    loadAccess,
    canShare,
    canEditSettings,
    sessionEditor,
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
    activeTextareaRef,
    adoptDoc,
    artifactDoc,
    canEditContent,
    claimed,
    claimMsg,
    claimSecret,
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
    isNew,
    isOwner,
    keyFragment,
    keySource,
    previewRef,
    pwdError,
    pwdFetching,
    pwdInput,
    pwdLocked,
    pwdUnlocking,
    pwdVisible,
    readable,
    readRef,
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
