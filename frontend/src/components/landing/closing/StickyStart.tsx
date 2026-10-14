"use client";

import { useEffect, useState } from "react";
import { Icon } from "../orbit/ds";
import s from "./Closing.module.css";

/**
 * Mobile sticky "Start writing" bar (MobileLanding.dc.html interaction phone c). Phones only (<768,
 * CSS). It appears once the hero has scrolled away and hides again when the closing CTA comes into
 * view, so it never doubles the page's own primary. Safe-area aware. Nothing renders on the server or
 * without JS.
 */
export default function StickyStart() {
  const [pastHero, setPastHero] = useState(false);
  const [atClose, setAtClose] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const hero = document.querySelector("#hero");
    const close = document.querySelector("[data-closing-cta]");
    const ios: IntersectionObserver[] = [];
    if (hero) {
      const io = new IntersectionObserver(([e]) => setPastHero(!e.isIntersecting && e.boundingClientRect.top < 0));
      io.observe(hero);
      ios.push(io);
    }
    if (close) {
      // "At the closing CTA" = it has entered the viewport, or the page is already past it (footer).
      const io = new IntersectionObserver(([e]) => setAtClose(e.isIntersecting || e.boundingClientRect.top < 0));
      io.observe(close);
      ios.push(io);
    }
    return () => ios.forEach((io) => io.disconnect());
  }, []);

  if (!pastHero || atClose) return null;
  return (
    <div className={s.bar} role="region" aria-label="Start writing">
      <div className={s.barCap}>
        <Icon name="check" size={14} />
        Markdown never needs an account
      </div>
      <div className={s.barRow}>
        <a href="/new" className="md-btn md-btn--primary md-btn--lg md-btn--block" data-cta="sticky_start">
          Start writing
          <Icon name="arrowRight" />
        </a>
        <a href="/upload" className="md-btn md-btn--secondary md-btn--lg md-iconbtn" aria-label="Upload a file" title="Upload a file" data-cta="sticky_upload">
          <Icon name="upload" />
        </a>
      </div>
    </div>
  );
}
