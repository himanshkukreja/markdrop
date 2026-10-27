"use client";

/**
 * /new: write and publish (REVAMP_PLAN 7.3, REVAMP_BUILD R14; boards Editor + MobileCreate 1–2).
 *
 * The publish flow is the one this page has always had, step for step:
 * 1. with Encrypt on, seal title + text in this tab (lib/e2e) before anything leaves it;
 * 2. `createDocument` (lib/api sends the title as null for an encrypted document);
 * 3. `track("doc_published", …)` with the same payload as before;
 * 4. keep the edit secret in `sessionStorage secret:<slug>` (never in the URL);
 * 5. file it into the chosen workspace as a second step. A failure there must not lose the
 *    published document, so it travels to the viewer as `sessionStorage md_ws_share_failed:<slug>`;
 * 6. `rememberKey` for an encrypted document;
 * 7. `router.push("/<slug>?new=1#k=<key>")`: a client push keeps the fragment, and the fragment is
 *    never sent to a server, which is why the key travels there.
 *
 * Query input is read after mount through `useQueryFlags` (never `useSearchParams`): `?sample=diagrams`,
 * `?slug=` (prefills the Link field) and `?encrypt=1` (turns Encrypt on).
 */
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Badge, Button, ConfirmDialog, Drawer, Dropdown, Icon, IconButton, Kbd, Meter, Progress, RowMenu, Spinner, Tabs, Tooltip, announce, cx,
  type MenuItem,
} from "@/components/ui";
import { EditorFrame } from "@/components/kit/EditorFrame";
import { PublishSettings } from "@/components/kit/PublishSettings";
import {
  DEFAULT_PUBLISH_SETTINGS, createAccess, expiryInvalid, PHONE_QUERY, publishSummary, toApiExpiry, useIsClient, useMediaQuery,
  type PublishField, type PublishSettingsValue, type PublishWorkspace,
} from "@/components/kit/publish-utils";
import MarkdownPreview from "@/components/MarkdownPreview";
import MarkdownToolbar from "@/components/MarkdownToolbar";
import { useAuth } from "@/contexts/AuthContext";
import { createDocument } from "@/lib/api";
import * as e2e from "@/lib/e2e";
import { MAX_CHARS } from "@/lib/limits";
import { DIAGRAM_SAMPLE, DIAGRAM_SAMPLE_PARAM } from "@/lib/samples";
import { track } from "@/lib/track";
import { useQueryFlags } from "@/lib/useQueryFlags";
import { usePrefilledTarget, useWorkspaceTargets } from "@/lib/useWorkspaceTargets";
import { fileIntoWorkspace } from "@/lib/workspaces";
import { clearDraft, readDraft, writeDraft } from "./draft";
import { classifyPublishError, slugFailureText, type PublishFailure } from "./publishFailure";
import { SplitPane } from "./SplitPane";

type Mode = "write" | "split" | "preview";
type Phase = "idle" | "encrypting" | "publishing";

/** The last Write / Split / Preview choice (per browser). */
const MODE_KEY = "md_new_mode";
/** Read by the viewer (S1): the document published, but filing it into the workspace failed. */
export const WS_SHARE_FAILED_KEY = (slug: string) => `md_ws_share_failed:${slug}`;

const SLUG_CHARS = /^[a-zA-Z0-9_-]*$/;
const NEARLY_FULL = 1000;
const fmt = (n: number) => n.toLocaleString("en-US");

/** Length of the envelope `e2e.seal` would produce: `mdx1.` + b64url(12-byte IV) + `.` + b64url(cipher + 16-byte tag). */
function sealedLength(title: string, content: string): number {
  const bytes = new TextEncoder().encode(JSON.stringify({ t: title.trim() || null, c: content })).length + 16;
  const b64 = (n: number) => Math.floor(n / 3) * 4 + [0, 2, 3][n % 3]!;
  return 5 + b64(12) + 1 + b64(bytes);
}

function slugProblem(slug: string): string | undefined {
  const s = slug.trim();
  if (!s) return undefined;
  if (!SLUG_CHARS.test(s)) return "Use letters, numbers, hyphens and underscores only.";
  if (s.length < 3) return "Use at least 3 characters.";
  return undefined;
}

function readMode(): Mode | null {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === "write" || m === "split" || m === "preview" ? m : null;
  } catch {
    return null;
  }
}

/** How far the on-screen keyboard covers the layout viewport (0 when closed or unknown). */
function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!enabled || !vv) { setInset(0); return; }
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, [enabled]);
  return inset;
}

export default function NewEditor() {
  const router = useRouter();
  const { user } = useAuth();
  const signedIn = !!user;
  const flags = useQueryFlags();
  const isClient = useIsClient();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const uid = useId();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [settings, setSettings] = useState<PublishSettingsValue>(DEFAULT_PUBLISH_SETTINGS);
  const [mode, setMode] = useState<Mode>("write");
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<PublishFailure | null>(null);
  const [openPanel, setOpenPanel] = useState<PublishField | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "clear" | "sample">(null);
  const [draftNote, setDraftNote] = useState<null | "restored" | "saved">(null);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [taFocused, setTaFocused] = useState(false);
  const [isMac, setIsMac] = useState(true);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const sheetIntroRef = useRef<HTMLParagraphElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const initDone = useRef(false);
  /** Only text the person typed is saved as a draft (a loaded sample isn't, until they edit it). */
  const edited = useRef(false);
  const publishedRef = useRef(false);

  const e2eSupported = isClient ? e2e.isSupported() : true;
  const encrypt = settings.encrypt && e2eSupported;
  const busy = phase !== "idle";
  const hasText = content.trim().length > 0;
  const displayMode: Mode = isPhone && mode === "split" ? "write" : mode;

  /* ── Workspaces (signed-in members and above) ── */
  const ws = useWorkspaceTargets(settings.target);
  const workspaces: PublishWorkspace[] = ws.publishWorkspaces;
  const workspaceName = ws.workspace?.name ?? null;
  // "New document here" from a workspace folder: /new?ws=<id>&folder=<id>.
  usePrefilledTarget(flags.ready, flags.get("ws"), flags.get("folder"), ws.workspaces, (target, defaultAccess) =>
    setSettings((s) => ({ ...s, target, access: defaultAccess ?? s.access })));

  /* ── Mount: sample, draft, ?slug=, ?encrypt=1, remembered mode ── */
  useEffect(() => {
    if (!flags.ready || initDone.current) return;
    initDone.current = true;
    const phone = window.matchMedia(PHONE_QUERY).matches;
    let nextMode = readMode();
    if (flags.get("sample") === DIAGRAM_SAMPLE_PARAM) {
      setTitle(DIAGRAM_SAMPLE.title);
      setContent(DIAGRAM_SAMPLE.content);
      // See the source next to its output on a desktop; a phone has room for one, so show the result.
      nextMode = phone ? "preview" : "split";
    } else {
      const d = readDraft();
      if (d) {
        setTitle(d.title);
        setContent(d.content);
        setDraftNote("restored");
      }
    }
    const slug = flags.get("slug");
    if (slug) setSettings((s) => ({ ...s, slug: slug.trim().slice(0, 50) }));
    if (flags.has("encrypt") && e2e.isSupported()) setSettings((s) => ({ ...s, encrypt: true }));
    if (nextMode) setMode(nextMode);
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent));
    if (!phone) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [flags]);

  /* ── D20 draft: plaintext only, never while Encrypt is on ── */
  useEffect(() => {
    if (encrypt) { clearDraft(); return; }
    if (!edited.current || publishedRef.current) return;
    const t = window.setTimeout(() => {
      if (writeDraft(title, content)) setDraftNote("saved");
      else setDraftNote(null);
    }, 600);
    return () => window.clearTimeout(t);
  }, [title, content, encrypt]);

  /* ── Leave guard while there is unpublished text ── */
  useEffect(() => {
    if (!hasText && !title.trim()) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (publishedRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasText, title]);

  /* ── 429 countdown ── */
  useEffect(() => {
    if (!blockedUntil) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= blockedUntil) setBlockedUntil(null);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [blockedUntil]);
  const secondsLeft = blockedUntil ? Math.max(0, Math.ceil((blockedUntil - now) / 1000)) : 0;
  const blocked = blockedUntil !== null && secondsLeft > 0;

  /* ── Size meter (against the sealed size when Encrypt is on) ── */
  const deferredContent = useDeferredValue(content);
  const deferredTitle = useDeferredValue(title);
  const used = useMemo(
    () => (encrypt ? sealedLength(deferredTitle, deferredContent) : content.length),
    [encrypt, deferredTitle, deferredContent, content.length],
  );
  const remaining = MAX_CHARS - used;
  const nearlyFull = remaining < NEARLY_FULL;
  const meterLabel = remaining >= 0 ? `${fmt(remaining)} characters left` : `${fmt(-remaining)} characters over the limit`;
  const stats = useMemo(() => {
    const text = deferredContent;
    const lines = text ? text.split("\n").length : 0;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return `${fmt(lines)} ${lines === 1 ? "line" : "lines"} · ${fmt(words)} ${words === 1 ? "word" : "words"}`;
  }, [deferredContent]);

  /* ── Validation ── */
  const slugError = slugProblem(settings.slug) ?? slugFailureText(failure);
  const fieldErrors: Partial<Record<PublishField, string>> = {};
  if (slugError) fieldErrors.slug = slugError;

  const summary = publishSummary(settings, { isClient, workspaceName, showEncrypt: e2eSupported });

  function showField(field: PublishField) {
    if (window.matchMedia(PHONE_QUERY).matches) setSheetOpen(true);
    else setOpenPanel(field);
  }

  function onSettingsChange(next: PublishSettingsValue, field: PublishField) {
    setSettings(next);
    if (field === "slug" && (failure?.kind === "slug-taken" || failure?.kind === "slug-reserved")) setFailure(null);
    if (field === "encrypt" && next.encrypt) announce("Encrypt is on. Drafts are not saved on this device while it's on.");
  }

  /* ── Publish ── */
  const handlePublish = useCallback(async () => {
    if (busy || publishedRef.current) return;
    if (!content.trim()) {
      textareaRef.current?.focus();
      return;
    }
    if (blocked) return;
    if (slugProblem(settings.slug)) { showField("slug"); return; }
    if (expiryInvalid(settings.expires)) { showField("expires"); return; }

    setFailure(null);
    const useE2E = settings.encrypt && e2e.isSupported();
    try {
      // Seal before anything leaves the tab. `body` is what the API stores; the key exists only
      // here and, in a moment, in the fragment of the link.
      let body = content;
      let keyFragment = "";
      let encodedKey = "";
      if (useE2E) {
        setPhase("encrypting");
        announce("Encrypting in your browser…");
        const key = await e2e.generateKey();
        body = await e2e.seal(key, { title: title.trim() || null, content });
        encodedKey = await e2e.exportKey(key);
        keyFragment = `#k=${encodedKey}`;
      }
      setPhase("publishing");
      announce("Publishing…");

      const { expiresIn, customExpiresAt } = toApiExpiry(settings.expires);
      const readPassword = settings.password || "";
      const accessLevel = settings.access;
      const target = settings.target;
      const doc = await createDocument(title, body, {
        customSlug: settings.slug.trim() || undefined,
        expiresIn,
        customExpiresAt,
        readPassword: readPassword || undefined,
        encrypted: useE2E || undefined,
        accessLevel: createAccess(accessLevel),
      });
      track("doc_published", { encrypted: !!useE2E, access: accessLevel, password: !!readPassword, expires: !!expiresIn, workspace: !!target.workspaceId });
      // Keep the secret in sessionStorage only — never in the URL (it would leak via history,
      // referrer headers and server logs).
      sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret);

      // Sharing is a second step rather than a field on create: it's the library's rule to enforce
      // (owner-only, role-checked). A failure here must not lose the document, which is already
      // published, so it is carried to the page the author lands on.
      if (target.workspaceId) {
        try {
          await fileIntoWorkspace(target.workspaceId, doc, target.folderId, accessLevel === "workspace" ? "workspace" : undefined);
        } catch {
          try { sessionStorage.setItem(WS_SHARE_FAILED_KEY(doc.slug), "1"); } catch { /* storage unavailable */ }
        }
      }
      // Keep a copy on this device so losing the link isn't automatically fatal. Still never
      // leaves the browser — see lib/e2e.ts.
      if (encodedKey) e2e.rememberKey(doc.slug, encodedKey);
      publishedRef.current = true;
      clearDraft();
      // The fragment survives a client-side push and is never sent to a server.
      router.push(`/${doc.slug}?new=1${keyFragment}`);
    } catch (e) {
      const f = classifyPublishError(e);
      setPhase("idle");
      setFailure(f);
      if (f.kind === "rate") setBlockedUntil(Date.now() + (f.retryAfter ?? 60) * 1000);
      if (f.kind === "slug-taken" || f.kind === "slug-reserved") showField("slug");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, blocked, content, title, settings, router]);

  /* ── ⌘/Ctrl+Enter publishes ── */
  const publishRef = useRef(handlePublish);
  publishRef.current = handlePublish;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      void publishRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── Editor actions ── */
  function onText(v: string) {
    edited.current = true;
    setContent(v);
    if (failure && failure.kind !== "rate") setFailure(null);
  }
  function chooseMode(m: Mode) {
    setMode(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* per-browser convenience only */ }
  }
  function loadSample() {
    edited.current = false;
    setTitle(DIAGRAM_SAMPLE.title);
    setContent(DIAGRAM_SAMPLE.content);
    setMode(window.matchMedia(PHONE_QUERY).matches ? "preview" : "split");
    setConfirm(null);
    announce("Loaded the diagrams sample.");
  }
  function clearEditor() {
    edited.current = false;
    setTitle("");
    setContent("");
    setFailure(null);
    clearDraft();
    setDraftNote(null);
    setConfirm(null);
    announce("Editor cleared.");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }
  function syncScroll() {
    const ta = textareaRef.current;
    const pv = previewRef.current;
    if (!ta || !pv) return;
    const ratio = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
    pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
  }

  const menuItems: MenuItem[] = [
    { label: "Export PDF", icon: "printer", onClick: () => window.print(), disabled: !hasText },
    { label: "Load the diagrams sample", icon: "layers", onClick: () => (hasText ? setConfirm("sample") : loadSample()) },
    { label: "Clear editor", icon: "trash", danger: true, separated: true, disabled: !hasText && !title, onClick: () => setConfirm("clear") },
  ];

  /* ── Phone: bottom bar above the keyboard ── */
  const keyboardInset = useKeyboardInset(isPhone);
  const [barHeight, setBarHeight] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el || !isPhone) { setBarHeight(0); return; }
    const ro = new ResizeObserver(() => setBarHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isPhone]);
  const [stripFocus, setStripFocus] = useState(false);
  const showStrip = isPhone && displayMode === "write" && (taFocused || stripFocus);

  /* ── Pieces ── */
  const publishLabel = phase === "encrypting" ? "Encrypting in your browser…" : phase === "publishing" ? "Publishing…" : "Publish";
  const publishOff = !hasText || blocked;
  const publishReason = !hasText
    ? "Write or paste something to publish."
    : blocked
      ? failure?.kind === "rate" && failure.retryAfter ? `Wait ${secondsLeft} seconds and try again.` : "Wait a minute and try again."
      : null;

  const publishButton = (block?: boolean, size: "md" | "lg" = "md") => {
    const btn = (
      <Button
        variant="primary"
        size={size}
        block={block}
        iconLeft={busy ? undefined : "globe"}
        // Not `loading`: that hides the label, and the label is the status ("Encrypting in your
        // browser…", then "Publishing…"). Clicks while busy are ignored by handlePublish.
        aria-busy={busy || undefined}
        aria-disabled={publishOff || undefined}
        aria-keyshortcuts={isMac ? "Meta+Enter" : "Control+Enter"}
        onClick={() => { void handlePublish(); }}
      >
        {busy && <span aria-hidden className="inline-flex"><Spinner size={14} /></span>}
        {publishLabel}
      </Button>
    );
    return publishReason && !busy ? <Tooltip content={publishReason} side="bottom" className={block ? "block w-full" : undefined}>{btn}</Tooltip> : btn;
  };

  const failureAlert = (() => {
    if (!failure) return null;
    switch (failure.kind) {
      case "slug-taken":
      case "slug-reserved":
        return <Alert tone="danger">{slugFailureText(failure)}</Alert>;
      case "rate":
        return (
          <Alert tone="warning" live title="Too many tries in a short time">
            {failure.retryAfter && secondsLeft > 0
              ? <>Wait <span className="tabular-nums">{secondsLeft}</span> {secondsLeft === 1 ? "second" : "seconds"} and try again.</>
              : "Wait a minute and try again."}
          </Alert>
        );
      case "offline":
        return (
          <Alert tone="danger" icon="wifiOff" title="Couldn't publish — you seem to be offline.">
            {encrypt ? "Your text is still in this tab." : "Your text is still here."}
          </Alert>
        );
      case "unreachable":
        return (
          <Alert tone="danger" title="Can't reach Markdrop right now"
            actions={<Button variant="secondary" size="sm" iconLeft="refresh" onClick={() => { void handlePublish(); }}>Try again</Button>}>
            Check your connection. If it&apos;s working, we&apos;re having trouble — try again in a minute. {encrypt ? "Your text is still in this tab." : "Your text is still here."}
          </Alert>
        );
      case "too-large":
        return <Alert tone="danger" title="Too long to encrypt">{failure.message}</Alert>;
      case "other":
        return <Alert tone="danger" title="Couldn't publish">{failure.message || "Something went wrong on our side. Try again in a minute."}</Alert>;
    }
  })();

  const meter = (
    <Meter
      size="sm"
      value={Math.max(0, Math.min(MAX_CHARS, used))}
      max={MAX_CHARS}
      threshold={(MAX_CHARS - NEARLY_FULL) / MAX_CHARS}
      label={<span className="tabular-nums">{meterLabel}</span>}
      valueText={encrypt ? `${meterLabel}, counted after encryption` : meterLabel}
      meta={nearlyFull ? <span className="inline-flex items-center gap-1"><Icon name="alert" size={12} />Nearly full</span> : undefined}
      className="w-44 shrink-0"
    />
  );

  const draftStatus = encrypt ? (
    <span className="inline-flex min-w-0 items-center gap-1.5"><Icon name="info" size={14} className="shrink-0" />Drafts are not saved on this device while Encrypt is on.</span>
  ) : draftNote === "saved" ? (
    <span className="inline-flex min-w-0 items-center gap-1.5"><Icon name="check" size={14} className="shrink-0" />Draft saved on this device</span>
  ) : draftNote === "restored" ? (
    <span className="inline-flex min-w-0 items-center gap-1.5"><Icon name="history" size={14} className="shrink-0" />Restored your draft from this device</span>
  ) : null;

  const tabsId = `${uid}-mode`.replace(/:/g, "");
  const tabItems = isPhone
    ? [{ value: "write", label: "Write" }, { value: "preview", label: "Preview" }]
    : [{ value: "write", label: "Write" }, { value: "split", label: "Split" }, { value: "preview", label: "Preview" }];
  const modeTabs = (
    <Tabs
      items={tabItems}
      value={displayMode}
      onChange={(v) => chooseMode(v as Mode)}
      variant={isPhone ? "pill" : "line"}
      idPrefix={tabsId}
      aria-label="Editor view"
      // Phones: 44px targets. Desktop: the line sits on the frame's own rule, so drop the tab row's.
      className={isPhone ? "[&_.md-tab]:min-h-[38px] [&_.md-tab]:px-4" : "bg-none"}
    />
  );

  const emptyOverlay = !content && (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-start gap-3 p-4">
      <p className="font-mono text-code text-text-secondary">Paste or type your markdown here</p>
      <div className="pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-1">
        <Button variant="link" size="sm" iconLeft="layers" onClick={loadSample}>Try the diagrams sample</Button>
        <Button variant="link" size="sm" iconLeft="lines" href="/builder">Build a README instead</Button>
      </div>
    </div>
  );

  const textarea = (
    <div className="relative h-full min-h-0">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => onText(e.target.value)}
        onScroll={displayMode === "split" ? syncScroll : undefined}
        onFocus={() => setTaFocused(true)}
        onBlur={() => setTaFocused(false)}
        aria-label="Markdown"
        maxLength={MAX_CHARS}
        spellCheck
        className="block h-full w-full resize-none bg-transparent p-4 font-mono text-code text-text caret-accent-text outline-none"
      />
      {emptyOverlay}
    </div>
  );

  const preview = (emptyText: string) => (
    <div
      ref={previewRef}
      role="region"
      aria-label="Preview"
      tabIndex={0}
      className="md-focus h-full min-h-0 overflow-y-auto bg-surface px-4 py-5 outline-offset-[-2px] sm:px-6"
    >
      {deferredContent.trim() ? (
        <MarkdownPreview content={deferredContent} />
      ) : (
        <div className="grid h-full place-items-center p-6">
          <p className="text-center text-caption text-text-muted">{emptyText}</p>
        </div>
      )}
    </div>
  );

  const panelProps = { id: `${tabsId}-panel-${displayMode}`, role: "tabpanel", "aria-labelledby": `${tabsId}-tab-${displayMode}` } as const;
  const editorBody =
    displayMode === "write" ? (
      <div {...panelProps} className="h-full min-h-0">{textarea}</div>
    ) : displayMode === "split" ? (
      <div {...panelProps} className="h-full min-h-0">
        <SplitPane leftId={`${tabsId}-source`} left={textarea} right={preview("Preview appears here as you type.")} />
      </div>
    ) : (
      <div {...panelProps} className="h-full min-h-0">
        {preview(isPhone ? "Nothing to preview yet. Switch to Write and add some markdown." : "Nothing to preview yet. Switch to Write or Split and add some markdown.")}
      </div>
    );

  const desktopHeadRight = displayMode !== "write" && !isPhone ? (
    <span className="hidden items-center gap-1.5 text-caption text-text-muted lg:inline-flex"><Icon name="eye" size={14} />Rendered as readers will see it</span>
  ) : undefined;

  const statusBar = isPhone ? (
    <>
      <span className={cx("tabular-nums", nearlyFull && "inline-flex items-center gap-1 text-warning")}>
        {nearlyFull && <Icon name="alert" size={12} />}{meterLabel}
      </span>
      <span className="ml-auto">Markdown</span>
    </>
  ) : (
    <>
      <span className="min-w-0">{draftStatus}</span>
      <span className="ml-auto inline-flex flex-wrap items-center gap-x-4 gap-y-0.5">
        <span className="tabular-nums">{stats}</span>
        <span>Markdown</span>
        {displayMode === "split" && <span className="inline-flex items-center gap-1"><Icon name="check" size={12} />Scroll synced</span>}
      </span>
    </>
  );

  return (
    <div
      className="flex h-[calc(100dvh-5.5rem)] min-h-[420px] min-w-0 flex-col gap-3 sm:min-h-[560px]"
      style={isPhone && barHeight ? { paddingBottom: barHeight + 4 } : undefined}
    >
      {/* Print: the title and the rendered document only. */}
      <div className="print-only hidden">
        {title && <h1 className="mb-4 text-h1">{title}</h1>}
        <MarkdownPreview content={content} />
      </div>

      {/* ── Document bar ── */}
      <div className="no-print flex shrink-0 flex-col gap-1.5">
        {/* The title is an input, so the page's heading for assistive tech is a hidden h1. */}
        <h1 className="md-visually-hidden">New document</h1>
        <div className="flex min-w-0 items-center gap-2 text-caption text-text-muted max-sm:hidden">
          <Badge size="sm" dot>Draft</Badge>
          <span className="truncate">{workspaceName ?? "Personal"} · not published yet</span>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => { edited.current = true; setTitle(e.target.value); }}
            placeholder="Untitled document"
            aria-label="Title"
            maxLength={200}
            dir="auto"
            className="min-w-0 flex-1 truncate bg-transparent text-h3 text-text outline-none placeholder:text-text-muted sm:text-h2"
          />
          <div className="flex shrink-0 items-center gap-2 max-sm:hidden">
            {meter}
            <RowMenu items={menuItems} label="More actions" align="right" />
            <span aria-hidden className="mx-1 h-6 w-px bg-border max-md:hidden" />
            {isClient && (
              <span aria-hidden className="inline-flex items-center gap-1 max-md:hidden">
                <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd><Kbd>Enter</Kbd>
              </span>
            )}
            {publishButton()}
          </div>
        </div>
        {busy && (
          <Progress indeterminate size="sm" aria-label={publishLabel} valueText={publishLabel} className="max-sm:hidden" />
        )}
        {!sheetOpen && failureAlert && <div className="mt-1">{failureAlert}</div>}
      </div>

      {/* ── Publish settings (desktop chips) ── */}
      <div className="no-print shrink-0 max-sm:hidden">
        {!isPhone && (
          <PublishSettings
            value={settings}
            onChange={onSettingsChange}
            layout="chips"
            signedIn={signedIn}
            workspaces={workspaces}
            e2eSupported={e2eSupported}
            errors={fieldErrors}
            disabled={busy}
            openPanel={openPanel}
            onOpenPanelChange={setOpenPanel}
          />
        )}
      </div>

      {/* ── Phone: view tabs, settings, more ── */}
      {isPhone && (
        <div className="no-print flex shrink-0 items-center gap-2">
          {modeTabs}
          <span className="relative ml-auto">
            <IconButton
              icon="settings"
              label={summary.changed ? "Publish settings (changed)" : "Publish settings"}
              variant="secondary"
              className="size-11"
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              onClick={() => setSheetOpen(true)}
            />
            {summary.changed && <span aria-hidden className="pointer-events-none absolute top-2 right-2 size-2 rounded-full bg-accent ring-2 ring-bg" />}
          </span>
          <Dropdown
            trigger={<IconButton icon="more" label="More actions" className="size-11" />}
            items={menuItems}
            align="right"
            aria-label="More actions"
          />
        </div>
      )}

      {/* ── Editor ── */}
      <EditorFrame
        icon={null}
        toolbar={!isPhone ? (
          <div className="flex min-w-0 flex-1 items-center gap-3 self-stretch">
            <div className="self-end px-1 pt-1">{modeTabs}</div>
            {displayMode !== "preview" && (
              <>
                <span aria-hidden className="h-5 w-px shrink-0 bg-border" />
                <div className="min-w-0 overflow-x-auto [scrollbar-width:none]">
                  <MarkdownToolbar textareaRef={textareaRef} onChange={onText} bare />
                </div>
              </>
            )}
          </div>
        ) : undefined}
        meter={desktopHeadRight}
        status={statusBar}
        bodyClassName="min-h-0"
        // The head row stretches its children so the tab underline lands on the head's bottom rule.
        className="no-print min-h-0 flex-1 [&>div:first-child]:items-stretch"
      >
        {editorBody}
      </EditorFrame>

      <p className="no-print shrink-0 text-caption text-text-muted max-sm:hidden">
        No login required. Your document gets a shareable link instantly.
      </p>

      {/* ── Phone: sticky bottom bar (formatting strip while typing, summary, Publish) ── */}
      {isPhone && (
        <div
          ref={barRef}
          className="no-print fixed inset-x-0 z-(--z-sticky) border-t border-border bg-bg px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          style={{ bottom: keyboardInset }}
        >
          {busy && <Progress indeterminate size="sm" aria-label={publishLabel} valueText={publishLabel} className="mb-2" />}
          <p className="mb-2 flex min-w-0 items-center gap-1.5 text-caption text-text-secondary">
            <Icon name={settings.access === "private" ? "lock" : settings.access === "workspace" ? "users" : "globe"} size={14} className="shrink-0" />
            <span className="truncate">{summary.text}</span>
          </p>
          {publishButton(true, "lg")}
          {showStrip && (
            <div
              className="-mx-4 mt-2 overflow-x-auto border-t border-border px-2 pt-1 [scrollbar-width:none]"
              onFocus={() => setStripFocus(true)}
              onBlur={() => setStripFocus(false)}
            >
              <MarkdownToolbar textareaRef={textareaRef} onChange={onText} bare large />
            </div>
          )}
        </div>
      )}

      {/* ── Phone: publish settings sheet ── */}
      {isPhone && (
        <Drawer
          side="bottom"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="Publish settings"
          initialFocus={sheetIntroRef}
          footer={publishButton(true, "lg")}
        >
          <div className="flex flex-col gap-4">
            <p ref={sheetIntroRef} tabIndex={-1} className="text-caption text-text-secondary outline-none">{summary.text}</p>
            {failureAlert}
            <PublishSettings
              value={settings}
              onChange={onSettingsChange}
              layout="sheet"
              signedIn={signedIn}
              workspaces={workspaces}
              e2eSupported={e2eSupported}
              errors={fieldErrors}
              disabled={busy}
            />
          </div>
        </Drawer>
      )}

      <ConfirmDialog
        open={confirm === "clear"}
        onClose={() => setConfirm(null)}
        onConfirm={clearEditor}
        title="Clear the editor?"
        body={encrypt ? "This removes the title and the text from this tab." : "This removes the title and the text from this tab and the draft saved on this device."}
        confirmLabel="Clear editor"
      />
      <ConfirmDialog
        open={confirm === "sample"}
        onClose={() => setConfirm(null)}
        onConfirm={loadSample}
        tone="default"
        title="Replace your text with the sample?"
        body={encrypt ? "The diagrams sample replaces what's in the editor." : "The diagrams sample replaces what's in the editor. Your draft on this device is kept until you edit the sample."}
        confirmLabel="Load the sample"
      />
    </div>
  );
}
