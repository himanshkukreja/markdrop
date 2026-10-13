"use client";

import { CopyButton as DSCopyButton, type CopyButtonProps as DSCopyButtonProps } from "@/components/ui";

/**
 * Compatibility wrapper over the design-system CopyButton (Clipboard API with a fallback, "Copied"
 * for 1.6s, announced through the shared status region). Keeps the old default export and props
 * (`text`, `label`, `className`, `onCopy`); the old "Copy Link" / "Copied!" read "Copy link" /
 * "Copied" now. Every DS prop (size, variant, iconOnly, block, copiedLabel…) passes through.
 */
export type CopyButtonProps = DSCopyButtonProps;

export default function CopyButton({ label = "Copy link", ...rest }: CopyButtonProps) {
  return <DSCopyButton label={label} {...rest} />;
}
