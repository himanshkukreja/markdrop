"use client";

/**
 * A page's "Move to…" and "Duplicate", for the reading view and the editor (DocumentView loads
 * this lazily, the first time either is asked for). `request` says which: it runs once per new
 * request object.
 */
import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui";
import { MovePageDialog, type MovablePage, type MovedTo } from "./MovePage";
import { useDuplicatePage } from "./DuplicatePage";
import { SaveTemplateDialog } from "./templates/SaveTemplateDialog";

export type PageActionRequest = { kind: "move" } | { kind: "duplicate"; open: boolean } | { kind: "template"; icon?: string | null };

export function PageActions({ request, page, onClose, onMoved }: {
  request: PageActionRequest | null;
  page: MovablePage;
  onClose: () => void;
  onMoved: (to: MovedTo) => void;
}) {
  const toast = useToast();
  const dup = useDuplicatePage();
  const ran = useRef<PageActionRequest | null>(null);

  useEffect(() => {
    if (!request || request.kind !== "duplicate" || ran.current === request) return;
    ran.current = request;
    void dup.duplicate({ slug: page.slug, title: page.title }, { open: request.open }).finally(onClose);
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {request?.kind === "move" && (
        <MovePageDialog
          open
          onClose={onClose}
          page={page}
          onMoved={(to) => {
            toast.success(`Moved “${page.title?.trim() || "Untitled"}” to ${to.label}`);
            onMoved(to);
          }}
        />
      )}
      {dup.dialog}
      {request?.kind === "template" && <SaveTemplateDialog open onClose={onClose} slug={page.slug} title={page.title} workspaceId={page.workspaceId} childrenCount={page.childrenCount} pageIcon={request.icon} />}
    </>
  );
}

export default PageActions;
