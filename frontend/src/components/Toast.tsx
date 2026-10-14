"use client";

/**
 * Toasts come from the design system (REVAMP_PLAN 7.19): bottom-left (the feedback launcher is
 * bottom-right), at most four, 3200 / 3800 / 6500 ms for success / info / error, paused on hover and
 * focus, errors as role="alert", and optional actions. The API is a superset of the old one, so
 * `useToast().toast(message, kind)`, `.success(message)` and `.error(message)` keep working;
 * `.info(message)`, `.dismiss(id)` and `{ action: { label, onClick } }` are new.
 * `useToast()` outside the provider is a no-op.
 */
export { ToastProvider, useToast } from "@/components/ui";
export type { ToastApi, ToastKind, ToastAction, ToastOptions, ToastInput } from "@/components/ui";
