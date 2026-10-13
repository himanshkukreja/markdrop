"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, MarkdropMark } from "@/components/ui";
import { BrowserFrame } from "@/components/kit/BrowserFrame";
import { LinkPill } from "@/components/kit/LinkPill";
import { KitIcon } from "@/components/kit/DeviceGlyph";
import s from "./enterprise.module.css";

/** sessionStorage flag: the swap has played in this session (REVAMP_PLAN 7.2: once per session). */
export const SWAP_KEY = "md_ent_swap";
/** Class on <html> that pins the figure to its end state (set pre-paint by SWAP_SCRIPT). */
const DONE_CLASS = "md-ent-swapped";

/** Inline, before the hero: a returning visitor in the same session (or reduced motion) never sees
 *  the markdrop.in start frame, not even for one paint. Storage errors mean "don't animate". */
export const SWAP_SCRIPT = `try{if(sessionStorage.getItem('${SWAP_KEY}')==='1'||matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.classList.add('${DONE_CLASS}')}catch(e){document.documentElement.classList.add('${DONE_CLASS}')}`;

const CHECKLIST = [
  { label: "Set up your laptop and accounts", done: true },
  { label: "Read the engineering handbook", done: true },
  { label: "Ship your first change", done: false },
];
const TOC = ["Your first week", "Accounts", "Tools we use", "Who to ask"];

type Phase = "rest" | "play" | "done";

/**
 * The hero's one autoplaying sequence: a single BrowserFrame whose tab, favicon, address and accent
 * rule swap from markdrop.in/onboarding to docs.example.com/onboarding, then numbered pins (keyed to
 * the list beside it) and a chat link preview pop in. It plays once per session, only once the frame
 * is half in view. The server HTML, no-JS, reduced motion and every later visit show the end state.
 *
 * The figure is one image to assistive tech (role="img" + a label naming the end state); the
 * swapping text inside is presentation.
 */
export function HeroSwap() {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("rest");

  // Client navigations don't run the inline script: decide before paint here too.
  useLayoutEffect(() => {
    const html = document.documentElement;
    try {
      if (sessionStorage.getItem(SWAP_KEY) === "1" || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        html.classList.add(DONE_CLASS);
      }
    } catch {
      html.classList.add(DONE_CLASS);
    }
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || document.documentElement.classList.contains(DONE_CLASS)) return;
    let timer: number | undefined;
    const finish = () => {
      try { sessionStorage.setItem(SWAP_KEY, "1"); } catch { /* private mode: replays next visit */ }
      document.documentElement.classList.add(DONE_CLASS);
      setPhase("done");
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        setPhase("play");
        timer = window.setTimeout(finish, 2100); // last pop ends at ~1.98s
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={s.stage}
      data-swap={phase}
      role="img"
      aria-label="A document served on docs.example.com with the Acme Docs name, favicon and colour, and its link preview in a chat"
    >
      <BrowserFrame
        size="lg"
        className={s.frame}
        favicon={
          <span className={s.swap}>
            <span className={`${s.out} inline-flex`}><MarkdropMark size={14} /></span>
            <span className={`${s.in} ${s.favicon}`}>A</span>
          </span>
        }
        title={
          <span className={s.swapBlock}>
            <span className={`${s.out} truncate`}>Onboarding guide · Markdrop</span>
            <span className={`${s.in} truncate`}>Onboarding guide · Acme Docs</span>
          </span>
        }
        bodyClassName="flex flex-col"
      >
        <div className={s.addr}>
          <span className="hidden sm:inline-flex"><KitIcon name="chevronLeft" size={16} /></span>
          <span className="hidden sm:inline-flex"><KitIcon name="chevronRight" size={16} /></span>
          <span className={`${s.swapBlock} flex-1`}>
            <LinkPill variant="address" size="sm" icon="lock" host="markdrop.in" slug="onboarding" className={`${s.out} ${s.addrPill}`} />
            <LinkPill variant="address" size="sm" icon="lock" host="docs.example.com" slug="onboarding" className={`${s.in} ${s.addrPill}`} />
          </span>
        </div>

        <div className={s.tenantRule} aria-hidden="true">
          <span className={`${s.out} ${s.ruleMarkdrop}`} />
          <span className={`${s.in} ${s.ruleTenant}`} />
        </div>

        <div className="flex h-12 items-center gap-7 border-b border-border bg-surface px-4 sm:h-13 sm:px-8">
          <span className="flex items-center gap-2.5">
            <span className={`${s.tenantMark} size-6.5 text-[13px]`}>A</span>
            <span className="text-body-strong whitespace-nowrap">Acme Docs</span>
          </span>
          <span className="hidden gap-5 text-[13px] text-text-muted md:flex lg:hidden xl:flex">
            <span className="text-text">Handbook</span>
            <span>Engineering</span>
            <span>Changelog</span>
          </span>
          <span className="ml-auto flex items-center gap-2 text-caption whitespace-nowrap text-text-secondary">
            Sign in
            <span className="inline-flex text-text-muted md:hidden lg:inline-flex xl:hidden"><KitIcon name="list" size={16} /></span>
          </span>
        </div>

        <div className="grid gap-8 px-5 pt-6 pb-8 sm:px-10 sm:pb-10 md:grid-cols-[minmax(0,1fr)_156px]">
          <div className="min-w-0">
            <div className="text-[26px] leading-8 font-bold tracking-[-0.02em]">Onboarding guide</div>
            <div className="mt-1 text-caption text-text-muted">Updated 2 days ago · 6 min read</div>
            <p className="mt-3.5 text-body leading-[22px] text-text-secondary">
              Welcome to the team. This guide covers your first week: your accounts, the tools we use, and who to ask when you are stuck.
            </p>
            <div className="mt-4 text-h4">Your first week</div>
            <ul className="mt-2 flex flex-col gap-2">
              {CHECKLIST.map((c) => (
                <li key={c.label} className="flex items-center gap-2.5">
                  <span className={`${s.check} ${c.done ? s.checkDone : ""}`}>{c.done && <KitIcon name="check" size={10} />}</span>
                  <span className={c.done ? "text-body text-text-secondary" : "text-body text-text"}>{c.label}</span>
                </li>
              ))}
            </ul>
            <div className={`${s.callout} mt-3.5 text-caption`}>Stuck? Ask in the team channel. Someone usually answers within the hour.</div>
          </div>
          <div className="hidden md:block">
            <div className="text-eyebrow text-text-muted uppercase">On this page</div>
            <div className="mt-2 flex flex-col">
              {TOC.map((t, i) => (
                <span key={t} className={`${s.tocItem} ${i === 0 ? s.tocCurrent : ""} text-caption`}>{t}</span>
              ))}
            </div>
          </div>
        </div>
      </BrowserFrame>

      {/* Pins keyed to the numbered list: 1 address, 2 tab, 3 colour, 4 link preview. */}
      <span aria-hidden="true" className={`${s.pin} ${s.stagePin} ${s.pinTab} ${s.pop} ${s.later}`}>2</span>
      <span aria-hidden="true" className={`${s.pin} ${s.stagePin} ${s.pinHost} ${s.pop} ${s.later}`}>1</span>
      <span aria-hidden="true" className={`${s.pin} ${s.stagePin} ${s.pinColour} ${s.pop} ${s.later}`}>3</span>

      <div className={`${s.chat} ${s.rise} ${s.later}`}>
        <div className="flex items-center gap-2">
          <Avatar name="Daniel Okafor" size="sm" />
          <span className="text-body-strong">Daniel</span>
          <span className="text-caption text-text-muted">10:42</span>
        </div>
        <div className="mt-1.5 font-mono text-caption text-accent-text">docs.example.com/onboarding</div>
        <div className="mt-2 flex overflow-hidden rounded-lg border border-border bg-surface">
          <span className={s.chatStripe} />
          <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <span className={s.favicon}>A</span>
              <span className="text-micro text-text-secondary">Acme Docs</span>
            </div>
            <span className="text-body-strong">Onboarding guide</span>
            <span className="text-caption text-text-muted">Your accounts, tools and first week.</span>
          </div>
        </div>
        <span aria-hidden="true" className={`${s.pin} ${s.pinCard} ${s.pop} ${s.later}`}>4</span>
      </div>
    </div>
  );
}

export default HeroSwap;
