"use client";

import type { ReactNode } from "react";
import { Badge, Button, FileIcon, IconButton, type FileRenderer, type MenuEntry } from "@/components/ui";
import ArtifactBadge from "@/components/ArtifactBadge";
import { PageTopBar, type PageAddressing } from "@/components/pages/PageChrome";
import type { ArtifactRenderer } from "@/lib/api";

export interface ArtifactTopBarProps {
  slug: string;
  /** The title, else the file's name; neither → /slug. */
  title: string | null;
  originalFilename: string | null;
  mime: string;
  renderer: ArtifactRenderer;
  fileRenderer?: FileRenderer;
  typeLabel: string;
  /** What Copy link copies (the public URL, or the workspace domain's address). */
  url: string;
  /** The workspace and folders before the title (members, on markdrop.in), as on a page. */
  addressing: PageAddressing;
  /** The password gate is showing: /slug and a lock badge, no file actions. */
  gated?: boolean;
  /** The file is there to download and to open full screen. */
  canOpen: boolean;
  downloading: boolean;
  onDownload: () => void;
  onFullScreen: () => void;
  /** Share (owners and resharers); everyone else gets Copy link in the bar. */
  onShare?: (() => void) | null;
  /** The ⋯ menu ("More artifact actions"). */
  menu: MenuEntry[];
  /** Who's viewing (components/presence). */
  presence?: ReactNode;
}

/**
 * A file's (artifact's) one top bar in the framed view: a page's bar (components/pages/PageChrome
 * PageTopBar), like a classic document's (doc/DocumentTopBar), with the file's actions. The app
 * header (SiteHeader, or TenantHeader on a workspace's domain) no longer sits above a second file
 * bar:
 *
 *   logo · workspace › folders › [file icon] title [type] ……… who's viewing · Download ·
 *   full screen · Share (or Copy link) · ⋯ │ Create · avatar (or Sign in)
 *
 * The size, views and date head the ⋯ menu, with Copy link (when Share takes the bar), Settings
 * (the title, link, password, expiry, the file and its versions), Report and the rest. On phones
 * Share leads ⋯ and the bottom dock keeps Copy link and Download within reach of a thumb.
 */
export function ArtifactTopBar(p: ArtifactTopBarProps) {
  const name = (p.title || "").trim() || p.originalFilename || "";
  const tools = p.gated || !p.canOpen ? null : (
    <>
      <Button variant="ghost" size="sm" iconLeft="download" onClick={p.onDownload} loading={p.downloading} className="pb-bar__btn pb-bar__wide">
        {p.downloading ? "Preparing…" : "Download"}
      </Button>
      <IconButton icon="expand" label="Read full screen" size="sm" variant="ghost" className="pb-bar__btn" onClick={p.onFullScreen} />
    </>
  );
  return (
    <PageTopBar
      className="md-docbar md-artbar"
      crumbs={[]}
      title={!p.gated && name ? name : `/${p.slug}`}
      tile={<FileIcon renderer={p.fileRenderer} name={p.originalFilename ?? ""} mime={p.mime} size={16} className="pb-crumb__glyph" />}
      addressing={p.addressing}
      badge={p.gated ? <Badge icon="lock" size="sm">Password</Badge> : <ArtifactBadge renderer={p.renderer} label={p.typeLabel} />}
      presence={p.gated ? null : p.presence}
      tools={tools}
      onShare={p.gated ? null : p.onShare}
      shareUrl={p.gated ? undefined : p.url}
      menu={p.menu}
      menuLabel="More artifact actions"
      rail={false}
    />
  );
}
