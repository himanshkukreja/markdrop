/**
 * Honesty gates for marketing and product copy (REVAMP_BUILD §5.H.6, O5). One place to flip a claim
 * when production state changes. Plain constants so server components can import them.
 */

/**
 * P2P copy discloses that an encrypted relay may forward the bytes when a network blocks a direct
 * path (owner rule; PROJECT_CONTEXT §1, `ec8bca1`). When true, the hero, Send Sim and /share show the
 * relay sentence and the relayed route in demos. Set to false to hide every relay mention (for example
 * if the TURN relay is confirmed not configured in production; REVAMP_BUILD Q2). Real transfers only
 * ever show a "Relayed" route when a peer's reported route is actually "relay".
 */
export const P2P_RELAY_LIVE = true;

/** Google Docs export stays hidden everywhere public until it is confirmed live in production (D7). */
export const GDOCS_LIVE = false;

/**
 * markdrop.in slugs that mocks display (REVAMP_BUILD §5.H.8). A chip renders as a link only if its slug
 * is in SAMPLE_SLUGS_PUBLISHED (published from a Markdrop-owned account); otherwise it is plain text,
 * so a mock never points at a stranger's document.
 */
export const SAMPLE_SLUGS = [
  "release-notes",
  "launch-page",
  "q3-report",
  "q3-budget",
  "product-demo",
  "docs-site",
  "plan",
  "my-project",
  "team-handbook",
  "onboarding",
  "q3-roadmap",
] as const;

export const SAMPLE_SLUGS_PUBLISHED: ReadonlySet<string> = new Set<string>([]);

export function sampleHref(slug: string): string | null {
  return SAMPLE_SLUGS_PUBLISHED.has(slug) ? `/${slug}` : null;
}
