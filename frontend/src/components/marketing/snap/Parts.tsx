import type { CSSProperties, ReactNode } from "react";
import LoopVideo from "@/components/guides-landing/LoopVideo";
import { Icon } from "@/components/landing/ds";
import { SnapSection } from "./Snap";
import p from "./parts.module.css";

/**
 * Section building blocks for the snap pages (/mcp, /enterprise), in the landing's language: every
 * section explains one thing the same way (eyebrow, benefit headline, a sentence or two, three or
 * four points, a docs link) beside the real product on the desk mat. Server components; the only
 * islands are the loops (LoopVideo) and whatever a page passes in.
 */

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

export interface Point {
  icon: string;
  title: ReactNode;
  text?: ReactNode;
}

export function Points({ items }: { items: Point[] }) {
  return (
    <ul className={p.points}>
      {items.map((it, i) => (
        <li key={i}>
          <Icon name={it.icon} />
          <span>
            <b>{it.title}</b>
            {it.text ? <> {it.text}</> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A docs or page link in the copy column, with an arrow. */
export function More({ href, children, cta, external }: { href: string; children: ReactNode; cta?: string; external?: boolean }) {
  return (
    <a className={p.more} href={href} data-cta={cta} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
      <Icon name={external ? "arrowUpRight" : "arrowRight"} />
    </a>
  );
}

export interface FeatureProps {
  id: string;
  eyebrow: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  points?: Point[];
  /** Under the points: buttons and links. */
  actions?: ReactNode;
  /** Anything between the lede and the points (a command, a note). */
  extra?: ReactNode;
  visual: ReactNode;
  /** The visual on the left. */
  rev?: boolean;
  /** The page's first section: an <h1>. */
  hero?: boolean;
  /** Equal columns (for a wide copy column, e.g. an FAQ beside a list). */
  even?: boolean;
  className?: string;
}

/** One snap section: the copy beside a visual. */
export function Feature({ id, eyebrow, title, lede, points, actions, extra, visual, rev, hero, even, className }: FeatureProps) {
  const H = hero ? "h1" : "h2";
  return (
    <SnapSection id={id} labelledBy={`${id}-h`} className={className}>
      <div className={cx(p.split, rev && p.rev, even && p.wideCopy)}>
        <div className={p.copy}>
          <span className={p.eyebrow}>{eyebrow}</span>
          <H id={`${id}-h`} className={hero ? p.h1 : p.h2}>
            {title}
          </H>
          {lede && <p className={p.lede}>{lede}</p>}
          {extra}
          {points && <Points items={points} />}
          {actions && <div className={p.actions}>{actions}</div>}
        </div>
        <div className={p.visual}>{visual}</div>
      </div>
    </SnapSection>
  );
}

/** The dotted desk mat under a product frame, with an optional caption below it. */
export function Mat({ children, caption, style }: { children: ReactNode; caption?: ReactNode; style?: CSSProperties }) {
  return (
    <>
      <div className={p.mat} style={style}>
        {children}
      </div>
      {caption && <p className={p.caption}>{caption}</p>}
    </>
  );
}

/** A window (title bar + screen) around a product recording or panel, sized from its aspect ratio. */
export function Frame({ addr, tag, tagIcon, tagOn, ar, room, children, className }: {
  addr?: ReactNode;
  tag?: ReactNode;
  tagIcon?: string;
  tagOn?: boolean;
  /** The screen's width / height. */
  ar: number;
  /** Height the mat, caption and title bar take from the section (px, default 150). */
  room?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(p.frame, className)} style={{ "--ar": ar, ...(room ? { "--frame-room": `${room}px` } : {}) } as CSSProperties}>
      {tag && (
        <span className={p.tag} data-on={tagOn ? "" : undefined} aria-hidden="true">
          {tagIcon && <Icon name={tagIcon} />}
          {tag}
        </span>
      )}
      <div className={p.bar} aria-hidden="true">
        <span className={p.dots}>
          <i />
          <i />
          <i />
        </span>
        {addr && <span className={p.addr}>{addr}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

/** A recorded product loop in a window on the mat. Files: public/marketing-loops/<name>.{mp4,webm,webp}. */
export function LoopShot({ name, w, h, label, addr, tag, tagIcon, tagOn, caption, room }: {
  name: string;
  w: number;
  h: number;
  label: string;
  addr?: ReactNode;
  tag?: ReactNode;
  tagIcon?: string;
  tagOn?: boolean;
  caption?: ReactNode;
  room?: number;
}) {
  return (
    <Mat caption={caption}>
      <Frame addr={addr} tag={tag} tagIcon={tagIcon} tagOn={tagOn} ar={w / h} room={room}>
        <LoopVideo src={`/marketing-loops/${name}`} w={w} h={h} label={label} />
      </Frame>
    </Mat>
  );
}

export interface Faq {
  q: string;
  a: ReactNode;
}

/** Questions as disclosure rows (closed by default). */
export function FaqList({ items }: { items: Faq[] }) {
  return (
    <div className={p.faq}>
      {items.map((f) => (
        <details key={f.q} className={p.qa}>
          <summary>
            <span>{f.q}</span>
            <Icon name="chevronDown" />
          </summary>
          <p>{f.a}</p>
        </details>
      ))}
    </div>
  );
}

export { p as parts };
