import type { Metadata } from "next";
import PrivacyChoicesButton from "@/components/analytics/PrivacyChoicesButton";

export const metadata: Metadata = {
  title: "Privacy — Markdrop",
  description: "What Markdrop stores, what it measures, who processes it, and how to opt out.",
  alternates: { canonical: "/privacy" },
};

const UPDATED = "16 October 2026";

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="mt-12 mb-3 scroll-mt-24 text-h3 text-text">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 text-body text-text-secondary">{children}</p>;
}
function Li({ children }: { children: React.ReactNode }) {
  return <li className="mb-2 text-body text-text-secondary">{children}</li>;
}
const link = "md-focus rounded-sm font-semibold text-accent-text underline underline-offset-2 hover:text-accent-text-hover";

/**
 * The privacy policy. Static. Keep it in step with what the code does: lib/track (first-party),
 * lib/thirdPartyAnalytics (PostHog, Google Analytics), lib/consent, backend services/traffic.
 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-reading px-4 pt-14 pb-24 sm:px-6 sm:pt-20">
      <p className="mb-2 text-eyebrow uppercase text-text-muted">Last updated {UPDATED}</p>
      <h1 className="mb-6 text-h1 text-text">Privacy</h1>
      <P>
        Markdrop turns documents and files into links. This page says what we keep, what we measure,
        who helps us run the service, and how to opt out. Questions or requests:{" "}
        <a className={link} href="mailto:himanshu@markdrop.in">himanshu@markdrop.in</a>.
      </P>

      <H2 id="publish">What you publish</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>Documents and files you publish are stored so the link can show them. Anyone with a link-access link can open it; private, password-protected and workspace documents are checked before they open.</Li>
        <Li>Encrypted documents are encrypted in your browser. We store only ciphertext. The key is in the part of the link after <code className="font-mono text-code">#</code>, which browsers never send to us.</Li>
        <Li>Documents you set to expire are deleted when they expire. You can delete anything you own from your dashboard.</Li>
      </ul>

      <H2 id="account">Your account</H2>
      <P>
        Markdown needs no account. Uploading files, workspaces and the dashboard need a free one: we keep your
        email address, your name and picture if you sign in with Google, and the documents you own. To delete your
        account and everything in it, email us from the address you signed in with.
      </P>

      <H2 id="analytics">What we measure</H2>
      <P>We use three kinds of analytics, all to understand how Markdrop is used and what to fix.</P>
      <ul className="mb-4 list-disc pl-5">
        <Li>
          <strong className="text-text">Our own analytics.</strong> Page views, time on page, where visits come from and
          product events such as &ldquo;published&rdquo;. No cookies: a random id in your browser&rsquo;s storage. Your IP
          address is used once to look up your country and city and is not stored. Kept for about 13 months.
        </Li>
        <Li>
          <strong className="text-text">PostHog</strong> (product analytics and session recordings, hosted in the US). It
          records pages, clicks and scrolling, and, on most pages, a replay of how the page was used. When you sign
          in, your visits are linked to your account&rsquo;s email.
        </Li>
        <Li>
          <strong className="text-text">Google Analytics</strong> (aggregate traffic reports).
        </Li>
      </ul>
      <P>What PostHog and Google Analytics never receive:</P>
      <ul className="mb-4 list-disc pl-5">
        <Li>Document and file links. A document is reported as an anonymous reference, never its address.</Li>
        <Li>Anything after <code className="font-mono text-code">#</code> in a link, including encryption keys, and sign-in or invite tokens.</Li>
        <Li>What you write. Editors, previews, document pages and lists of your documents are not recorded, and every text field is masked.</Li>
        <Li>The contents or names of files you send with Share.</Li>
      </ul>

      <H2 id="cookies">Cookies and your choices</H2>
      <P>
        Our own analytics set no cookies. PostHog and Google Analytics do. If you are in the EU, the EEA, the UK or
        Switzerland, we ask first: until you accept, PostHog counts your visit without cookies and records nothing,
        and Google Analytics does not load. If your browser sends Global Privacy Control or Do Not Track, we treat
        that as a no.
      </P>
      <P>
        You can change your choice at any time:{" "}
        <PrivacyChoicesButton className={link}>open privacy choices</PrivacyChoicesButton>.
      </P>

      <H2 id="share">Sending files (Share)</H2>
      <P>
        Files go straight from your device to the other person&rsquo;s and are never stored on our servers. If a network
        blocks a direct path, an encrypted relay forwards the bytes and can&rsquo;t read them. We keep the name, type and
        size of the files, how many there were, a hashed IP, your account if you&rsquo;re signed in, and connection
        details (route, timing, browser), for 90 days.
      </P>

      <H2 id="processors">Who processes data for us</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>Vercel (website hosting) and Amazon Web Services in Mumbai (our API).</Li>
        <Li>MongoDB Atlas (database) and Cloudflare (file storage, the file viewer and the Share relay).</Li>
        <Li>Resend (sign-in and notification email).</Li>
        <Li>PostHog and Google (analytics, as above).</Li>
      </ul>
      <P>We don&rsquo;t sell personal data, and we don&rsquo;t use it for advertising.</P>

      <H2 id="email">Email</H2>
      <P>
        We send sign-in codes, notifications you trigger, and occasional product updates. Every update has an
        unsubscribe link.
      </P>

      <H2 id="changes">Changes</H2>
      <P>When this policy changes, the date at the top changes with it.</P>
    </div>
  );
}
