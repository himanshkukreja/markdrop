"use client";

import { useState, type ReactNode } from "react";
import LoopVideo from "./LoopVideo";
import { LOOPS, type Loop } from "./loops";
import p from "./Proof.module.css";

/**
 * "See it for real": the product's own recordings (LOOPS, real screens with fictional data) in one
 * window, one at a time, picked from a list beside it. Every clip is server HTML (its poster); only
 * the chosen one is shown, so only it loads and plays (LoopVideo plays what is on screen).
 */

const TABS: Array<{ id: string; title: string; text: string; addr: string; loop: Loop; dark?: boolean }> = [
  {
    id: "fix",
    title: "The Fix list",
    text: "The top item, its evidence, a drafted fix, and the publish that closes it.",
    addr: "guides.markdrop.in · Fix list",
    loop: LOOPS.heroFix,
    dark: true,
  },
  {
    id: "editor",
    title: "A fix in the editor",
    text: "The drafted fix offered over the section, accepted with one click.",
    addr: "guides.markdrop.in · Editor",
    loop: LOOPS.editorFix,
    dark: true,
  },
  {
    id: "import",
    title: "Import from GitBook",
    text: "Navigation, pages and images come across as drafts, sped up.",
    addr: "guides.markdrop.in/new",
    loop: LOOPS.import,
  },
  {
    id: "private",
    title: "A private section",
    text: "jane@northwind.com signs in with an emailed link; the Northwind section opens.",
    addr: "help.acme.com/single-sign-on",
    loop: LOOPS.private,
    dark: true,
  },
];

/** The window's screen: 1.6 wide per 1 high; clips wider than that fill its width, the others its height. */
const SCREEN_AR = 1.6;

export default function Proof({ head }: { head?: ReactNode }) {
  const [on, setOn] = useState(TABS[0].id);
  const cur = TABS.find((t) => t.id === on) ?? TABS[0];
  return (
    <div className={p.grid}>
      <div className={p.side}>
        {head}
        <div className={p.list} role="group" aria-label="Recordings">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={p.tab} aria-pressed={t.id === on} data-on={t.id === on || undefined} onClick={() => setOn(t.id)}>
            <b>{t.title}</b>
            <small>{t.text}</small>
          </button>
        ))}
        </div>
      </div>
      <figure className={p.fig}>
        <div className={p.window}>
          <div className={p.bar} aria-hidden="true">
            <span className={p.dots}>
              <i />
              <i />
              <i />
            </span>
            <span className={p.addr}>{cur.addr}</span>
          </div>
          <div className={p.screen} style={{ aspectRatio: String(SCREEN_AR) }}>
            {TABS.map((t) => (
              <div key={t.id} className={p.slide} hidden={t.id !== on}>
                <LoopVideo {...t.loop} dark={t.dark} className={t.loop.w / t.loop.h >= SCREEN_AR ? p.wide : p.tall} />
              </div>
            ))}
          </div>
        </div>
        <figcaption className={p.cap}>Recorded in the studio and in a published guide, with fictional data.</figcaption>
      </figure>
    </div>
  );
}
