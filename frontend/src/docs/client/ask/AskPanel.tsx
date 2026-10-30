"use client";

/**
 * The Ask AI conversation (board "AskAI"): a docked right panel on desktop that pushes the page
 * over (not a modal), a right drawer on tablets, and a bottom sheet on phones (board
 * "MobileAsk"; the drawer and sheet are modal, with a focus trap). Loaded on first open.
 */
import { useEffect, useMemo, useRef } from "react";
import { Button, Drawer, Icon, IconButton, cx } from "@/components/ui";
import { openSearch } from "../state";
import { Composer, FollowUps, OpenInLinks, TurnView, fallbackOpenIn, useFollowUps } from "./Conversation";
import { aboutProduct, askIn, assistantName, closeAsk, isStreaming, newConversation, setDraft, setFull, useAsk, type AskState } from "./store";

export type PanelMode = "docked" | "drawer" | "sheet";

function unavailableText(reason: string | undefined): string {
  const name = assistantName();
  return reason === "not_configured"
    ? `${name} isn't set up on this server yet. You can still search the docs, or open this page in your own assistant.`
    : `${name} is turned off right now. You can still search the docs, or open this page in your own assistant.`;
}

function liveText(s: AskState): string {
  const last = s.panel.turns[s.panel.turns.length - 1];
  if (!last) return "";
  if (isStreaming(last)) return last.status?.label ? `${last.status.label}…` : "Answering…";
  if (last.state === "done") return last.sources.length ? `Answer ready, with ${last.sources.length === 1 ? "1 source" : `${last.sources.length} sources`}.` : "Answer ready.";
  if (last.state === "stopped") return "Stopped.";
  return last.message ?? "";
}

function Empty({ suggestions, onPick }: { suggestions: string[]; onPick: (q: string) => void }) {
  return (
    <div className="dx-askempty">
      <span className="dx-tile" aria-hidden>
        <Icon name="zap" />
      </span>
      <strong className="dx-askempty__title">{`Ask ${aboutProduct()}`}</strong>
      <p className="dx-askempty__text">Answers come from these docs, with numbered links to the exact sections they used.</p>
      {suggestions.length > 0 && <FollowUps title="Try" items={suggestions.slice(0, 4)} onPick={onPick} />}
    </div>
  );
}

function Unavailable({ s }: { s: AskState }) {
  return (
    <div className="dx-askoff" role="status">
      <strong className="dx-askempty__title">{`${assistantName()} is off`}</strong>
      <p>{unavailableText(s.unavailableReason)}</p>
      <OpenInLinks links={fallbackOpenIn("", s.context ?? s.page, s.siteUrl)} />
      <Button variant="ghost" size="sm" iconLeft="search" onClick={() => openSearch()}>
        Search the docs
      </Button>
    </div>
  );
}

export default function AskPanel({ mode, suggestions }: { mode: PanelMode; suggestions: string[] }) {
  const s = useAsk();
  const body = useRef<HTMLDivElement>(null);
  const turns = s.panel.turns;
  const last = turns[turns.length - 1];
  const streaming = last && isStreaming(last) ? last : undefined;
  const asked = useMemo(() => turns.map((t) => t.question), [turns]);
  const followUps = useFollowUps(last, asked);
  const unavailable = s.availability === "unavailable";
  const onNavigate = mode === "docked" ? undefined : () => closeAsk({ restoreFocus: false });

  const ask = (q: string) => {
    askIn("panel", q, s.context);
    setDraft("");
  };

  // A new question scrolls into view; while an answer streams, stay at the bottom if already there.
  const pinned = useRef(true);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  });
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
  }, [turns.length]);
  useEffect(() => {
    const el = body.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [last?.answer, last?.state, last?.sources.length, followUps.length]);

  const conversation = (
    <>
      <div className="dx-sr" aria-live="polite" aria-atomic="true">
        {liveText(s)}
      </div>
      {turns.length === 0 ? (
        unavailable ? <Unavailable s={s} /> : <Empty suggestions={suggestions} onPick={ask} />
      ) : (
        turns.map((t) => <TurnView key={t.id} turn={t} variant={mode === "sheet" ? "sheet" : "panel"} siteUrl={s.siteUrl} onNavigate={onNavigate} />)
      )}
      {!streaming && !unavailable && <FollowUps items={followUps} onPick={ask} />}
    </>
  );

  // Ask AI off: the body explains and offers the Open-in links; a conversation from before keeps them under it.
  const composer = unavailable ? (
    turns.length ? <Unavailable s={s} /> : null
  ) : (
    <Composer draft={s.draft} context={s.context} streamingTurn={streaming} focusNonce={s.focusNonce} onSubmit={ask} variant={mode === "sheet" ? "sheet" : "panel"} followUp={turns.length > 0} />
  );

  if (mode !== "docked") {
    return (
      <Drawer
        open={s.open}
        onClose={() => closeAsk()}
        side={mode === "sheet" ? "bottom" : "right"}
        width={440}
        title={
          <span className="dx-askdrawer__title">
            {mode === "drawer" && <Icon name="zap" />}
            {assistantName()}
          </span>
        }
        className={cx("dx-askdrawer", `dx-askdrawer--${mode}`)}
        bodyClassName="dx-askpanel__body"
        footer={composer ? <div className="dx-askdrawer__foot">{composer}</div> : undefined}
      >
        {turns.length > 0 && (
          <div className="dx-askdrawer__tools">
            <Button variant="ghost" size="sm" iconLeft="plus" onClick={newConversation}>
              New conversation
            </Button>
          </div>
        )}
        <div ref={body} className="dx-askpanel__scroll">
          {conversation}
        </div>
      </Drawer>
    );
  }

  return (
    <aside
      className={cx("dx-askpanel", s.full && "dx-askpanel--full")}
      aria-label={assistantName()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          closeAsk();
        }
      }}
    >
      <div className="dx-askpanel__head">
        <Icon name="zap" className="dx-askpanel__glyph" />
        <h2 className="dx-askpanel__title">{assistantName()}</h2>
        <IconButton icon="plus" label="New conversation" size="sm" onClick={newConversation} disabled={!turns.length && !s.draft} />
        <IconButton icon={s.full ? "minimize" : "expand"} label={s.full ? "Exit full screen" : "Open full screen"} size="sm" onClick={() => setFull(!s.full)} />
        <IconButton icon="x" label={`Close ${assistantName()}`} size="sm" onClick={() => closeAsk()} aria-keyshortcuts="Escape" />
      </div>
      <div ref={body} className="dx-askpanel__body">
        <div className="dx-askpanel__col">{conversation}</div>
      </div>
      {composer && (
        <div className="dx-askpanel__foot">
          <div className="dx-askpanel__col">{composer}</div>
        </div>
      )}
    </aside>
  );
}
