"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { StudioLoader, useSite } from "../SiteContext";
import { ANCHORS, settingsHref } from "./sections";

/**
 * /guides/<site>/settings: goes to a section. The old one-page Settings' #anchors (#people,
 * #redirects, #review, #ai, #access…, still used by Publishes, Members and links people saved) go to
 * the section that has that card now, keeping the anchor; anything else goes to General.
 */
export default function SettingsIndex() {
  const { base } = useSite();
  const router = useRouter();
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    const section = ANCHORS[hash] ?? "general";
    router.replace(`${settingsHref(base, section)}${hash && ANCHORS[hash] ? `#${hash}` : ""}`);
  }, [base, router]);
  return <StudioLoader label="Opening settings" />;
}
