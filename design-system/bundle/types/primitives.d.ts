import React from "react";
declare const cx: (...a: Array<string | false | null | undefined>) => string;
export declare const ICONS: Record<string, string>;
export type IconName = keyof typeof ICONS;
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
    href?: string;
    target?: string;
    type?: "button" | "submit" | "reset";
}
export declare const Button: React.ForwardRefExoticComponent<ButtonProps & React.RefAttributes<HTMLButtonElement>>;
export interface IconButtonProps extends Omit<ButtonProps, "iconLeft" | "iconRight" | "children"> {
    icon: string;
    label: string;
}
export declare function IconButton({ icon, label, variant, className, ...rest }: IconButtonProps): import("react/jsx-runtime").JSX.Element;
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
    size?: "sm" | "md";
    invalid?: boolean;
    mono?: boolean;
    prefix?: React.ReactNode;
    suffix?: React.ReactNode;
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
}
export declare function RadioGroup({ name, value, onChange, options, row, ...rest }: RadioGroupProps): import("react/jsx-runtime").JSX.Element;
export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
    label?: React.ReactNode;
}
export declare function Switch({ label, disabled, className, ...rest }: SwitchProps): import("react/jsx-runtime").JSX.Element;
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
    tone?: Tone;
    variant?: "soft" | "solid" | "outline";
    size?: "sm" | "md";
    dot?: boolean;
    icon?: string;
    upper?: boolean;
}
export declare function Badge({ tone, variant, size, dot, icon, upper, className, children, ...rest }: BadgeProps): import("react/jsx-runtime").JSX.Element;
export interface TagProps {
    children: React.ReactNode;
    onRemove?: () => void;
    className?: string;
}
export declare function Tag({ children, onRemove, className }: TagProps): import("react/jsx-runtime").JSX.Element;
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
export declare function Card({ title, description, actions, footer, interactive, inset, compact, className, children, ...rest }: CardProps): import("react/jsx-runtime").JSX.Element;
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
    "aria-label"?: string;
    className?: string;
}
export declare function Tabs({ items, value, onChange, variant, className, ...rest }: TabsProps): import("react/jsx-runtime").JSX.Element;
export interface DialogProps {
    open: boolean;
    onClose: () => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
    size?: "sm" | "md" | "lg" | "xl";
}
export declare function Dialog({ open, onClose, title, description, children, footer, size }: DialogProps): import("react/jsx-runtime").JSX.Element;
export interface DrawerProps {
    open: boolean;
    onClose: () => void;
    title: React.ReactNode;
    side?: "right" | "left";
    children?: React.ReactNode;
    footer?: React.ReactNode;
}
export declare function Drawer({ open, onClose, title, side, children, footer }: DrawerProps): import("react/jsx-runtime").JSX.Element;
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
}
export interface DropdownProps {
    trigger: React.ReactElement;
    items: MenuItem[];
    align?: "left" | "right";
    defaultOpen?: boolean;
    minWidth?: number;
    className?: string;
}
export declare function Dropdown({ trigger, items, align, defaultOpen, minWidth, className }: DropdownProps): import("react/jsx-runtime").JSX.Element;
export declare function Tooltip({ content, children, below, className }: {
    content: React.ReactNode;
    children: React.ReactNode;
    below?: boolean;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
export type ToastKind = "success" | "error" | "info";
export interface ToastApi {
    toast: (message: string, kind?: ToastKind) => void;
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
}
export declare function useToast(): ToastApi;
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
}
export declare function Alert({ tone, title, children, actions, onDismiss, icon, className }: AlertProps): import("react/jsx-runtime").JSX.Element;
export interface ProgressProps {
    value?: number;
    max?: number;
    label?: React.ReactNode;
    showValue?: boolean;
    tone?: "accent" | "success" | "danger";
    size?: "sm" | "md";
    indeterminate?: boolean;
    className?: string;
}
export declare function Progress({ value, max, label, showValue, tone, size, indeterminate, className }: ProgressProps): import("react/jsx-runtime").JSX.Element;
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
