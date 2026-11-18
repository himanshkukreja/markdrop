"use client";

/**
 * /todos (You › My to-dos): your personal to-do page in each team you're in (never General), made from the team's
 * calls — a section per company, ticking synced with the call. Each card opens the page.
 */
import { useEffect, useState } from "react";
import { Alert, Icon, Skeleton } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { myTodos, type TodoCard } from "@/lib/todos";
import { TodoCards } from "./TodoCards";
import "./todos.css";

export default function MyTodos() {
  const [cards, setCards] = useState<TodoCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    myTodos().then((d) => { if (live) setCards(d.pages); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Couldn't load your to-dos."); });
    return () => { live = false; };
  }, []);
  const open = (cards ?? []).reduce((a, c) => a + c.open, 0);
  return (
    <div className="td-page" data-testid="my-todos">
      <header className="td-head">
        <h1 className="td-title">My to-dos</h1>
        <p className="td-sub">
          Your action items from your teams&apos; calls, one page per team, by company{cards && cards.length ? ` · ${open} open` : ""}.
          Tick one on its page or on the call: both follow. Only you and your team&apos;s leads see them.
        </p>
      </header>
      {error && <Alert tone="danger" className="td-alert">{error}</Alert>}
      {!cards && !error && <div className="td-cards">{[0, 1].map((i) => <Skeleton key={i} variant="rect" height={130} />)}</div>}
      {cards && cards.length === 0 && (
        <div className="td-empty">
          <Icon name="checkSquare" />
          <p>No to-dos yet. Join a team (not General) and your action items from its calls land here.</p>
        </div>
      )}
      {cards && cards.length > 0 && <TodoCards cards={cards} by="team" />}
      <p className="td-muted" style={{ marginTop: 18 }}><ReadMore topic="todos" /></p>
    </div>
  );
}
