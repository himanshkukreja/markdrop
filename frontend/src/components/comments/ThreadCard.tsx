"use client";

/**
 * One thread: what it points at (the quote, "text was changed" with the original, a block, or the page),
 * its messages with reactions, reply, resolve / reopen, assign, edit / delete own, and Track B / C's
 * actions and sections (slots.ts).
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Dropdown, Icon, IconButton, type MenuEntry } from "@/components/ui";
import { commentPeople, type MentionCandidate, type Message, type Person, type Thread } from "@/lib/comments";
import { Composer } from "./Composer";
import type { CommentsCtx } from "./context";
import { slots } from "./slots";

const REACTIONS = ["👍", "❤️", "🎉", "😄", "👀", "🙏", "✅", "🚀"];

export function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function Avatar({ p, size = "md" }: { p: Person | null; size?: "sm" | "md" }) {
  const name = p?.name ?? "Someone";
  return (
    <span className={`mdc-avatar mdc-avatar--${size}`} aria-hidden title={name}>
      {p?.picture ? <img src={p.picture} alt="" /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Light Markdown for comment bodies: **bold**, *italics*, `code`, links and @mentions. Never HTML. */
export function renderBody(text: string, mentions: Person[]): ReactNode[] {
  const out: ReactNode[] = [];
  const names = mentions.map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionRe = names.length ? `@(?:${names.map(esc).join("|")})` : "@\\u0000never";
  const re = new RegExp(`(\`[^\`\\n]+\`)|(\\*\\*[^*\\n]+\\*\\*)|(\\*[^*\\n]+\\*)|(\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^)\\s]+\\))|(https?:\\/\\/[^\\s<>()]+)|(${mentionRe})`, "g");
  text.split("\n").forEach((line, li) => {
    if (li) out.push(<br key={`br${li}`} />);
    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      const k = `${li}-${m.index}`;
      if (m[1]) out.push(<code key={k} className="mdc-code">{m[1].slice(1, -1)}</code>);
      else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
      else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>);
      else if (m[4]) {
        const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(m[4])!;
        out.push(<a key={k} href={mm[2]} target="_blank" rel="noopener noreferrer nofollow ugc">{mm[1]}</a>);
      } else if (m[5]) out.push(<a key={k} href={m[5]} target="_blank" rel="noopener noreferrer nofollow ugc">{m[5]}</a>);
      else if (m[6]) out.push(<span key={k} className="mdc-mention">{m[6]}</span>);
      last = m.index + m[0].length;
    }
    if (last < line.length) out.push(line.slice(last));
  });
  return out;
}

function Reactions({ ctx, thread, m }: { ctx: CommentsCtx; thread: Thread; m: Message }) {
  const can = ctx.perms.comment;
  const [picking, setPicking] = useState(false);
  if (!m.reactions.length && !can) return null;
  return (
    <div className="mdc-reactions">
      {m.reactions.map((r) => (
        <button key={r.emoji} type="button" className={`mdc-reaction${r.mine ? " is-mine" : ""}`} disabled={!can}
          aria-pressed={r.mine} title={r.names.join(", ")} aria-label={`${r.emoji} ${r.count}${r.mine ? ", including you" : ""}`}
          onClick={() => void ctx.react(thread.id, m.id, r.emoji)}>
          <span aria-hidden>{r.emoji}</span> {r.count}
        </button>
      ))}
      {can && (
        <Dropdown
          align="left"
          portal
          open={picking}
          onOpenChange={setPicking}
          aria-label="Add a reaction"
          trigger={<button type="button" className="mdc-reaction mdc-reaction--add" aria-label="Add a reaction"><Icon name="smile" /></button>}
          items={[{ custom: (
            <div className="mdc-emoji-row">
              {REACTIONS.map((e) => (
                <button key={e} type="button" className="mdc-emoji" aria-label={`React ${e}`} onClick={() => { setPicking(false); void ctx.react(thread.id, m.id, e); }}>{e}</button>
              ))}
            </div>
          ) }]}
        />
      )}
    </div>
  );
}

function MessageView({ ctx, thread, m, first }: { ctx: CommentsCtx; thread: Thread; m: Message; first: boolean }) {
  const [editing, setEditing] = useState(false);
  const extras = useMemo(() => slots().messageExtras, []);
  const menu: MenuEntry[] = [
    ...(m.can.edit ? [{ label: "Edit", icon: "edit", onClick: () => setEditing(true) }] : []),
    ...(m.can.delete ? [{ label: "Delete", icon: "trash", danger: true, onClick: () => { if (window.confirm("Delete this comment?")) void ctx.remove(thread.id, m.id); } }] : []),
  ];
  return (
    <div className={`mdc-msg${first ? " mdc-msg--first" : ""}`} data-message-id={m.id}>
      <div className="mdc-msg__head">
        <Avatar p={m.author} size="sm" />
        <span className="mdc-msg__name">{m.author.name}{m.ai && <Badge size="sm" tone="info" className="mdc-ai">AI</Badge>}</span>
        <time className="mdc-msg__time" dateTime={m.created_at ?? undefined} title={m.created_at ? new Date(m.created_at).toLocaleString() : undefined}>
          {timeAgo(m.created_at)}{m.edited_at ? " · edited" : ""}
        </time>
        {menu.length > 0 && !editing && (
          <Dropdown portal trigger={<IconButton icon="more" label="Comment options" size="sm" className="mdc-msg__more" />} items={menu} />
        )}
      </div>
      {editing ? (
        <Composer ctx={ctx} threadId={thread.id} autoFocus compact submitLabel="Save" initial={{ body: m.body, mentions: m.mentions.map((p) => p.id!).filter(Boolean) }}
          onCancel={() => setEditing(false)}
          onSubmit={async (d) => { await ctx.edit(thread.id, m.id, d.body, d.mentions); setEditing(false); }} />
      ) : m.deleted ? (
        <p className="mdc-msg__body mdc-muted">This comment was deleted.</p>
      ) : (
        <p className="mdc-msg__body" dir="auto">{renderBody(m.body, m.mentions)}</p>
      )}
      {!m.deleted && extras.map((x) => <x.Component key={x.id} message={m} thread={thread} ctx={ctx} />)}
      {!m.deleted && !editing && <Reactions ctx={ctx} thread={thread} m={m} />}
    </div>
  );
}

function AssignMenu({ ctx, thread }: { ctx: CommentsCtx; thread: Thread }) {
  const [people, setPeople] = useState<MentionCandidate[] | null>(null);
  const load = () => { if (!people) void commentPeople(ctx.slug, "", { readPassword: ctx.readPassword }).then((r) => setPeople(r.people.filter((p) => p.has_access))).catch(() => setPeople([])); };
  const items: MenuEntry[] = [
    { header: "Assign to" },
    ...(people ?? []).map((p) => ({ label: p.name + (p.you ? " (you)" : ""), icon: thread.assignee?.id === p.id ? "check" : "user", onClick: () => void ctx.assign(thread.id, p.id) })),
    ...(people === null ? [{ label: "Loading…", disabled: true }] : []),
    ...(thread.assignee ? [{ label: "Remove assignee", icon: "x", separated: true, onClick: () => void ctx.assign(thread.id, null) }] : []),
  ];
  return (
    <span onPointerDown={load} onKeyDown={load} onFocus={load}>
      <Dropdown portal trigger={<IconButton icon="user" label={thread.assignee ? `Assigned to ${thread.assignee.name}` : "Assign"} size="sm" />} items={items} />
    </span>
  );
}

export function ThreadCard({ ctx, thread, active, style, onMeasure }: {
  ctx: CommentsCtx; thread: Thread; active: boolean; style?: React.CSSProperties; onMeasure?: (el: HTMLElement | null) => void;
}) {
  const [replying, setReplying] = useState(false);
  const actions = useMemo(() => slots().threadActions.filter((a) => a.when(thread, ctx)), [thread, ctx]);
  const sections = useMemo(() => slots().threadSections, []);
  const a = thread.anchor;
  const changed = thread.anchor_status === "changed";
  const quote = changed ? thread.original.exact ?? a.quote?.exact : a.quote?.exact;
  const first = thread.messages[0];
  const rest = thread.messages.slice(1);
  const collapsed = !active && rest.length > 2;
  const shown = collapsed ? rest.slice(-1) : rest;
  return (
    <article
      ref={onMeasure}
      className={`mdc-thread${active ? " is-active" : ""}${thread.status === "resolved" ? " is-resolved" : ""}`}
      style={style}
      data-thread-id={thread.id}
      aria-label={`Comment by ${first?.author.name ?? "someone"}`}
      tabIndex={-1}
      onClick={(e) => {
        if ((e.target as Element).closest("button, a, textarea, input, [role='menu']")) return;
        ctx.setActive(thread.id, { scroll: true });
      }}
    >
      <header className="mdc-thread__head">
        {a.type === "page" ? (
          <span className="mdc-anchor mdc-anchor--page"><Icon name="doc" /> On the page</span>
        ) : quote ? (
          <blockquote className={`mdc-anchor${changed ? " mdc-anchor--changed" : ""}`} title={quote}>{quote}</blockquote>
        ) : (
          <span className="mdc-anchor mdc-anchor--block"><Icon name="lines" /> {(a.block_text ?? "A block").slice(0, 80)}</span>
        )}
        <div className="mdc-thread__tools">
          {thread.can.assign && thread.status === "open" && <AssignMenu ctx={ctx} thread={thread} />}
          {actions.map((x) => <IconButton key={x.id} icon={x.icon} label={x.label} size="sm" onClick={() => void x.run(thread, ctx)} />)}
          {thread.can.resolve && <IconButton icon="check" label="Resolve" size="sm" onClick={() => void ctx.resolve(thread.id)} />}
          {thread.can.reopen && <IconButton icon="undo" label="Reopen" size="sm" onClick={() => void ctx.reopen(thread.id)} />}
        </div>
      </header>
      {changed && <p className="mdc-changed"><Icon name="alert" /> The text this was about was changed.</p>}
      {thread.assignee && thread.status === "open" && (
        <p className="mdc-assignee"><Icon name="user" /> Assigned to <strong>{thread.assignee.name}</strong></p>
      )}
      {thread.status === "resolved" && thread.resolved_by && (
        <p className="mdc-resolved"><Icon name="check" /> Resolved by {thread.resolved_by.name} {timeAgo(thread.resolved_at)}</p>
      )}
      {first && <MessageView ctx={ctx} thread={thread} m={first} first />}
      {sections.map((s) => <s.Component key={s.id} thread={thread} ctx={ctx} />)}
      {collapsed && (
        <button type="button" className="mdc-more" onClick={() => ctx.setActive(thread.id)}>
          {rest.length - 1} more {rest.length - 1 === 1 ? "reply" : "replies"}
        </button>
      )}
      {shown.map((m) => <Fragment key={m.id}><MessageView ctx={ctx} thread={thread} m={m} first={false} /></Fragment>)}
      {thread.can.reply && (active || replying) ? (
        <Composer ctx={ctx} threadId={thread.id} compact placeholder="Reply…" submitLabel="Reply" autoFocus={replying}
          onCancel={replying ? () => setReplying(false) : undefined}
          onSubmit={async (d) => { await ctx.reply(thread.id, d.body, d.mentions, { attachments: d.attachments.map((x) => x.id), suggestion: d.suggestion ?? null }); setReplying(false); }} />
      ) : thread.can.reply ? (
        <Button size="sm" variant="ghost" className="mdc-replybtn" onClick={() => { setReplying(true); ctx.setActive(thread.id); }}>Reply</Button>
      ) : null}
    </article>
  );
}
