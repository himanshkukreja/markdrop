import type { ReactNode } from "react";
import { sampleHref } from "@/lib/marketingFlags";

/**
 * A markdrop.in/<slug> chip in a mock (REVAMP_BUILD §5.H.8). It becomes a real link only when the slug
 * is published from a Markdrop-owned account (`sampleHref`); otherwise the children render as plain
 * text, so a mock never points at a stranger's document. Non-markdrop hosts (docs.example.com),
 * share ids and #k= fragments never link. No hooks: usable from server posters and client games.
 *
 * Only for chips outside interactive controls; mock address bars inside buttons or aria-hidden
 * illustrations stay text (a link inside a button is invalid HTML).
 */
export default function SampleSlug({ slug, host = "markdrop.in/", className, children }: { slug: string; host?: string; className?: string; children: ReactNode }) {
  const href = host === "markdrop.in/" ? sampleHref(slug) : null;
  if (!href) return className ? <span className={className}>{children}</span> : <>{children}</>;
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
