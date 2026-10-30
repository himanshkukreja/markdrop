"use client";

/** Client bits of the docs chrome: the phone menu sheet and the home page's ask box / install box. */
import Link from "next/link";
import { useState } from "react";
import { Badge, Button, CopyButton, Drawer, Icon, IconButton, cx } from "@/components/ui";
import type { NavGroup, SiteTab } from "../types";
import { openSearch, setSyncedChoice, useSyncedChoice } from "./state";
import { ensureStatus, openAsk, useAsk } from "./ask/store";

export function NavLinks({ groups, current, onPick }: { groups: NavGroup[]; current?: string; onPick?: () => void }) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.group} className="dx-nav__group">
          <p className="dx-eyebrow dx-nav__title">{g.group}</p>
          <ul>
            {g.items.map((it) =>
              it.available ? (
                <li key={it.path}>
                  <Link href={it.path} className="dx-nav__item" aria-current={it.path === current ? "page" : undefined} onClick={onPick}>
                    <span className="dx-nav__label">{it.title}</span>
                    {it.isNew && (
                      <Badge tone="info" size="sm" upper>
                        New
                      </Badge>
                    )}
                  </Link>
                </li>
              ) : (
                <li key={it.path}>
                  <span className="dx-nav__item dx-nav__item--missing" title="Not written yet">
                    <span className="dx-nav__label">{it.title}</span>
                  </span>
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </>
  );
}

export function MobileMenu({ tabs, groups, activeTab, current, title }: { tabs: SiteTab[]; groups: NavGroup[]; activeTab?: string; current?: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(activeTab ?? tabs[0]?.id);
  const shown = groups.filter((g) => g.tab === tab);
  return (
    <>
      <IconButton icon="list" label="Open the docs menu" className="dx-menubtn" onClick={() => setOpen(true)} aria-expanded={open} />
      <Drawer open={open} onClose={() => setOpen(false)} side="left" width={320} title={title} bodyClassName="dx-sheet">
        <div className="dx-sheet__tabs" role="tablist" aria-label="Docs sections">
          {tabs.map((t) => {
            const hasGroups = groups.some((g) => g.tab === t.id);
            return hasGroups ? (
              <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} className="dx-sheet__tab" onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ) : (
              <Link key={t.id} href={t.href} className="dx-sheet__tab" onClick={() => setOpen(false)}>
                {t.label}
              </Link>
            );
          })}
        </div>
        <nav aria-label="Pages" className="dx-nav dx-nav--sheet">
          <NavLinks groups={shown} current={current} onPick={() => setOpen(false)} />
        </nav>
      </Drawer>
    </>
  );
}

/**
 * The home hero's ask box: the question goes to the Ask AI panel (the sheet on phones). When the
 * server says Ask AI is off, it searches the docs instead.
 */
export function HomeAsk({ chips = [], placeholder }: { chips?: string[]; placeholder?: string }) {
  const [q, setQ] = useState("");
  const { availability } = useAsk();
  const off = availability === "unavailable";
  const go = (question: string) => {
    const text = question.trim();
    if (!text) return;
    void ensureStatus().then((ok) => {
      if (ok) {
        openAsk({ question: text });
        setQ("");
      } else openSearch(text);
    });
  };
  return (
    <form
      className="dx-ask"
      onSubmit={(e) => {
        e.preventDefault();
        go(q);
      }}
    >
      <label htmlFor="dx-ask-home" className="dx-sr">
        Ask a question about these docs
      </label>
      <div className="dx-ask__box">
        <Icon name="zap" className="dx-ask__glyph" />
        <input
          id="dx-ask-home"
          type="text"
          className="dx-ask__input"
          placeholder={placeholder ?? "Ask anything"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => void ensureStatus()}
          autoComplete="off"
          maxLength={2000}
        />
        <Button type="submit" iconRight="arrowRight">
          {off ? "Search" : "Ask"}
        </Button>
      </div>
      {chips.length > 0 && (
        <div className="dx-ask__chips">
          {chips.map((c) => (
            <button key={c} type="button" className="dx-chip" onClick={() => go(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <p className="dx-ask__hint">{off ? "Ask AI is off right now, so Ask searches these docs." : "Answers come only from these docs, with links to the exact sections they used."}</p>
    </form>
  );
}

/** "Install the CLI" with an OS switch that follows (and sets) the reader's `os` choice. */
export function InstallBox({ title, commands, note, sync = "os", href }: { title: string; commands: Record<string, string>; note?: React.ReactNode; sync?: string; href?: string }) {
  const oses = Object.keys(commands);
  const stored = useSyncedChoice(sync);
  const [local, setLocal] = useState<string | null>(null);
  const pick = stored ?? local;
  const os = pick && oses.includes(pick) ? pick : oses[0];
  const cmd = commands[os] ?? "";
  return (
    <section aria-labelledby="dx-cli-h" className="dx-panel dx-install">
      <div className="dx-panel__head">
        <h2 id="dx-cli-h" className="dx-panel__title">
          {href ? <Link href={href}>{title}</Link> : title}
        </h2>
        <div role="radiogroup" aria-label="Your system" className="dx-seg">
          {oses.map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={o === os}
              data-on={o === os ? "" : undefined}
              className="dx-seg__opt"
              onClick={() => {
                setLocal(o);
                setSyncedChoice(sync, o);
              }}
            >
              {o}
            </button>
          ))}
        </div>
      </div>
      <div className={cx("dx-cmd")}>
        <span className="dx-cmd__prompt" aria-hidden>
          $
        </span>
        <code className="dx-cmd__code">{cmd}</code>
        <CopyButton text={cmd} label="Copy" size="sm" variant="ghost" announceText="Command copied" />
      </div>
      {note && <p className="dx-panel__note">{note}</p>}
    </section>
  );
}
