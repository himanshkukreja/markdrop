"use client";

/**
 * "Who's viewing": an avatar stack and the list behind it (lib/presence). One component for
 * documents, files and the Guides studio, so presence looks the same everywhere.
 *
 * Avatars: the photo or initials (an animal for anonymous viewers) on a tint of the viewer's
 * colour, ringed in that colour, faded with a moon badge when their tab is hidden. Up to 4 others
 * (2 on phones), "+N", then you. Clicking opens the list: you first with "(you)", everyone with
 * where they are, and "Show me as anonymous" when the page offers it. A popover on desktop, a bottom
 * sheet on phones.
 *
 * Recording: names, photos and the list are masked (`ph-mask`) and never autocaptured
 * (`ph-no-capture`). A join is announced politely, at most once every 10 s.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { announce, Drawer, Icon, Popover, Switch, Tooltip } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import {
  animalGlyph, sectionText, stackLabel, viewerColor, viewerInitials, viewerName,
  type PresenceViewer,
} from "@/lib/presence";
import s from "./presence.module.css";

export interface PresenceStackProps {
  /** Everyone listed (yourself included), in the server's order. */
  viewers: PresenceViewer[];
  /** Your own entry, when you're listed. */
  me: PresenceViewer | null;
  /** Everyone viewing, including those beyond the list. */
  total: number;
  /** End-to-end encrypted: "3 viewing" and nothing more. */
  countOnly?: boolean;
  /** "Show me as anonymous" (signed-in readers); null hides it. */
  anon?: { on: boolean; onChange: (on: boolean) => void } | null;
  /** The studio: open the page someone is on. */
  onSelect?: (v: PresenceViewer) => void;
  /** "bar": in a header bar. "float": a chip over a full-screen reader. */
  variant?: "bar" | "float";
  /** Shown only when somebody else is here (otherwise just you: nothing). */
  hideWhenAlone?: boolean;
  /** The list's heading. */
  title?: string;
  /** Under the list. */
  note?: string;
  /** The float variant's corner: a full-screen video keeps its controls at the bottom. */
  corner?: "bottom-right" | "top-right";
  className?: string;
}

function Face({ v, size = "sm", ring = true }: { v: PresenceViewer; size?: "sm" | "md"; ring?: boolean }) {
  const glyph = v.name ? null : animalGlyph(v.animal);
  const style = { "--pc": viewerColor(v.color) } as CSSProperties;
  return (
    <span
      className={[s.face, size === "md" ? s.faceMd : s.faceSm, ring && s.ring, v.state === "away" && s.away, "ph-mask"].filter(Boolean).join(" ")}
      style={style}
      aria-hidden
    >
      {v.pic ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={v.pic} alt="" referrerPolicy="no-referrer" className="ph-mask" />
      ) : glyph ? (
        <span className={s.glyph}>{glyph}</span>
      ) : (
        viewerInitials(v)
      )}
      {v.state === "away" && <span className={s.awayDot} />}
    </span>
  );
}

function tooltipText(v: PresenceViewer, you: boolean): string {
  const where = sectionText(v.sec);
  const name = you ? `${viewerName(v)} (you)` : viewerName(v);
  return [name, v.editing ? "Editing" : where, v.state === "away" ? "Away" : null].filter(Boolean).join(" · ");
}

function Row({ v, you, onSelect }: { v: PresenceViewer; you: boolean; onSelect?: (v: PresenceViewer) => void }) {
  const where = sectionText(v.sec);
  const body = (
    <>
      <Face v={v} size="md" />
      <span className="min-w-0 flex-1">
        <span className="ph-sensitive ph-mask block truncate text-body text-text">
          {viewerName(v)}
          {you && <span className="text-text-muted"> (you)</span>}
        </span>
        {(where || v.editing || v.state === "away") && (
          <span className="ph-mask block truncate text-caption text-text-muted">
            {[v.editing ? "Editing" : where, v.state === "away" ? "Away" : null].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      {v.owner && <span className="shrink-0 text-[12px] text-text-muted">Owner</span>}
    </>
  );
  return (
    <li>
      {onSelect && !you && v.sec ? (
        <button type="button" className={`md-focus ${s.row} ${s.rowButton}`} onClick={() => onSelect(v)}>{body}</button>
      ) : (
        <div className={s.row}>{body}</div>
      )}
    </li>
  );
}

function List({ viewers, me, total, anon, onSelect, note, close }: PresenceStackProps & { close?: () => void }) {
  const others = viewers.filter((v) => v.id !== me?.id);
  const hidden = total - others.length - (me ? 1 : 0);
  return (
    <div className="ph-no-capture flex flex-col gap-3">
      <ul className={s.list} aria-label="People viewing">
        {me && <Row v={me} you />}
        {others.map((v) => (
          <Row key={v.id} v={v} you={false} onSelect={onSelect ? (x) => { onSelect(x); close?.(); } : undefined} />
        ))}
        {hidden > 0 && (
          <li className="px-1 text-caption text-text-muted">and {hidden} more</li>
        )}
      </ul>
      {anon && (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <Switch
            checked={anon.on}
            onChange={(e) => anon.onChange(e.target.checked)}
            label={<span className="text-body text-text">Show me as anonymous</span>}
          />
          <span className="text-caption text-text-muted">
            {anon.on
              ? "Others see an animal instead of your name. Remembered in this browser."
              : me && !me.name
                ? "You appear as anonymous here: only the owner, its workspace and people it's shared with appear by name."
                : "Others here see your name and photo."}
          </span>
        </div>
      )}
      {note && <p className="m-0 text-caption text-text-muted">{note}</p>}
    </div>
  );
}

export function PresenceStack(props: PresenceStackProps) {
  const { viewers, me, total, countOnly, variant = "bar", hideWhenAlone, title = "Viewing now", corner = "bottom-right", className } = props;
  const phone = useMediaQuery(PHONE_QUERY);
  const [sheet, setSheet] = useState(false);

  // A polite word when someone arrives (never more often than every 10 s; never on load).
  const seen = useRef<Set<string> | null>(null);
  const lastSaid = useRef(0);
  useEffect(() => {
    const ids = new Set(viewers.map((v) => v.id));
    const before = seen.current;
    seen.current = ids;
    if (!before || countOnly) return;
    const arrived = viewers.filter((v) => !before.has(v.id) && v.id !== me?.id);
    if (!arrived.length || Date.now() - lastSaid.current < 10_000) return;
    lastSaid.current = Date.now();
    announce(arrived.length === 1 ? `${viewerName(arrived[0]!)} is viewing` : `${arrived.length} more people are viewing`);
  }, [viewers, me, countOnly]);

  const others = useMemo(() => viewers.filter((v) => v.id !== me?.id), [viewers, me]);
  if (total <= 0 || (hideWhenAlone && total <= 1)) return null;
  const wrap = [s.stackWrap, variant === "float" && s.float, variant === "float" && (corner === "top-right" ? s.floatTr : s.floatBr), "no-print", className]
    .filter(Boolean).join(" ");

  if (countOnly) {
    const label = total === 1 ? "Only you are viewing" : `${total} people viewing`;
    return (
      <span className={wrap}>
        <Tooltip content="Names aren't shown on end-to-end encrypted documents." side="bottom" focusable>
          <span className={s.count} aria-label={label}>
            <Icon name="eye" size={14} />
            {total} viewing
          </span>
        </Tooltip>
      </span>
    );
  }

  const shown = others.slice(0, 4);
  const moreWide = others.length - shown.length + Math.max(0, total - viewers.length);
  const moreNarrow = others.length - Math.min(2, shown.length) + Math.max(0, total - viewers.length);
  const label = stackLabel(viewers, me?.id ?? null, total);
  const trigger = (
    <button
      type="button"
      className={`md-focus ph-no-capture ${s.stack}`}
      aria-label={label}
      onClick={phone ? () => setSheet(true) : undefined}
    >
      {shown.map((v, i) => (
        // Earlier faces sit on top of the ones after them, so every face's initials stay readable.
        <span key={v.id} className={i >= 2 ? s.wideOnly : undefined} style={{ position: "relative", zIndex: 6 - i }}>
          <Tooltip content={<span className="ph-mask">{tooltipText(v, false)}</span>} side="bottom">
            <Face v={v} />
          </Tooltip>
        </span>
      ))}
      {moreWide > 0 && <span className={`${s.more} ${moreNarrow !== moreWide ? s.wideOnly : ""}`}>+{moreWide}</span>}
      {moreNarrow > 0 && moreNarrow !== moreWide && <span className={`${s.more} ${s.narrowOnly}`}>+{moreNarrow}</span>}
      {me && (
        <span className={others.length ? s.self : undefined}>
          <Tooltip content={<span className="ph-mask">{tooltipText(me, true)}</span>} side="bottom">
            <Face v={me} />
          </Tooltip>
        </span>
      )}
    </button>
  );

  if (phone) {
    return (
      <span className={wrap}>
        {trigger}
        <Drawer open={sheet} onClose={() => setSheet(false)} title={title} side="bottom" className={s.sheet}>
          <List {...props} close={() => setSheet(false)} />
        </Drawer>
      </span>
    );
  }
  return (
    <span className={wrap}>
      <Popover
        trigger={trigger}
        title={title}
        placement={variant === "float" ? (corner === "top-right" ? "bottom-end" : "top-end") : "bottom-end"}
        // In place, not portalled: anchored to the stack in the sticky bar (or the floating chip),
        // so opening it never scrolls the page to wherever a portalled panel first lands.
        width={320}
        panelClassName={s.panel}
      >
        {({ close }) => <List {...props} close={close} />}
      </Popover>
    </span>
  );
}
