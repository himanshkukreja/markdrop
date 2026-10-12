import React from "react";
import { MenuItem } from "./primitives";
export interface MarkdropLogoProps {
    size?: number;
    wordmark?: boolean;
    href?: string;
    className?: string;
}
/** The mark, drawn exactly as app/icon.svg: pill rx 8, mono "m" at 3/23, dot at 27/20 r 4. */
export declare function MarkdropMark({ size, className }: {
    size?: number;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function Wordmark({ className, style }: {
    className?: string;
    style?: React.CSSProperties;
}): import("react/jsx-runtime").JSX.Element;
export declare function MarkdropLogo({ size, wordmark, href, className }: MarkdropLogoProps): import("react/jsx-runtime").JSX.Element;
declare const SIZES: {
    readonly sm: {
        readonly mark: 56;
        readonly word: 14;
        readonly bar: 80;
    };
    readonly md: {
        readonly mark: 78;
        readonly word: 18;
        readonly bar: 112;
    };
    readonly lg: {
        readonly mark: 104;
        readonly word: 24;
        readonly bar: 144;
    };
};
export interface MarkdropLoaderProps {
    label?: string | null;
    size?: keyof typeof SIZES;
    hideWordmark?: boolean;
    className?: string;
}
export declare function MarkdropLoader({ label, size, hideWordmark, className }: MarkdropLoaderProps): import("react/jsx-runtime").JSX.Element;
export interface AppHeaderProps {
    nav?: Array<{
        label: string;
        href: string;
        current?: boolean;
    }>;
    user?: {
        name: string;
        src?: string;
    } | null;
    onSignIn?: () => void;
    onToggleTheme?: () => void;
    theme?: "dark" | "light";
    className?: string;
}
export declare function AppHeader({ nav, user, onSignIn, onToggleTheme, theme, className }: AppHeaderProps): import("react/jsx-runtime").JSX.Element;
export declare function CreateMenu({ defaultOpen }: {
    defaultOpen?: boolean;
}): import("react/jsx-runtime").JSX.Element;
export declare function RowMenu({ items, label, defaultOpen }: {
    items: MenuItem[];
    label?: string;
    defaultOpen?: boolean;
}): import("react/jsx-runtime").JSX.Element;
export interface DocumentRowProps {
    title: string;
    meta: string;
    href?: string;
    icon?: string;
    badges?: React.ReactNode;
    actions?: MenuItem[];
    onOpen?: () => void;
    className?: string;
}
export declare function DocumentRow({ title, meta, href, icon, badges, actions, className }: DocumentRowProps): import("react/jsx-runtime").JSX.Element;
export declare function CopyButton({ text, label, size, variant, onCopy }: {
    text: string;
    label?: string;
    size?: "sm" | "md";
    variant?: "secondary" | "ghost" | "primary";
    onCopy?: () => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function isImage(name: string, mime: string): boolean;
export declare function FileIcon({ name, mime, size }: {
    name: string;
    mime: string;
    size?: number;
}): import("react/jsx-runtime").JSX.Element;
export declare function RouteBadge({ route }: {
    route: "direct" | "relay" | null;
}): import("react/jsx-runtime").JSX.Element;
type Mode = "password" | "signin" | "denied";
export interface AccessGateProps {
    mode: Mode;
    signInHref: string;
    email?: string | null;
    value?: string;
    onValue?: (v: string) => void;
    onSubmit?: (e: React.SyntheticEvent) => void;
    submitting?: boolean;
    error?: string;
}
export declare function AccessGate({ mode, signInHref, email, value, onValue, onSubmit, submitting, error }: AccessGateProps): import("react/jsx-runtime").JSX.Element;
export interface AssetUploadProps {
    label: string;
    hint: string;
    value: string | null;
    shape?: "square" | "wide";
    disabled?: boolean;
    onUpload: (file: File) => Promise<void>;
    onClear: () => void;
}
export declare function AssetUpload({ label, hint, value, shape, disabled, onUpload, onClear }: AssetUploadProps): import("react/jsx-runtime").JSX.Element;
export declare function ColorPicker({ value, disabled, onChange, label }: {
    value: string | null;
    disabled?: boolean;
    onChange: (hex: string | null) => void;
    label?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function MarkdownToolbar({ textareaRef, onChange, bare }: {
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    onChange: (v: string) => void;
    bare?: boolean;
}): import("react/jsx-runtime").JSX.Element;
export declare function ImmersiveExit({ onExit, placement }: {
    onExit: () => void;
    placement?: "bottom-right" | "top-right";
}): import("react/jsx-runtime").JSX.Element;
export declare function AmbientBackground(): import("react/jsx-runtime").JSX.Element;
export declare function VSCodeIcon({ size, className }: {
    size?: number;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function TransferExplainer({ href }: {
    href?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function BulkGuide(): import("react/jsx-runtime").JSX.Element;
export {};
