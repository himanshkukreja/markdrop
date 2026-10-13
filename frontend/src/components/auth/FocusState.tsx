"use client";

import type { ReactNode } from "react";
import { Icon } from "@/components/ui";

/**
 * A DS `EmptyState` (same `md-empty` classes and look) whose title is the page's `h1`, for focus
 * pages whose whole content is one state (the sign-in callback and handoff errors). The DS
 * component renders an h3, which would leave these pages without an h1.
 */
export function FocusState({ icon, title, description, actions }: {
  icon: string; title: ReactNode; description?: ReactNode; actions?: ReactNode;
}) {
  return (
    <div className="md-empty w-full max-w-[480px]">
      <div className="md-empty__glyph"><Icon name={icon} /></div>
      <h1 className="md-empty__title text-h3">{title}</h1>
      {description && <p className="md-empty__desc">{description}</p>}
      {actions && <div className="md-empty__actions flex-wrap justify-center">{actions}</div>}
    </div>
  );
}
