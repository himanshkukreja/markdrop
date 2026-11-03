"use client";

import { Icon } from "@/components/ui";
import type { UserTemplate } from "./api";

/** A template's emoji (its own, else its page's), its uploaded icon, or a layers glyph. */
export function TemplateEmoji({ t, className = "tpl-card__emoji" }: { t: Pick<UserTemplate, "icon" | "icon_url">; className?: string }) {
  return (
    <span className={className} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {t.icon ? t.icon : t.icon_url ? <img src={t.icon_url} alt="" /> : <Icon name="layers" />}
    </span>
  );
}
