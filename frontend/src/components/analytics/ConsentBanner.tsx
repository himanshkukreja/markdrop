"use client";

import { Button } from "@/components/ui";
import s from "./ConsentBanner.module.css";

/**
 * The analytics consent prompt (lib/consent). Shown to visitors in the EU, EEA, UK and Switzerland
 * until they choose, and to anyone who opens "Privacy choices" from the footer. A region, not a
 * modal: the page stays usable and focus is never taken.
 */
export default function ConsentBanner({ onChoose }: { onChoose: (granted: boolean) => void }) {
  return (
    <section className={s.banner} role="region" aria-labelledby="md-consent-title">
      <h2 id="md-consent-title" className={s.title}>Cookies and analytics</h2>
      <p className={s.body}>
        We&rsquo;d like to use cookies and session recordings to see how Markdrop is used and fix what&rsquo;s
        confusing. Documents, what you type and file contents are never recorded.
      </p>
      <div className={s.actions}>
        <Button size="sm" onClick={() => onChoose(true)}>Accept</Button>
        <Button size="sm" variant="secondary" onClick={() => onChoose(false)}>Decline</Button>
        <Button size="sm" variant="link" href="/privacy" className={s.more}>Privacy policy</Button>
      </div>
    </section>
  );
}
