import React, { useEffect, useRef, useState } from "react";
import { Avatar, Badge, Button, Dropdown, Icon, IconButton, Input, Kbd, MenuItem, cx } from "./primitives";

/* ── Logo / wordmark ──────────────────────────────────────────────────── */
export interface MarkdropLogoProps { size?: number; wordmark?: boolean; href?: string; className?: string; }
/** The mark, drawn exactly as app/icon.svg: pill rx 8, mono "m" at 3/23, dot at 27/20 r 4. */
export function MarkdropMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      <rect width="32" height="32" rx="8" fill="var(--logo-ground)" />
      <text x="3" y="23" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontSize="18" fontWeight="700" fill="var(--logo-ink)">m</text>
      <circle cx="27" cy="20" r="4" fill="var(--logo-dot)" />
    </svg>
  );
}
export function Wordmark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={cx("md-wordmark", className)} style={style}>mark<em>drop</em></span>;
}
export function MarkdropLogo({ size = 28, wordmark = true, href = "/", className }: MarkdropLogoProps) {
  return <a href={href} className={cx("md-logo", className)} aria-label="Markdrop home"><MarkdropMark size={size} />{wordmark && <Wordmark style={{ fontSize: Math.round(size * 0.72) }} />}</a>;
}

/* ── Loader ───────────────────────────────────────────────────────────── */
const SIZES = { sm: { mark: 56, word: 14, bar: 80 }, md: { mark: 78, word: 18, bar: 112 }, lg: { mark: 104, word: 24, bar: 144 } } as const;
export interface MarkdropLoaderProps { label?: string | null; size?: keyof typeof SIZES; hideWordmark?: boolean; className?: string; }
export function MarkdropLoader({ label = "Loading", size = "md", hideWordmark, className }: MarkdropLoaderProps) {
  const s = SIZES[size];
  return (
    <div className={cx("md-loader", className)} role="status" aria-live="polite" aria-label={label || "Loading"}>
      <svg width={s.mark} height={s.mark} viewBox="-7 -11 46 46" fill="none" aria-hidden className="md-loader__mark">
        <rect width="32" height="32" rx="8" fill="var(--logo-ground)" />
        <rect x=".5" y=".5" width="31" height="31" rx="7.5" fill="none" stroke="#1e293b" />
        <text x="3" y="23" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontSize="18" fontWeight="700" fill="var(--logo-ink)">m</text>
        <circle className="md-drop-ripple" cx="27" cy="20" r="4" fill="none" stroke="var(--logo-dot)" strokeWidth="1.5" />
        <circle className="md-drop-ripple md-drop-ripple-2" cx="27" cy="20" r="4" fill="none" stroke="var(--logo-drop)" strokeWidth="1" />
        <circle className="md-drop-absorb" cx="27" cy="20" r="4" fill="var(--logo-dot)" />
        <path className="md-drop-fall" d="M27 3.2c0 0 3 4.1 3 5.8a3 3 0 0 1-6 0c0-1.7 3-5.8 3-5.8z" fill="var(--logo-drop)" />
      </svg>
      {!hideWordmark && <Wordmark style={{ fontSize: s.word }} />}
      <div className="md-loader__bar" style={{ width: s.bar }}><div /></div>
      {label && <p className="md-loader__label" style={{ margin: 0 }}>{label}</p>}
    </div>
  );
}

/* ── App header ───────────────────────────────────────────────────────── */
export interface AppHeaderProps { nav?: Array<{ label: string; href: string; current?: boolean }>; user?: { name: string; src?: string } | null; onSignIn?: () => void; onToggleTheme?: () => void; theme?: "dark" | "light"; className?: string; }
export function AppHeader({ nav = [], user, onSignIn, onToggleTheme, theme = "dark", className }: AppHeaderProps) {
  return (
    <header className={cx("md-header", className)}>
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <MarkdropLogo />
        {nav.length > 0 && <nav className="md-header__nav" aria-label="Primary">{nav.map(n => <a key={n.href} href={n.href} aria-current={n.current ? "page" : undefined}>{n.label}</a>)}</nav>}
      </div>
      <div className="md-header__actions">
        {onToggleTheme && <IconButton icon={theme === "dark" ? "sun" : "moon"} label={theme === "dark" ? "Switch to light" : "Switch to dark"} onClick={onToggleTheme} />}
        <CreateMenu />
        {user ? <Avatar name={user.name} src={user.src} /> : <Button variant="secondary" onClick={onSignIn}>Sign in</Button>}
      </div>
    </header>
  );
}

/* ── Create menu ──────────────────────────────────────────────────────── */
const CREATE: Array<MenuItem & { tint: string }> = [
  { href: "/new", label: "Markdown document", description: "Write or paste markdown, publish a link", icon: "lines", tint: "cat-document" },
  { href: "/upload", label: <>Artifact <Badge tone="warning" size="sm" upper>New</Badge></>, description: "PDF, spreadsheet, Word doc or web page", icon: "doc", tint: "cat-artifact" },
  { href: "/builder", label: "README builder", description: "Assemble a README from ready-made blocks", icon: "builder", tint: "cat-builder" },
  { href: "/share", label: "Send a file", description: "Peer-to-peer, nothing stored on our servers", icon: "upload", tint: "cat-share" },
];
export function CreateMenu({ defaultOpen }: { defaultOpen?: boolean }) {
  const items: MenuItem[] = CREATE.map(({ tint, icon, ...it }) => ({ ...it, tile: <span className="md-menu__tile" style={{ color: `var(--${tint})`, background: "color-mix(in srgb, currentColor 12%, transparent)" }}><Icon name={icon!} /></span> }));
  return <Dropdown defaultOpen={defaultOpen} minWidth={304} trigger={<Button iconLeft="plus" iconRight="chevronDown">Create</Button>} items={items} />;
}

/* ── Row menu / document row ──────────────────────────────────────────── */
export function RowMenu({ items, label = "More actions", defaultOpen }: { items: MenuItem[]; label?: string; defaultOpen?: boolean }) {
  return <Dropdown defaultOpen={defaultOpen} trigger={<IconButton icon="more" label={label} size="sm" />} items={items} />;
}
export interface DocumentRowProps { title: string; meta: string; href?: string; icon?: string; badges?: React.ReactNode; actions?: MenuItem[]; onOpen?: () => void; className?: string; }
export function DocumentRow({ title, meta, href = "#", icon = "doc", badges, actions, className }: DocumentRowProps) {
  return (
    <div className={cx("md-docrow", className)}>
      <span className="md-docrow__icon"><Icon name={icon} /></span>
      <div className="md-docrow__main"><a href={href} className="md-docrow__title" style={{ textDecoration: "none", color: "inherit" }}>{title}{badges}</a><div className="md-docrow__meta">{meta}</div></div>
      <div className="md-docrow__actions"><Button size="sm" variant="secondary" href={href} iconLeft="external">Open</Button>{actions && <RowMenu items={actions} />}</div>
    </div>
  );
}

/* ── Copy button ──────────────────────────────────────────────────────── */
export function CopyButton({ text, label = "Copy link", size = "sm", variant = "secondary", onCopy }: { text: string; label?: string; size?: "sm" | "md"; variant?: "secondary" | "ghost" | "primary"; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() { try { await navigator.clipboard.writeText(text); } catch {} setCopied(true); onCopy?.(); setTimeout(() => setCopied(false), 2000); }
  return <Button size={size} variant={variant} iconLeft={copied ? "check" : "copy"} onClick={copy} aria-live="polite">{copied ? "Copied!" : label}</Button>;
}

/* ── File icon / route badge ──────────────────────────────────────────── */
const IMG = /\.(png|jpe?g|gif|webp|svg|avif|heic)$/i;
export function isImage(name: string, mime: string) { return mime.startsWith("image/") || IMG.test(name); }
function kind(name: string, mime: string): { icon: string; tint: string } {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (isImage(name, mime)) return { icon: "image", tint: "var(--pink-400)" };
  if (mime.startsWith("video/")) return { icon: "film", tint: "var(--cat-share)" };
  if (ext === "pdf" || mime === "application/pdf") return { icon: "doc", tint: "var(--danger)" };
  if (/^(zip|gz|tar|rar|7z)$/.test(ext) || mime.includes("zip")) return { icon: "archive", tint: "var(--cat-artifact)" };
  if (/^(csv|xlsx?|tsv)$/.test(ext)) return { icon: "table", tint: "var(--success)" };
  if (/^(md|markdown|txt|docx?)$/.test(ext)) return { icon: "lines", tint: "var(--cat-document)" };
  if (/^(js|ts|tsx|jsx|py|go|rs|json|html|css|sh)$/.test(ext)) return { icon: "code", tint: "var(--cat-sync)" };
  return { icon: "doc", tint: "var(--text-muted)" };
}
export function FileIcon({ name, mime, size = 20 }: { name: string; mime: string; size?: number }) {
  const k = kind(name, mime); return <Icon name={k.icon} size={size} style={{ color: k.tint }} />;
}
export function RouteBadge({ route }: { route: "direct" | "relay" | null }) {
  if (!route) return null; const relay = route === "relay";
  return <Badge tone={relay ? "info" : "success"} icon={relay ? "wave" : "arrowRight"} title={relay ? "No direct path between the two networks, so bytes pass through an encrypted relay. The relay can't read them." : "Bytes are going straight from one device to the other."}>{relay ? "Relayed" : "Direct"}</Badge>;
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
  async function take(f: File | undefined) { if (!f || disabled) return; if (!f.type.startsWith("image/")) { setErr("Choose an image file."); return; } setErr(""); setLocal(URL.createObjectURL(f)); setBusy(true); try { await onUpload(f); } catch (e: any) { setErr(e?.message || "Upload failed."); setLocal(null); } finally { setBusy(false); } }
  return (
    <div className="md-field">
      <span className="md-field__label">{label}</span>
      <div className={cx("md-dropzone", over && "md-dropzone--over")} onClick={() => input.current?.click()} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") input.current?.click(); }}>
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
export function ImmersiveExit({ onExit, placement = "bottom-right" }: { onExit: () => void; placement?: "bottom-right" | "top-right" }) {
  return <button type="button" onClick={onExit} aria-label="Show document details" className={cx("md-immersive", placement === "top-right" ? "md-immersive--tr" : "md-immersive--br")}><Icon name="expand" size={14} />Show details<Kbd>Esc</Kbd></button>;
}
export function AmbientBackground() {
  return <div aria-hidden className="md-ambient"><div className="md-ambient__blob md-ambient__blob--1" /><div className="md-ambient__blob md-ambient__blob--2" /><div className="md-ambient__grid" /></div>;
}
export function VSCodeIcon({ size = 14, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}><path d="M17.583 2.25 9.21 10.313 4.2 6.52 2 7.58v8.84l2.2 1.06 5.01-3.793 8.373 8.063L22 19.79V4.21l-4.417-1.96zM4.2 13.98V10.02L6.6 12l-2.4 1.98zm13.383 2.19L12.28 12l5.303-4.17v8.34z" /></svg>;
}

/* ── Explainers ───────────────────────────────────────────────────────── */
export function TransferExplainer({ href = "#" }: { href?: string }) {
  return (
    <section className="md-explainer" aria-labelledby="md-xfer">
      <h2 id="md-xfer" className="md-explainer__head" style={{ margin: 0 }}><Icon name="bulb" />How the transfer works</h2>
      <div className="md-explainer__diagram">
        <div className="md-explainer__peer md-explainer__peer--you"><div><Icon name="globe" /></div>You</div>
        <div className="md-explainer__path" data-label="direct · encrypted"><span className="md-explainer__packet" /></div>
        <div className="md-explainer__peer md-explainer__peer--them"><div><Icon name="globe" /></div>Recipient</div>
      </div>
      <div className="md-explainer__steps">
        {[["Handshake", "Our server only relays a few KB of connection details (WebRTC SDP/ICE), then steps out of the way."], ["Encrypted, direct when possible", "Files stream device-to-device, encrypted end-to-end with DTLS. If a network blocks that, an encrypted relay carries them — it can't read them."], ["Zero storage", "Nothing is uploaded or saved. Close the tab and the room disappears — no copy to leak."]].map(([t, b], i) =>
          <div key={t} className="md-explainer__step"><h3><span>{i + 1}</span>{t}</h3><p>{b}</p></div>)}
      </div>
      <a className="md-explainer__link" href={href}>Read the full technical breakdown <Icon name="arrowRight" /></a>
    </section>
  );
}
export function BulkGuide() {
  const steps = [
    ["checkSquare", "Pick them all at once", <>Select several files — hold <Kbd>⌘</Kbd> / <Kbd>Ctrl</Kbd> to pick, <Kbd>Shift</Kbd> for a range — or drop a whole folder. On a phone, open your photo library and tap <strong>Select</strong>.</>],
    ["link", "Share one link", "One link and one QR code for the whole lot — send it to one person or ten; they can all download at once. Forgot something? Add it while the link is open."],
    ["checkCircle", "They choose what to keep", "Everything in one tap, or just the files they want. Each file saves the moment it arrives, and on an iPhone photos go straight to the camera roll."],
  ] as const;
  return (
    <section className="md-explainer" aria-labelledby="md-bulk">
      <h2 id="md-bulk" className="md-explainer__head" style={{ margin: 0 }}><Badge tone="info" size="sm" upper>New</Badge>Sending lots of files?</h2>
      <div className="md-explainer__steps" style={{ marginTop: 16 }}>
        {steps.map(([ic, t, b], i) => <div key={t} className="md-explainer__step"><h3><span className="md-explainer__num" style={{ background: "var(--accent-soft)" }}><Icon name={ic} size={12} /></span>{i + 1}. {t}</h3><p>{b}</p></div>)}
      </div>
    </section>
  );
}
