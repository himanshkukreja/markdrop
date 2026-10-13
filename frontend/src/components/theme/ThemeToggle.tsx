"use client";

import { useEffect, useState } from "react";
import { Button, Icon, cx } from "@/components/ui";
import { useTheme } from "@/lib/theme";

/**
 * The header theme switch (REVAMP_PLAN 5.2): a 36px ghost icon button. It renders both the sun and
 * the moon and CSS shows the right one from <html data-theme> (markdrop.css, `.md-tt`), so the
 * server HTML never mismatches the client. A click stores the opposite of the resolved theme.
 * Hidden when the light theme is switched off (NEXT_PUBLIC_LIGHT_THEME=off).
 */
export function ThemeToggle({ className, size = "md" }: { className?: string; size?: "sm" | "md" }) {
  const { resolved, setTheme, lightEnabled } = useTheme();
  const [mounted, setMounted] = useState(false);
  // Bumped per click: remounts the icons so the rotate + crossfade keyframes replay.
  const [played, setPlayed] = useState(0);
  useEffect(() => setMounted(true), []);
  if (!lightEnabled) return null;

  const label = !mounted || !resolved ? "Switch theme" : resolved === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Button
      variant="ghost"
      size={size}
      className={cx("md-iconbtn md-tt", played > 0 && "md-tt--played", className)}
      aria-label={label}
      title={label}
      onClick={() => {
        const current = resolved ?? (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
        setTheme(current === "dark" ? "light" : "dark");
        setPlayed((n) => n + 1);
      }}
    >
      <span key={played} className="md-tt__icons" aria-hidden>
        <Icon name="sun" className="md-tt-sun" />
        <Icon name="moon" className="md-tt-moon" />
      </span>
    </Button>
  );
}

export default ThemeToggle;
