import type { Metadata } from "next";
import PrivacyChoicesButton from "@/components/analytics/PrivacyChoicesButton";

export const metadata: Metadata = {
  title: "Privacy — Markdrop",
  description: "What Markdrop stores, what it measures, who processes it, and how to opt out.",
  alternates: { canonical: "/privacy" },
};

const UPDATED = "11 November 2026";

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
 * lib/thirdPartyAnalytics (PostHog, Google Analytics), lib/consent, backend services/traffic, and
 * viewer analytics (lib/engage, backend services/doc_views).
 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-reading px-4 pt-14 pb-24 sm:px-6 sm:pt-20">
      <p className="mb-2 text-eyebrow uppercase text-text-muted">Last updated {UPDATED}</p>
      <h1 className="mb-6 text-h1 text-text">Privacy</h1>
      <P>
        Markdrop turns documents and files into links. This page says what we keep, what we measure,
        who helps us run the service, and how to opt out. Markdrop is operated by Himanshu Kukreja, an individual
        based in India, who is responsible for your data. Questions or requests:{" "}
        <a className={link} href="mailto:himanshu@markdrop.in">himanshu@markdrop.in</a>. Using Markdrop is also covered by
        our <a className={link} href="/terms">Terms of Use</a>.
      </P>

      <H2 id="publish">What you publish</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>Documents and files you publish are stored so the link can show them. Anyone with a link-access link can open it; private, password-protected and workspace documents are checked before they open.</Li>
        <Li>Encrypted documents are encrypted in your browser. Our servers store only the encrypted text and never receive the key — the part of the link after <code className="font-mono text-code">#</code>. Anyone with the full link can read it, and we can&rsquo;t recover it. We still see the link name, the size of the encrypted text, dates and view counts, and the page code that does the encrypting is served by us.</Li>
        <Li>Documents you set to expire are deleted when they expire. You can delete anything you own from your dashboard.</Li>
        <Li>Who&rsquo;s viewing a document is shown live to the others on it and never stored. You appear by name only on documents you have access to (you own it, it&rsquo;s in your workspace, or it was shared with you); everywhere else you&rsquo;re an anonymous animal.</Li>
      </ul>

      <H2 id="views">When you open someone&rsquo;s document or file</H2>
      <P>
        Each time a document or file is opened, its owner can see that view in their analytics: when it was opened,
        how long it was actively read or watched, and what happened in it (sections and pages read, slides and
        spreadsheet tabs shown, video played, paused and skipped, how far down the page, links opened, code copied
        (never the text), downloads, prints, questions asked with Ask AI and sign-offs). For an item in a workspace,
        the workspace&rsquo;s admins and editors see the same; its viewers see only how many views there were.
      </P>
      <ul className="mb-4 list-disc pl-5">
        <Li><strong className="text-text">Where from and on what.</strong> An approximate location (country, region and city, looked up from your IP address, which is not stored) and timezone; your device type, operating system and browser with their versions (or the app you opened it in, like Slack or LinkedIn); screen size and language; whether you used the installed app or a page that embeds it; and where you came from (another site, an email, a Markdrop page).</Li>
        <Li><strong className="text-text">Signed in:</strong> the owner sees your name and email address with your view.</Li>
        <Li><strong className="text-text">Not signed in:</strong> you&rsquo;re an anonymous visitor, recognised only by a random id in your browser&rsquo;s storage (so a second visit shows as a return), never by name, email or IP address.</Li>
        <Li>Each view&rsquo;s detail is kept for 180 days; totals are kept longer. In Settings → Account you can see how many views carry your name and take your name off all of them; deleting your account removes your name from every view.</Li>
        <Li>If your browser sends Global Privacy Control, none of this is recorded: the view is counted, nothing more.</Li>
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
          <strong className="text-text">PostHog</strong> (product analytics and session recordings, hosted in the US). On
          markdrop.in, guides.markdrop.in and docs.markdrop.in it records pages, clicks and scrolling, and a replay
          of how each page was used. When you sign in, your visits are linked to your account&rsquo;s email.
        </Li>
        <Li>
          <strong className="text-text">Google Analytics</strong> (aggregate traffic reports).
        </Li>
      </ul>
      <P>What PostHog and Google Analytics never receive:</P>
      <ul className="mb-4 list-disc pl-5">
        <Li>Document and file links. A document is reported as an anonymous reference, never its address.</Li>
        <Li>Anything after <code className="font-mono text-code">#</code> in a link, including encryption keys, and sign-in or invite tokens.</Li>
        <Li>Anything at all from an encrypted document&rsquo;s page: they don&rsquo;t run there.</Li>
        <Li>What you write or publish. A replay shows the page around a document or file, never its content: documents, files, editors, previews and lists of your documents are blanked out, titles, names and email addresses are hidden, and every text field is masked.</Li>
        <Li>A replay of a sign-in link or of our admin pages: those are never recorded.</Li>
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

      <H2 id="zoom">Zoom meetings</H2>
      <P>
        A workspace admin can connect the company&rsquo;s Zoom account, with the Markdrop app for Zoom or with an app the
        company creates in Zoom. A Zoom account admin approves it. Markdrop then reads, with read-only access:
      </P>
      <ul className="mb-4 list-disc pl-5">
        <Li><strong className="text-text">Who the users are.</strong> The Zoom account&rsquo;s users (name, email, Zoom user ID), to know
          who hosted a meeting and whether they belong to the team the admin picked. The list is used and not kept.</Li>
        <Li><strong className="text-text">Recordings of the team&rsquo;s meetings.</strong> For cloud-recorded meetings hosted by a member
          of that team: the topic, start time, duration and the list of recording files, and the audio transcript (a text file).
          Markdrop never downloads the audio or video.</Li>
        <Li><strong className="text-text">Who joined.</strong> The names of the people who joined those meetings, to list them as attendees.</Li>
        <Li><strong className="text-text">Who connected it.</strong> The Zoom account&rsquo;s ID and the name and email of the Zoom admin who
          approved the Markdrop app.</Li>
      </ul>
      <P>
        <strong className="text-text">How it&rsquo;s used.</strong> Each transcript becomes a meeting page in that team in the workspace,
        visible to the team&rsquo;s members and the workspace&rsquo;s admins, with a summary, decisions and action items written from it by
        AI (see Anthropic below) and the other things meetings do in Markdrop. Meetings hosted by anyone else are skipped, and nothing about
        them is stored, not even the topic. Zoom data is used only to provide this feature to that workspace: it isn&rsquo;t sold, used for
        advertising, used to train AI models, or shared beyond the processors listed below.
      </P>
      <P>
        <strong className="text-text">Kept and deleted.</strong> Zoom&rsquo;s access and refresh tokens (and an app&rsquo;s secrets, when the company
        uses its own) are stored encrypted until Zoom is disconnected. When a workspace admin disconnects Zoom in Markdrop, or a Zoom admin
        removes the Markdrop app from the Zoom App Marketplace, Markdrop deletes the tokens and secrets, the Zoom account&rsquo;s ID and the
        approving admin&rsquo;s name and email, and the import log (topics, dates, hosts and states of the meetings it handled) right away.
        Meetings already imported are the workspace&rsquo;s own pages: they stay until a workspace admin or their owner deletes them (Disconnect
        can delete them all at once), and are deleted with the workspace. How to remove the app:{" "}
        <a className={link} href="https://docs.markdrop.in/integrations/zoom#removing-the-app">Removing the app</a>.
      </P>

      <H2 id="integrations">Other integrations</H2>
      <P>
        Each integration is off until you, or an admin of your workspace, connect it, and it can be disconnected at any
        time. Tokens for other services are stored encrypted, used only for the feature you turned on, and deleted when
        you disconnect.
      </P>
      <ul className="mb-4 list-disc pl-5">
        <Li><strong className="text-text">Google sign-in.</strong> Your email address, name and picture. Nothing else from your Google account.</Li>
        <Li><strong className="text-text">Google Docs.</strong> With your separate permission, access only to the Google Docs that Markdrop creates for you or that you pick (<code className="font-mono text-code">drive.file</code>), to export and refresh documents and to read the meeting notes you choose to import. We keep an encrypted refresh token and the ids of those Docs.</Li>
        <Li><strong className="text-text">Google Meet (automatic import).</strong> A script runs in your own Google account with read-only Drive access. It reads only Docs that look like Meet transcripts or Gemini&rsquo;s notes and sends them to your workspace with a token that can do nothing else. Each one becomes a meeting page, as for Zoom above.</Li>
        <Li><strong className="text-text">Slack.</strong> The Slack workspace&rsquo;s name and an encrypted app token, the meetings channel, who linked which Slack account and their notification choices. Markdrop doesn&rsquo;t read your channels: it sees only messages that contain a Markdrop link, and only the link, to show its preview.</Li>
        <Li><strong className="text-text">Jira (Atlassian).</strong> Each person&rsquo;s encrypted Atlassian tokens, the connected sites, the issues linked to pages and meetings, and a short-lived copy of the issues it shows (key, summary, status, assignee, due date).</Li>
        <Li><strong className="text-text">GitHub (Markdrop Guides).</strong> Read-only access to the repositories you install the Markdrop Guides app on, to import and sync a guide&rsquo;s pages. We keep the installation and repository you chose and the files the guide uses.</Li>
        <Li><strong className="text-text">AI apps, the CLI and VS Code.</strong> An AI app you connect (for example Claude, ChatGPT or Cursor), the command-line tool and the VS Code extension act as you, with the access you approve, and can read and change what you can. We keep which app or token it is and when it was last used; revoke it in Settings at any time.</Li>
      </ul>
      <P>
        Markdrop&rsquo;s use and transfer of information received from Google APIs adheres to the{" "}
        <a className={link} href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
        including the Limited Use requirements. Data from Google, Zoom, Slack, Atlassian and GitHub isn&rsquo;t sold, used
        for advertising or used to train AI models.
      </P>

      <H2 id="processors">Who processes data for us</H2>
      <ul className="mb-4 list-disc pl-5">
        <Li>Vercel (website hosting) and Amazon Web Services in Hyderabad, India (our API and our database, which runs on our own server there, including connected integrations&rsquo; encrypted tokens and imported meetings, with its backups).</Li>
        <Li>Cloudflare (file storage, the file viewer, Markdrop Guides sites, DNS and the Share relay).</Li>
        <Li>Resend and Brevo (sign-in and notification email).</Li>
        <Li>PostHog and Google (analytics, as above).</Li>
        <Li>Anthropic (AI in pages, guides, search, Ask, meetings, Team, analytics and Jira drafts, which are powered by Anthropic&rsquo;s Claude models): when you use an AI feature, the text it needs is sent to Anthropic&rsquo;s API to answer. For AI search and Ask, that is your question (and earlier questions in the same conversation) and short excerpts of the matching items you can open; for a workspace's Ask suggestions, the meeting topics, decisions and action items and the page titles and headings every member of it can open (never encrypted items, and only the title of a password-protected one). Nothing sent is used to train models: Anthropic doesn&rsquo;t train on data sent through its commercial API. Encrypted items are never sent. We keep only usage counts (tokens, cost, which feature), not the text sent. The one exception: your Ask conversations (questions, answers and their sources) are kept for you alone, so you can return to them, and deleted 90 days after the last question or when you clear them.</Li>
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
