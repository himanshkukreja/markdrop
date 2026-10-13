/**
 * Relay honesty gate for the share pages (REVAMP_BUILD D6/Q2, §5.5): the shared marketing flag.
 *
 * The idle page can't see the server's ICE configuration (lib/p2p only receives it on the signalling
 * socket, privately), so "the relay is available" is the product flag the hero and Send Sim use.
 * It gates the relay row in TransferExplainer and the relay sentence in "What we record". The live
 * console and the receiver draw a relayed path / "Relayed" badge only from a peer's real route.
 */
export { P2P_RELAY_LIVE } from "@/lib/marketingFlags";
