"use client";

/**
 * Small pieces the Trash page and the trashed-link notice share: the kind tile, the item's name,
 * where it was, and who deleted it when.
 */
import { FILE_KINDS, FileIcon, Icon, fileKind, type FileRenderer } from "@/components/ui";
import { relativeTime } from "@/components/dashboard/format";
import { kindNoun } from "@/lib/itemKind";
import type { TrashItem } from "@/lib/trash";

const LABEL_RENDERER: Array<[RegExp, FileRenderer]> = [
  [/pdf/i, "pdf"], [/html/i, "html"], [/image|svg/i, "image"], [/video/i, "video"], [/audio/i, "audio"],
  [/csv|spreadsheet|excel/i, "sheet"], [/word/i, "docx"], [/bundle|zip/i, "zip"], [/json|text/i, "text"],
];

/** The kind's icon in its category colour (a folder, a page, a document, a file by its type). */
export function TrashTile({ item }: { item: Pick<TrashItem, "kind" | "type_label"> }) {
  let icon: React.ReactNode;
  let tint = "var(--text-secondary)";
  if (item.kind === "folder") {
    icon = <Icon name="folder" size={18} />;
  } else if (item.kind === "page") {
    icon = <Icon name="doc" size={18} />;
    tint = FILE_KINDS.document.tint;
  } else if (item.kind === "document") {
    tint = FILE_KINDS.document.tint;
    icon = <FileIcon name="doc.md" size={18} />;
  } else {
    const renderer = LABEL_RENDERER.find(([re]) => re.test(item.type_label || ""))?.[1] ?? null;
    tint = FILE_KINDS[fileKind("", "", renderer)].tint;
    icon = <FileIcon renderer={renderer} size={18} />;
  }
  return (
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg" style={{ color: tint, background: "color-mix(in srgb, currentColor 12%, transparent)" }}>
      {icon}
    </span>
  );
}

/** What the row is called: its title, "A private item" (an admin can't read it), or the slug (encrypted). */
export function trashName(it: Pick<TrashItem, "hidden" | "title" | "slug" | "encrypted" | "kind">): string {
  if (it.hidden) return "A private item";
  if (it.encrypted) return it.slug || "An encrypted document";
  return it.title?.trim() || it.slug || (it.kind === "folder" ? "A folder" : "Untitled");
}

/** "page", "HTML file", "folder"… for sentences. */
export const trashNoun = (it: Pick<TrashItem, "kind" | "type_label">) => kindNoun(it.kind, it.type_label);

/** "Page", "HTML file", "Folder"… for a meta line. */
export function trashKindLabel(it: Pick<TrashItem, "kind" | "type_label">): string {
  if (it.kind === "document") return "Doc";
  const n = trashNoun(it);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** "markdrop.in/EegpMKD" (no scheme). */
export function trashAddress(it: Pick<TrashItem, "url" | "slug">): string | null {
  if (it.url) {
    try {
      const u = new URL(it.url);
      return `${u.host}${u.pathname}`.replace(/\/$/, "");
    } catch {
      /* fall through */
    }
  }
  return it.slug ? `markdrop.in/${it.slug}` : null;
}

/** Where it was, with a place that's gone marked: "Acme › Guides", "Inside “Handbook”", "Your files". */
export function trashWhere(it: Pick<TrashItem, "where" | "kind">): { text: string; gone: string | null } {
  const { workspace, folder, parent } = it.where;
  if (parent) {
    return {
      text: parent.title ? `Inside “${parent.title}”` : "Inside another page",
      gone: parent.exists ? null : "(deleted)",
    };
  }
  if (workspace) {
    const parts = [workspace.name || "A workspace"];
    if (folder) parts.push(folder.name || "a folder");
    const gone = !workspace.exists ? "(workspace deleted)" : folder && folder.in_trash ? "(folder in Trash)" : folder && !folder.exists ? "(folder deleted)" : null;
    return { text: parts.join(" › "), gone };
  }
  return { text: "Your files", gone: null };
}

const VIA: Record<string, string> = { mcp: "with MCP", api: "with the API", "edit secret": "with the edit secret" };

/** "Deleted 2 days ago by you" (and how, when it wasn't the web app). */
export function trashDeleted(it: Pick<TrashItem, "deleted_at" | "deleted_by" | "via">): string {
  const when = relativeTime(it.deleted_at);
  const who = it.deleted_by ? (it.deleted_by.is_you ? "you" : it.deleted_by.name || "someone") : null;
  const how = it.via && VIA[it.via] ? ` ${VIA[it.via]}` : "";
  return `Deleted ${when}${who ? ` by ${who}` : ""}${how}`;
}
