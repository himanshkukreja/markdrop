"use client";

/** The DS "How the transfer works" explainer, wired to the relay honesty gate and the real breakdown link. */
import { TransferExplainer as DSTransferExplainer } from "@/components/ui";
import { P2P_RELAY_LIVE } from "./relay";

export const FILESHARE_DOC = "https://github.com/himanshkukreja/markdrop/blob/main/FILESHARE.md";

export default function TransferExplainer() {
  return <DSTransferExplainer href={FILESHARE_DOC} relayAvailable={P2P_RELAY_LIVE} discloseRelay={P2P_RELAY_LIVE} />;
}
