/**
 * Markdrop UI primitives. Canonical copy (design-system/scripts/build-bundle.mjs builds the preview
 * bundle from this folder). Depends on react and react-dom only: links go through `LinkProvider`
 * (./link), theme islands through `ThemeScope` (./scope), announcements through `announce` (./status).
 * Server components that need plain data (`ICONS`) import ./icons directly: every export of this
 * module is a client reference on the server, so non-component exports (`cx`) can't be called there.
 */
import React from "react";
import { ICONS } from "./icons";
export { ICONS };
export type { IconName } from "./icons";
type ClassValue = string | number | bigint | boolean | null | undefined;
declare const cx: (...a: ClassValue[]) => string;
export interface IconProps extends React.SVGProps<SVGSVGElement> {
    name: string;
    size?: number | string;
}
export declare function Icon({ name, size, className, style, ...rest }: IconProps): import("react/jsx-runtime").JSX.Element;
export interface SpinnerProps {
    size?: number | string;
    className?: string;
    label?: string;
}
export declare function Spinner({ size, className, label }: SpinnerProps): import("react/jsx-runtime").JSX.Element;
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "inverse" | "link";
export type ButtonSize = "sm" | "md" | "lg";
export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    block?: boolean;
    iconLeft?: string;
    iconRight?: string;
    /** Renders a link (through LinkProvider, so next/link in the app). */
    href?: string;
    target?: string;
    rel?: string;
    download?: boolean | string;
    type?: "button" | "submit" | "reset";
}
export declare const Button: React.ForwardRefExoticComponent<ButtonProps & React.RefAttributes<HTMLButtonElement>>;
export interface IconButtonProps extends Omit<ButtonProps, "iconLeft" | "iconRight" | "children"> {
    icon: string;
    label: string;
}
export declare function IconButton({ icon, label, variant, className, title, ...rest }: IconButtonProps): import("react/jsx-runtime").JSX.Element;
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
    size?: "sm" | "md";
    invalid?: boolean;
    mono?: boolean;
    /** Icon adornment: a string is an icon name, anything else renders as-is. */
    prefix?: React.ReactNode;
    suffix?: React.ReactNode;
    /** Aliases of prefix/suffix (icon adornments). */
    iconPrefix?: React.ReactNode;
    iconSuffix?: React.ReactNode;
    /** Literal text attached inside the field border, e.g. "markdrop.in/". Follows `mono`. */
    textPrefix?: string;
    textSuffix?: string;
    /** Class for the wrapper rendered when there are adornments. */
    wrapClassName?: string;
}
export declare const Input: React.ForwardRefExoticComponent<InputProps & React.RefAttributes<HTMLInputElement>>;
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    invalid?: boolean;
    mono?: boolean;
}
export declare const Textarea: React.ForwardRefExoticComponent<TextareaProps & React.RefAttributes<HTMLTextAreaElement>>;
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
    invalid?: boolean;
    options?: Array<{
        value: string;
        label: string;
        disabled?: boolean;
    }>;
}
export declare const Select: React.ForwardRefExoticComponent<SelectProps & React.RefAttributes<HTMLSelectElement>>;
export interface FieldProps {
    label?: React.ReactNode;
    hint?: React.ReactNode;
    error?: React.ReactNode;
    required?: boolean;
    htmlFor?: string;
    children: React.ReactElement;
    className?: string;
}
export declare function Field({ label, hint, error, required, htmlFor, children, className }: FieldProps): import("react/jsx-runtime").JSX.Element;
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
    label?: React.ReactNode;
    description?: React.ReactNode;
    indeterminate?: boolean;
}
export declare const Checkbox: React.ForwardRefExoticComponent<CheckboxProps & React.RefAttributes<HTMLInputElement>>;
export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
    label?: React.ReactNode;
    description?: React.ReactNode;
}
export declare function Radio({ label, description, disabled, className, ...rest }: RadioProps): import("react/jsx-runtime").JSX.Element;
export interface RadioGroupProps {
    name: string;
    value?: string;
    onChange?: (v: string) => void;
    options: Array<{
        value: string;
        label: React.ReactNode;
        description?: React.ReactNode;
        disabled?: boolean;
    }>;
    row?: boolean;
    "aria-label"?: string;
    "aria-labelledby"?: string;
}
export declare function RadioGroup({ name, value, onChange, options, row, ...rest }: RadioGroupProps): import("react/jsx-runtime").JSX.Element;
export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
    label?: React.ReactNode;
}
export declare function Switch({ label, disabled, className, ...rest }: SwitchProps): import("react/jsx-runtime").JSX.Element;
export interface SegmentedOption<V extends string = string> {
    value: V;
    label: React.ReactNode;
    icon?: string;
    disabled?: boolean;
    "aria-label"?: string;
}
export interface SegmentedControlProps<V extends string = string> {
    /** The checked value. `undefined`/`null` renders with nothing checked (e.g. the theme before mount). */
    value: V | undefined | null;
    onChange: (value: V) => void;
    options: Array<SegmentedOption<V>>;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    size?: "sm" | "md";
    /** Show icons only; string labels become each option's accessible name and title. */
    iconOnly?: boolean;
    /** Stretch to the container width, options sharing it equally. */
    block?: boolean;
    disabled?: boolean;
    className?: string;
    id?: string;
}
export declare function SegmentedControl<V extends string = string>({ value, onChange, options, size, iconOnly, block, disabled, className, ...aria }: SegmentedControlProps<V>): import("react/jsx-runtime").JSX.Element;
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
    tone?: Tone;
    variant?: "soft" | "solid" | "outline";
    size?: "sm" | "md";
    dot?: boolean;
    icon?: string;
    upper?: boolean;
    /** A breathing dot (2s opacity pulse; static under reduced motion), for "live" states. */
    live?: boolean;
}
export declare function Badge({ tone, variant, size, dot, live, icon, upper, className, children, ...rest }: BadgeProps): import("react/jsx-runtime").JSX.Element;
export interface TagProps {
    children: React.ReactNode;
    onRemove?: () => void;
    className?: string;
    removeLabel?: string;
}
export declare function Tag({ children, onRemove, className, removeLabel }: TagProps): import("react/jsx-runtime").JSX.Element;
export declare function Kbd({ children, className }: {
    children: React.ReactNode;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
export interface AvatarProps {
    name: string;
    src?: string;
    size?: "sm" | "md" | "lg" | "xl";
    status?: "online" | "away" | "offline";
    neutral?: boolean;
    className?: string;
}
export declare function Avatar({ name, src, size, status, neutral, className }: AvatarProps): import("react/jsx-runtime").JSX.Element;
export declare function AvatarGroup({ children, className }: {
    children: React.ReactNode;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
    title?: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
    footer?: React.ReactNode;
    interactive?: boolean;
    inset?: boolean;
    compact?: boolean;
}
export declare function Card({ title, description, actions, footer, interactive, inset, compact, className, children, onKeyDown, ...rest }: CardProps): import("react/jsx-runtime").JSX.Element;
export interface TabItem {
    value: string;
    label: React.ReactNode;
    icon?: string;
    count?: number;
    disabled?: boolean;
}
export interface TabsProps {
    items: TabItem[];
    value: string;
    onChange: (v: string) => void;
    variant?: "line" | "pill";
    /** Pill only: "sm" is the compact pill (28px). */
    size?: "sm" | "md";
    /** When set, tabs get ids `${idPrefix}-tab-${value}` and aria-controls `${idPrefix}-panel-${value}`. */
    idPrefix?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    className?: string;
}
export declare function Tabs({ items, value, onChange, variant, size, idPrefix, className, ...rest }: TabsProps): import("react/jsx-runtime").JSX.Element;
export interface RouterTabItem {
    href: string;
    label: React.ReactNode;
    value?: string;
    icon?: string;
    count?: number;
}
export interface RouterTabsProps {
    items: RouterTabItem[]; /** The active item's value (defaults to its href). */
    value: string;
    variant?: "line" | "pill";
    size?: "sm" | "md";
    "aria-label"?: string;
    className?: string;
}
/** Tabs that are links (one per route): a nav with aria-current="page", not role=tab. */
export declare function RouterTabs({ items, value, variant, size, className, ...rest }: RouterTabsProps): import("react/jsx-runtime").JSX.Element;
export interface DialogProps {
    open: boolean;
    onClose: () => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
    size?: "sm" | "md" | "lg" | "xl";
    /** "danger" adds the danger glyph; use it only for actions that destroy data or access. */
    tone?: "default" | "danger";
    /** Element to focus on open. Default: the first focusable that isn't the close button, else the dialog. */
    initialFocus?: React.RefObject<HTMLElement | null>;
    hideClose?: boolean;
    /** false: Escape and the scrim don't close it (e.g. while a request runs). Default true. */
    dismissible?: boolean;
    className?: string;
    bodyClassName?: string;
}
export declare function Dialog({ open, onClose, title, description, children, footer, size, tone, initialFocus, hideClose, dismissible, className, bodyClassName }: DialogProps): React.ReactPortal;
export interface DrawerProps {
    open: boolean;
    onClose: () => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    /** "bottom" is a sheet: grab handle, rounded top, max-height 90dvh, safe-area padding. */
    side?: "right" | "left" | "bottom";
    /** Right/left width (number = px). Default 420; always full width on phones. */
    width?: number | string;
    children?: React.ReactNode;
    footer?: React.ReactNode;
    initialFocus?: React.RefObject<HTMLElement | null>;
    hideClose?: boolean;
    dismissible?: boolean;
    className?: string;
    bodyClassName?: string;
}
export declare function Drawer({ open, onClose, title, description, side, width, children, footer, initialFocus, hideClose, dismissible, className, bodyClassName }: DrawerProps): React.ReactPortal;
export interface ConfirmDialogProps {
    open: boolean;
    onClose: () => void;
    /** May return a promise: the confirm button shows a spinner until it settles; a rejection shows its message. Close the dialog yourself on success. */
    onConfirm: () => void | Promise<unknown>;
    title: React.ReactNode;
    body?: React.ReactNode;
    description?: React.ReactNode;
    confirmLabel: React.ReactNode;
    cancelLabel?: React.ReactNode;
    /** Default "danger". */
    tone?: "danger" | "default";
    /** The confirm button stays disabled until this exact text is typed. */
    typeToConfirm?: string;
    busy?: boolean;
    /** Shown inline as a danger Alert inside the dialog. */
    error?: React.ReactNode;
    size?: DialogProps["size"];
}
export declare function ConfirmDialog({ open, onClose, onConfirm, title, body, description, confirmLabel, cancelLabel, tone, typeToConfirm, busy, error, size }: ConfirmDialogProps): import("react/jsx-runtime").JSX.Element;
export interface MenuItem {
    label: React.ReactNode;
    onClick?: () => void;
    href?: string;
    external?: boolean;
    icon?: string;
    kbd?: string;
    danger?: boolean;
    disabled?: boolean;
    separated?: boolean;
    busy?: boolean;
    description?: React.ReactNode;
    tile?: React.ReactNode;
    /** A quiet third line under the description, e.g. "Needs an account". */
    caption?: React.ReactNode;
}
/** A non-interactive header row. */
export interface MenuHeader {
    header: React.ReactNode;
    separated?: boolean;
}
/** An arbitrary content row (e.g. the theme SegmentedControl). Arrow keys stop on its first control. */
export interface MenuCustom {
    custom: React.ReactNode;
    separated?: boolean;
}
export type MenuEntry = MenuItem | MenuHeader | MenuCustom;
export interface DropdownProps {
    trigger: React.ReactElement;
    items: MenuEntry[];
    align?: "left" | "right";
    defaultOpen?: boolean;
    minWidth?: number;
    className?: string;
    /** Controlled mode. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** "auto" opens below and flips up when there isn't room. */
    placement?: "auto" | "bottom" | "top";
    /** Render the menu in a body portal (fixed position) so overflow containers can't clip it. Stamps the nearest ThemeScope. Don't use inside a Dialog. */
    portal?: boolean;
    menuClassName?: string;
    "aria-label"?: string;
}
export declare function Dropdown({ trigger, items, align, defaultOpen, minWidth, className, open: openProp, onOpenChange, placement, portal, menuClassName, ...aria }: DropdownProps): import("react/jsx-runtime").JSX.Element;
export interface PopoverProps {
    /** The anchor: gets aria-haspopup="dialog", aria-expanded and click-to-toggle. */
    trigger: React.ReactElement;
    children: React.ReactNode | ((api: {
        close: () => void;
    }) => React.ReactNode);
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
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
    className?: string;
    panelClassName?: string;
}
export declare function Popover({ trigger, children, open: openProp, onOpenChange, defaultOpen, placement, trap, portal, title, width, initialFocus, className, panelClassName, ...aria }: PopoverProps): import("react/jsx-runtime").JSX.Element;
export interface TooltipProps {
    content: React.ReactNode;
    children: React.ReactNode;
    side?: "top" | "bottom" | "left" | "right";
    /** Legacy alias for side="bottom". */
    below?: boolean;
    /** Make the wrapper focusable, for a non-interactive child (a Badge) whose tooltip must be reachable by keyboard. */
    focusable?: boolean;
    className?: string;
}
/** Shows on hover and on keyboard focus; Escape hides it. Text wraps at 260px. */
export declare function Tooltip({ content, children, side, below, focusable, className }: TooltipProps): import("react/jsx-runtime").JSX.Element;
export interface DisclosureProps {
    summary: React.ReactNode;
    children?: React.ReactNode;
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    className?: string;
    buttonClassName?: string;
    panelClassName?: string;
}
export declare function Disclosure({ summary, children, defaultOpen, open, onOpenChange, className, buttonClassName, panelClassName }: DisclosureProps): import("react/jsx-runtime").JSX.Element;
export type ToastKind = "success" | "error" | "info";
export interface ToastAction {
    label: string;
    onClick: () => void;
}
export interface ToastOptions {
    action?: ToastAction; /** ms; defaults by kind (3200 / 3800 / 6500). */
    duration?: number;
}
export interface ToastInput extends ToastOptions {
    message: React.ReactNode;
    kind?: ToastKind;
}
export interface ToastApi {
    /** `toast("Saved")`, `toast("Couldn't save", "error", { action })` or `toast({ message, kind, action })`. Returns the toast id. */
    toast: (message: React.ReactNode | ToastInput, kind?: ToastKind, opts?: ToastOptions) => number;
    success: (message: React.ReactNode, opts?: ToastOptions) => number;
    error: (message: React.ReactNode, opts?: ToastOptions) => number;
    info: (message: React.ReactNode, opts?: ToastOptions) => number;
    dismiss: (id: number) => void;
}
export declare function useToast(): ToastApi;
/** Toasts sit bottom-left, at most 4; hover or focus pauses the timer. They follow the page theme (never a ThemeScope). */
export declare function ToastProvider({ children }: {
    children: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export interface AlertProps {
    tone?: Tone;
    title?: React.ReactNode;
    children?: React.ReactNode;
    actions?: React.ReactNode;
    onDismiss?: () => void;
    icon?: string | null;
    className?: string;
    /** Announce changes politely (aria-live). Danger alerts are always role="alert". */
    live?: boolean;
}
export declare function Alert({ tone, title, children, actions, onDismiss, icon, className, live }: AlertProps): import("react/jsx-runtime").JSX.Element;
export interface ProgressProps {
    value?: number;
    max?: number;
    label?: React.ReactNode;
    showValue?: boolean;
    tone?: "accent" | "success" | "danger";
    size?: "sm" | "md";
    indeterminate?: boolean;
    className?: string;
    /** Spoken value, e.g. "3 of 8 files, 42%". */
    valueText?: string;
    /** Right of the label (rate, ETA…). */
    meta?: React.ReactNode;
    /** Name when there's no visible label. */
    "aria-label"?: string;
}
export declare function Progress({ value, max, label, showValue, tone, size, indeterminate, className, valueText, meta, ...rest }: ProgressProps): import("react/jsx-runtime").JSX.Element;
export interface MeterProps {
    value: number;
    max?: number;
    label: React.ReactNode;
    valueText?: string;
    /** Fraction of max (0–1) at and above which the meter turns warning (near the cap). */
    threshold?: number;
    /** Visible value right of the label, e.g. "84 MB of 100 MB". */
    meta?: React.ReactNode;
    size?: "sm" | "md";
    className?: string;
}
/** A gauge (storage, quota), not task progress: role="meter". */
export declare function Meter({ value, max, label, valueText, threshold, meta, size, className }: MeterProps): import("react/jsx-runtime").JSX.Element;
export declare function Skeleton({ width, height, variant, className, style }: {
    width?: number | string;
    height?: number | string;
    variant?: "text" | "circle" | "rect";
    className?: string;
    style?: React.CSSProperties;
}): import("react/jsx-runtime").JSX.Element;
export interface Column<T> {
    key: string;
    header: React.ReactNode;
    render?: (row: T) => React.ReactNode;
    align?: "left" | "right";
    primary?: boolean;
    width?: number | string;
}
export interface TableProps<T> {
    columns: Column<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    hover?: boolean;
    compact?: boolean;
    selected?: (row: T) => boolean;
    onRowClick?: (row: T) => void;
    caption?: string;
    empty?: React.ReactNode;
    className?: string;
}
export declare function Table<T>({ columns, rows, rowKey, hover, compact, selected, onRowClick, caption, empty, className }: TableProps<T>): import("react/jsx-runtime").JSX.Element;
export declare function Pagination({ page, pageCount, onChange, className }: {
    page: number;
    pageCount: number;
    onChange: (p: number) => void;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function Breadcrumb({ items, className }: {
    items: Array<{
        label: React.ReactNode;
        href?: string;
        icon?: string;
    }>;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function EmptyState({ icon, title, description, actions, className }: {
    icon?: string;
    title: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
export { cx };
