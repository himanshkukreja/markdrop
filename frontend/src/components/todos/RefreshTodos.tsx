"use client";

/**
 * "Create my to-dos" / "Refresh to-dos" (lib/todos.ts → POST …/teams/{team}/todos/mine): makes your to-do page in a
 * team, or brings it up to date now, from the team's calls and the tasks on its pages that mention you. The toast
 * says what changed ("Added 2 new · 5 open", or "Up to date") and opens the page. Used on the team's Overview
 * (header actions), You › My to-dos and the team's to-dos list; leads also get "Create for everyone" there.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@/components/ui";
import { createTeamTodos, myTodoStatus, refreshMessage, refreshMyTodos } from "@/lib/todos";

type Props = {
  ws: string;
  team: string;
  /** Known already (a card): skips the status read. Unknown: read it (the team's Overview). */
  exists?: boolean;
  size?: "sm" | "md";
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
  onDone?: () => void;
};

export function RefreshTodosButton({ ws, team, exists: known, size = "md", variant = "secondary", className, onDone }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [exists, setExists] = useState<boolean | null>(known ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (known !== undefined) { setExists(known); return; }
    let live = true;
    myTodoStatus(ws, team).then((s) => { if (live) setExists(s.exists); }).catch(() => { if (live) setExists(null); });
    return () => { live = false; };
  }, [ws, team, known]);
  if (known === undefined && exists === null) return null;
  const label = exists ? "Refresh to-dos" : "Create my to-dos";
  const run = async () => {
    setBusy(true);
    try {
      const r = await refreshMyTodos(ws, team);
      setExists(true);
      const href = r.href;
      toast.success(r.created ? `Your to-do page is ready · ${r.open} open` : refreshMessage(r),
        href ? { action: { label: "Open", onClick: () => router.push(href) }, duration: 6500 } : undefined);
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update your to-dos.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant={variant} size={size} iconLeft={exists ? "refresh" : "checkSquare"} loading={busy} disabled={busy}
      onClick={run} className={className} data-testid="todos-refresh" aria-label={label}>
      {label}
    </Button>
  );
}

/** Leads: a to-do page for every member who has none yet. */
export function CreateTeamTodosButton({ ws, team, onDone }: { ws: string; team: string; onDone?: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await createTeamTodos(ws, team);
      toast.success(r.created ? `Made ${r.created} to-do ${r.created === 1 ? "page" : "pages"}` : "Everyone already has a to-do page");
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't make the to-do pages.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" size="sm" iconLeft="users" loading={busy} disabled={busy} onClick={run} data-testid="todos-create-all">
      Create for everyone
    </Button>
  );
}
