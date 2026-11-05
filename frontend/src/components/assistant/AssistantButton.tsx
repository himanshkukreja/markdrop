"use client";

/** "✦ Ask" in a screen's one top bar: opens (or closes) Ask Markdrop; ⌘J does the same. */
import { Icon, cx } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { loadAssistantPanel } from "./AssistantRoot";
import { toggleAssistant, useAssistant } from "./store";
import "./assistant.css";

export function AssistantButton({ label = "Ask", className }: { label?: string; className?: string }) {
  const { user } = useAuth();
  const { open } = useAssistant();
  if (!user) return null;
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || "");
  return (
    <button
      type="button"
      className={cx("as-btn no-print", className)}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+J Control+J"
      title={`Ask Markdrop (${mac ? "⌘J" : "Ctrl J"})`}
      onPointerEnter={() => void loadAssistantPanel().catch(() => {})}
      onFocus={() => void loadAssistantPanel().catch(() => {})}
      onClick={() => toggleAssistant()}
      data-testid="assistant-button"
    >
      <Icon name="sparkle" />
      <span className="as-btn__label">{label}</span>
    </button>
  );
}

export default AssistantButton;
