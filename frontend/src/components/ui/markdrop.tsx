"use client";
/**
 * Markdrop components: logo, loader, header, Create menu, document rows, copy, file icons, route
 * badge, access gate, uploads, toolbar, immersive exit, ambient, explainers. Canonical copy; see
 * primitives.tsx for the rules (react + react-dom only; links via LinkProvider).
 */
import React, { useEffect, useId, useRef, useState } from "react";
import { Avatar, Badge, Button, Dropdown, Icon, IconButton, Input, Kbd, Skeleton, Tooltip, cx } from "./primitives";
import type { ButtonSize, ButtonVariant, MenuItem } from "./primitives";
import { useLinkComponent } from "./link";
import { announce } from "./status";

/* ── Logo / wordmark ──────────────────────────────────────────────────── */
/** The mark's "m" is set in the mono face first; the logo colours are constant (never invert). */
const MONO_STACK = "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace";
export interface MarkdropMarkProps { size?: number; className?: string; /** Accessible name when the mark stands alone (otherwise it's decorative). */ title?: string; }
/** The mark, drawn exactly as app/icon.svg: pill rx 8, mono "m" at 3/23, dot at 27/20 r 4. */
export function MarkdropMark({ size = 32, className, title }: MarkdropMarkProps) {
  const tid = useId();
  const a11y = title ? { role: "img", "aria-labelledby": tid } : { "aria-hidden": true as const };
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} {...a11y}>
      {title && <title id={tid}>{title}</title>}
      <rect width="32" height="32" rx="8" style={{ fill: "var(--logo-ground)" }} />
      <text x="3" y="23" fontSize="18" fontWeight="700" style={{ fontFamily: MONO_STACK, fill: "var(--logo-ink)" }}>m</text>
      <circle cx="27" cy="20" r="4" style={{ fill: "var(--logo-dot)" }} />
    </svg>
  );
}
export function Wordmark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={cx("md-wordmark", className)} style={style}>mark<em>drop</em></span>;
}
export interface MarkdropLogoProps { size?: number; wordmark?: boolean; href?: string; className?: string; /** Accessible name; default "Markdrop home". */ label?: string; }
export function MarkdropLogo({ size = 28, wordmark = true, href = "/", className, label = "Markdrop home" }: MarkdropLogoProps) {
  const L = useLinkComponent();
  return <L href={href} className={cx("md-logo", className)} aria-label={label}><MarkdropMark size={size} />{wordmark && <Wordmark style={{ fontSize: Math.round(size * 0.72) }} />}</L>;
}

/* ── Loader ───────────────────────────────────────────────────────────── */
const SIZES = { sm: { mark: 56, word: 14, bar: 80 }, md: { mark: 78, word: 18, bar: 112 }, lg: { mark: 104, word: 24, bar: 144 } } as const;
export interface MarkdropLoaderProps {
  label?: string | null; size?: keyof typeof SIZES; hideWordmark?: boolean; className?: string;
  /** ms before it renders (default 300), so fast loads never flash a loader. 0 renders at once (also on the server). */
  delay?: number;
}
export function MarkdropLoader({ label = "Loading", size = "md", hideWordmark, className, delay = 300 }: MarkdropLoaderProps) {
  const [shown, setShown] = useState(delay <= 0);
  useEffect(() => {
    if (delay <= 0) { setShown(true); return; }
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  if (!shown) return null;
  const s = SIZES[size];
  return (
    <div className={cx("md-loader", className)} role="status" aria-live="polite" aria-label={label || "Loading"}>
      <svg width={s.mark} height={s.mark} viewBox="-7 -11 46 46" fill="none" aria-hidden className="md-loader__mark">
        <rect width="32" height="32" rx="8" style={{ fill: "var(--logo-ground)" }} />
        <rect x=".5" y=".5" width="31" height="31" rx="7.5" fill="none" stroke="#1e293b" />
        <text x="3" y="23" fontSize="18" fontWeight="700" style={{ fontFamily: MONO_STACK, fill: "var(--logo-ink)" }}>m</text>
        <circle className="md-drop-ripple" cx="27" cy="20" r="4" fill="none" strokeWidth="1.5" style={{ stroke: "var(--logo-dot)" }} />
        <circle className="md-drop-ripple md-drop-ripple-2" cx="27" cy="20" r="4" fill="none" strokeWidth="1" style={{ stroke: "var(--logo-drop)" }} />
        <circle className="md-drop-absorb" cx="27" cy="20" r="4" style={{ fill: "var(--logo-dot)" }} />
        <path className="md-drop-fall" d="M27 3.2c0 0 3 4.1 3 5.8a3 3 0 0 1-6 0c0-1.7 3-5.8 3-5.8z" style={{ fill: "var(--logo-drop)" }} />
      </svg>
      {!hideWordmark && <Wordmark style={{ fontSize: s.word }} />}
      <div className="md-loader__bar" style={{ width: s.bar }}><div /></div>
      {label && <p className="md-loader__label" style={{ margin: 0 }}>{label}</p>}
    </div>
  );
}

/* ── App header (design-system demo; the app's SiteHeader is built on it) ─ */
export interface AppHeaderProps { nav?: Array<{ label: string; href: string; current?: boolean }>; user?: { name: string; src?: string } | null; onSignIn?: () => void; onToggleTheme?: () => void; theme?: "dark" | "light"; className?: string; }
export function AppHeader({ nav = [], user, onSignIn, onToggleTheme, theme = "dark", className }: AppHeaderProps) {
  const L = useLinkComponent();
  return (
    <header className={cx("md-header", className)}>
      <div className="md-header__start">
        <MarkdropLogo />
        {nav.length > 0 && <nav className="md-header__nav" aria-label="Primary">{nav.map(n => <L key={n.href} href={n.href} aria-current={n.current ? "page" : undefined}>{n.label}</L>)}</nav>}
      </div>
      <div className="md-header__actions">
        {onToggleTheme && <IconButton icon={theme === "dark" ? "sun" : "moon"} label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={onToggleTheme} />}
        <CreateMenu signedIn={!!user} />
        {user ? <Avatar name={user.name} src={user.src} /> : <Button variant="secondary" onClick={onSignIn}>Sign in</Button>}
      </div>
    </header>
  );
}

/* ── Create menu ──────────────────────────────────────────────────────── */
type CreateKey = "document" | "artifact" | "builder" | "share";
const CREATE: Array<{ key: CreateKey; href: string; label: React.ReactNode; description: string; icon: string; tint: string }> = [
  { key: "document", href: "/new", label: "Markdown document", description: "Write or paste markdown, publish a link", icon: "lines", tint: "cat-document" },
  { key: "artifact", href: "/upload", label: <>Artifact <Badge tone="warning" size="sm" upper>New</Badge></>, description: "HTML page, PDF, spreadsheet, Word doc or video", icon: "doc", tint: "cat-artifact" },
  { key: "builder", href: "/builder", label: "README builder", description: "Assemble a README from ready-made blocks", icon: "builder", tint: "cat-builder" },
  { key: "share", href: "/share", label: "Send a file", description: "Peer-to-peer. Files are never stored on our servers.", icon: "send", tint: "cat-share" },
];
export interface CreateMenuProps {
  defaultOpen?: boolean;
  /** Signed out, the Artifact row carries the caption "Needs an account". Default true. */
  signedIn?: boolean;
  /** Trigger variant; secondary except where the page has no action of its own (REVAMP_PLAN 4.4). */
  variant?: ButtonVariant;
  size?: ButtonSize;
  align?: "left" | "right";
  /** Override a row's link (e.g. artifact → "/login?next=/upload" when signed out). */
  hrefs?: Partial<Record<CreateKey, string>>;
}
export function CreateMenu({ defaultOpen, signedIn = true, variant = "secondary", size, align = "right", hrefs }: CreateMenuProps) {
  const items: MenuItem[] = CREATE.map(({ key, tint, icon, href, ...it }) => ({
    ...it,
    href: hrefs?.[key] ?? href,
    caption: key === "artifact" && !signedIn ? "Needs an account" : undefined,
    tile: <span className="md-menu__tile" style={{ color: `var(--${tint})`, background: "color-mix(in srgb, currentColor 12%, transparent)" }}><Icon name={icon} /></span>,
  }));
  return <Dropdown defaultOpen={defaultOpen} align={align} minWidth={304} trigger={<Button variant={variant} size={size} iconLeft="plus" iconRight="chevronDown" className="md-create"><span className="md-create__label">Create</span></Button>} items={items} />;
}

/* ── Row menu / document row ──────────────────────────────────────────── */
export function RowMenu({ items, label = "More actions", defaultOpen, portal, align }: { items: MenuItem[]; label?: string; defaultOpen?: boolean; portal?: boolean; align?: "left" | "right" }) {
  return <Dropdown defaultOpen={defaultOpen} portal={portal} align={align} trigger={<IconButton icon="more" label={label} size="sm" />} items={items} />;
}
export interface DocumentRowProps {
  title: string; meta: React.ReactNode; href?: string; icon?: string; badges?: React.ReactNode; actions?: MenuItem[]; onOpen?: () => void; className?: string;
  /** Replaces the icon tile (e.g. a FileIcon tile keyed by renderer). */
  tile?: React.ReactNode;
  /** A quiet trailing control before the row menu (e.g. the access button). */
  trailing?: React.ReactNode;
  hideOpen?: boolean; openLabel?: string;
}
export function DocumentRow({ title, meta, href = "#", icon = "doc", badges, actions, onOpen, className, tile, trailing, hideOpen, openLabel = "Open" }: DocumentRowProps) {
  const L = useLinkComponent();
  return (
    <div className={cx("md-docrow", className)}>
      {tile ?? <span className="md-docrow__icon"><Icon name={icon} /></span>}
      <div className="md-docrow__main"><L href={href} className="md-docrow__title" onClick={onOpen}>{title}{badges}</L><div className="md-docrow__meta">{meta}</div></div>
      <div className="md-docrow__actions">{trailing}{!hideOpen && <Button size="sm" variant="secondary" href={href} iconLeft="external" onClick={onOpen}>{openLabel}</Button>}{actions && <RowMenu items={actions} />}</div>
    </div>
  );
}
export function DocumentRowSkeleton({ className }: { className?: string }) {
  return (
    <div className={cx("md-docrow md-docrow--skeleton", className)} aria-hidden>
      <Skeleton variant="rect" width={36} height={36} />
      <div className="md-docrow__main"><Skeleton width="40%" height={14} /><Skeleton width="62%" height={12} style={{ marginTop: 6 }} /></div>
    </div>
  );
}
DocumentRow.Skeleton = DocumentRowSkeleton;

/* ── Copy ─────────────────────────────────────────────────────────────── */
/** Clipboard write with a textarea fallback (http, older Safari, denied permission). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.setAttribute("data-md-focus-free", ""); ta.setAttribute("aria-hidden", "true");
    Object.assign(ta.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
    const prev = document.activeElement as HTMLElement | null;
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta); prev?.focus?.({ preventScroll: true });
    return ok;
  } catch { return false; }
}
export interface CopyButtonProps {
  text: string; label?: string; copiedLabel?: string; size?: "sm" | "md"; variant?: "secondary" | "ghost" | "primary";
  onCopy?: () => void;
  /** An IconButton named by `label` (default variant ghost). */
  iconOnly?: boolean;
  block?: boolean; className?: string;
  /** What the status region announces; default `copiedLabel`. */
  announceText?: string;
}
/** Copy → "Copied" for 1.6s with a copy→check icon morph; announced through the shared StatusRegion, never aria-live on the button. */
export function CopyButton({ text, label = "Copy link", copiedLabel = "Copied", size = "sm", variant, onCopy, iconOnly, block, className, announceText }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    const ok = await copyText(text);
    if (!ok) { announce("Couldn't copy. Select the text and copy it instead."); return; }
    setCopied(true); onCopy?.(); announce(announceText ?? copiedLabel);
    clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1600);
  }
  const cls = cx("md-copy", copied && "md-copy--done", className);
  if (iconOnly) return <IconButton icon={copied ? "check" : "copy"} label={label} size={size} variant={variant ?? "ghost"} className={cls} onClick={copy} />;
  return <Button size={size} variant={variant ?? "secondary"} block={block} iconLeft={copied ? "check" : "copy"} className={cls} onClick={copy}>{copied ? copiedLabel : label}</Button>;
}

/* ── File icon / route badge ──────────────────────────────────────────── */
const IMG = /\.(png|jpe?g|gif|webp|svg|avif|heic)$/i;
export function isImage(name: string, mime: string) { return mime.startsWith("image/") || IMG.test(name); }
/** The artifact renderers the backend reports; a renderer wins over mime and extension. */
export type FileRenderer = "pdf" | "sheet" | "docx" | "text" | "video" | "html" | "image" | "zip";
export type FileKind = "image" | "video" | "audio" | "pdf" | "sheet" | "archive" | "html" | "document" | "code" | "other";
/** Icon and category token per kind (never a state colour; REVAMP_PLAN 8.1). */
export const FILE_KINDS: Record<FileKind, { icon: string; tint: string }> = {
  image: { icon: "image", tint: "var(--cat-image)" },
  video: { icon: "film", tint: "var(--cat-video)" },
  audio: { icon: "music", tint: "var(--cat-audio)" },
  pdf: { icon: "doc", tint: "var(--cat-pdf)" },
  sheet: { icon: "table", tint: "var(--cat-sheet)" },
  archive: { icon: "archive", tint: "var(--cat-artifact)" },
  html: { icon: "globe", tint: "var(--cat-artifact)" },
  document: { icon: "lines", tint: "var(--cat-document)" },
  code: { icon: "code", tint: "var(--cat-sync)" },
  other: { icon: "doc", tint: "var(--text-muted)" },
};
const RENDERER_KIND: Record<FileRenderer, FileKind> = { pdf: "pdf", sheet: "sheet", docx: "document", text: "document", video: "video", html: "html", image: "image", zip: "archive" };
export function fileKind(name = "", mime = "", renderer?: FileRenderer | null): FileKind {
  if (renderer && RENDERER_KIND[renderer]) return RENDERER_KIND[renderer];
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (isImage(name, mime)) return "image";
  if (mime.startsWith("video/") || /^(mp4|mov|webm|mkv|m4v|avi)$/.test(ext)) return "video";
  if (mime.startsWith("audio/") || /^(mp3|wav|ogg|oga|flac|m4a|aac|opus)$/.test(ext)) return "audio";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (/^(zip|gz|tgz|tar|rar|7z|bz2)$/.test(ext) || mime.includes("zip")) return "archive";
  if (/^(csv|tsv|xlsx?|ods|numbers)$/.test(ext) || mime === "text/csv" || mime.includes("spreadsheet")) return "sheet";
  if (/^(md|markdown|txt|docx?|rtf|odt|pages)$/.test(ext)) return "document";
  if (/^(js|mjs|ts|tsx|jsx|py|go|rs|rb|java|c|cpp|h|json|ya?ml|toml|xml|sql|html?|css|sh)$/.test(ext)) return "code";
  return "other";
}
export interface FileIconProps { name?: string; mime?: string; renderer?: FileRenderer | null; size?: number; className?: string; }
export function FileIcon({ name = "", mime = "", renderer, size = 20, className }: FileIconProps) {
  const k = FILE_KINDS[fileKind(name, mime, renderer)];
  return <Icon name={k.icon} size={size} className={className} style={{ color: k.tint }} />;
}
const ROUTE_COPY = {
  relay: { label: "Relayed", tip: "No direct path between the two networks, so the bytes pass through an encrypted relay. The relay can't read them." },
  direct: { label: "Direct", tip: "Bytes are going straight from one device to the other." },
} as const;
/** Relayed is a state, not a category: neutral tone plus its icon. The explanation is a keyboard-reachable Tooltip. */
export function RouteBadge({ route }: { route: "direct" | "relay" | null | undefined }) {
  if (!route) return null;
  const relay = route === "relay"; const c = ROUTE_COPY[route];
  return <Tooltip focusable content={c.tip}><Badge tone={relay ? "neutral" : "success"} icon={relay ? "wave" : "arrowRight"}>{c.label}</Badge></Tooltip>;
}

/* ── Access gate ──────────────────────────────────────────────────────── */
type Mode = "password" | "signin" | "denied";
const COPY: Record<Mode, { title: string; body: string }> = {
  password: { title: "This document is password protected", body: "Enter the password you were given to open it." },
  signin: { title: "This document is private", body: "It's shared with specific people. Sign in with the address it was shared with and it'll open." },
  denied: { title: "You don't have access", body: "This document is shared with specific people, and this account isn't one of them." },
};
export interface AccessGateProps { mode: Mode; signInHref: string; email?: string | null; value?: string; onValue?: (v: string) => void; onSubmit?: (e: React.SyntheticEvent) => void; submitting?: boolean; error?: string; }
export function AccessGate({ mode, signInHref, email, value = "", onValue, onSubmit, submitting, error }: AccessGateProps) {
  const [show, setShow] = useState(false); const { title, body } = COPY[mode];
  return (
    <div className="md-gate">
      <div className="md-gate__ghost" aria-hidden>{[40, 100, 83, 75, 100, 83, 60, 100, 90].map((w, i) => <span key={i} style={{ width: w + "%" }} />)}</div>
      <div className="md-gate__panel"><div className="md-gate__inner">
        <span className={cx("md-gate__glyph", mode === "denied" ? "md-gate__glyph--amber" : "md-gate__glyph--blue")}><Icon name={mode === "denied" ? "userX" : "lock"} /></span>
        <div><h2 className="md-gate__title">{title}</h2><p className="md-gate__body">{body}{mode === "denied" && email && <> You're signed in as <strong style={{ color: "var(--text)" }}>{email}</strong>.</>}</p></div>
        {mode === "password" && <form className="md-gate__form" onSubmit={e => { e.preventDefault(); onSubmit?.(e); }}>
          <Input type={show ? "text" : "password"} placeholder="Password" value={value} onChange={e => onValue?.(e.target.value)} invalid={!!error} autoComplete="current-password" aria-label="Password"
            suffix={<button type="button" className="md-tag__x" aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow(s => !s)}><Icon name={show ? "eyeOff" : "eye"} /></button>} />
          <Button type="submit" loading={submitting} disabled={!value}>Unlock</Button>
        </form>}
        {error && <div className="md-field__error" role="alert"><Icon name="alertCircle" /> {error}</div>}
        {mode === "signin" && <Button href={signInHref} iconLeft="user">Sign in to open</Button>}
        {mode === "denied" && <Button href={signInHref} variant="secondary">Sign in with another account</Button>}
      </div></div>
    </div>
  );
}

/* ── Asset upload / colour picker ─────────────────────────────────────── */
export interface AssetUploadProps { label: string; hint: string; value: string | null; shape?: "square" | "wide"; disabled?: boolean; onUpload: (file: File) => Promise<void>; onClear: () => void; }
export function AssetUpload({ label, hint, value, shape = "square", disabled, onUpload, onClear }: AssetUploadProps) {
  const input = useRef<HTMLInputElement>(null); const [over, setOver] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [local, setLocal] = useState<string | null>(null);
  const shown = local || value;
  async function take(f: File | undefined) { if (!f || disabled) return; if (!f.type.startsWith("image/")) { setErr("Choose an image file."); return; } setErr(""); setLocal(URL.createObjectURL(f)); setBusy(true); try { await onUpload(f); } catch (e) { setErr((e as Error)?.message || "Upload failed."); setLocal(null); } finally { setBusy(false); } }
  return (
    <div className="md-field">
      <span className="md-field__label">{label}</span>
      <div className={cx("md-dropzone", over && "md-dropzone--over")} onClick={() => input.current?.click()} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}
        role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}>
        <span className={cx("md-dropzone__thumb", shape === "wide" && "md-dropzone__thumb--wide")}>{shown ? <img src={shown} alt="" /> : <Icon name="image" />}</span>
        <div><div className="md-dropzone__text">{busy ? "Uploading…" : shown ? "Drop a new image to replace" : "Drop an image or click to choose"}</div><div className="md-dropzone__hint">{hint}</div></div>
        {shown && !busy && <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); setLocal(null); onClear(); }} style={{ marginLeft: "auto" }}>Remove</Button>}
        <input ref={input} type="file" accept="image/*" hidden onChange={e => take(e.target.files?.[0])} disabled={disabled} />
      </div>
      {err && <div className="md-field__error" role="alert"><Icon name="alertCircle" /> {err}</div>}
    </div>
  );
}
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export function ColorPicker({ value, disabled, onChange, label = "Accent colour" }: { value: string | null; disabled?: boolean; onChange: (hex: string | null) => void; label?: string }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => { setDraft(value ?? ""); }, [value]);
  // The fallback is a value for the native colour input (user data), not a UI colour.
  const current = value && HEX.test(value) ? value : "#3b82f6";
  return (
    <div className="md-field">
      <span className="md-field__label" style={{ justifyContent: "space-between" }}>{label}{value && <Button variant="link" size="sm" onClick={() => onChange(null)} disabled={disabled}>Reset</Button>}</span>
      <div className="md-color">
        <span className="md-color__swatch" style={{ background: current }} title="Pick a colour"><input type="color" value={current} disabled={disabled} onChange={e => onChange(e.target.value)} aria-label="Pick a colour" style={{ opacity: 0 }} /></span>
        <Input mono value={draft} placeholder="#3b82f6" disabled={disabled} onChange={e => { const v = e.target.value; setDraft(v); if (HEX.test(v)) onChange(v); }} invalid={!!draft && !HEX.test(draft)} aria-label="Hex colour" />
      </div>
    </div>
  );
}

/* ── Markdown toolbar ─────────────────────────────────────────────────── */
const ACTIONS = [
  { icon: "bold", title: "Bold", prefix: "**", suffix: "**", ph: "bold text" },
  { icon: "italic", title: "Italic", prefix: "_", suffix: "_", ph: "italic text" },
  { icon: "heading", title: "Heading", prefix: "## ", suffix: "", ph: "Heading", block: true },
  { label: "`", title: "Inline code", prefix: "`", suffix: "`", ph: "code" },
  { icon: "code", title: "Code block", prefix: "```\n", suffix: "\n```", ph: "code here", block: true },
  { icon: "link", title: "Link", prefix: "[", suffix: "](url)", ph: "link text" },
  { icon: "list", title: "List item", prefix: "- ", suffix: "", ph: "item", block: true },
] as const;
export function MarkdownToolbar({ textareaRef, onChange, bare }: { textareaRef: React.RefObject<HTMLTextAreaElement | null>; onChange: (v: string) => void; bare?: boolean }) {
  function apply(a: (typeof ACTIONS)[number]) {
    const ta = textareaRef.current; if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value; const sel = v.slice(s, e) || a.ph;
    const nl = "block" in a && a.block && s > 0 && v[s - 1] !== "\n" ? "\n" : "";
    const next = v.slice(0, s) + nl + a.prefix + sel + a.suffix + v.slice(e);
    onChange(next); requestAnimationFrame(() => { ta.focus(); const p = s + nl.length + a.prefix.length; ta.setSelectionRange(p, p + sel.length); });
  }
  return <div className={cx("md-toolbar", bare && "md-toolbar--bare")} role="toolbar" aria-label="Formatting">{ACTIONS.map(a => <button key={a.title} type="button" className="md-toolbar__btn" title={a.title} aria-label={a.title} onClick={() => apply(a)}>{"icon" in a ? <Icon name={a.icon} size={14} /> : a.label}</button>)}</div>;
}

/* ── Immersive exit / ambient / VS Code ───────────────────────────────── */
export interface ImmersiveExitProps {
  onExit: () => void; placement?: "bottom-right" | "top-right";
  /** The quiet state: a surface chip with a muted icon, never opacity-faded; full again on hover and focus. */
  quiet?: boolean;
  label?: string; className?: string;
}
/** The one way out of the immersive reader: 44px target, full opacity, offset by the safe area. */
export function ImmersiveExit({ onExit, placement = "bottom-right", quiet, label = "Show details", className }: ImmersiveExitProps) {
  return (
    <button type="button" onClick={onExit} aria-label={label} aria-keyshortcuts="Escape"
      className={cx("md-immersive", placement === "top-right" ? "md-immersive--tr" : "md-immersive--br", quiet && "md-immersive--quiet", className)}>
      <Icon name="expand" /><span className="md-immersive__label">{label}</span><Kbd className="md-immersive__kbd">Esc</Kbd>
    </button>
  );
}
/** The landing glow: a dot grid plus one static accent-soft radial. Absolute within its parent (give the parent position:relative and isolation:isolate), or `fixed`. */
export function AmbientBackground({ fixed, className }: { fixed?: boolean; className?: string }) {
  return <div aria-hidden className={cx("md-ambient", fixed && "md-ambient--fixed", className)}><div className="md-ambient__glow" /><div className="md-ambient__grid" /></div>;
}
export function VSCodeIcon({ size = 14, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}><path d="M17.583 2.25 9.21 10.313 4.2 6.52 2 7.58v8.84l2.2 1.06 5.01-3.793 8.373 8.063L22 19.79V4.21l-4.417-1.96zM4.2 13.98V10.02L6.6 12l-2.4 1.98zm13.383 2.19L12.28 12l5.303-4.17v8.34z" /></svg>;
}

/* ── Explainers ───────────────────────────────────────────────────────── */
const XFER_STEPS: Array<[string, string]> = [
  ["Handshake", "Our server only relays a few KB of connection details (WebRTC SDP/ICE), then steps out of the way."],
  ["Encrypted, direct when possible", "Files stream device to device, encrypted with DTLS. If a network blocks a direct path, an encrypted relay forwards the bytes and can't read them."],
  ["Never stored", "Files are never stored on our servers. We keep the file names, sizes and count, a hashed IP, your account if you're signed in, and connection details."],
];
function Peer({ who }: { who: "you" | "them" }) {
  return <div className={cx("md-explainer__peer", `md-explainer__peer--${who}`)}><div><Icon name="globe" /></div>{who === "you" ? "You" : "Recipient"}</div>;
}
/** `relayAvailable` adds the relayed path (only when the relay is confirmed live). */
export function TransferExplainer({ href = "#", relayAvailable }: { href?: string; relayAvailable?: boolean }) {
  const hid = useId();
  return (
    <section className="md-explainer" aria-labelledby={hid}>
      <h2 id={hid} className="md-explainer__head" style={{ margin: 0 }}><Icon name="bulb" />How the transfer works</h2>
      <div className="md-explainer__diagram">
        <Peer who="you" />
        <div className="md-explainer__path" data-label="direct · encrypted"><span className="md-explainer__packet" /></div>
        <Peer who="them" />
      </div>
      {relayAvailable && (
        <div className="md-explainer__diagram md-explainer__diagram--relay">
          <Peer who="you" />
          <div className="md-explainer__path md-explainer__path--relay" data-label="relayed · encrypted" />
          <div className="md-explainer__relay"><div><Icon name="server" /></div>Encrypted relay</div>
          <div className="md-explainer__path md-explainer__path--relay" />
          <Peer who="them" />
        </div>
      )}
      <div className="md-explainer__steps">
        {XFER_STEPS.map(([t, b], i) => <div key={t} className="md-explainer__step"><h3><span>{i + 1}</span>{t}</h3><p>{b}</p></div>)}
      </div>
      <a className="md-explainer__link" href={href}>Read the full technical breakdown <Icon name="arrowRight" /></a>
    </section>
  );
}
export function BulkGuide() {
  const hid = useId();
  const steps = [
    ["checkSquare", "Pick them all at once", <>Select several files — hold <Kbd>⌘</Kbd> / <Kbd>Ctrl</Kbd> to pick, <Kbd>Shift</Kbd> for a range — or drop a whole folder. On a phone, open your photo library and tap <strong>Select</strong>.</>],
    ["link", "Share one link", "One link and one QR code for the whole lot — send it to one person or ten; they can all download at once. Forgot something? Add it while the link is open."],
    ["checkCircle", "They choose what to keep", "Everything in one tap, or just the files they want. Each file saves the moment it arrives, and on an iPhone photos go straight to the camera roll."],
  ] as const;
  return (
    <section className="md-explainer" aria-labelledby={hid}>
      <h2 id={hid} className="md-explainer__head" style={{ margin: 0 }}><Badge tone="info" size="sm" upper>New</Badge>Sending lots of files?</h2>
      <div className="md-explainer__steps" style={{ marginTop: 16 }}>
        {steps.map(([ic, t, b], i) => <div key={t} className="md-explainer__step"><h3><span className="md-explainer__num" style={{ background: "var(--accent-soft)" }}><Icon name={ic} size={12} /></span>{i + 1}. {t}</h3><p>{b}</p></div>)}
      </div>
    </section>
  );
}
