/**
 * Markdrop components: logo, loader, header, Create menu, document rows, copy, file icons, route
 * badge, access gate, uploads, toolbar, immersive exit, ambient, explainers. Canonical copy; see
 * primitives.tsx for the rules (react + react-dom only; links via LinkProvider).
 */
import React from "react";
import type { ButtonSize, ButtonVariant, MenuItem } from "./primitives";
export interface MarkdropMarkProps {
    size?: number;
    className?: string; /** Accessible name when the mark stands alone (otherwise it's decorative). */
    title?: string;
}
/** The mark, drawn exactly as app/icon.svg: pill rx 8, mono "m" at 3/23, dot at 27/20 r 4. */
export declare function MarkdropMark({ size, className, title }: MarkdropMarkProps): import("react/jsx-runtime").JSX.Element;
export declare function Wordmark({ className, style }: {
    className?: string;
    style?: React.CSSProperties;
}): import("react/jsx-runtime").JSX.Element;
export interface MarkdropLogoProps {
    size?: number;
    wordmark?: boolean;
    href?: string;
    className?: string; /** Accessible name; default "Markdrop home". */
    label?: string;
}
export declare function MarkdropLogo({ size, wordmark, href, className, label }: MarkdropLogoProps): import("react/jsx-runtime").JSX.Element;
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
    /** ms before it renders (default 300), so fast loads never flash a loader. 0 renders at once (also on the server). */
    delay?: number;
}
export declare function MarkdropLoader({ label, size, hideWordmark, className, delay }: MarkdropLoaderProps): import("react/jsx-runtime").JSX.Element;
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
type CreateKey = "document" | "artifact" | "builder" | "share";
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
export declare function CreateMenu({ defaultOpen, signedIn, variant, size, align, hrefs }: CreateMenuProps): import("react/jsx-runtime").JSX.Element;
export declare function RowMenu({ items, label, defaultOpen, portal, align }: {
    items: MenuItem[];
    label?: string;
    defaultOpen?: boolean;
    portal?: boolean;
    align?: "left" | "right";
}): import("react/jsx-runtime").JSX.Element;
export interface DocumentRowProps {
    /** A string or a node (e.g. the slug in mono for an untitled or encrypted document). Ellipsised on one line. */
    title: React.ReactNode;
    meta: React.ReactNode;
    href?: string;
    icon?: string;
    badges?: React.ReactNode;
    actions?: MenuItem[];
    onOpen?: () => void;
    className?: string;
    /** Replaces the icon tile (e.g. a FileIcon tile keyed by renderer). */
    tile?: React.ReactNode;
    /** A quiet trailing control before the row menu (e.g. the access button). */
    trailing?: React.ReactNode;
    hideOpen?: boolean;
    openLabel?: string;
}
export declare function DocumentRow({ title, meta, href, icon, badges, actions, onOpen, className, tile, trailing, hideOpen, openLabel }: DocumentRowProps): import("react/jsx-runtime").JSX.Element;
export declare namespace DocumentRow {
    var Skeleton: typeof DocumentRowSkeleton;
}
export declare function DocumentRowSkeleton({ className }: {
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
/** Clipboard write with a textarea fallback (http, older Safari, denied permission). */
export declare function copyText(text: string): Promise<boolean>;
export interface CopyButtonProps {
    text: string;
    label?: string;
    copiedLabel?: string;
    size?: "sm" | "md";
    variant?: "secondary" | "ghost" | "primary";
    onCopy?: () => void;
    /** An IconButton named by `label` (default variant ghost). */
    iconOnly?: boolean;
    block?: boolean;
    className?: string;
    /** What the status region announces; default `copiedLabel`. */
    announceText?: string;
}
/** Copy → "Copied" for 1.6s with a copy→check icon morph; announced through the shared StatusRegion, never aria-live on the button. */
export declare function CopyButton({ text, label, copiedLabel, size, variant, onCopy, iconOnly, block, className, announceText }: CopyButtonProps): import("react/jsx-runtime").JSX.Element;
export declare function isImage(name: string, mime: string): boolean;
/** The artifact renderers the backend reports; a renderer wins over mime and extension. */
export type FileRenderer = "pdf" | "sheet" | "docx" | "text" | "video" | "html" | "image" | "zip";
export type FileKind = "image" | "video" | "audio" | "pdf" | "sheet" | "archive" | "html" | "document" | "code" | "other";
/** Icon and category token per kind (never a state colour; REVAMP_PLAN 8.1). */
export declare const FILE_KINDS: Record<FileKind, {
    icon: string;
    tint: string;
}>;
export declare function fileKind(name?: string, mime?: string, renderer?: FileRenderer | null): FileKind;
export interface FileIconProps {
    name?: string;
    mime?: string;
    renderer?: FileRenderer | null;
    size?: number;
    className?: string;
}
export declare function FileIcon({ name, mime, renderer, size, className }: FileIconProps): import("react/jsx-runtime").JSX.Element;
/** Relayed is a state, not a category: neutral tone plus its icon. The explanation is a keyboard-reachable Tooltip. */
export declare function RouteBadge({ route }: {
    route: "direct" | "relay" | null | undefined;
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
export interface ImmersiveExitProps {
    onExit: () => void;
    placement?: "bottom-right" | "top-right";
    /** The quiet state: a surface chip with a muted icon, never opacity-faded; full again on hover and focus. */
    quiet?: boolean;
    label?: string;
    className?: string;
}
/** The one way out of the immersive reader: 44px target, full opacity, offset by the safe area. */
export declare function ImmersiveExit({ onExit, placement, quiet, label, className }: ImmersiveExitProps): import("react/jsx-runtime").JSX.Element;
/** The landing glow: a dot grid plus one static accent-soft radial. Absolute within its parent (give the parent position:relative and isolation:isolate), or `fixed`. */
export declare function AmbientBackground({ fixed, className }: {
    fixed?: boolean;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function VSCodeIcon({ size, className }: {
    size?: number;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
/**
 * `relayAvailable` draws the relayed route; `discloseRelay` (default true) adds the relay sentence to step 2.
 * The packet rests mid-path and only travels while the explainer is hovered or focused (no endless loop).
 */
export declare function TransferExplainer({ href, relayAvailable, discloseRelay }: {
    href?: string;
    relayAvailable?: boolean;
    discloseRelay?: boolean;
}): import("react/jsx-runtime").JSX.Element;
export declare function BulkGuide(): import("react/jsx-runtime").JSX.Element;
export {};
