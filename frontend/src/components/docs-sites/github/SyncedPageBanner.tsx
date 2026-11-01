"use client";

import { useCallback, useState } from "react";
import { Alert, Button } from "@/components/ui";
import { editOnGithubUrl, type GithubLink } from "@/lib/docsGithub";
import type { PageOrigin } from "@/lib/docsSites";

const KEY = "markdrop_github_banner_hidden";

/** Pages whose banner was dismissed in this tab (sessionStorage; a convenience, never relied on). */
export function useDismissedBanners(): [Set<string>, (pageId: string) => void] {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem(KEY) || "[]") as string[]); } catch { return new Set(); }
  });
  const hide = useCallback((pageId: string) => {
    setHidden((prev) => {
      const next = new Set(prev).add(pageId);
      try { sessionStorage.setItem(KEY, JSON.stringify([...next].slice(-200))); } catch { /* private mode */ }
      return next;
    });
  }, []);
  return [hidden, hide];
}

/**
 * Above a synced page in the editor: it comes from a file in the linked repository, and the next
 * push (or sync) replaces what's typed here. Informational only: editing stays open. "Edit on
 * GitHub" opens github.com's editor for the file in a new tab.
 */
export function SyncedPageBanner({ link, origin, onDismiss, className }: {
  link: Pick<GithubLink, "owner" | "name" | "branch" | "html_url" | "sync">;
  origin: PageOrigin;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <Alert
      tone="info"
      icon="github"
      className={className}
      title="This page comes from GitHub"
      onDismiss={onDismiss}
      actions={
        <Button size="sm" variant="secondary" iconRight="external" href={editOnGithubUrl(link, origin.path)} target="_blank" rel="noopener noreferrer">
          Edit on GitHub<span className="md-visually-hidden"> (opens in a new tab)</span>
        </Button>
      }
    >
      <code className="ph-sensitive ph-mask font-mono text-[13px] [overflow-wrap:anywhere]">{link.owner}/{link.name} › {origin.path}</code>
      <br />
      Changes here are replaced by the next {link.sync ? "push" : "sync"}.
    </Alert>
  );
}

export default SyncedPageBanner;
