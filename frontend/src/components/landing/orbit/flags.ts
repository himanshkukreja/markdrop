/**
 * Behaviour switches for the Orbit hero. Honesty gates (P2P_RELAY_LIVE, GDOCS_LIVE, sample slugs)
 * live in "@/lib/marketingFlags" (REVAMP_BUILD 5.H.6); the hero imports them from there.
 */

/**
 * The boards return to the attract demo after 20 s without input. The build brief for this package
 * says autoplay "stops for good once the visitor interacts", so this is off; flip it to restore the
 * board's idle return.
 */
export const IDLE_RETURN = false;

/** The VS Code Marketplace listing (the boards' `#vs-code` placeholder). */
export { VSCODE_URL } from "@/components/shell/links";

/** Compatibility re-export for components/share/relay.ts; new code imports "@/lib/marketingFlags". */
export { P2P_RELAY_LIVE } from "@/lib/marketingFlags";
