import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Use — Markdrop",
  description: "The rules for using Markdrop: your account and content, what you can publish, AI and integrations, limits, and the legal terms.",
  alternates: { canonical: "/terms" },
};

const UPDATED = "11 November 2026";
const CONTACT = "team@markdrop.in";

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="mt-12 mb-3 scroll-mt-24 text-h3 text-text">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 text-body text-text-secondary">{children}</p>;
}
function Li({ children }: { children: React.ReactNode }) {
  return <li className="mb-2 text-body text-text-secondary">{children}</li>;
}
function B({ children }: { children: React.ReactNode }) {
  return <strong className="text-text">{children}</strong>;
}
const link = "md-focus rounded-sm font-semibold text-accent-text underline underline-offset-2 hover:text-accent-text-hover";
const Mail = () => <a className={link} href={`mailto:${CONTACT}`}>{CONTACT}</a>;

const SECTIONS: Array<[string, string]> = [
  ["about", "Who we are"],
  ["service", "What Markdrop is"],
  ["accounts", "Your account"],
  ["workspaces", "Workspaces and domains"],
  ["content", "Your content"],
  ["links", "Links and who can open them"],
  ["acceptable-use", "Acceptable use"],
  ["files", "Files, pages and storage"],
  ["ai", "AI features"],
  ["integrations", "Integrations and other services"],
  ["share", "Sending files (Share)"],
  ["free", "Free use, limits and changes"],
  ["software", "Our software and name"],
  ["complaints", "Reports, copyright and grievances"],
  ["ending", "Ending your use"],
  ["disclaimers", "Disclaimers"],
  ["liability", "Limitation of liability"],
  ["indemnity", "Indemnity"],
  ["law", "Governing law"],
  ["changes", "Changes to these terms"],
  ["notices", "Notices and contact"],
  ["general", "General"],
];

/**
 * Terms of Use. Static. Keep it in step with what the product does and with /privacy (which it
 * refers to for anything about personal data). Owner decisions 2026-11-11: operated by Himanshu
 * Kukreja as an individual; laws of India, courts at New Delhi; contact team@markdrop.in.
 * Never name AI models, versions, caps or costs here (say "fair-use limits").
 */
export default function TermsPage() {
  return (
    <div className="mx-auto w-full max-w-reading px-4 pt-14 pb-24 sm:px-6 sm:pt-20">
      <p className="mb-2 text-eyebrow uppercase text-text-muted">Last updated {UPDATED}</p>
      <h1 className="mb-6 text-h1 text-text">Terms of Use</h1>
      <P>
        These terms are the agreement between you and Markdrop for using markdrop.in, its apps and its API. We&rsquo;ve
        tried to write them plainly. Please read them with our{" "}
        <a className={link} href="/privacy">Privacy Policy</a>, which says what we do with personal data and is part of
        these terms. By using Markdrop, or by choosing Continue when you sign in, you agree to them. If you don&rsquo;t
        agree, please don&rsquo;t use Markdrop.
      </P>

      <nav aria-label="On this page" className="mb-4 rounded-md border border-border bg-surface px-4 py-3">
        <p className="mb-2 text-eyebrow uppercase text-text-muted">On this page</p>
        <ol className="grid list-decimal gap-x-6 gap-y-1 pl-5 text-body text-text-secondary sm:grid-cols-2">
          {SECTIONS.map(([id, label]) => (
            <li key={id}><a className="md-focus rounded-sm text-text-secondary underline-offset-2 hover:text-text hover:underline" href={`#${id}`}>{label}</a></li>
          ))}
        </ol>
      </nav>

      <H2 id="about">1. Who we are</H2>
      <P>
        Markdrop is operated by Himanshu Kukreja, an individual (sole proprietor) based in India. In these terms
        &ldquo;Markdrop&rdquo;, &ldquo;we&rdquo; and &ldquo;us&rdquo; mean him, and &ldquo;the service&rdquo; means
        markdrop.in and every site, app, extension, command-line tool, API and AI-app connection we provide under the
        Markdrop name (including docs.markdrop.in, Markdrop Guides and pages served on a workspace&rsquo;s own domain).
        You can reach us at <Mail />.
      </P>
      <P>
        &ldquo;You&rdquo; means the person using the service. If you use it for a company or other organization (for
        example by creating or joining its workspace), you agree to these terms for that organization too, and you
        confirm you&rsquo;re allowed to.
      </P>
      <P>
        You must be at least 13 years old, and old enough where you live to agree to these terms. If you&rsquo;re under
        18, a parent or guardian must agree to them for you.
      </P>

      <H2 id="service">2. What Markdrop is</H2>
      <P>
        Markdrop turns documents and files into links that open rendered in a browser: Markdown documents, pages,
        HTML pages and zipped websites, PDFs, spreadsheets, images, audio and video. Around that it offers workspaces
        and folders for teams, custom domains, Markdrop Guides (documentation sites), meetings and team memory,
        comments and sign-offs, analytics for the things you publish, peer-to-peer file sending (Share), AI features,
        integrations with other services, a command-line tool, a VS Code extension, an API and connections for AI
        apps (MCP). Features can be added, changed or removed over time (see <a className={link} href="#free">section 12</a>).
      </P>

      <H2 id="accounts">3. Your account</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>Publishing a Markdown document needs no account. Uploading files, workspaces, the dashboard and most other features need a free account, which you create by signing in with an email code or with Google.</Li>
        <Li>Use an email address you control and keep it current: we send sign-in codes and important notices to it.</Li>
        <Li>Keep your sign-in, devices, API tokens and connected AI apps secure. They act as you, and you&rsquo;re responsible for what is done through your account. Tell us at <Mail /> if you think someone else has access, and revoke tokens or apps you don&rsquo;t recognise in Settings.</Li>
        <Li>An account is for one person. Don&rsquo;t share it, sell it, or create accounts to get around limits or a suspension.</Li>
      </ul>

      <H2 id="workspaces">4. Workspaces and domains</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>A workspace belongs to its owner. The owner and admins decide who is a member, what members can do, which integrations are connected and which domains it uses, and they can see, move, change access to and delete items in it (as described in our docs). When you add something to a workspace, its owner and admins get that control over it.</Li>
        <Li>Meetings, pages and other items made in a workspace are part of that workspace. If you leave or are removed, they stay with the workspace.</Li>
        <Li>Only connect a domain you own or are allowed to use, and keep its DNS records in place. If the records are removed or the domain lapses, the domain stops serving your workspace. Addresses on markdrop.in keep working.</Li>
        <Li>If you invite people or connect services for a workspace, you&rsquo;re responsible for having the right to do so.</Li>
      </ul>

      <H2 id="content">5. Your content</H2>
      <P>
        <B>You own what you publish.</B> Documents, files, pages, comments, meeting notes and everything else you add
        (&ldquo;your content&rdquo;) stay yours. We claim no ownership of it.
      </P>
      <P>
        <B>The licence you give us.</B> So we can run the service, you give us a worldwide, non-exclusive, royalty-free
        licence to store, copy, process, convert, render and display your content, and send it to the people and
        services you choose, only to provide, secure and improve the service for you and as you direct. That includes
        making previews and thumbnails, converting formats (for example rendering Markdown, diagrams and math, or
        exporting to Google Docs or PDF), indexing it for search and Ask, sending it to an AI provider when you use an
        AI feature, and keeping backups. The licence ends when your content is deleted, except for copies in backups
        until they roll over, and copies other people made while they had access.
      </P>
      <P>
        <B>Your responsibility.</B> You confirm you have the rights to everything you publish, upload or connect, and
        that it, and the way you share it, doesn&rsquo;t break the law or anyone else&rsquo;s rights (including
        copyright, trademarks, privacy and confidentiality). If your content includes other people&rsquo;s personal
        data (for example meeting transcripts), you&rsquo;re responsible for having a lawful basis to share it with us
        and the people you share it with.
      </P>
      <P>
        <B>Feedback.</B> If you send us ideas or suggestions, we may use them without owing you anything.
      </P>

      <H2 id="links">6. Links and who can open them</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>An item set to <B>Anyone with the link</B> can be opened by anyone who has or guesses the link, and links can be forwarded. Don&rsquo;t publish anything there you wouldn&rsquo;t want seen by people you didn&rsquo;t send it to. Use private, password-protected, workspace or encrypted items for anything sensitive.</Li>
        <Li>For end-to-end encrypted documents, the key is the part of the link after <code className="font-mono text-code">#</code> and never reaches us. If you lose the full link (or the password), we can&rsquo;t recover the document.</Li>
        <Li>The people you give access to can copy, download, print or forward what they can open. We can&rsquo;t take back a copy someone else made.</Li>
        <Li>Owners of documents and files see analytics about the views of what they publish, as described in our <a className={link} href="/privacy#views">Privacy Policy</a>.</Li>
      </ul>

      <H2 id="acceptable-use">7. Acceptable use</H2>
      <P>Don&rsquo;t use Markdrop to, or try to:</P>
      <ul className="mb-4 list-disc pl-5">
        <Li>publish or send anything illegal, including child sexual abuse material, content that promotes terrorism or violence, or content a court or authority has ordered removed;</Li>
        <Li>infringe copyright, trademarks or other rights, or publish other people&rsquo;s private or confidential information without the right to;</Li>
        <Li>harass, threaten, defame or impersonate anyone, or mislead people about who you are or who a page comes from;</Li>
        <Li>phish, or collect passwords, payment details or other credentials under false pretences, including with HTML pages that imitate another service;</Li>
        <Li>distribute malware, exploits or anything designed to harm devices or data, or host files for an attack;</Li>
        <Li>send spam, or use links, invitations, comments or notifications to reach people who didn&rsquo;t ask for them;</Li>
        <Li>get around limits, access controls, rate limits, payments or security, probe or test our systems for vulnerabilities without our written permission (we welcome responsible reports at <Mail />), or access accounts, items or data that aren&rsquo;t yours;</Li>
        <Li>overload or disrupt the service, scrape it in bulk outside the API, mine cryptocurrency, or use it as general-purpose file hosting or a content delivery network for another service;</Li>
        <Li>use AI features to produce content these terms forbid, or in a way that breaks our AI provider&rsquo;s usage rules;</Li>
        <Li>copy, resell or offer the service to others as your own, or use it to build a competing service, except as the open-source licence of our code allows (see <a className={link} href="#software">section 13</a>).</Li>
      </ul>
      <P>
        We may remove or disable content, links, domains, integrations or accounts that break these rules or the law,
        or that put people or the service at risk, and we may report illegal activity to the authorities. Where it&rsquo;s
        practical and lawful, we&rsquo;ll tell you what we did and why, and you can reply to dispute it.
      </P>

      <H2 id="files">8. Files, pages and storage</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>Files are stored with our storage provider and served from a separate address so that HTML and other active content can&rsquo;t reach your Markdrop account. Even so, only open HTML pages and files from people you trust, as with any website.</Li>
        <Li>The service has limits, such as file size, storage per account, versions kept per file, and numbers of members and domains. They are listed in the <a className={link} href="https://docs.markdrop.in/account/limits">Limits</a> page of our docs and can change (see <a className={link} href="#free">section 12</a>).</Li>
        <Li>Items you set to expire are deleted when they expire. Older versions of a file can be removed to keep you within your storage.</Li>
        <Li>We work to keep your content safe and back it up, but Markdrop isn&rsquo;t a backup service. Keep your own copies of anything important.</Li>
      </ul>

      <H2 id="ai">9. AI features</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>Some features use AI: writing and editing in pages, summaries of meetings, search and Ask, insights in analytics, Team updates, Jira drafts and Guides. They&rsquo;re optional, and they run only when you or your workspace use them.</Li>
        <Li>AI output can be wrong, incomplete or out of date. Check it before you rely on it, publish it or act on it, especially for decisions about people, money, health or law. You&rsquo;re responsible for what you do with it.</Li>
        <Li>What you send to an AI feature and what it gives back are your content (<a className={link} href="#content">section 5</a>). To answer, the text a feature needs is sent to our AI provider, which doesn&rsquo;t use it to train models. Encrypted items are never sent. Details are in our <a className={link} href="/privacy#processors">Privacy Policy</a>.</Li>
        <Li>AI features have fair-use limits. When one is reached, the feature tells you, and everything else keeps working without the AI part.</Li>
      </ul>

      <H2 id="integrations">10. Integrations and other services</H2>
      <P>
        Markdrop can connect to other services, such as Zoom, Google (sign-in, Google Docs and Google Meet notes in
        Drive), Slack, Jira (Atlassian), GitHub, VS Code and AI apps like Claude, ChatGPT and Cursor. When you connect
        one:
      </P>
      <ul className="mb-4 list-disc pl-5">
        <Li>You authorise Markdrop to access that service on your behalf, or on your workspace&rsquo;s, within the permissions you approve on that service&rsquo;s own screen, and only to provide the feature you turned on. What each integration reads and keeps is in our <a className={link} href="/privacy#integrations">Privacy Policy</a>.</Li>
        <Li>Your use of that service stays under its own terms and policies, and its provider is responsible for it. We don&rsquo;t control other services and aren&rsquo;t responsible for their availability, changes or what they do with data you give them.</Li>
        <Li>If you connect a service for a workspace or a company account (for example a Zoom account or a Slack workspace), you confirm you&rsquo;re allowed to, and that the people whose data it brings in (such as meeting participants) have been told as the law requires.</Li>
        <Li>You can disconnect an integration at any time, in Markdrop or in the other service. What is deleted when you do is in our docs and Privacy Policy.</Li>
        <Li>A provider may change or stop its service or its API, and we may then have to change or stop the integration.</Li>
      </ul>

      <H2 id="share">11. Sending files (Share)</H2>
      <P>
        Share sends files directly from your device to the people you choose; they aren&rsquo;t stored on our servers.
        You&rsquo;re responsible for what you send and to whom, and the rules in <a className={link} href="#acceptable-use">section 7</a>{" "}
        apply. A transfer can fail or stop if either side goes offline, so keep the original until it arrives.
      </P>

      <H2 id="free">12. Free use, limits and changes</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>Markdrop is free to use today. If we introduce paid plans or paid features, we&rsquo;ll show the price and terms before you choose them, and you&rsquo;ll never be charged without agreeing to it.</Li>
        <Li>Use of the service is subject to fair-use and rate limits that keep it fast and available for everyone. If an account&rsquo;s use is far beyond normal and affects others, we may slow it down or ask you to reduce it.</Li>
        <Li>We keep improving Markdrop, so features change. We may add, change, limit or remove features, or stop the service. If a change significantly reduces what you can do, or if we stop the service, we&rsquo;ll give reasonable notice where we can (at least 30 days before stopping the service) so you can export your content.</Li>
        <Li>Features marked beta, preview or early access may be less reliable, and may change or be withdrawn without notice.</Li>
      </ul>

      <H2 id="software">13. Our software and name</H2>
      <P>
        Markdrop&rsquo;s source code is published on{" "}
        <a className={link} href="https://github.com/himanshkukreja/markdrop">GitHub</a> under the MIT licence, and that
        licence governs your use of the code. These terms govern your use of the service we run. The Markdrop name, logo
        and look aren&rsquo;t licensed to you: don&rsquo;t use them in a way that suggests your service is ours or that we
        endorse you. Third-party names and logos belong to their owners.
      </P>

      <H2 id="complaints">14. Reports, copyright and grievances</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li><B>Reporting an item.</B> Use <B>Report</B> on a document or file, or email <Mail /> with its link and what is wrong.</Li>
        <Li><B>Copyright.</B> If you believe something on Markdrop infringes your copyright, email <Mail /> with: the work you own, the link to the material, why it infringes, your contact details, a statement that you believe in good faith the use isn&rsquo;t authorised, and a statement that your notice is accurate and that you are the owner or authorised to act for them. We&rsquo;ll act on valid notices and may close the accounts of repeat infringers. If your content was removed and you believe that was a mistake, reply with your reasons.</Li>
        <Li><B>Grievance Officer.</B> Under India&rsquo;s Information Technology Act, 2000 and the rules made under it, complaints about content or about these terms can be sent to our Grievance Officer, Himanshu Kukreja, at <Mail />. We acknowledge complaints within 24 hours and aim to resolve them within 15 days.</Li>
      </ul>

      <H2 id="ending">15. Ending your use</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li><B>You</B> can stop using Markdrop at any time. You can delete anything you own from your dashboard, and to delete your account and everything in it, email <Mail /> from the address you sign in with.</Li>
        <Li><B>We</B> may suspend or close an account, or remove access to the service, if you break these terms, if the law requires it, or if your use creates risk or harm for others or for the service. Unless it&rsquo;s urgent or unlawful to do so, we&rsquo;ll tell you first and give you a chance to fix it or to export your content.</Li>
        <Li>When an account is closed, its content is deleted, together with workspaces it owns. Copies in backups are deleted as the backups roll over. Items in a workspace someone else owns stay with that workspace.</Li>
        <Li>Sections 5 (the licence, until content is deleted), 7, 14 and 16 to 22 keep applying after you stop using Markdrop.</Li>
      </ul>

      <H2 id="disclaimers">16. Disclaimers</H2>
      <P>
        Markdrop is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent the law allows, we make no
        promises or warranties about it, express or implied, including that it will be uninterrupted, error-free,
        secure, or fit for a particular purpose, that content will never be lost, or that AI output or other
        people&rsquo;s content is accurate. You use the service, and content published by others, at your own risk.
        Content on Markdrop is the responsibility of the person who published it, not ours.
      </P>

      <H2 id="liability">17. Limitation of liability</H2>
      <P>
        To the extent the law allows, Markdrop won&rsquo;t be liable for any indirect, incidental, special,
        consequential or punitive damages, or for lost profits, revenue, data, goodwill or business opportunities,
        arising out of or relating to the service or these terms, even if we were told they were possible. Our total
        liability for all claims relating to the service or these terms is limited to the greater of the amount you
        paid us for the service in the 12 months before the claim and INR 5,000.
      </P>
      <P>
        Nothing in these terms limits liability that can&rsquo;t be limited by law, such as for fraud, or takes away
        rights you have as a consumer under the law where you live that can&rsquo;t be waived by agreement.
      </P>

      <H2 id="indemnity">18. Indemnity</H2>
      <P>
        To the extent the law allows, you agree to defend and compensate Markdrop for claims, losses and reasonable
        costs (including legal fees) brought by others that arise from your content, your use of the service, your
        breach of these terms, or your breach of the law or someone else&rsquo;s rights. We&rsquo;ll tell you about such
        a claim promptly and let you take part in defending it.
      </P>

      <H2 id="law">19. Governing law</H2>
      <P>
        These terms are governed by the laws of India. The courts at New Delhi, India have exclusive jurisdiction over
        any dispute arising out of or relating to them or the service, subject to any mandatory right you have to bring
        a claim where you live. Before going to court, please write to us at <Mail /> so we can try to settle it
        informally first.
      </P>

      <H2 id="changes">20. Changes to these terms</H2>
      <P>
        We may update these terms as Markdrop and the law change. The date at the top shows the latest version. If a
        change is significant, we&rsquo;ll tell you by email or in the app before it takes effect, normally at least 14
        days ahead, unless the change is required by law or for security. If you keep using Markdrop after a change
        takes effect, you accept the new terms; if you don&rsquo;t agree, stop using the service and you can delete your
        account.
      </P>

      <H2 id="notices">21. Notices and contact</H2>
      <P>
        We send notices to the email address on your account, or show them in the app. Send notices and questions to
        us at <Mail />.
      </P>

      <H2 id="general">22. General</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>These terms and the Privacy Policy are the whole agreement between you and us about the service. Some features may come with extra terms that we show you when you turn them on.</Li>
        <Li>If a part of these terms can&rsquo;t be enforced, the rest still applies. If we don&rsquo;t enforce a part straight away, we haven&rsquo;t given up the right to enforce it later.</Li>
        <Li>You may not transfer these terms to someone else without our consent. We may transfer them to a company or person that takes over Markdrop (for example a company we form to run it), and we&rsquo;ll tell you if we do.</Li>
        <Li>We aren&rsquo;t responsible for delays or failures caused by events beyond our reasonable control, such as outages of the providers we rely on, natural disasters or acts of government.</Li>
        <Li>Nothing in these terms makes you and us partners, employees or agents of each other.</Li>
      </ul>
    </div>
  );
}
