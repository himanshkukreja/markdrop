import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

/* ── Icon ─────────────────────────────────────────────────────────────── */
export const ICONS: Record<string, string> = {
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  chevronDown: "m6 9 6 6 6-6",
  chevronUp: "m18 15-6-6-6 6",
  chevronRight: "m9 18 6-6-6-6",
  chevronLeft: "m15 18-6-6 6-6",
  more: "M12 12h.01M19 12h.01M5 12h.01",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.35-4.35",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  copy: "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  doc: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  lines: "M4 6h16M4 12h10M4 18h13",
  builder: "M4 5h16M4 10h16M4 15h10M4 20h7",
  upload: "M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  download: "M12 4v12m0 0 4-4m-4 4-4-4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  image: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21",
  lock: "M19 10h-1V7a6 6 0 0 0-12 0v3H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zM8 10V7a4 4 0 0 1 8 0v3",
  eye: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  userX: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8-3 5 5m0-5-5 5",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-6v-4m0-4h.01",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4m0 4h.01",
  alertCircle: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14v5m0 4h.01",
  checkCircle: "M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14.01l-3-3",
  bulb: "M9 18h6m-5 4h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z",
  arrowRight: "M5 12h14m-7-7 7 7-7 7",
  wave: "M4 12h4l2-5 4 10 2-5h4",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z",
  trash: "M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6h12z",
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m4-3h6v6m-11 5L21 3",
  code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
  bold: "M6 4h8a4 4 0 0 1 0 8H6zm0 8h9a4 4 0 0 1 0 8H6z",
  italic: "M19 4h-9m4 16H5M15 4 9 20",
  heading: "M6 4v16M18 4v16M6 12h12",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  home: "m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V20a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 18.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 14a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  expand: "M15 3h6v6M9 21H3v-15M21 3l-7 7M3 21l7-7",
  zap: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-16v6l4 2",
  film: "M19.82 2H4.18A2.18 2.18 0 0 0 2 4.18v15.64C2 21.02 2.98 22 4.18 22h15.64A2.18 2.18 0 0 0 22 19.82V4.18A2.18 2.18 0 0 0 19.82 2zM7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5",
  archive: "M21 8v13H3V8M1 3h22v5H1zm9 9h4",
  table: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18",
  checkSquare: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-16v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42",
  moon: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
};
export type IconName = keyof typeof ICONS;
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
  iconLeft?: string; iconRight?: string; href?: string; target?: string; type?: "button" | "submit" | "reset";
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, block, iconLeft, iconRight, href, target, className, children, disabled, type = "button", ...rest }, ref) {
  const cls = cx("md-btn", `md-btn--${variant}`, `md-btn--${size}`, block && "md-btn--block", loading && "md-btn--loading", className);
  const inner = <>
    {iconLeft && <Icon name={iconLeft} />}
    {children}
    {iconRight && <Icon name={iconRight} />}
    {loading && <span className="md-btn__spinner"><Spinner /></span>}
  </>;
  if (href) return <a className={cls} href={href} target={target} rel={target === "_blank" ? "noopener noreferrer" : undefined} aria-disabled={disabled || loading || undefined} {...(rest as any)}>{inner}</a>;
  return <button ref={ref} type={type} className={cls} disabled={disabled || loading} {...rest}>{inner}</button>;
});
export interface IconButtonProps extends Omit<ButtonProps, "iconLeft" | "iconRight" | "children"> { icon: string; label: string; }
export function IconButton({ icon, label, variant = "ghost", className, ...rest }: IconButtonProps) {
  return <Button variant={variant} className={cx("md-iconbtn", className)} aria-label={label} title={label} {...rest}><Icon name={icon} /></Button>;
}

/* ── Input / Textarea / Select ────────────────────────────────────────── */
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  size?: "sm" | "md"; invalid?: boolean; mono?: boolean; prefix?: React.ReactNode; suffix?: React.ReactNode;
}
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ size = "md", invalid, mono, prefix, suffix, className, ...rest }, ref) {
  const el = <input ref={ref} className={cx("md-input", size === "sm" && "md-input--sm", invalid && "md-input--invalid", mono && "md-input--mono", className)} aria-invalid={invalid || undefined} {...rest} />;
  if (!prefix && !suffix) return el;
  return (
    <div className={cx("md-input-wrap", prefix && "md-input-wrap--prefix", suffix && "md-input-wrap--suffix")}>
      {prefix && <span className="md-input__adorn md-input__adorn--prefix">{typeof prefix === "string" ? <Icon name={prefix} /> : prefix}</span>}
      {el}
      {suffix && <span className="md-input__adorn md-input__adorn--suffix">{typeof suffix === "string" ? <Icon name={suffix} /> : suffix}</span>}
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
  const auto = useId(); const id = htmlFor ?? (children.props as any).id ?? auto;
  const hintId = hint ? id + "-hint" : undefined, errId = error ? id + "-err" : undefined;
  const child = React.cloneElement(children, { id, invalid: !!error || (children.props as any).invalid, "aria-describedby": [hintId, errId].filter(Boolean).join(" ") || undefined, required });
  return (
    <div className={cx("md-field", className)}>
      {label && <label className="md-field__label" htmlFor={id}>{label}{required && <span className="md-field__req" aria-hidden>*</span>}</label>}
      {child}
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
      <input type="checkbox" ref={el => { ref.current = el; if (typeof fref === "function") fref(el); else if (fref) (fref as any).current = el; }} disabled={disabled} {...rest} />
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
export interface RadioGroupProps { name: string; value?: string; onChange?: (v: string) => void; options: Array<{ value: string; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean }>; row?: boolean; "aria-label"?: string; }
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

/* ── Badge / Tag / Kbd ────────────────────────────────────────────────── */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> { tone?: Tone; variant?: "soft" | "solid" | "outline"; size?: "sm" | "md"; dot?: boolean; icon?: string; upper?: boolean; }
export function Badge({ tone = "neutral", variant = "soft", size = "md", dot, icon, upper, className, children, ...rest }: BadgeProps) {
  return <span className={cx("md-badge", `md-badge--${tone}`, variant !== "soft" && `md-badge--${variant}`, size === "sm" && "md-badge--sm", upper && "md-badge--upper", className)} {...rest}>{dot && <span className="md-badge__dot" />}{icon && <Icon name={icon} />}{children}</span>;
}
export interface TagProps { children: React.ReactNode; onRemove?: () => void; className?: string; }
export function Tag({ children, onRemove, className }: TagProps) {
  return <span className={cx("md-tag", !onRemove && "md-tag--plain", className)}>{children}{onRemove && <button type="button" className="md-tag__x" aria-label="Remove" onClick={onRemove}><Icon name="x" /></button>}</span>;
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
export function Card({ title, description, actions, footer, interactive, inset, compact, className, children, ...rest }: CardProps) {
  return (
    <div className={cx("md-card", interactive && "md-card--interactive", inset && "md-card--inset", compact && "md-card--compact", className)} tabIndex={interactive ? 0 : undefined} {...rest}>
      {(title || actions) && <div className="md-card__header"><div>{title && <h3 className="md-card__title">{title}</h3>}{description && <p className="md-card__desc">{description}</p>}</div>{actions}</div>}
      {children !== undefined && <div className="md-card__body">{children}</div>}
      {footer && <div className="md-card__footer">{footer}</div>}
    </div>
  );
}

/* ── Tabs ─────────────────────────────────────────────────────────────── */
export interface TabItem { value: string; label: React.ReactNode; icon?: string; count?: number; disabled?: boolean; }
export interface TabsProps { items: TabItem[]; value: string; onChange: (v: string) => void; variant?: "line" | "pill"; "aria-label"?: string; className?: string; }
export function Tabs({ items, value, onChange, variant = "line", className, ...rest }: TabsProps) {
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault(); const n = (i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length; onChange(items[n]!.value);
    (e.currentTarget.parentElement?.children[n] as HTMLElement)?.focus();
  };
  return (
    <div role="tablist" className={cx("md-tabs", `md-tabs--${variant}`, className)} {...rest}>
      {items.map((t, i) => <button key={t.value} role="tab" type="button" className="md-tab" aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1} disabled={t.disabled} onClick={() => onChange(t.value)} onKeyDown={e => onKey(e, i)}>{t.icon && <Icon name={t.icon} />}{t.label}{t.count !== undefined && <span className="md-tab__count">{t.count}</span>}</button>)}
    </div>
  );
}

/* ── Overlays ─────────────────────────────────────────────────────────── */
function useEscape(on: boolean, fn: () => void) {
  useEffect(() => { if (!on) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [on, fn]);
}
function useLockScroll(on: boolean) {
  useEffect(() => { if (!on) return; const p = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = p; }; }, [on]);
}
export interface DialogProps { open: boolean; onClose: () => void; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; size?: "sm" | "md" | "lg" | "xl"; }
export function Dialog({ open, onClose, title, description, children, footer, size = "md" }: DialogProps) {
  useEscape(open, onClose); useLockScroll(open); const id = useId();
  if (!open) return null;
  return (
    <div className="md-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal aria-labelledby={id} className={cx("md-dialog", size !== "md" && `md-dialog--${size}`)}>
        <div className="md-dialog__head"><div style={{ flex: 1 }}><h2 id={id} className="md-dialog__title">{title}</h2>{description && <p className="md-dialog__desc">{description}</p>}</div><IconButton icon="x" label="Close" size="sm" onClick={onClose} /></div>
        {children !== undefined && <div className="md-dialog__body">{children}</div>}
        {footer && <div className="md-dialog__foot">{footer}</div>}
      </div>
    </div>
  );
}
export interface DrawerProps { open: boolean; onClose: () => void; title: React.ReactNode; side?: "right" | "left"; children?: React.ReactNode; footer?: React.ReactNode; }
export function Drawer({ open, onClose, title, side = "right", children, footer }: DrawerProps) {
  useEscape(open, onClose); useLockScroll(open);
  if (!open) return null;
  return <>
    <div className="md-drawer-scrim" onClick={onClose} />
    <div role="dialog" aria-modal aria-label={typeof title === "string" ? title : undefined} className={cx("md-drawer", `md-drawer--${side}`)}>
      <div className="md-drawer__head"><h2>{title}</h2><IconButton icon="x" label="Close" size="sm" onClick={onClose} /></div>
      <div className="md-drawer__body">{children}</div>
      {footer && <div className="md-drawer__foot">{footer}</div>}
    </div>
  </>;
}

/* ── Dropdown ─────────────────────────────────────────────────────────── */
export interface MenuItem { label: React.ReactNode; onClick?: () => void; href?: string; external?: boolean; icon?: string; kbd?: string; danger?: boolean; disabled?: boolean; separated?: boolean; busy?: boolean; description?: React.ReactNode; tile?: React.ReactNode; }
export interface DropdownProps { trigger: React.ReactElement; items: MenuItem[]; align?: "left" | "right"; defaultOpen?: boolean; minWidth?: number; className?: string; }
export function Dropdown({ trigger, items, align = "right", defaultOpen = false, minWidth, className }: DropdownProps) {
  const [open, setOpen] = useState(defaultOpen); const [up, setUp] = useState(false); const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const r = wrap.current?.getBoundingClientRect(); if (r) setUp(window.innerHeight - r.bottom < 280 && r.top > 280);
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  const t = React.cloneElement(trigger, { onClick: (e: any) => { trigger.props.onClick?.(e); setOpen(o => !o); }, "aria-haspopup": "menu", "aria-expanded": open });
  return (
    <div ref={wrap} className={cx("md-dropdown", className)}>
      {t}
      {open && <div role="menu" className={cx("md-menu", `md-menu--${align}`, up && "md-menu--up")} style={minWidth ? { minWidth } : undefined}>
        {items.map((it, i) => {
          const cls = cx("md-menu__item", it.danger && "md-menu__item--danger", (it.description || it.tile) && "md-menu__item--rich");
          const body = <>{it.tile ?? (it.icon && <Icon name={it.icon} />)}<span style={{ flex: 1, minWidth: 0 }}><span className={it.description ? "md-menu__label" : undefined}>{it.label}</span>{it.description && <span className="md-menu__desc">{it.description}</span>}</span>{it.busy ? <Spinner /> : it.kbd ? <Kbd className="md-menu__kbd">{it.kbd}</Kbd> : it.external ? <Icon name="external" /> : null}</>;
          const common = { role: "menuitem", className: cls, "aria-disabled": it.disabled || undefined, key: i } as any;
          return <React.Fragment key={i}>
            {it.separated && i > 0 && <div className="md-menu__sep" role="separator" />}
            {it.href ? <a {...common} href={it.href} target={it.external ? "_blank" : undefined} rel={it.external ? "noopener noreferrer" : undefined} onClick={() => setOpen(false)}>{body}</a>
                     : <button {...common} type="button" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick?.(); }}>{body}</button>}
          </React.Fragment>;
        })}
      </div>}
    </div>
  );
}

/* ── Tooltip ──────────────────────────────────────────────────────────── */
export function Tooltip({ content, children, below, className }: { content: React.ReactNode; children: React.ReactNode; below?: boolean; className?: string }) {
  const id = useId();
  return <span className={cx("md-tip", className)}>{React.isValidElement(children) ? React.cloneElement(children as any, { "aria-describedby": id }) : children}<span role="tooltip" id={id} className={cx("md-tip__bubble", below && "md-tip__bubble--below")}>{content}</span></span>;
}

/* ── Toast ────────────────────────────────────────────────────────────── */
export type ToastKind = "success" | "error" | "info";
export interface ToastApi { toast: (message: string, kind?: ToastKind) => void; success: (message: string) => void; error: (message: string) => void; info: (message: string) => void; }
const ToastCtx = createContext<ToastApi | null>(null);
const DURATION: Record<ToastKind, number> = { success: 3200, info: 3800, error: 6500 };
const TOAST_ICON: Record<ToastKind, string> = { success: "check", error: "alertCircle", info: "info" };
export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) { const noop = () => {}; return { toast: noop, success: noop, error: noop, info: noop }; }
  return ctx;
}
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; kind: ToastKind; message: string }>>([]);
  const seq = useRef(0); const timers = useRef(new Map<number, any>());
  const dismiss = useCallback((id: number) => { setToasts(t => t.filter(x => x.id !== id)); clearTimeout(timers.current.get(id)); timers.current.delete(id); }, []);
  const toast = useCallback((message: string, kind: ToastKind = "success") => { const id = ++seq.current; setToasts(t => [...t.slice(-3), { id, kind, message }]); timers.current.set(id, setTimeout(() => dismiss(id), DURATION[kind])); }, [dismiss]);
  useEffect(() => { const p = timers.current; return () => { p.forEach(clearTimeout); p.clear(); }; }, []);
  const api: ToastApi = { toast, success: m => toast(m, "success"), error: m => toast(m, "error"), info: m => toast(m, "info") };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="md-toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className={cx("md-toast", `md-toast--${t.kind}`)} onClick={() => dismiss(t.id)}><Icon name={TOAST_ICON[t.kind]} /><span className="md-toast__msg">{t.message}</span></div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/* ── Alert ────────────────────────────────────────────────────────────── */
export interface AlertProps { tone?: Tone; title?: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode; onDismiss?: () => void; icon?: string | null; className?: string; }
const ALERT_ICON: Record<Tone, string> = { neutral: "info", info: "info", success: "checkCircle", warning: "alert", danger: "alertCircle" };
export function Alert({ tone = "info", title, children, actions, onDismiss, icon, className }: AlertProps) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("md-alert", `md-alert--${tone}`, className)}>
      {icon !== null && <Icon name={icon ?? ALERT_ICON[tone]} />}
      <div style={{ flex: 1 }}>{title && <div className="md-alert__title">{title}</div>}{children && <div className="md-alert__body">{children}</div>}{actions && <div className="md-alert__actions">{actions}</div>}</div>
      {onDismiss && <IconButton className="md-alert__x" icon="x" label="Dismiss" size="sm" onClick={onDismiss} />}
    </div>
  );
}

/* ── Progress / Skeleton ──────────────────────────────────────────────── */
export interface ProgressProps { value?: number; max?: number; label?: React.ReactNode; showValue?: boolean; tone?: "accent" | "success" | "danger"; size?: "sm" | "md"; indeterminate?: boolean; className?: string; }
export function Progress({ value = 0, max = 100, label, showValue, tone = "accent", size = "md", indeterminate, className }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cx("md-progress", tone !== "accent" && `md-progress--${tone}`, size === "sm" && "md-progress--sm", indeterminate && "md-progress--indeterminate", className)}>
      {(label || showValue) && <div className="md-progress__row"><span>{label}</span>{showValue && !indeterminate && <span>{Math.round(pct)}%</span>}</div>}
      <div className="md-progress__track" role="progressbar" aria-valuenow={indeterminate ? undefined : value} aria-valuemax={max} aria-label={typeof label === "string" ? label : undefined}><div className="md-progress__bar" style={indeterminate ? undefined : { width: pct + "%" }} /></div>
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
        <thead><tr>{columns.map(c => <th key={c.key} style={{ width: c.width, textAlign: c.align }}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={columns.length} style={{ textAlign: "center", padding: 32 }}>{empty ?? "Nothing here yet."}</td></tr>}
          {rows.map(r => <tr key={rowKey(r)} aria-selected={selected?.(r) || undefined} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: "pointer" } : undefined}>
            {columns.map(c => <td key={c.key} className={cx(c.primary && "md-td--primary", c.align === "right" && "md-td--num")}>{c.render ? c.render(r) : String((r as any)[c.key] ?? "")}</td>)}
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
      {pages.map((p, i) => p === "…" ? <span key={"g" + i} className="md-pages__gap">…</span> : <button key={p} type="button" className="md-pages__btn" aria-current={p === page ? "page" : undefined} onClick={() => onChange(p)}>{p}</button>)}
      <button type="button" className="md-pages__btn" disabled={page >= pageCount} onClick={() => onChange(page + 1)} aria-label="Next page"><Icon name="chevronRight" /></button>
    </nav>
  );
}
export function Breadcrumb({ items, className }: { items: Array<{ label: React.ReactNode; href?: string; icon?: string }>; className?: string }) {
  return (
    <nav aria-label="Breadcrumb"><ol className={cx("md-crumbs", className)}>
      {items.map((it, i) => { const last = i === items.length - 1; return <li key={i} aria-current={last ? "page" : undefined}>{i > 0 && <Icon name="chevronRight" />}{it.icon && <Icon name={it.icon} style={{ color: "inherit" }} />}{it.href && !last ? <a href={it.href}>{it.label}</a> : <span>{it.label}</span>}</li>; })}
    </ol></nav>
  );
}

/* ── EmptyState ───────────────────────────────────────────────────────── */
export function EmptyState({ icon = "inbox", title, description, actions, className }: { icon?: string; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return <div className={cx("md-empty", className)}><div className="md-empty__glyph"><Icon name={icon} /></div><h3 className="md-empty__title">{title}</h3>{description && <p className="md-empty__desc">{description}</p>}{actions && <div className="md-empty__actions">{actions}</div>}</div>;
}

export { cx };
