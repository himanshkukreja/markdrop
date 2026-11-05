"use client";

/**
 * Mounted once in the root layout: ⌘J / Ctrl+J opens (or closes) Ask Markdrop from anywhere in the app
 * for a signed-in person, and the panel (its own code) loads on first use. An editor's own ⌘J (Ask AI on
 * the selection) handles the key first and wins (isAssistantKey skips a handled event). Guides sites,
 * sign-in screens and marketing pages without a screen that registered itself are left alone.
 */
import { useEffect, useState, type ComponentType } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { isAssistantKey } from "./assistantCore.mjs";
import { getAssistant, toggleAssistant, useAssistant } from "./store";

let panelModule: Promise<ComponentType> | null = null;
export const loadAssistantPanel = () => (panelModule ??= import("./AssistantPanel").then((m) => m.AssistantPanel).catch((e) => {
  panelModule = null;
  throw e;
}));

const APP = /^\/(dashboard|meetings|w|pages|recent|search|shared|requests|settings|trash)(\/|$)/;

/** Can ⌘J open the assistant on this screen? (a screen registered itself, or an app route) */
export function assistantHere(): boolean {
  if (getAssistant().here) return true;
  return typeof window !== "undefined" && APP.test(window.location.pathname);
}

export function AssistantRoot() {
  const { user } = useAuth();
  const { open } = useAssistant();
  const [Panel, setPanel] = useState<ComponentType | null>(null);

  useEffect(() => {
    if (!user) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isAssistantKey(e) || !assistantHere()) return;
      e.preventDefault();
      toggleAssistant();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [user]);

  useEffect(() => {
    if (!open || Panel) return;
    void loadAssistantPanel().then((C) => setPanel(() => C)).catch(() => {});
  }, [open, Panel]);

  if (!user || !Panel) return null;
  return <Panel />;
}

export default AssistantRoot;
