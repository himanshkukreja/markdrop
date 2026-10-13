"use client";
/**
 * Markdrop UI primitives. Canonical copy (design-system/scripts/build-bundle.mjs builds the preview
 * bundle from this folder). Depends on react and react-dom only: links go through `LinkProvider`
 * (./link), theme islands through `ThemeScope` (./scope), announcements through `announce` (./status).
 * Server components that need plain data (`ICONS`) import ./icons directly: every export of this
 * module is a client reference on the server, so non-component exports (`cx`) can't be called there.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { ICONS } from "./icons";
import { useLinkComponent } from "./link";
import { PortalScope } from "./scope";

export { ICONS };
export type { IconName } from "./icons";

type ClassValue = string | number | bigint | boolean | null | undefined;
const cx = (...a: ClassValue[]) => a.filter((x): x is string => typeof x === "string" && x.length > 0).join(" ");

/* ── Small hooks ──────────────────────────────────────────────────────── */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const noopSubscribe = () => () => {};
/** false on the server and during hydration, true after: portals render only on the client. */
function useIsClient() { return useSyncExternalStore(noopSubscribe, () => true, () => false); }
function useLatest<T>(value: T) { const r = useRef(value); useIsoLayoutEffect(() => { r.current = value; }); return r; }
function setRef<T>(ref: React.Ref<T> | undefined, value: T | null) { if (typeof ref === "function") ref(value); else if (ref) (ref as React.MutableRefObject<T | null>).current = value; }
function useControllable(value: boolean | undefined, defaultValue: boolean, onChange?: (v: boolean) => void): [boolean, (v: boolean) => void] {
  const [inner, setInner] = useState(defaultValue);
  const controlled = value !== undefined;
  const cb = useLatest(onChange);
  const set = useCallback((v: boolean) => { if (!controlled) setInner(v); cb.current?.(v); }, [controlled, cb]);
  return [controlled ? !!value : inner, set];
}

/* ── Icon ─────────────────────────────────────────────────────────────── */
export interface IconProps extends React.SVGProps<SVGSVGElement> { name: string; size?: number | string; }
export function Icon({ name, size, className, style, ...rest }: IconProps) {
  const d = ICONS[name] ?? "";
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cx("md-icon", className)} style={size ? { fontSize: size, ...style } : style} {...rest}>
      <path d={d} />
    </svg>
  );
}

/* ── Spinner ──────────────────────────────────────────────────────────── */
export interface SpinnerProps { size?: number | string; className?: string; label?: string; }
export function Spinner({ size = 16, className, label }: SpinnerProps) {
  return (
    <svg className={cx("md-spinner", className)} style={{ fontSize: size }} viewBox="0 0 24 24" fill="none" role={label ? "status" : undefined} aria-label={label} aria-hidden={!label}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity=".25" />
      <path fill="currentColor" opacity=".9" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

/* ── Button / IconButton ──────────────────────────────────────────────── */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "inverse" | "link";
export type ButtonSize = "sm" | "md" | "lg";
export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant; size?: ButtonSize; loading?: boolean; block?: boolean;
  iconLeft?: string; iconRight?: string;
  /** Renders a link (through LinkProvider, so next/link in the app). */
  href?: string; target?: string; rel?: string; download?: boolean | string;
  type?: "button" | "submit" | "reset";
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, block, iconLeft, iconRight, href, target, rel, download, className, children, disabled, type = "button", ...rest }, ref) {
  const L = useLinkComponent();
  const cls = cx("md-btn", `md-btn--${variant}`, `md-btn--${size}`, block && "md-btn--block", loading && "md-btn--loading", className);
  const inner = <>
    {iconLeft && <Icon name={iconLeft} />}
    {children}
    {iconRight && <Icon name={iconRight} />}
    {loading && <span className="md-btn__spinner"><Spinner /></span>}
  </>;
  if (href) {
    const off = disabled || loading;
    const { onClick, ...anchorRest } = rest as unknown as React.AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <L className={cls} href={href} target={target} rel={rel ?? (target === "_blank" ? "noopener noreferrer" : undefined)} download={download}
        aria-disabled={off || undefined} aria-busy={loading || undefined}
        onClick={(e: React.MouseEvent<HTMLAnchorElement>) => { if (off) { e.preventDefault(); return; } onClick?.(e); }}
        {...anchorRest}>{inner}</L>
    );
  }
  return <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>{inner}</button>;
});
export interface IconButtonProps extends Omit<ButtonProps, "iconLeft" | "iconRight" | "children"> { icon: string; label: string; }
export function IconButton({ icon, label, variant = "ghost", className, title, ...rest }: IconButtonProps) {
  return <Button variant={variant} className={cx("md-iconbtn", className)} aria-label={label} title={title ?? label} {...rest}><Icon name={icon} /></Button>;
}

/* ── Input / Textarea / Select ────────────────────────────────────────── */
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  size?: "sm" | "md"; invalid?: boolean; mono?: boolean;
  /** Icon adornment: a string is an icon name, anything else renders as-is. */
  prefix?: React.ReactNode; suffix?: React.ReactNode;
  /** Aliases of prefix/suffix (icon adornments). */
  iconPrefix?: React.ReactNode; iconSuffix?: React.ReactNode;
  /** Literal text attached inside the field border, e.g. "markdrop.in/". Follows `mono`. */
  textPrefix?: string; textSuffix?: string;
  /** Class for the wrapper rendered when there are adornments. */
  wrapClassName?: string;
}
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = "md", invalid, mono, prefix, suffix, iconPrefix, iconSuffix, textPrefix, textSuffix, wrapClassName, className, ...rest }, fref) {
  const local = useRef<HTMLInputElement | null>(null);
  const textId = useId();
  // A string prefix/suffix that isn't an icon name is literal text (the canvas boards pass
  // prefix="markdrop.in/"); the old behaviour drew it as an unknown icon, i.e. an empty box.
  const literal = (v: React.ReactNode) => (typeof v === "string" && !Object.prototype.hasOwnProperty.call(ICONS, v) ? v : undefined);
  if (textPrefix === undefined && literal(prefix) !== undefined) { textPrefix = literal(prefix); prefix = undefined; }
  if (textSuffix === undefined && literal(suffix) !== undefined) { textSuffix = literal(suffix); suffix = undefined; }
  const ip = iconPrefix ?? prefix, is = iconSuffix ?? suffix;
  const adorn = (n: React.ReactNode) => (typeof n === "string" ? <Icon name={n} /> : n);
  const refCb = useCallback((el: HTMLInputElement | null) => { local.current = el; setRef(fref, el); }, [fref]);
  if (textPrefix || textSuffix) {
    const described = [rest["aria-describedby"], textPrefix ? textId : undefined].filter(Boolean).join(" ") || undefined;
    return (
      <div className={cx("md-input-group", size === "sm" && "md-input-group--sm", invalid && "md-input-group--invalid", mono && "md-input-group--mono", rest.disabled && "md-input-group--disabled", wrapClassName)}
        onMouseDown={(e) => { if (e.target !== local.current && !(e.target as HTMLElement).closest("button,a,input")) { e.preventDefault(); local.current?.focus(); } }}>
        {ip ? <span className="md-input-group__icon">{adorn(ip)}</span> : null}
        {textPrefix && <span id={textId} className="md-input-group__text">{textPrefix}</span>}
        <input ref={refCb} className={cx("md-input", "md-input--bare", mono && "md-input--mono", className)} aria-invalid={invalid || undefined} {...rest} aria-describedby={described} />
        {textSuffix && <span className="md-input-group__text md-input-group__text--suffix">{textSuffix}</span>}
        {is ? <span className="md-input-group__icon">{adorn(is)}</span> : null}
      </div>
    );
  }
  const el = <input ref={refCb} className={cx("md-input", size === "sm" && "md-input--sm", invalid && "md-input--invalid", mono && "md-input--mono", className)} aria-invalid={invalid || undefined} {...rest} />;
  if (!ip && !is) return el;
  return (
    <div className={cx("md-input-wrap", !!ip && "md-input-wrap--prefix", !!is && "md-input-wrap--suffix", wrapClassName)}>
      {ip ? <span className="md-input__adorn md-input__adorn--prefix">{adorn(ip)}</span> : null}
      {el}
      {is ? <span className="md-input__adorn md-input__adorn--suffix">{adorn(is)}</span> : null}
    </div>
  );
});
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { invalid?: boolean; mono?: boolean; }
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, mono, className, ...rest }, ref) {
  return <textarea ref={ref} className={cx("md-textarea", invalid && "md-textarea--invalid", mono && "md-input--mono", className)} aria-invalid={invalid || undefined} {...rest} />;
});
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> { invalid?: boolean; options?: Array<{ value: string; label: string; disabled?: boolean }>; }
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select({ invalid, options, className, children, ...rest }, ref) {
  return (
    <div className="md-select-wrap">
      <select ref={ref} className={cx("md-select", invalid && "md-select--invalid", className)} aria-invalid={invalid || undefined} {...rest}>
        {options ? options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>) : children}
      </select>
      <span className="md-input__adorn"><Icon name="chevronDown" /></span>
    </div>
  );
});

/* ── Field ────────────────────────────────────────────────────────────── */
export interface FieldProps { label?: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; required?: boolean; htmlFor?: string; children: React.ReactElement; className?: string; }
export function Field({ label, hint, error, required, htmlFor, children, className }: FieldProps) {
  const auto = useId();
  const child = children as React.ReactElement<any>;
  const id = htmlFor ?? child.props.id ?? auto;
  const hintId = hint ? id + "-hint" : undefined, errId = error ? id + "-err" : undefined;
  const describedBy = [child.props["aria-describedby"], hintId, errId].filter(Boolean).join(" ") || undefined;
  const cloned = React.cloneElement(child, { id, invalid: !!error || child.props.invalid, "aria-describedby": describedBy, required: required ?? child.props.required });
  return (
    <div className={cx("md-field", className)}>
      {label && <label className="md-field__label" htmlFor={id}>{label}{required && <span className="md-field__req" aria-hidden>*</span>}</label>}
      {cloned}
      {hint && !error && <div id={hintId} className="md-field__hint">{hint}</div>}
      {error && <div id={errId} className="md-field__error" role="alert"><Icon name="alertCircle" /> {error}</div>}
    </div>
  );
}

/* ── Checkbox / Radio / Switch ────────────────────────────────────────── */
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> { label?: React.ReactNode; description?: React.ReactNode; indeterminate?: boolean; }
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, description, indeterminate, disabled, className, ...rest }, fref) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <label className={cx("md-check", disabled && "md-check--disabled", className)}>
      <input type="checkbox" ref={el => { ref.current = el; setRef(fref, el); }} disabled={disabled} {...rest} />
      <span className="md-check__box"><Icon name={indeterminate ? "minus" : "check"} /></span>
      {(label || description) && <span className="md-check__text"><span>{label}</span>{description && <span className="md-check__desc">{description}</span>}</span>}
    </label>
  );
});
export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> { label?: React.ReactNode; description?: React.ReactNode; }
export function Radio({ label, description, disabled, className, ...rest }: RadioProps) {
  return (
    <label className={cx("md-check md-check--radio", disabled && "md-check--disabled", className)}>
      <input type="radio" disabled={disabled} {...rest} />
      <span className="md-check__box" />
      {(label || description) && <span className="md-check__text"><span>{label}</span>{description && <span className="md-check__desc">{description}</span>}</span>}
    </label>
  );
}
export interface RadioGroupProps { name: string; value?: string; onChange?: (v: string) => void; options: Array<{ value: string; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean }>; row?: boolean; "aria-label"?: string; "aria-labelledby"?: string; }
export function RadioGroup({ name, value, onChange, options, row, ...rest }: RadioGroupProps) {
  return (
    <div role="radiogroup" className={cx("md-radiogroup", row && "md-radiogroup--row")} {...rest}>
      {options.map(o => <Radio key={o.value} name={name} value={o.value} checked={value === o.value} onChange={() => onChange?.(o.value)} label={o.label} description={o.description} disabled={o.disabled} />)}
    </div>
  );
}
export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> { label?: React.ReactNode; }
export function Switch({ label, disabled, className, ...rest }: SwitchProps) {
  return (
    <label className={cx("md-switch", disabled && "md-switch--disabled", className)}>
      <input type="checkbox" role="switch" disabled={disabled} {...rest} />
      <span className="md-switch__track" />
      {label && <span>{label}</span>}
    </label>
  );
}

/* ── SegmentedControl (radio semantics) ───────────────────────────────── */
export interface SegmentedOption<V extends string = string> { value: V; label: React.ReactNode; icon?: string; disabled?: boolean; "aria-label"?: string; }
export interface SegmentedControlProps<V extends string = string> {
  /** The checked value. `undefined`/`null` renders with nothing checked (e.g. the theme before mount). */
  value: V | undefined | null;
  onChange: (value: V) => void;
  options: Array<SegmentedOption<V>>;
  "aria-label"?: string; "aria-labelledby"?: string;
  size?: "sm" | "md";
  /** Show icons only; string labels become each option's accessible name and title. */
  iconOnly?: boolean;
  /** Stretch to the container width, options sharing it equally. */
  block?: boolean;
  disabled?: boolean;
  className?: string; id?: string;
}
export function SegmentedControl<V extends string = string>({ value, onChange, options, size = "md", iconOnly, block, disabled, className, ...aria }: SegmentedControlProps<V>) {
  const ref = useRef<HTMLDivElement>(null);
  const usable = (i: number) => !disabled && !options[i]?.disabled;
  const checked = options.findIndex(o => o.value === value);
  const tabbable = checked >= 0 && usable(checked) ? checked : options.findIndex((_, i) => usable(i));
  const go = (from: number, step: number | "first" | "last") => {
    const n = options.length; let i = step === "first" ? -1 : step === "last" ? n : from;
    const dir = step === "last" ? -1 : step === "first" ? 1 : step;
    for (let k = 0; k < n; k++) { i = (i + dir + n) % n; if (usable(i)) break; }
    if (!usable(i)) return;
    onChange(options[i]!.value);
    (ref.current?.children[i] as HTMLElement | undefined)?.focus();
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const inMenu = !!ref.current?.closest('[role="menu"]');
    let step: number | "first" | "last" | null = null;
    if (e.key === "ArrowRight" || (!inMenu && e.key === "ArrowDown")) step = 1;
    else if (e.key === "ArrowLeft" || (!inMenu && e.key === "ArrowUp")) step = -1;
    else if (e.key === "Home") step = "first";
    else if (e.key === "End") step = "last";
    if (step === null) return;
    e.preventDefault(); e.stopPropagation(); go(i, step);
  };
  return (
    <div ref={ref} role="radiogroup" aria-disabled={disabled || undefined} className={cx("md-seg", size === "sm" && "md-seg--sm", block && "md-seg--block", iconOnly && "md-seg--icons", className)} {...aria}>
      {options.map((o, i) => {
        const name = o["aria-label"] ?? (iconOnly && typeof o.label === "string" ? o.label : undefined);
        return (
          <button key={o.value} type="button" role="radio" className="md-seg__opt" aria-checked={o.value === value} tabIndex={i === tabbable ? 0 : -1}
            disabled={disabled || o.disabled} aria-label={name} title={iconOnly ? name : undefined}
            onClick={() => { if (o.value !== value) onChange(o.value); }} onKeyDown={e => onKey(e, i)}>
            {o.icon && <Icon name={o.icon} />}{!iconOnly && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ── Badge / Tag / Kbd ────────────────────────────────────────────────── */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone; variant?: "soft" | "solid" | "outline"; size?: "sm" | "md"; dot?: boolean; icon?: string; upper?: boolean;
  /** A breathing dot (2s opacity pulse; static under reduced motion), for "live" states. */
  live?: boolean;
}
export function Badge({ tone = "neutral", variant = "soft", size = "md", dot, live, icon, upper, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx("md-badge", `md-badge--${tone}`, variant !== "soft" && `md-badge--${variant}`, size === "sm" && "md-badge--sm", upper && "md-badge--upper", className)} {...rest}>
      {(dot || live) && <span className={cx("md-badge__dot", live && "md-badge__dot--live")} aria-hidden />}
      {icon && <Icon name={icon} />}{children}
    </span>
  );
}
export interface TagProps { children: React.ReactNode; onRemove?: () => void; className?: string; removeLabel?: string; }
export function Tag({ children, onRemove, className, removeLabel = "Remove" }: TagProps) {
  return <span className={cx("md-tag", !onRemove && "md-tag--plain", className)}>{children}{onRemove && <button type="button" className="md-tag__x" aria-label={removeLabel} onClick={onRemove}><Icon name="x" /></button>}</span>;
}
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) { return <kbd className={cx("md-kbd", className)}>{children}</kbd>; }

/* ── Avatar ───────────────────────────────────────────────────────────── */
export interface AvatarProps { name: string; src?: string; size?: "sm" | "md" | "lg" | "xl"; status?: "online" | "away" | "offline"; neutral?: boolean; className?: string; }
export function Avatar({ name, src, size = "md", status, neutral, className }: AvatarProps) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("");
  return (
    <span className={cx("md-avatar", `md-avatar--${size}`, neutral && "md-avatar--neutral", className)} title={name} aria-label={name} role="img">
      {src ? <img src={src} alt="" /> : initials}
      {status && <span className={cx("md-avatar__status", status !== "online" && `md-avatar__status--${status}`)} />}
    </span>
  );
}
export function AvatarGroup({ children, className }: { children: React.ReactNode; className?: string }) { return <span className={cx("md-avatar-group", className)}>{children}</span>; }

/* ── Card ─────────────────────────────────────────────────────────────── */
export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; footer?: React.ReactNode; interactive?: boolean; inset?: boolean; compact?: boolean; }
export function Card({ title, description, actions, footer, interactive, inset, compact, className, children, onKeyDown, ...rest }: CardProps) {
  return (
    <div className={cx("md-card", interactive && "md-card--interactive", inset && "md-card--inset", compact && "md-card--compact", className)} tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive && rest.onClick ? (e) => { onKeyDown?.(e); if (!e.defaultPrevented && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.currentTarget.click(); } } : onKeyDown}
      {...rest}>
      {(title || actions) && <div className="md-card__header"><div>{title && <h3 className="md-card__title">{title}</h3>}{description && <p className="md-card__desc">{description}</p>}</div>{actions}</div>}
      {children !== undefined && <div className="md-card__body">{children}</div>}
      {footer && <div className="md-card__footer">{footer}</div>}
    </div>
  );
}

/* ── Tabs / RouterTabs ────────────────────────────────────────────────── */
export interface TabItem { value: string; label: React.ReactNode; icon?: string; count?: number; disabled?: boolean; }
export interface TabsProps {
  items: TabItem[]; value: string; onChange: (v: string) => void; variant?: "line" | "pill";
  /** Pill only: "sm" is the compact pill (28px). */
  size?: "sm" | "md";
  /** When set, tabs get ids `${idPrefix}-tab-${value}` and aria-controls `${idPrefix}-panel-${value}`. */
  idPrefix?: string;
  "aria-label"?: string; "aria-labelledby"?: string; className?: string;
}
export function Tabs({ items, value, onChange, variant = "line", size = "md", idPrefix, className, ...rest }: TabsProps) {
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = items.length; let next = -1;
    const scan = (start: number, dir: number) => { let j = start; for (let k = 0; k < n; k++) { j = (j + dir + n) % n; if (!items[j]!.disabled) return j; } return -1; };
    if (e.key === "ArrowRight") next = scan(i, 1);
    else if (e.key === "ArrowLeft") next = scan(i, -1);
    else if (e.key === "Home") next = scan(-1, 1);
    else if (e.key === "End") next = scan(n, -1);
    else return;
    e.preventDefault(); if (next < 0) return;
    onChange(items[next]!.value);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="tablist" className={cx("md-tabs", `md-tabs--${variant}`, size === "sm" && "md-tabs--sm", className)} {...rest}>
      {items.map((t, i) => (
        <button key={t.value} role="tab" type="button" className="md-tab" aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1} disabled={t.disabled}
          id={idPrefix ? `${idPrefix}-tab-${t.value}` : undefined} aria-controls={idPrefix ? `${idPrefix}-panel-${t.value}` : undefined}
          onClick={() => onChange(t.value)} onKeyDown={e => onKey(e, i)}>
          {t.icon && <Icon name={t.icon} />}{t.label}{t.count !== undefined && <span className="md-tab__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
export interface RouterTabItem { href: string; label: React.ReactNode; value?: string; icon?: string; count?: number; }
export interface RouterTabsProps { items: RouterTabItem[]; /** The active item's value (defaults to its href). */ value: string; variant?: "line" | "pill"; size?: "sm" | "md"; "aria-label"?: string; className?: string; }
/** Tabs that are links (one per route): a nav with aria-current="page", not role=tab. */
export function RouterTabs({ items, value, variant = "line", size = "md", className, ...rest }: RouterTabsProps) {
  const L = useLinkComponent();
  return (
    <nav className={cx("md-tabs", `md-tabs--${variant}`, size === "sm" && "md-tabs--sm", className)} {...rest}>
      {items.map(t => {
        const active = (t.value ?? t.href) === value;
        return <L key={t.href} href={t.href} className="md-tab" aria-current={active ? "page" : undefined}>{t.icon && <Icon name={t.icon} />}{t.label}{t.count !== undefined && <span className="md-tab__count">{t.count}</span>}</L>;
      })}
    </nav>
  );
}

/* ── Overlay plumbing: layer stack, focus, scroll lock, presence ──────── */
const FOCUSABLE = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),iframe,summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.getClientRects().length > 0);
}
function trapTab(e: React.KeyboardEvent, panel: HTMLElement | null) {
  if (e.key !== "Tab" || e.defaultPrevented || !panel) return;
  const f = focusables(panel);
  if (!f.length) { e.preventDefault(); panel.focus(); return; }
  const first = f[0]!, last = f[f.length - 1]!, a = document.activeElement;
  if (e.shiftKey && (a === first || a === panel || !panel.contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (a === last || !panel.contains(a))) { e.preventDefault(); first.focus(); }
}

/**
 * The overlay stack. Every open Dialog, Drawer, Dropdown and Popover registers a layer. One document
 * listener routes Escape to the topmost layer only and stops it there (stopPropagation +
 * preventDefault), so a viewer's own window-level Escape handler (exit immersive) never also fires.
 * A control inside an overlay that wants Escape for itself calls preventDefault first; the layer
 * then leaves itself open but still stops the event.
 */
interface Layer { onEscape: () => void; el: () => HTMLElement | null; modal: boolean; }
const layers: Layer[] = [];
function onLayerKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.stopPropagation();
  if (e.defaultPrevented) return;
  e.preventDefault();
  top.onEscape();
}
function onLayerFocus(e: FocusEvent) {
  let m = -1;
  for (let i = layers.length - 1; i >= 0; i--) if (layers[i]!.modal) { m = i; break; }
  if (m < 0) return;
  const t = e.target;
  if (!(t instanceof Node) || t === document) return;
  for (let i = m; i < layers.length; i++) { const el = layers[i]!.el(); if (el && el.contains(t)) return; }
  if (t instanceof Element && t.closest(".md-toasts, [data-md-focus-free]")) return;
  const el = layers[m]!.el();
  if (el) (focusables(el)[0] ?? el).focus();
}
function useOverlayLayer(active: boolean, onEscape: () => void, getEl: () => HTMLElement | null, modal: boolean) {
  const esc = useLatest(onEscape), get = useLatest(getEl);
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { onEscape: () => esc.current(), el: () => get.current(), modal };
    if (!layers.length) { document.addEventListener("keydown", onLayerKey); document.addEventListener("focusin", onLayerFocus); }
    layers.push(layer);
    return () => {
      const i = layers.indexOf(layer); if (i >= 0) layers.splice(i, 1);
      if (!layers.length) { document.removeEventListener("keydown", onLayerKey); document.removeEventListener("focusin", onLayerFocus); }
    };
  }, [active, modal, esc, get]);
}

/** Body scroll lock with a count, so nested overlays restore exactly what was there before the first. */
let lockCount = 0;
let lockSaved: { overflow: string; paddingRight: string } | null = null;
function lockScroll() {
  if (lockCount++ > 0) return;
  const b = document.body, html = document.documentElement;
  lockSaved = { overflow: b.style.overflow, paddingRight: b.style.paddingRight };
  const gutter = window.innerWidth - html.clientWidth;
  const stable = (getComputedStyle(html) as CSSStyleDeclaration & { scrollbarGutter?: string }).scrollbarGutter?.includes("stable");
  if (gutter > 0 && !stable) b.style.paddingRight = `calc(${getComputedStyle(b).paddingRight} + ${gutter}px)`;
  b.style.overflow = "hidden";
}
function unlockScroll() {
  if (lockCount === 0 || --lockCount > 0 || !lockSaved) return;
  document.body.style.overflow = lockSaved.overflow;
  document.body.style.paddingRight = lockSaved.paddingRight;
  lockSaved = null;
}

/** `--duration-exit` in ms (0 under reduced motion). */
function exitDuration(): number {
  if (typeof window === "undefined") return 0;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  const v = getComputedStyle(document.documentElement).getPropertyValue("--duration-exit").trim();
  const n = parseFloat(v);
  return isNaN(n) ? 120 : /ms$/.test(v) ? n : n * 1000;
}
/** Keeps an overlay mounted for its exit animation after `open` turns false. */
function usePresence(open: boolean) {
  const [phase, setPhase] = useState<"open" | "closing" | "closed">(open ? "open" : "closed");
  useEffect(() => {
    if (open) { setPhase("open"); return; }
    setPhase(p => (p === "closed" ? p : "closing"));
    const t = setTimeout(() => setPhase("closed"), exitDuration());
    return () => clearTimeout(t);
  }, [open]);
  return { mounted: open || phase !== "closed", closing: !open && phase !== "closed" };
}

/** Modal behaviour shared by Dialog and Drawer: layer, scroll lock, initial focus, focus return. */
function useModal(active: boolean, panel: React.RefObject<HTMLElement | null>, onEscape: () => void, initialFocus?: React.RefObject<HTMLElement | null>) {
  useOverlayLayer(active, onEscape, () => panel.current, true);
  useEffect(() => {
    if (!active) return;
    lockScroll();
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    if (el) {
      const want = initialFocus?.current;
      if (want) want.focus();
      else if (!el.contains(document.activeElement)) (focusables(el).find(f => !f.hasAttribute("data-md-close")) ?? el).focus();
    }
    return () => {
      unlockScroll();
      if (prev && prev !== document.body && prev.isConnected) prev.focus({ preventScroll: true });
    };
    // initialFocus is read once per open, by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/* ── Dialog ───────────────────────────────────────────────────────────── */
export interface DialogProps {
  open: boolean; onClose: () => void; title: React.ReactNode; description?: React.ReactNode;
  children?: React.ReactNode; footer?: React.ReactNode; size?: "sm" | "md" | "lg" | "xl";
  /** "danger" adds the danger glyph; use it only for actions that destroy data or access. */
  tone?: "default" | "danger";
  /** Element to focus on open. Default: the first focusable that isn't the close button, else the dialog. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  hideClose?: boolean;
  /** false: Escape and the scrim don't close it (e.g. while a request runs). Default true. */
  dismissible?: boolean;
  className?: string; bodyClassName?: string;
}
export function Dialog({ open, onClose, title, description, children, footer, size = "md", tone = "default", initialFocus, hideClose, dismissible = true, className, bodyClassName }: DialogProps) {
  const isClient = useIsClient();
  const { mounted, closing } = usePresence(open);
  const panel = useRef<HTMLDivElement>(null);
  const downOnScrim = useRef(false);
  const titleId = useId(), descId = useId();
  const dismiss = () => { if (dismissible) onClose(); };
  useModal(open && isClient, panel, dismiss, initialFocus);
  if (!isClient || !mounted) return null;
  return createPortal(
    <PortalScope>
      <div className={cx("md-scrim", closing && "md-scrim--closing")}
        onMouseDown={e => { downOnScrim.current = e.target === e.currentTarget; }}
        onClick={e => { if (downOnScrim.current && e.target === e.currentTarget) dismiss(); downOnScrim.current = false; }}>
        <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} tabIndex={-1}
          className={cx("md-dialog", size !== "md" && `md-dialog--${size}`, tone === "danger" && "md-dialog--danger", closing && "md-dialog--closing", className)}
          onKeyDown={e => trapTab(e, panel.current)}>
          <div className="md-dialog__head">
            {tone === "danger" && <span className="md-dialog__glyph" aria-hidden><Icon name="alert" /></span>}
            <div className="md-dialog__heading"><h2 id={titleId} className="md-dialog__title">{title}</h2>{description && <p id={descId} className="md-dialog__desc">{description}</p>}</div>
            {!hideClose && <IconButton icon="x" label="Close" size="sm" onClick={onClose} data-md-close="" />}
          </div>
          {children !== undefined && <div className={cx("md-dialog__body", bodyClassName)}>{children}</div>}
          {footer && <div className="md-dialog__foot">{footer}</div>}
        </div>
      </div>
    </PortalScope>,
    document.body,
  );
}

/* ── Drawer ───────────────────────────────────────────────────────────── */
export interface DrawerProps {
  open: boolean; onClose: () => void; title: React.ReactNode; description?: React.ReactNode;
  /** "bottom" is a sheet: grab handle, rounded top, max-height 90dvh, safe-area padding. */
  side?: "right" | "left" | "bottom";
  /** Right/left width (number = px). Default 420; always full width on phones. */
  width?: number | string;
  children?: React.ReactNode; footer?: React.ReactNode;
  initialFocus?: React.RefObject<HTMLElement | null>; hideClose?: boolean; dismissible?: boolean;
  className?: string; bodyClassName?: string;
}
export function Drawer({ open, onClose, title, description, side = "right", width = 420, children, footer, initialFocus, hideClose, dismissible = true, className, bodyClassName }: DrawerProps) {
  const isClient = useIsClient();
  const { mounted, closing } = usePresence(open);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId(), descId = useId();
  const dismiss = () => { if (dismissible) onClose(); };
  useModal(open && isClient, panel, dismiss, initialFocus);
  if (!isClient || !mounted) return null;
  const style = side !== "bottom" ? ({ "--md-drawer-w": typeof width === "number" ? `${width}px` : width } as React.CSSProperties) : undefined;
  return createPortal(
    <PortalScope>
      <div className={cx("md-drawer-scrim", closing && "md-scrim--closing")} onClick={dismiss} aria-hidden />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} tabIndex={-1} style={style}
        className={cx("md-drawer", `md-drawer--${side}`, closing && "md-drawer--closing", className)} onKeyDown={e => trapTab(e, panel.current)}>
        {side === "bottom" && <div className="md-drawer__handle" aria-hidden />}
        <div className="md-drawer__head">
          <div className="md-drawer__heading"><h2 id={titleId}>{title}</h2>{description && <p id={descId} className="md-drawer__desc">{description}</p>}</div>
          {!hideClose && <IconButton icon="x" label="Close" size="sm" onClick={onClose} data-md-close="" />}
        </div>
        <div className={cx("md-drawer__body", bodyClassName)}>{children}</div>
        {footer && <div className="md-drawer__foot">{footer}</div>}
      </div>
    </PortalScope>,
    document.body,
  );
}

/* ── ConfirmDialog ────────────────────────────────────────────────────── */
export interface ConfirmDialogProps {
  open: boolean; onClose: () => void;
  /** May return a promise: the confirm button shows a spinner until it settles; a rejection shows its message. Close the dialog yourself on success. */
  onConfirm: () => void | Promise<unknown>;
  title: React.ReactNode; body?: React.ReactNode; description?: React.ReactNode;
  confirmLabel: React.ReactNode; cancelLabel?: React.ReactNode;
  /** Default "danger". */
  tone?: "danger" | "default";
  /** The confirm button stays disabled until this exact text is typed. */
  typeToConfirm?: string;
  busy?: boolean;
  /** Shown inline as a danger Alert inside the dialog. */
  error?: React.ReactNode;
  size?: DialogProps["size"];
}
export function ConfirmDialog({ open, onClose, onConfirm, title, body, description, confirmLabel, cancelLabel = "Cancel", tone = "danger", typeToConfirm, busy, error, size = "sm" }: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<React.ReactNode>(null);
  const cancelRef = useRef<HTMLButtonElement>(null), confirmRef = useRef<HTMLButtonElement>(null), inputRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => { if (open) { setTyped(""); setFailure(null); setPending(false); } }, [open]);
  const working = !!busy || pending;
  const matches = !typeToConfirm || typed === typeToConfirm;
  const confirm = async () => {
    if (!matches || working) return;
    setFailure(null);
    try {
      const r = onConfirm();
      if (r && typeof (r as Promise<unknown>).then === "function") { setPending(true); await r; }
    } catch (e) {
      if (live.current) setFailure((e as Error)?.message || "Something went wrong. Try again.");
    } finally {
      if (live.current) setPending(false);
    }
  };
  const shown = error ?? failure;
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} size={size} tone={tone === "danger" ? "danger" : "default"} dismissible={!working}
      initialFocus={typeToConfirm ? inputRef : tone === "danger" ? cancelRef : confirmRef}
      footer={<>
        <Button ref={cancelRef} variant="secondary" onClick={onClose} disabled={working}>{cancelLabel}</Button>
        <Button ref={confirmRef} variant={tone === "danger" ? "danger" : "primary"} onClick={confirm} disabled={!matches} loading={working}>{confirmLabel}</Button>
      </>}>
      <div className="md-confirm">
        {body && <div className="md-confirm__body">{body}</div>}
        {typeToConfirm && (
          <Field label={<>Type <strong className="md-confirm__phrase">{typeToConfirm}</strong> to confirm</>}>
            <Input ref={inputRef} value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} mono
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void confirm(); } }} />
          </Field>
        )}
        {shown ? <Alert tone="danger">{shown}</Alert> : null}
      </div>
    </Dialog>
  );
}

/* ── Anchored positioning (Dropdown, Popover) ─────────────────────────── */
function useAnchored(open: boolean, anchor: React.RefObject<HTMLElement | null>, panel: React.RefObject<HTMLElement | null>, opts: { placement: "auto" | "top" | "bottom"; align: "left" | "right"; portal?: boolean; gap?: number }) {
  const [up, setUp] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties | undefined>(undefined);
  const { placement, align, portal, gap = 6 } = opts;
  useIsoLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect(), p = panel.current;
      if (!a || !p) return;
      const h = p.offsetHeight, vh = window.innerHeight, vw = document.documentElement.clientWidth;
      const below = vh - a.bottom, above = a.top;
      const flip = placement === "top" || (placement === "auto" && below < h + gap + 8 && above > below);
      setUp(flip);
      if (portal) {
        const s: React.CSSProperties = { position: "fixed" };
        if (flip) s.bottom = vh - a.top + gap; else s.top = a.bottom + gap;
        if (align === "right") s.right = Math.max(8, vw - a.right); else s.left = Math.max(8, a.left);
        setStyle(s);
      }
    };
    place();
    if (!portal) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, placement, align, portal, gap]);
  return { up, style };
}

/* ── Dropdown (WAI-ARIA menu button) ──────────────────────────────────── */
export interface MenuItem {
  label: React.ReactNode; onClick?: () => void; href?: string; external?: boolean; icon?: string; kbd?: string;
  danger?: boolean; disabled?: boolean; separated?: boolean; busy?: boolean; description?: React.ReactNode; tile?: React.ReactNode;
  /** A quiet third line under the description, e.g. "Needs an account". */
  caption?: React.ReactNode;
}
/** A non-interactive header row. */
export interface MenuHeader { header: React.ReactNode; separated?: boolean; }
/** An arbitrary content row (e.g. the theme SegmentedControl). Arrow keys stop on its first control. */
export interface MenuCustom { custom: React.ReactNode; separated?: boolean; }
export type MenuEntry = MenuItem | MenuHeader | MenuCustom;
export interface DropdownProps {
  trigger: React.ReactElement; items: MenuEntry[]; align?: "left" | "right"; defaultOpen?: boolean; minWidth?: number; className?: string;
  /** Controlled mode. */
  open?: boolean; onOpenChange?: (open: boolean) => void;
  /** "auto" opens below and flips up when there isn't room. */
  placement?: "auto" | "bottom" | "top";
  /** Render the menu in a body portal (fixed position) so overflow containers can't clip it. Stamps the nearest ThemeScope. Don't use inside a Dialog. */
  portal?: boolean;
  menuClassName?: string; "aria-label"?: string;
}
const isHeader = (e: MenuEntry): e is MenuHeader => "header" in e;
const isCustom = (e: MenuEntry): e is MenuCustom => "custom" in e;
export function Dropdown({ trigger, items, align = "right", defaultOpen = false, minWidth, className, open: openProp, onOpenChange, placement = "auto", portal, menuClassName, ...aria }: DropdownProps) {
  const [isOpen, setOpen] = useControllable(openProp, defaultOpen, onOpenChange);
  const isClient = useIsClient();
  const L = useLinkComponent();
  const wrap = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null);
  const intent = useRef<"first" | "last" | "menu" | null>(null);
  const typeahead = useRef({ buf: "", t: 0 as unknown as ReturnType<typeof setTimeout> });
  const uid = useId();
  const tp = (trigger as React.ReactElement<any>).props;
  const triggerId: string = tp.id ?? `${uid}-trigger`, menuId = `${uid}-menu`;

  const triggerEl = () => (document.getElementById(triggerId) ?? wrap.current?.firstElementChild ?? null) as HTMLElement | null;
  const stops = () => (menu.current ? Array.from(menu.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]), [data-md-menu-stop]')) : [])
    .filter(el => !el.hasAttribute("data-md-menu-stop") || focusables(el).length > 0);
  const targetOf = (el: HTMLElement) => el.hasAttribute("data-md-menu-stop") ? (el.querySelector<HTMLElement>('[aria-checked="true"]:not([disabled])') ?? focusables(el)[0] ?? el) : el;
  const focusStop = (which: "first" | "last" | number) => {
    const s = stops(); if (!s.length) { menu.current?.focus(); return; }
    const i = which === "first" ? 0 : which === "last" ? s.length - 1 : ((which % s.length) + s.length) % s.length;
    targetOf(s[i]!).focus();
  };
  const close = (returnFocus: boolean) => { setOpen(false); if (returnFocus) triggerEl()?.focus(); };

  const { up, style } = useAnchored(isOpen, wrap, menu, { placement, align, portal });
  useOverlayLayer(isOpen, () => close(true), () => menu.current, false);
  useEffect(() => {
    if (!isOpen) return;
    const down = (e: MouseEvent) => { const t = e.target as Node; if (wrap.current?.contains(t) || menu.current?.contains(t)) return; setOpen(false); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [isOpen, setOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const want = intent.current; intent.current = null;
    if (want === "first" || want === "last") focusStop(want);
    else if (want === "menu") menu.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
    const s = stops(); const cur = s.findIndex(el => el.contains(t));
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); focusStop(cur < 0 ? 0 : cur + 1); break;
      case "ArrowUp": e.preventDefault(); focusStop(cur < 0 ? -1 : cur - 1); break;
      case "Home": if (inField) return; e.preventDefault(); focusStop("first"); break;
      case "End": if (inField) return; e.preventDefault(); focusStop("last"); break;
      case "Tab": e.preventDefault(); close(true); break;
      case " ": if (t.tagName === "A" && t.getAttribute("role") === "menuitem") { e.preventDefault(); t.click(); } break;
      default: {
        if (inField || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        const ta = typeahead.current; clearTimeout(ta.t); ta.buf += e.key.toLowerCase(); ta.t = setTimeout(() => { ta.buf = ""; }, 500);
        const items = s.filter(el => el.getAttribute("role") === "menuitem");
        const start = Math.max(0, items.findIndex(el => el.contains(t)));
        const order = items.slice(start + (ta.buf.length === 1 ? 1 : 0)).concat(items.slice(0, start + (ta.buf.length === 1 ? 1 : 0)));
        const hit = order.find(el => (el.textContent ?? "").trim().toLowerCase().startsWith(ta.buf));
        if (hit) { e.preventDefault(); hit.focus(); }
      }
    }
  };

  const t = React.cloneElement(trigger as React.ReactElement<any>, {
    id: triggerId, "aria-haspopup": "menu", "aria-expanded": isOpen, "aria-controls": isOpen ? menuId : undefined,
    onClick: (e: React.MouseEvent) => {
      tp.onClick?.(e); if (e.defaultPrevented) return;
      if (isOpen) { setOpen(false); return; }
      intent.current = e.detail === 0 ? "first" : "menu"; setOpen(true);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      tp.onKeyDown?.(e); if (e.defaultPrevented) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault(); const w = e.key === "ArrowDown" ? "first" : "last";
      if (isOpen) focusStop(w); else { intent.current = w; setOpen(true); }
    },
  });

  const menuEl = isOpen ? (
    <div ref={menu} id={menuId} role="menu" tabIndex={-1} aria-label={aria["aria-label"]} aria-labelledby={aria["aria-label"] ? undefined : triggerId}
      className={cx("md-menu", !portal && `md-menu--${align}`, up && "md-menu--up", portal && "md-menu--portal", menuClassName)}
      style={{ ...(minWidth ? { minWidth } : null), ...style }} onKeyDown={onMenuKey}>
      {items.map((it, i) => {
        const sep = it.separated && i > 0 ? <div className="md-menu__sep" role="separator" /> : null;
        if (isHeader(it)) return <React.Fragment key={i}>{sep}<div className="md-menu__header" role="presentation">{it.header}</div></React.Fragment>;
        if (isCustom(it)) return <React.Fragment key={i}>{sep}<div className="md-menu__custom" role="none" data-md-menu-stop="">{it.custom}</div></React.Fragment>;
        const cls = cx("md-menu__item", it.danger && "md-menu__item--danger", (it.description || it.tile || it.caption) && "md-menu__item--rich");
        const body = <>
          {it.tile ?? (it.icon && <Icon name={it.icon} />)}
          <span className="md-menu__text"><span className={it.description || it.caption ? "md-menu__label" : undefined}>{it.label}</span>{it.description && <span className="md-menu__desc">{it.description}</span>}{it.caption && <span className="md-menu__caption">{it.caption}</span>}</span>
          {it.busy ? <Spinner /> : it.kbd ? <Kbd className="md-menu__kbd">{it.kbd}</Kbd> : it.external ? <Icon name="external" /> : null}
        </>;
        const select = (e: React.MouseEvent) => {
          if (it.disabled) { e.preventDefault(); return; }
          close(true); it.onClick?.();
        };
        return (
          <React.Fragment key={i}>
            {sep}
            {it.href
              ? <L role="menuitem" tabIndex={-1} className={cls} aria-disabled={it.disabled || undefined} href={it.href} target={it.external ? "_blank" : undefined} rel={it.external ? "noopener noreferrer" : undefined} onClick={select}>{body}</L>
              : <button role="menuitem" tabIndex={-1} type="button" className={cls} aria-disabled={it.disabled || undefined} aria-busy={it.busy || undefined} onClick={select}>{body}</button>}
          </React.Fragment>
        );
      })}
    </div>
  ) : null;

  return (
    <div ref={wrap} className={cx("md-dropdown", className)}>
      {t}
      {portal ? (isClient && menuEl ? createPortal(<PortalScope>{menuEl}</PortalScope>, document.body) : null) : menuEl}
    </div>
  );
}

/* ── Popover ──────────────────────────────────────────────────────────── */
export interface PopoverProps {
  /** The anchor: gets aria-haspopup="dialog", aria-expanded and click-to-toggle. */
  trigger: React.ReactElement;
  children: React.ReactNode | ((api: { close: () => void }) => React.ReactNode);
  open?: boolean; onOpenChange?: (open: boolean) => void; defaultOpen?: boolean;
  /** Side and alignment; the side flips when there isn't room. Default "bottom-start". */
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
  /** Trap Tab inside the panel (a small modal form). Default false: tabbing out closes it. */
  trap?: boolean;
  portal?: boolean;
  /** Visible heading; also names the dialog. */
  title?: React.ReactNode;
  "aria-label"?: string;
  width?: number | string;
  initialFocus?: React.RefObject<HTMLElement | null>;
  className?: string; panelClassName?: string;
}
export function Popover({ trigger, children, open: openProp, onOpenChange, defaultOpen = false, placement = "bottom-start", trap, portal, title, width, initialFocus, className, panelClassName, ...aria }: PopoverProps) {
  const [isOpen, setOpen] = useControllable(openProp, defaultOpen, onOpenChange);
  const isClient = useIsClient();
  const wrap = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null);
  const intent = useRef(false);
  const uid = useId(); const panelId = `${uid}-pop`, titleId = `${uid}-title`;
  const tp = (trigger as React.ReactElement<any>).props;
  const triggerEl = () => (wrap.current?.firstElementChild ?? null) as HTMLElement | null;
  // Focus returns to the trigger only after the panel's overlay layer has unregistered: focusing it
  // while the layer is live made the modal focus guard pull focus back into the closing panel, which
  // then unmounted and dropped focus to <body>.
  const returnFocus = useRef(false);
  const close = useCallback((back = true) => { returnFocus.current = back; setOpen(false); }, [setOpen]);
  const [side, alignSide] = placement.split("-") as ["bottom" | "top", "start" | "end"];
  const { up, style } = useAnchored(isOpen, wrap, panel, { placement: side === "top" ? "top" : "auto", align: alignSide === "end" ? "right" : "left", portal });
  useOverlayLayer(isOpen, () => close(true), () => panel.current, !!trap);
  useEffect(() => {
    if (isOpen || !returnFocus.current) return;
    returnFocus.current = false;
    triggerEl()?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const down = (e: MouseEvent) => { const t = e.target as Node; if (wrap.current?.contains(t) || panel.current?.contains(t)) return; setOpen(false); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [isOpen, setOpen]);
  useEffect(() => {
    if (!isOpen || !intent.current) return;
    intent.current = false;
    const p = panel.current; if (!p) return;
    (initialFocus?.current ?? focusables(p)[0] ?? p).focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const t = React.cloneElement(trigger as React.ReactElement<any>, {
    "aria-haspopup": "dialog", "aria-expanded": isOpen, "aria-controls": isOpen ? panelId : undefined,
    onClick: (e: React.MouseEvent) => { tp.onClick?.(e); if (e.defaultPrevented) return; if (isOpen) setOpen(false); else { intent.current = true; setOpen(true); } },
  });
  const panelEl = isOpen ? (
    <div ref={panel} id={panelId} role="dialog" aria-modal={trap || undefined} tabIndex={-1}
      aria-label={title ? undefined : aria["aria-label"]} aria-labelledby={title ? titleId : undefined}
      className={cx("md-popover", !portal && (alignSide === "end" ? "md-popover--end" : "md-popover--start"), (up || side === "top") && "md-popover--up", portal && "md-popover--portal", panelClassName)}
      style={{ ...(width !== undefined ? { width } : null), ...style }}
      onKeyDown={e => { if (trap) trapTab(e, panel.current); }}
      onBlur={e => { if (trap) return; const n = e.relatedTarget as Node | null; if (n && !panel.current?.contains(n) && !wrap.current?.contains(n)) setOpen(false); }}>
      {title && <div id={titleId} className="md-popover__title">{title}</div>}
      {typeof children === "function" ? children({ close: () => close(true) }) : children}
    </div>
  ) : null;
  return (
    <div ref={wrap} className={cx("md-popover-wrap", className)}>
      {t}
      {portal ? (isClient && panelEl ? createPortal(<PortalScope>{panelEl}</PortalScope>, document.body) : null) : panelEl}
    </div>
  );
}

/* ── Tooltip ──────────────────────────────────────────────────────────── */
export interface TooltipProps {
  content: React.ReactNode; children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** Legacy alias for side="bottom". */
  below?: boolean;
  /** Make the wrapper focusable, for a non-interactive child (a Badge) whose tooltip must be reachable by keyboard. */
  focusable?: boolean;
  className?: string;
}
/** Shows on hover and on keyboard focus; Escape hides it. Text wraps at 260px. */
export function Tooltip({ content, children, side, below, focusable, className }: TooltipProps) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    // Hover-only tooltips are dismissible too (WCAG 1.4.13), without moving the pointer.
    if (!hovered || dismissed) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setDismissed(true); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [hovered, dismissed]);
  const s = side ?? (below ? "bottom" : "top");
  const child = !focusable && React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<any>, { "aria-describedby": [(children as React.ReactElement<any>).props["aria-describedby"], id].filter(Boolean).join(" ") })
    : children;
  return (
    <span className={cx("md-tip", dismissed && "md-tip--dismissed", className)} tabIndex={focusable ? 0 : undefined} aria-describedby={focusable ? id : undefined}
      onKeyDown={e => { if (e.key === "Escape" && !dismissed) { setDismissed(true); e.preventDefault(); e.stopPropagation(); } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setDismissed(false); }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDismissed(false); }}>
      {child}
      <span role="tooltip" id={id} className={cx("md-tip__bubble", `md-tip__bubble--${s}`)}>{content}</span>
    </span>
  );
}

/* ── Disclosure ───────────────────────────────────────────────────────── */
export interface DisclosureProps {
  summary: React.ReactNode; children?: React.ReactNode;
  defaultOpen?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void;
  className?: string; buttonClassName?: string; panelClassName?: string;
}
export function Disclosure({ summary, children, defaultOpen = false, open, onOpenChange, className, buttonClassName, panelClassName }: DisclosureProps) {
  const [isOpen, setOpen] = useControllable(open, defaultOpen, onOpenChange);
  const id = useId();
  return (
    <div className={cx("md-disclosure", isOpen && "md-disclosure--open", className)}>
      <button type="button" className={cx("md-disclosure__btn", buttonClassName)} aria-expanded={isOpen} aria-controls={id} onClick={() => setOpen(!isOpen)}>
        <Icon name="chevronRight" className="md-disclosure__chev" />{summary}
      </button>
      <div id={id} className={cx("md-disclosure__panel", panelClassName)} hidden={!isOpen}>{children}</div>
    </div>
  );
}

/* ── Toast ────────────────────────────────────────────────────────────── */
export type ToastKind = "success" | "error" | "info";
export interface ToastAction { label: string; onClick: () => void; }
export interface ToastOptions { action?: ToastAction; /** ms; defaults by kind (3200 / 3800 / 6500). */ duration?: number; }
export interface ToastInput extends ToastOptions { message: React.ReactNode; kind?: ToastKind; }
export interface ToastApi {
  /** `toast("Saved")`, `toast("Couldn't save", "error", { action })` or `toast({ message, kind, action })`. Returns the toast id. */
  toast: (message: React.ReactNode | ToastInput, kind?: ToastKind, opts?: ToastOptions) => number;
  success: (message: React.ReactNode, opts?: ToastOptions) => number;
  error: (message: React.ReactNode, opts?: ToastOptions) => number;
  info: (message: React.ReactNode, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}
const ToastCtx = createContext<ToastApi | null>(null);
const DURATION: Record<ToastKind, number> = { success: 3200, info: 3800, error: 6500 };
const TOAST_ICON: Record<ToastKind, string> = { success: "check", error: "alertCircle", info: "info" };
const NOOP_TOASTS: ToastApi = { toast: () => 0, success: () => 0, error: () => 0, info: () => 0, dismiss: () => {} };
const isToastInput = (m: unknown): m is ToastInput => typeof m === "object" && m !== null && !React.isValidElement(m) && "message" in m;
export function useToast(): ToastApi { return useContext(ToastCtx) ?? NOOP_TOASTS; }
interface ToastItem { id: number; kind: ToastKind; message: React.ReactNode; action?: ToastAction; }
/** Toasts sit bottom-left, at most 4; hover or focus pauses the timer. They follow the page theme (never a ThemeScope). */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, { left: number; started: number; t: ReturnType<typeof setTimeout> | null }>());
  const forget = (id: number) => { const m = timers.current.get(id); if (m?.t) clearTimeout(m.t); timers.current.delete(id); };
  const dismiss = useCallback((id: number) => { forget(id); setToasts(ts => ts.filter(x => x.id !== id)); }, []);
  const pause = useCallback((id: number) => { const m = timers.current.get(id); if (!m || !m.t) return; clearTimeout(m.t); m.t = null; m.left -= Date.now() - m.started; }, []);
  const resume = useCallback((id: number) => { const m = timers.current.get(id); if (!m || m.t) return; m.started = Date.now(); m.t = setTimeout(() => dismiss(id), Math.max(1500, m.left)); }, [dismiss]);
  const toast = useCallback((input: React.ReactNode | ToastInput, kind?: ToastKind, opts?: ToastOptions) => {
    const o: ToastInput = isToastInput(input) ? input : { message: input, kind, ...opts };
    const k: ToastKind = o.kind ?? kind ?? "success";
    const id = ++seq.current;
    const ms = o.duration ?? DURATION[k];
    timers.current.set(id, { left: ms, started: Date.now(), t: setTimeout(() => dismiss(id), ms) });
    setToasts(ts => {
      const next = [...ts, { id, kind: k, message: o.message, action: o.action }];
      next.slice(0, Math.max(0, next.length - 4)).forEach(d => forget(d.id));
      return next.slice(-4);
    });
    return id;
  }, [dismiss]);
  useEffect(() => { const p = timers.current; return () => { p.forEach(m => m.t && clearTimeout(m.t)); p.clear(); }; }, []);
  const api = useMemo<ToastApi>(() => ({
    toast, dismiss,
    success: (m, o) => toast(m, "success", o), error: (m, o) => toast(m, "error", o), info: (m, o) => toast(m, "info", o),
  }), [toast, dismiss]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="md-toasts" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} role={t.kind === "error" ? "alert" : undefined} className={cx("md-toast", `md-toast--${t.kind}`)}
            onMouseEnter={() => pause(t.id)} onMouseLeave={e => { if (!e.currentTarget.contains(document.activeElement)) resume(t.id); }}
            onFocus={() => pause(t.id)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover")) resume(t.id); }}>
            <Icon name={TOAST_ICON[t.kind]} />
            <div className="md-toast__msg">
              {t.message}
              {t.action && <button type="button" className="md-toast__action" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
            </div>
            <IconButton className="md-toast__x" icon="x" label="Dismiss" size="sm" onClick={() => dismiss(t.id)} />
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ── Alert ────────────────────────────────────────────────────────────── */
export interface AlertProps {
  tone?: Tone; title?: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode; onDismiss?: () => void; icon?: string | null; className?: string;
  /** Announce changes politely (aria-live). Danger alerts are always role="alert". */
  live?: boolean;
}
const ALERT_ICON: Record<Tone, string> = { neutral: "info", info: "info", success: "checkCircle", warning: "alert", danger: "alertCircle" };
export function Alert({ tone = "info", title, children, actions, onDismiss, icon, className, live }: AlertProps) {
  const a11y = tone === "danger" ? { role: "alert" } : live ? { role: "status", "aria-live": "polite" as const } : {};
  return (
    <div {...a11y} className={cx("md-alert", `md-alert--${tone}`, className)}>
      {icon !== null && <Icon name={icon ?? ALERT_ICON[tone]} />}
      <div className="md-alert__main">{title && <div className="md-alert__title">{title}</div>}{children && <div className="md-alert__body">{children}</div>}{actions && <div className="md-alert__actions">{actions}</div>}</div>
      {onDismiss && <IconButton className="md-alert__x" icon="x" label="Dismiss" size="sm" onClick={onDismiss} />}
    </div>
  );
}

/* ── Progress / Meter / Skeleton ──────────────────────────────────────── */
export interface ProgressProps {
  value?: number; max?: number; label?: React.ReactNode; showValue?: boolean; tone?: "accent" | "success" | "danger"; size?: "sm" | "md"; indeterminate?: boolean; className?: string;
  /** Spoken value, e.g. "3 of 8 files, 42%". */
  valueText?: string;
  /** Right of the label (rate, ETA…). */
  meta?: React.ReactNode;
  /** Name when there's no visible label. */
  "aria-label"?: string;
}
export function Progress({ value = 0, max = 100, label, showValue, tone = "accent", size = "md", indeterminate, className, valueText, meta, ...rest }: ProgressProps) {
  const labelId = useId();
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className={cx("md-progress", tone !== "accent" && `md-progress--${tone}`, size === "sm" && "md-progress--sm", indeterminate && "md-progress--indeterminate", className)}>
      {(label || showValue || meta) && <div className="md-progress__row"><span id={labelId}>{label}</span><span className="md-progress__meta">{meta}{showValue && !indeterminate && <span>{Math.round(pct)}%</span>}</span></div>}
      <div className="md-progress__track" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={indeterminate ? undefined : value} aria-valuetext={valueText}
        aria-labelledby={label ? labelId : undefined} aria-label={label ? undefined : rest["aria-label"]}>
        <div className="md-progress__bar" style={indeterminate ? undefined : { width: pct + "%" }} />
      </div>
    </div>
  );
}
export interface MeterProps {
  value: number; max?: number; label: React.ReactNode;
  valueText?: string;
  /** Fraction of max (0–1) at and above which the meter turns warning (near the cap). */
  threshold?: number;
  /** Visible value right of the label, e.g. "84 MB of 100 MB". */
  meta?: React.ReactNode;
  size?: "sm" | "md"; className?: string;
}
/** A gauge (storage, quota), not task progress: role="meter". */
export function Meter({ value, max = 100, label, valueText, threshold, meta, size = "md", className }: MeterProps) {
  const labelId = useId();
  const frac = Math.max(0, Math.min(1, value / (max || 1)));
  const warn = threshold !== undefined && frac >= threshold;
  return (
    <div className={cx("md-progress md-meter", warn && "md-progress--warning", size === "sm" && "md-progress--sm", className)}>
      <div className="md-progress__row"><span id={labelId}>{label}</span>{meta !== undefined && <span className="md-progress__meta">{meta}</span>}</div>
      <div className="md-progress__track" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={valueText} aria-labelledby={labelId}>
        <div className="md-progress__bar" style={{ width: frac * 100 + "%" }} />
      </div>
    </div>
  );
}
export function Skeleton({ width, height = 14, variant = "text", className, style }: { width?: number | string; height?: number | string; variant?: "text" | "circle" | "rect"; className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={cx("md-skeleton", variant !== "text" && `md-skeleton--${variant}`, className)} style={{ width: width ?? (variant === "circle" ? height : "100%"), height, ...style }} />;
}

/* ── Table ────────────────────────────────────────────────────────────── */
export interface Column<T> { key: string; header: React.ReactNode; render?: (row: T) => React.ReactNode; align?: "left" | "right"; primary?: boolean; width?: number | string; }
export interface TableProps<T> { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; hover?: boolean; compact?: boolean; selected?: (row: T) => boolean; onRowClick?: (row: T) => void; caption?: string; empty?: React.ReactNode; className?: string; }
export function Table<T>({ columns, rows, rowKey, hover = true, compact, selected, onRowClick, caption, empty, className }: TableProps<T>) {
  return (
    <div className={cx("md-table-wrap", className)}>
      <table className={cx("md-table", hover && "md-table--hover", compact && "md-table--compact")}>
        {caption && <caption className="md-visually-hidden">{caption}</caption>}
        <thead><tr>{columns.map(c => <th key={c.key} scope="col" style={{ width: c.width, textAlign: c.align }}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={columns.length} className="md-table__empty">{empty ?? "Nothing here yet."}</td></tr>}
          {rows.map(r => <tr key={rowKey(r)} aria-selected={selected?.(r) || undefined} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: "pointer" } : undefined}>
            {columns.map(c => <td key={c.key} className={cx(c.primary && "md-td--primary", c.align === "right" && "md-td--num")}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "")}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  );
}

/* ── Pagination / Breadcrumb ──────────────────────────────────────────── */
export function Pagination({ page, pageCount, onChange, className }: { page: number; pageCount: number; onChange: (p: number) => void; className?: string }) {
  const pages: Array<number | "…"> = [];
  for (let p = 1; p <= pageCount; p++) { if (p === 1 || p === pageCount || Math.abs(p - page) <= 1) pages.push(p); else if (pages[pages.length - 1] !== "…") pages.push("…"); }
  return (
    <nav aria-label="Pagination" className={cx("md-pages", className)}>
      <button type="button" className="md-pages__btn" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><Icon name="chevronLeft" /></button>
      {pages.map((p, i) => p === "…" ? <span key={"g" + i} className="md-pages__gap" aria-hidden>…</span> : <button key={p} type="button" className="md-pages__btn" aria-label={`Page ${p}`} aria-current={p === page ? "page" : undefined} onClick={() => onChange(p)}>{p}</button>)}
      <button type="button" className="md-pages__btn" disabled={page >= pageCount} onClick={() => onChange(page + 1)} aria-label="Next page"><Icon name="chevronRight" /></button>
    </nav>
  );
}
export function Breadcrumb({ items, className }: { items: Array<{ label: React.ReactNode; href?: string; icon?: string }>; className?: string }) {
  const L = useLinkComponent();
  return (
    <nav aria-label="Breadcrumb"><ol className={cx("md-crumbs", className)}>
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return <li key={i} aria-current={last ? "page" : undefined}>{i > 0 && <Icon name="chevronRight" />}{it.icon && <Icon name={it.icon} style={{ color: "inherit" }} />}{it.href && !last ? <L href={it.href}>{it.label}</L> : <span>{it.label}</span>}</li>;
      })}
    </ol></nav>
  );
}

/* ── EmptyState ───────────────────────────────────────────────────────── */
export function EmptyState({ icon = "inbox", title, description, actions, className }: { icon?: string; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return <div className={cx("md-empty", className)}><div className="md-empty__glyph"><Icon name={icon} /></div><h3 className="md-empty__title">{title}</h3>{description && <p className="md-empty__desc">{description}</p>}{actions && <div className="md-empty__actions">{actions}</div>}</div>;
}

export { cx };
