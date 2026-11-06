"use client";

import { Badge } from "@/components/ui";
import type { SlackActionItemsPreview, SlackReach } from "@/lib/slack";

const REACH: Record<SlackReach, string> = {
  linked: "Linked Slack account",
  email: "Found by email",
  name: "Found by exact name, if only one person has it",
  none: "Not reached (restricted meeting, no email)",
};

/**
 * Workspace settings › Integrations › Slack: what the next "Your action items" direct messages look
 * like (GET /api/v1/slack/action-items/preview), from the newest meeting the admin can open that has
 * action items with a person. A neutral drawing of the message, not Slack's own interface: who it
 * goes to, their items, "Open the notes" or who to ask, and the Stop these footer. Then everyone who
 * would get one, and how Markdrop finds them in Slack.
 */
export function ActionItemsPreview({ preview }: { preview: SlackActionItemsPreview }) {
  const msg = preview.message;
  if (!preview.meeting || !msg) {
    return (
      <p className="text-caption text-text-muted" data-testid="slack-ai-preview-empty">
        No meeting with action items yet. After the next one, each person gets their own items here.
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="slack-ai-preview">
      <p className="text-caption text-text-muted">
        From <span className="text-text">{preview.meeting.title}</span>{preview.meeting.when ? ` · ${preview.meeting.when}` : ""}. Nothing is sent from here.
      </p>
      <figure className="m-0 min-w-0 rounded-lg border border-border bg-bg p-4" aria-label={`Example message to ${msg.to}`}>
        <figcaption className="mb-2 text-caption text-text-muted">To <span className="ph-sensitive ph-mask text-text-secondary">{msg.to}</span></figcaption>
        <p className="text-[13px] leading-5 text-text">
          Your action items from <strong>{msg.title}</strong>{msg.when ? ` · ${msg.when}` : ""}
        </p>
        <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
          {msg.items.map((it, i) => (
            <li key={i} className="flex min-w-0 items-start gap-2 text-[13px] leading-5 text-text">
              <span aria-hidden className="mt-[3px] size-3.5 shrink-0 rounded-[3px] border border-border-strong" />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {it.text}
                {it.due && <em className="ml-1.5 text-text-muted">due {it.due}</em>}
              </span>
              {msg.done_buttons && <span className="shrink-0 rounded-md border border-border px-2 text-caption text-text-secondary">Done</span>}
            </li>
          ))}
        </ul>
        <div className="mt-3">
          {msg.open_link
            ? <span className="inline-block rounded-md border border-border px-2.5 py-0.5 text-caption font-medium text-text">Open the notes</span>
            : <p className="text-caption text-text-muted">Notes are in Markdrop (ask {msg.organizer || "the organizer"} for access)</p>}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
          <span className="text-caption italic text-text-muted">Sent after each meeting</span>
          <span className="rounded-md border border-border px-2 text-caption text-text-secondary">Stop these</span>
        </div>
      </figure>
      <div>
        <p className="text-caption font-medium text-text-secondary">Who gets one</p>
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0" data-testid="slack-ai-people">
          {preview.people.map((p, i) => (
            <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption">
              <span className="ph-sensitive ph-mask text-text">{p.name}</span>
              <span className="text-text-muted">{p.items} {p.items === 1 ? "item" : "items"}</span>
              {!p.member && <Badge size="sm">Not in Markdrop: items only</Badge>}
              <span className="text-text-muted">· {REACH[p.reach]}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
