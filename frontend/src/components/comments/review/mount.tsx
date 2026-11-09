"use client";

/**
 * A dialog opened from outside React's tree (a panel action or a check before posting runs as a plain
 * function): rendered into its own root, resolved with the person's answer, then removed.
 */
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";

export function openDialog<T>(render: (done: (value: T) => void) => ReactNode): Promise<T> {
  return new Promise<T>((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-comments-review-dialog", "");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
      // Let the dialog play its closing animation before the root goes.
      window.setTimeout(() => {
        root.unmount();
        host.remove();
      }, 250);
      root.render(null);
    };
    root.render(render(done));
  });
}
