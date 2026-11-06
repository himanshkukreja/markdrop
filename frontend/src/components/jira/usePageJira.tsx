"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, useToast } from "@/components/ui";
import { jiraPage, jiraRetry, type JiraItemRef, type JiraPage } from "@/lib/jira";
import type { PageJira } from "@/components/pages/PageRenderer";

const CreateIssueDialog = dynamic(() => import("./CreateIssueDialog").then((m) => m.CreateIssueDialog), { ssr: false, loading: () => null });
const BulkIssuesDialog = dynamic(() => import("./CreateIssueDialog").then((m) => m.BulkIssuesDialog), { ssr: false, loading: () => null });

/**
 * Jira on a page in View mode (DocumentView), for a signed-in member of the page's workspace when the
 * workspace has a Jira site: the page's chips (GET /jira/page), "Create Jira issue" on a meeting's
 * decisions, action items and open questions and "Jira issues" (draft issues for all action items) in the
 * meeting bar — both for people who can edit the page (the item gets the chip and ticks both ways) — and the dialogs.
 * `rev`: the page's revision; the chips are fetched again when it changes.
 */
export function usePageJira({ slug, enabled, meeting, workspaceId, rev }: {
  slug: string; enabled: boolean; meeting: boolean; workspaceId: string | null; rev: number | null | undefined;
}): { jira: PageJira | null; dialogs: ReactNode; bulkButton: ReactNode; create: (ref: JiraItemRef) => void; info: JiraPage | null } {
  const toast = useToast();
  const [info, setInfo] = useState<JiraPage | null>(null);
  const [item, setItem] = useState<JiraItemRef | null>(null);
  const [bulk, setBulk] = useState(false);

  const load = useCallback(() => {
    if (!enabled) { setInfo(null); return; }
    jiraPage(slug).then(setInfo).catch(() => setInfo(null));
  }, [slug, enabled]);
  useEffect(() => { load(); }, [load, rev]);

  const live = !!info?.site;
  const create = useCallback((ref: JiraItemRef) => setItem({ slug, ...ref }), [slug]);
  const jira = useMemo<PageJira | null>(() => (live && info ? {
    links: info.links,
    canCreate: meeting && info.can_create && info.can_edit,
    onCreate: ({ block, offset }) => setItem({ slug, block, offset }),
    onRetry: async (id: string) => {
      try {
        const r = await jiraRetry(id);
        if (r.state === "ok") toast.success("In step with Jira again.");
        else toast.error(r.message || "Still not in step with Jira.");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "That didn't work.");
      }
      load();
    },
  } : null), [live, info, meeting, slug, toast, load]);

  const bulkButton = live && meeting && info?.can_create && info?.can_edit ? (
    <Button size="sm" variant="secondary" iconLeft="checkSquare" onClick={() => setBulk(true)} data-testid="jira-bulk-open">Jira issues</Button>
  ) : null;

  const dialogs = live ? (
    <>
      {item && <CreateIssueDialog open={!!item} item={item} workspaceId={workspaceId} onClose={() => setItem(null)} onCreated={() => load()} />}
      {bulk && <BulkIssuesDialog open={bulk} slug={slug} onClose={() => setBulk(false)} onDone={() => load()} />}
    </>
  ) : null;
  return { jira, dialogs, bulkButton, create, info };
}
