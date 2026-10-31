"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog } from "@/components/ui";

/**
 * Unsaved work on a screen (the design, redirect rows): closing or reloading the tab asks first
 * (`beforeunload`), and an in-app link (the site tabs, the site switcher, the header) opens a
 * "Leave without saving?" dialog instead of dropping the changes. Same rules as the document
 * editor's LeaveGuard: only plain left-clicks on same-origin links to another page are held;
 * new-tab clicks, downloads and links already handled pass through. Render the returned element.
 */
export function useLeaveGuard(active: boolean, what: string): React.ReactElement {
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

  const leave = () => {
    const to = pending;
    setPending(null);
    if (to) router.push(to);
  };

  return (
    <Dialog
      open={!!pending}
      onClose={() => setPending(null)}
      size="sm"
      title="Leave without saving?"
      description={`Your changes to ${what} aren't saved yet.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => setPending(null)}>Keep editing</Button>
          <Button variant="danger" onClick={leave}>Leave</Button>
        </>
      }
    />
  );
}

export default useLeaveGuard;
