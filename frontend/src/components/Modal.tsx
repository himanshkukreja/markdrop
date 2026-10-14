"use client";

import { Dialog } from "@/components/ui";

/**
 * Compatibility shim (REVAMP_PLAN 7.19): the old `<Modal title onClose>` signature, rendered by the
 * design-system Dialog, so every call site gets the focus trap, focus return, stacked Escape, scroll
 * lock and the themed portal without changing. Callers mount it conditionally (`{open && <Modal…>}`),
 * so it is always open while mounted. New code should use `Dialog` from "@/components/ui" directly;
 * delete this file once the last call site has migrated.
 */
export interface ModalProps {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  /** Optional extras, passed through to Dialog. */
  description?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  tone?: "default" | "danger";
  /** false: Escape and the scrim don't close it (e.g. while a request runs). */
  dismissible?: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
}

export default function Modal({ title, onClose, children, description, footer, size, tone, dismissible, initialFocus }: ModalProps) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={footer}
      size={size}
      tone={tone}
      dismissible={dismissible}
      initialFocus={initialFocus}
    >
      {children}
    </Dialog>
  );
}
