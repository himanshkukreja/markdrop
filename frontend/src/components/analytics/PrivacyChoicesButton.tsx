"use client";

import { openPrivacyChoices } from "@/lib/consent";

/** Footer and privacy-page control that reopens the analytics consent prompt. */
export default function PrivacyChoicesButton({ className, children = "Privacy choices" }: { className?: string; children?: React.ReactNode }) {
  return (
    <button type="button" className={className} onClick={openPrivacyChoices}>
      {children}
    </button>
  );
}
