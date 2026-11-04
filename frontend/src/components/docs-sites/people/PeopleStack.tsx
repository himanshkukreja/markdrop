"use client";

import { useState } from "react";
import { Anchor, Tooltip, cx } from "@/components/ui";
import { roleLabel, type GuidePerson } from "@/lib/docsSites";
import { colorFor, viewerColor } from "@/lib/presence";

/** One letter: two don't fit a small circle legibly. */
const initial = (name: string) => Array.from(name.trim())[0]?.toUpperCase() || "?";

/** "You", else their name. */
export const personLabel = (p: Pick<GuidePerson, "name" | "you">) => (p.you ? "You" : p.name || "Someone");

/** A person's face: their photo (https), else their initial on a soft colour that's stable per name. */
export function PersonFace({ person, size = 24, className }: { person: Pick<GuidePerson, "name" | "picture">; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const pic = person.picture && person.picture.startsWith("https://") && !broken ? person.picture : null;
  return (
    <span
      aria-hidden
      className={cx("ph-no-capture relative inline-grid shrink-0 select-none place-items-center overflow-hidden rounded-full font-bold leading-none", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        background: `color-mix(in srgb, ${viewerColor(colorFor(person.name || "?"))} 16%, var(--surface))`,
        color: `color-mix(in srgb, ${viewerColor(colorFor(person.name || "?"))} 82%, var(--text))`,
      }}
    >
      {initial(person.name || "?")}
      {/* A profile photo from the sign-in provider: next/image would need every host allow-listed. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {pic && <img src={pic} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setBroken(true)} className="absolute inset-0 size-full object-cover" />}
    </span>
  );
}

/** "Riya, Sam, you and 4 more". */
export function peopleWords(people: GuidePerson[], count: number): string {
  const names = people.map((p) => (p.you ? "you" : p.name || "someone"));
  const rest = Math.max(0, count - people.length);
  if (!names.length) return "No one yet";
  const listed = rest ? names.join(", ") : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]!;
  const text = rest ? `${listed} and ${rest} more` : listed;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Who works on a guide, at a glance: up to three overlapping faces (admins first), then "+n". Each
 * face names its person and role on hover (the design system's tooltip, instant); "+n" says how many
 * more. The whole stack is one link to the guide's Settings › People (edit controls there for the
 * guide's admins only; everyone else sees who's there), with a label that reads the names out.
 */
export function PeopleStack({ people, count, href, guide, size = 24, className, tipSide = "top" }: {
  people: GuidePerson[];
  count: number;
  /** Settings › People of the guide. */
  href: string;
  /** The guide's name, for the link's label. */
  guide: string;
  size?: number;
  className?: string;
  tipSide?: "top" | "bottom";
}) {
  if (!people.length) return null;
  const rest = Math.max(0, count - people.length);
  const words = peopleWords(people, count);
  return (
    <Anchor
      href={href}
      data-people-stack
      aria-label={`People on ${guide}: ${words}. Open People`}
      className={cx(
        "md-focus group inline-flex shrink-0 items-center rounded-full py-0.5 pl-0.5 pr-1.5 no-underline transition-colors hover:bg-surface-hover",
        !rest && "pr-0.5",
        className,
      )}
    >
      {people.map((p, i) => (
        <Tooltip key={p.user_id} side={tipSide} content={<span className="ph-sensitive ph-mask">{personLabel(p)} · {roleLabel(p.role)}</span>}>
          <span className={cx("inline-flex rounded-full shadow-[0_0_0_2px_var(--surface)] transition-shadow group-hover:shadow-[0_0_0_2px_var(--surface-hover)]", i > 0 && "-ml-1.5")}>
            <PersonFace person={p} size={size} />
          </span>
        </Tooltip>
      ))}
      {rest > 0 && (
        <Tooltip side={tipSide} content={`${rest} more ${rest === 1 ? "person works" : "people work"} on it`}>
          <span aria-hidden className="ml-1 text-[12px] font-semibold tabular-nums text-text-muted group-hover:text-text-secondary">+{rest}</span>
        </Tooltip>
      )}
    </Anchor>
  );
}

export default PeopleStack;
