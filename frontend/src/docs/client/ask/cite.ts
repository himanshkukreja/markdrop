"use client";

/**
 * Going to a cited section: answers carry absolute docs URLs (https://docs.markdrop.in/page#id),
 * which become in-app paths here so they work on any docs host (and locally). The same page
 * scrolls; another page navigates first. Either way the section is briefly highlighted
 * (accent-soft with a ring, about 2 s) and its heading takes focus.
 */
import { DOCS_HOST } from "../../host";

const KNOWN_HOSTS = new Set([DOCS_HOST, "docs.markdrop.in"]);

/** "/path#anchor" for a docs URL (or an in-app path), or null for anything else. */
export function docsPath(url: string, siteUrl?: string): string | null {
  if (!url) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (url.startsWith("#")) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const hosts = new Set(KNOWN_HOSTS);
    if (siteUrl) {
      try {
        hosts.add(new URL(siteUrl).host);
      } catch {}
    }
    if (typeof location !== "undefined") hosts.add(location.host);
    if (!hosts.has(u.host)) return null;
    // Text outputs (.md twins, llms.txt) are real files: leave them as links.
    if (/\.[a-z0-9]+$/i.test(u.pathname)) return null;
    return (u.pathname.replace(/\/+$/, "") || "/") + u.hash;
  } catch {
    return null;
  }
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function isHeading(el: Element): boolean {
  return /^H[1-6]$/.test(el.tagName) || el.classList.contains("dx-h");
}

function levelOf(el: Element): number {
  const h = el.classList.contains("dx-h") ? el.querySelector("h1,h2,h3,h4,h5,h6") : el;
  return h ? Number(h.tagName.slice(1)) || 6 : 6;
}

let current: { overlay: HTMLElement; host: HTMLElement; timers: ReturnType<typeof setTimeout>[] } | null = null;

function clearHighlight() {
  if (!current) return;
  current.timers.forEach(clearTimeout);
  current.overlay.remove();
  current.host.classList.remove("dx-cite-host");
  current = null;
}

/** Scrolls to #id and highlights the section it starts (heading → next heading of the same level or higher). */
export function highlightSection(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  clearHighlight();
  const start = target.closest(".dx-h") ?? target;
  const host = start.parentElement;
  const reduce = reducedMotion();
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  if (!host) return true;

  let end: Element = start;
  if (isHeading(start)) {
    const level = levelOf(start);
    for (let n = start.nextElementSibling; n; n = n.nextElementSibling) {
      if (isHeading(n) && levelOf(n) <= level) break;
      end = n;
    }
  }
  host.classList.add("dx-cite-host");
  const hostRect = host.getBoundingClientRect();
  const a = start.getBoundingClientRect();
  const b = end.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = "dx-cite-mark";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.top = `${a.top - hostRect.top - 10}px`;
  overlay.style.height = `${Math.max(b.bottom, a.bottom) - a.top + 20}px`;
  host.appendChild(overlay);
  const timers = [
    setTimeout(() => overlay.classList.add("dx-cite-mark--out"), 2000),
    setTimeout(() => clearHighlight(), reduce ? 2000 : 2600),
  ];
  current = { overlay, host, timers };
  return true;
}

/** Waits (up to 4 s) for `pathname` to be on screen with #id rendered, then highlights it. */
function highlightWhenReady(pathname: string, id: string) {
  const until = Date.now() + 4000;
  const tick = () => {
    const here = location.pathname.replace(/\/+$/, "") || "/";
    if (here === pathname && document.getElementById(id)) {
      // One more frame so the router's own hash scroll has happened.
      requestAnimationFrame(() => highlightSection(id));
      return;
    }
    if (Date.now() < until) setTimeout(tick, 60);
  };
  tick();
}

/**
 * Opens a source. `push` is the router's push (client navigation). Returns false when the URL
 * isn't a docs page (the caller lets the link open normally).
 */
export function goToSource(url: string, push: (href: string) => void, siteUrl?: string): boolean {
  const href = docsPath(url, siteUrl);
  if (!href) return false;
  const hashAt = href.indexOf("#");
  const pathname = (hashAt >= 0 ? href.slice(0, hashAt) : href) || "/";
  const id = hashAt >= 0 ? decodeURIComponent(href.slice(hashAt + 1)) : "";
  const here = location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === here) {
    if (id) {
      highlightSection(id);
      history.replaceState(history.state, "", `#${encodeURIComponent(id)}`);
    } else window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
    return true;
  }
  push(href);
  if (id) highlightWhenReady(pathname, id);
  return true;
}
