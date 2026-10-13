"use client";

import { useEffect, useId, useState } from "react";
import { SegmentedControl, cx } from "@/components/ui";
import { useTheme, type ThemeChoice } from "@/lib/theme";

const OPTIONS: Array<{ value: ThemeChoice; label: string; icon: string }> = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/**
 * System / Light / Dark with radio semantics (account menu, mobile drawer, footer, settings).
 * Nothing is checked until mount, because the choice lives in localStorage and the server can't
 * know it. Hidden when the light theme is switched off.
 */
export function ThemeSegmented({
  size = "md",
  label = "Theme",
  showLabel = false,
  iconOnly = false,
  block = false,
  className,
}: {
  size?: "sm" | "md";
  /** The group's name; visually hidden unless `showLabel`. */
  label?: string;
  showLabel?: boolean;
  iconOnly?: boolean;
  block?: boolean;
  className?: string;
}) {
  const { choice, setTheme, lightEnabled } = useTheme();
  const [mounted, setMounted] = useState(false);
  const labelId = useId();
  useEffect(() => setMounted(true), []);
  if (!lightEnabled) return null;

  return (
    <div className={cx("md-theme-seg", className)}>
      <span id={labelId} className={showLabel ? "md-theme-seg__label" : "md-visually-hidden"}>
        {label}
      </span>
      <SegmentedControl<ThemeChoice>
        aria-labelledby={labelId}
        value={mounted ? choice : undefined}
        onChange={setTheme}
        options={OPTIONS}
        size={size}
        iconOnly={iconOnly}
        block={block}
      />
    </div>
  );
}

export default ThemeSegmented;
