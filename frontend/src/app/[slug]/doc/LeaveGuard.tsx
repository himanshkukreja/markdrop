"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, copyText } from "@/components/ui";

/**
 * D22: until the anonymous author has copied their edit secret (or dismissed the panel), closing
 * the tab asks first (`beforeunload`), and an in-app link opens "Leave without saving your edit
 * secret?" with "Copy secret" (primary) and "Leave anyway".
 *
 * Only plain left-clicks on same-origin links that change the page are intercepted; new-tab
 * clicks, downloads, in-page `#` links and anything already handled pass straight through.
 */
export function LeaveGuard({ active, secret, onCopied }: { active: boolean; secret: string; onCopied: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      let next: URL;
      try { next = new URL(a.href, window.location.href); } catch { return; }
      if (next.origin !== window.location.origin) return;
      if (next.pathname === window.location.pathname && next.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(next.pathname + next.search + next.hash);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [active]);

  function leave() {
    const to = pending;
    setPending(null);
    if (to) router.push(to);
  }

  return (
    <Dialog
      open={!!pending}
      onClose={() => setPending(null)}
      size="sm"
      title="Leave without saving your edit secret?"
      description="It's the only way to edit or delete this document without an account, and this tab is the only place it's shown."
      footer={
        <>
          <Button variant="secondary" onClick={leave}>Leave anyway</Button>
          <Button
            iconLeft="copy"
            onClick={async () => {
              if (await copyText(secret)) {
                onCopied();
                leave();
              }
            }}
          >
            Copy secret
          </Button>
        </>
      }
    />
  );
}
