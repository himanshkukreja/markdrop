"use client";

/** The small ways into Ask AI that live in server-rendered chrome (header, right rail, article). */
import { useEffect, useState } from "react";
import { Button, IconButton, cx } from "@/components/ui";
import { useDocsSite } from "../site";
import { askAboutPage, toggleAsk, useAsk } from "./store";

function useMac(): boolean {
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)), []);
  return mac;
}

/** The header's "Ask AI" (toggles the panel). Nothing when the site has Ask AI off. */
export function AskButton({ variant = "button" }: { variant?: "button" | "icon" }) {
  const { open } = useAsk();
  const mac = useMac();
  const { ai } = useDocsSite();
  if (!ai) return null;
  const hint = mac ? "⌘I" : "Ctrl+I";
  if (variant === "icon") return <IconButton icon="zap" label={ai.name} onClick={toggleAsk} aria-expanded={open} className="dx-askicon" />;
  return (
    <Button variant="secondary" size="sm" iconLeft="zap" onClick={toggleAsk} aria-expanded={open} aria-keyshortcuts="Meta+I Control+I" title={`${ai.name} (${hint})`} className={cx(open && "dx-askbtn--on")}>
      {ai.name}
    </Button>
  );
}

/** "Ask about this page" (right rail card, the feedback row). Nothing when the site has Ask AI off. */
export function AskAboutPageButton({ variant = "primary", children = "Ask about this page" }: { variant?: "primary" | "secondary" | "ghost"; children?: React.ReactNode }) {
  const { ai } = useDocsSite();
  if (!ai) return null;
  return (
    <Button variant={variant} size="sm" iconLeft="zap" onClick={askAboutPage}>
      {children}
    </Button>
  );
}
