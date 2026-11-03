"use client";

/**
 * "✦ Ask": the floating pill that opens Ask this page (SPEC.md feature 6).
 *
 * DocumentView mounts this only for a signed-in reader of a page (never anonymous visitors or
 * encrypted documents), lazily. It asks GET /ai/pages/status and shows the pill only when AI is
 * on for this page and this reader may ask. The panel itself (Markdown rendering, the stream)
 * loads on the first click, or on hover/focus just before it, so the reading page carries only
 * this pill.
 */
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Icon } from "@/components/ui";
import { fetchPageAiStatus, type PageAiStatus } from "@/lib/pages-ai/ask";
import type { AskPanelProps } from "./AskPanel";
import "./ask-pill.css";

let panelModule: Promise<ComponentType<AskPanelProps>> | null = null;
const loadPanel = () => (panelModule ??= import("./AskPanel").then((m) => m.AskPanel).catch((e) => {
  panelModule = null;
  throw e;
}));

export interface AskLauncherProps {
  slug: string;
  title: string | null;
  /** The status, once known (DocumentView uses it for Translate… in an editor's ⋯ menu). */
  onStatus?: (status: PageAiStatus | null) => void;
}

export function AskLauncher({ slug, title, onStatus }: AskLauncherProps) {
  const [status, setStatus] = useState<PageAiStatus | null>(null);
  const [Panel, setPanel] = useState<ComponentType<AskPanelProps> | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    let live = true;
    setStatus(null);
    setOpen(false);
    void fetchPageAiStatus(slug).then((s) => {
      if (!live) return;
      setStatus(s);
      onStatusRef.current?.(s);
    });
    return () => {
      live = false;
    };
  }, [slug]);

  const show = async () => {
    if (Panel) return setOpen(true);
    setLoading(true);
    try {
      const C = await loadPanel();
      setPanel(() => C);
      setOpen(true);
    } catch {
      /* offline: the pill stays, a second click tries again */
    } finally {
      setLoading(false);
    }
  };
  const close = useCallback(() => {
    setOpen(false);
    window.setTimeout(() => pill.current?.focus({ preventScroll: true }), 0);
  }, []);

  if (!status?.enabled || !status.can_ask) return null;
  return (
    <>
      <button
        ref={pill}
        type="button"
        className="pa-pill no-print"
        data-hidden={open ? "" : undefined}
        aria-hidden={open || undefined}
        tabIndex={open ? -1 : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={loading || undefined}
        onPointerEnter={() => void loadPanel().catch(() => {})}
        onFocus={() => void loadPanel().catch(() => {})}
        onClick={() => void show()}
      >
        <Icon name="sparkle" className="pa-pill__icon" />
        <span>Ask</span>
      </button>
      {Panel && <Panel open={open} onClose={close} slug={slug} title={title} />}
    </>
  );
}

export default AskLauncher;
