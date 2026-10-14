"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  Anchor, Badge, Button, CopyButton, FileIcon, FILE_KINDS, Icon, Tooltip, VSCodeIcon, cx, fileKind,
  type FileRenderer, type MenuEntry, type Tone,
} from "@/components/ui";
import type { MyDocListItem } from "@/lib/api";
import RowMenu from "./RowMenu";
import { expiresLabel, plural, relativeTime, fullDate } from "./format";
import styles from "./dashboard.module.css";

export interface RowStatus {
  key: string;
  label: string;
  tone: Tone;
  icon?: string;
  upper?: boolean;
  title?: string;
}

/**
 * Every status a row could show, in priority order (REVAMP_PLAN 7.10): E2E > Password > Expires >
 * Google Doc out of date. The row shows the first two as badges; the rest go into the RowMenu
 * header line.
 */
export function rowStatuses(d: MyDocListItem, googleConnected: boolean): RowStatus[] {
  const out: RowStatus[] = [];
  if (d.encrypted) out.push({ key: "e2e", label: "E2E", tone: "info", icon: "key", upper: true, title: "Encrypted in your browser. The key is in your link." });
  if (d.is_password_protected) out.push({ key: "pw", label: "Password", tone: "neutral", icon: "lock", title: "Readers need the password" });
  const exp = expiresLabel(d.expires_at);
  if (exp) out.push({ key: "exp", label: exp, tone: "warning", icon: "clock", title: `Stops working ${fullDate(d.expires_at)}` });
  if (googleConnected && d.google_doc_url && d.google_doc_stale) out.push({ key: "gdoc", label: "Google Doc out of date", tone: "warning", icon: "refresh" });
  return out;
}

/** The status line at the top of the row menu for statuses that didn't fit on the row. */
export function statusHeader(rest: RowStatus[]): MenuEntry[] {
  if (!rest.length) return [];
  return [{ header: <span className="text-caption text-text-secondary">Also: {rest.map((s) => s.label).join(" · ")}</span> }];
}

type Access = { label: string; icon: string; aria: string };

/** Access as words + icon, never colour alone. */
export function accessOf(d: MyDocListItem): Access {
  const n = d.shared_with_count ?? 0;
  if (d.access_level === "private") {
    if (n > 0) return { label: `+${n} ${n === 1 ? "person" : "people"}`, icon: "users", aria: `Private, shared with ${plural(n, "person", "people")}` };
    return { label: "Private", icon: "lock", aria: "Private" };
  }
  if (d.access_level === "workspace") {
    return { label: n > 0 ? `Workspace +${n}` : "Workspace", icon: "users", aria: n > 0 ? `Everyone in the workspace, and ${plural(n, "person", "people")}` : "Everyone in the workspace" };
  }
  return { label: n > 0 ? `Anyone with link +${n}` : "Anyone with link", icon: "link", aria: "Anyone with the link" };
}

const ARTIFACT_RENDERERS = new Set<FileRenderer>(["pdf", "sheet", "docx", "text", "video", "html", "image", "zip"]);

/** A tile in the file's category colour, keyed by renderer (markdown documents are "document"). */
export function RowTile({ d }: { d: MyDocListItem }) {
  const renderer = d.renderer && ARTIFACT_RENDERERS.has(d.renderer as FileRenderer) ? (d.renderer as FileRenderer) : null;
  const name = d.kind === "artifact" ? d.original_filename || "" : "doc.md";
  const kind = fileKind(name, d.mime || "", renderer);
  const tint = FILE_KINDS[kind].tint;
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-lg"
      style={{ color: tint, background: "color-mix(in srgb, currentColor 12%, transparent)" }}
    >
      <FileIcon name={name} mime={d.mime || ""} renderer={renderer} size={18} />
    </span>
  );
}

export interface DocRowProps {
  doc: MyDocListItem;
  title: string;
  href: string;
  external?: boolean;
  /** "markdrop.in/slug" or the workspace host + path. */
  address: string;
  /** Extra meta items after the views (e.g. who shared it in a library). */
  extraMeta?: ReactNode;
  statuses: RowStatus[];
  /** null = no access control on this row (e.g. a library row you don't own shows plain text). */
  onAccess?: (() => void) | null;
  copy?: { text: string; hint?: string } | null;
  menu: MenuEntry[];
  phone: boolean;
  /** First-load rise, delay in ms (null = no animation). */
  riseDelay?: number | null;
  menuLabel: string;
}

/**
 * One dashboard row (REVAMP_PLAN 7.10): FileIcon tile, title (+ at most two badges), a one-line meta
 * (VS Code mark · address · views · updated), the access control as a quiet trailing button, Copy
 * link and the RowMenu. On phones the meta drops to "slug · views" and the only action is the menu.
 */
export function DocRow({
  doc: d, title, href, external, address, extraMeta, statuses, onAccess, copy, menu, phone, riseDelay, menuLabel,
}: DocRowProps) {
  const shown = statuses.slice(0, 2);
  const access = accessOf(d);
  const views = plural(d.views ?? 0, "view");
  const updated = relativeTime(d.updated_at || d.created_at);
  const style: CSSProperties | undefined = riseDelay != null ? { animationDelay: `${riseDelay}ms` } : undefined;
  const menuItems = [...statusHeader(statuses.slice(2)), ...menu];

  return (
    <li className={cx("md-docrow", styles.row, riseDelay != null && styles.rise, "min-w-0")} style={style}>
      <RowTile d={d} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Anchor
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
            className="md-focus min-w-0 truncate rounded-sm text-body-strong text-text hover:underline hover:underline-offset-3"
            dir="auto"
            title={title}
          >
            {title}
            {external && <span className="md-visually-hidden"> (opens in a new tab)</span>}
          </Anchor>
          {shown.length > 0 && (
            <span className="flex shrink-0 items-center gap-1 max-sm:hidden">
              {shown.map((s) => (
                <Badge key={s.key} size="sm" tone={s.tone} icon={s.icon} upper={s.upper} title={s.title}>{s.label}</Badge>
              ))}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-caption text-text-muted">
          {d.vscode_synced && (
            <Tooltip content="Synced with VS Code" focusable>
              <span className="inline-flex shrink-0 items-center" aria-label="Synced with VS Code" role="img">
                <VSCodeIcon size={12} />
              </span>
            </Tooltip>
          )}
          {phone && shown.length > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1">
              {shown.slice(0, 1).map((s) => (
                <Badge key={s.key} size="sm" tone={s.tone} icon={s.icon} upper={s.upper}>{s.label}</Badge>
              ))}
            </span>
          )}
          <span className="min-w-0 truncate">
            {d.encrypted ? (
              <span>Encrypted</span>
            ) : (
              <span className="font-mono">{phone ? d.slug : address}</span>
            )}
            <span aria-hidden> · </span>
            <span>{views}</span>
            {!phone && extraMeta}
            {!phone && updated && (
              <>
                <span aria-hidden> · </span>
                <time dateTime={d.updated_at} title={`Updated ${fullDate(d.updated_at)}`}>{updated}</time>
              </>
            )}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!phone && (
          onAccess ? (
            <Button
              variant="ghost"
              size="sm"
              iconLeft={access.icon}
              onClick={onAccess}
              aria-label={`Who can open this: ${access.aria}. Change in Share`}
              className="text-text-secondary"
            >
              {access.label}
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 text-caption text-text-muted" title={access.aria}>
              <Icon name={access.icon} size={14} />
              {access.label}
            </span>
          )
        )}
        {!phone && copy && (
          copy.hint ? (
            <Tooltip content={copy.hint}>
              <CopyButton text={copy.text} label="Copy link" announceText="Link copied" />
            </Tooltip>
          ) : (
            <CopyButton text={copy.text} label="Copy link" announceText="Link copied" />
          )
        )}
        <RowMenu items={menuItems} label={menuLabel} />
      </div>
    </li>
  );
}

export default DocRow;
