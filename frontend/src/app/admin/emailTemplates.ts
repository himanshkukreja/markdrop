/**
 * Ready-made campaign templates for the admin emailer.
 *
 * Built on the one light shell every Markdrop email shares (REVAMP_PLAN 7.20). The source of truth
 * is `_shell()` in backend/app/services/mailer.py and backend/app/emails/campaign-*.html; the
 * helpers below reproduce that markup, so a campaign composed here looks like the system emails.
 * Keep them in step when the backend shell changes.
 *
 * Email rules: table layout and inline styles (Gmail and Outlook strip <style> and ignore
 * flex/grid); a fluid-hybrid 560px column (a max-width div plus an MSO ghost table) so nothing
 * overflows at 375px; light only and built to survive Gmail's forced inversion (dark text on white;
 * the only colour without text is saturated); no emoji and no remote images (the wordmark is text).
 *
 * The hexes here are email-safe values from the light palette, the documented exception to the
 * token rule (email clients can't read CSS variables).
 *
 * Placeholders: {{name}}, {{email}} (HTML-escaped by the backend) and {{unsubscribe_url}}, the
 * signed one-click link, which MUST stay in the footer. Never write a placeholder inside an HTML
 * comment: SendPreview's "unsubscribe link present" check would pass even if the footer link were
 * deleted.
 */

export interface EmailTemplate {
  id: string;
  /** Shown in the composer's "Load template" menu. */
  label: string;
  description: string;
  subject: string;
  html: string;
}

// ── Shell palette (mirrors mailer.py) ─────────────────────────────────────────

const GROUND = "#f9fafb";
const CARD = "#ffffff";
const LINE = "#e5e7eb";
const ACCENT = "#155dfc";
const INK = "#101828"; // headings, strong text
const BODY = "#364153"; // body copy
const MUTED = "#6a7282"; // eyebrows and footers (never #999 / #94a3b8: they fail AA)
const WARN_BG = "#fffbeb";
const WARN_LINE = "#fee685";
const WARN_INK = "#bb4d00";

const SANS = "'Manrope',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,Menlo,monospace";
const SITE = "https://markdrop.in";

/** Hidden filler after a preheader, so clients don't scrape body text into the preview line. */
const PREHEADER_PAD = "&#847;&zwnj;&nbsp;".repeat(40);

// ── Building blocks (mirror mailer.py) ────────────────────────────────────────

const eyebrow = (text: string) =>
  `<div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin:0 0 10px">${text}</div>`;

const heading = (text: string, tag: "h1" | "h2" = "h1", extra = "") =>
  `<${tag} style="font-family:${SANS};font-size:${tag === "h1" ? 24 : 20}px;line-height:1.3;font-weight:700;color:${INK};margin:0 0 ${tag === "h1" ? 12 : 8}px;padding:0${extra}">${text}</${tag}>`;

const p = (inner: string, margin = "0 0 16px") =>
  `<p style="font-size:15px;line-height:1.6;color:${BODY};margin:${margin}">${inner}</p>`;

const strong = (text: string) => `<strong style="color:${INK}">${text}</strong>`;

/** A divided list of points, each with a bold lead-in (no emoji). */
function points(items: [string, string][]) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${items.map(([lead, text], i) => `              <tr><td style="padding:14px 0;${i < items.length - 1 ? `border-bottom:1px solid ${LINE};` : ""}font-size:14px;line-height:1.6;color:${BODY}">
                ${strong(lead)} ${text}
              </td></tr>`).join("\n")}
            </table>`;
}

/** Bulletproof button: the fill is on the table cell. */
const button = (href: string, label: string) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td bgcolor="${ACCENT}" style="background-color:${ACCENT};border-radius:8px">
                <a href="${href}" style="display:inline-block;padding:12px 24px;font-family:${SANS};font-size:14px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${label}</a>
              </td></tr>
            </table>`;

/** A boxed aside: neutral (inset) or warning-soft. */
function aside(title: string, text: string, tone: "neutral" | "warning" = "neutral") {
  const [bg, line, ink, body] = tone === "warning" ? [WARN_BG, WARN_LINE, WARN_INK, WARN_INK] : [GROUND, LINE, INK, BODY];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td bgcolor="${bg}" style="background-color:${bg};border:1px solid ${line};border-radius:8px;padding:12px 14px">
                <div style="font-size:14px;line-height:1.6;font-weight:700;color:${ink};margin:0 0 4px">${title}</div>
                <div style="font-size:14px;line-height:1.6;color:${body}">${text}</div>
              </td></tr>
            </table>`;
}

/** One padded row of the card. */
const row = (inner: string, pad = "0 32px", h1 = false) =>
  `          <tr><td class="md-pad${h1 ? " md-h1" : ""}" style="padding:${pad}">
            ${inner}
          </td></tr>`;

/** A section opening with a hairline, an eyebrow and an h2. */
const section = (kicker: string, title: string, intro: string, titleMono = false) => row(
  `<div style="border-top:1px solid ${LINE};padding-top:24px">
              ${eyebrow(kicker)}
              ${heading(title, "h2", titleMono ? `;font-family:${MONO};word-break:break-all` : "")}
              ${p(intro, "0 0 4px")}
            </div>`,
  "28px 32px 0", true);

/** The shell: ground, a 560px white card with the 4px accent bar and the text wordmark, then the
 *  footer (with the unsubscribe placeholder) on the ground. */
function shell({ title, preheader, rows }: { title: string; preheader: string; rows: string[] }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
<style>
  :root { color-scheme: light only; supported-color-schemes: light; }
  body { margin: 0; padding: 0; }
  a { color: ${ACCENT}; }
  @media (max-width: 600px) {
    .md-pad { padding-left: 22px !important; padding-right: 22px !important; }
    .md-h1 h1, .md-h1 h2 { font-size: 22px !important; }
  }
</style>
</head>
<body bgcolor="${GROUND}" style="margin:0;padding:0;background-color:${GROUND};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${preheader}${PREHEADER_PAD}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${GROUND}" style="background-color:${GROUND}">
  <tr><td align="center" style="padding:32px 12px">
    <!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <div style="max-width:560px;margin:0 auto">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">
      <tr><td bgcolor="${CARD}" style="background-color:${CARD};border:1px solid ${LINE};border-radius:12px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${SANS};word-break:break-word;overflow-wrap:anywhere">
          <tr><td bgcolor="${ACCENT}" height="4" style="background-color:${ACCENT};height:4px;line-height:4px;font-size:0;border-radius:11px 11px 0 0">&nbsp;</td></tr>
          <tr><td class="md-pad" style="padding:26px 32px 22px">
            <a href="${SITE}" style="text-decoration:none"><span style="font-family:${SANS};font-size:20px;line-height:1;font-weight:800;letter-spacing:-0.02em;color:${INK}">mark<span style="color:${ACCENT}">drop</span></span></a>
          </td></tr>
${rows.join("\n")}
        </table>
      </td></tr>
      <tr><td class="md-pad" style="padding:20px 32px 0">
        <div style="font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED}">
          You're getting this because you have a Markdrop account.
          <a href="{{unsubscribe_url}}" style="color:${MUTED};text-decoration:underline">Unsubscribe</a>
        </div>
      </td></tr>
    </table>
    </div>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;
}

// ── Templates ─────────────────────────────────────────────────────────────────

export const ARTIFACTS_ANNOUNCEMENT: EmailTemplate = {
  id: "artifacts",
  label: "Artifacts announcement",
  description: "Files that render: HTML, PDFs, sheets, Word docs and video",
  subject: "New in Markdrop: PDFs, spreadsheets and web pages that render",
  html: shell({
    title: "Files that render",
    preheader: "Upload an HTML page, a PDF, a spreadsheet, a Word doc or a video and get a link that opens it rendered, not downloaded.",
    rows: [
      row(`${eyebrow("Just shipped")}
            ${heading("Drop it. It renders.")}
            ${p(`Hi {{name}}, Markdrop now turns your files into links that open ${strong("rendered")}, not as downloads: full screen, in any browser, on any device, with no app to install.`)}`, "0 32px", true),
      row(points([
        ["HTML pages.", "Upload a page, or a zipped site with its own CSS and JS. It renders exactly as built."],
        ["PDFs.", "Read in the browser with selectable, copyable text. No plugin, no download."],
        ["Spreadsheets.", "Excel and CSV files open as a clean table, one tab per sheet."],
        ["Word documents and video.", "A .docx renders as a readable page; mp4, mov and webm play in place."],
      ])),
      row(button(`${SITE}/upload`, "Upload a file"), "20px 32px 0"),
      row(`<p style="font-size:13px;line-height:1.6;color:${MUTED};margin:12px 0 0">Uploading files uses your Markdrop account, so you're already set.</p>`),
      row(aside(
        "Private by design",
        "Artifacts render on a separate domain, so a published page can never reach your Markdrop account. Add a password or an access level and the file itself is locked, not just the page around it.",
      ), "20px 32px 32px"),
    ],
  }),
};

/** Mirrors backend/app/emails/campaign-encryption-and-workspaces.html. */
export const ENCRYPTION_AND_WORKSPACES: EmailTemplate = {
  id: "encryption-workspaces",
  label: "Encryption and workspaces",
  description: "Encrypted documents, and your own domain",
  subject: "Encrypted documents, and your own domain",
  html: shell({
    title: "Encrypted documents, and your own domain",
    preheader: "Documents encrypted in your browser, with a key that never reaches us, and your own domain for the ones you publish. Every existing link keeps working.",
    rows: [
      row(`${eyebrow("Two new things")}
            ${heading("Encrypted documents, and&nbsp;your own domain")}
            ${p(`Hi {{name}}, everything you already publish keeps working exactly as it does today. One of these is for keeping something ${strong("private")}, the other for publishing it as ${strong("your company")}. Both are opt-in, and neither changes a single existing link.`)}`, "0 32px", true),
      section("01 &middot; End-to-end encryption", "Encrypted in your browser, before it reaches us",
        "Tick one box when you publish and the document, title included, is sealed in your browser with AES-256-GCM before anything is sent."),
      row(points([
        ["The key lives in the link, after the&nbsp;#.", "That's the one part of a URL browsers never send to a server, and they strip it from referrers. It reaches no log, no database, nothing of ours. You can watch a network tab and confirm that yourself."],
        ["Rotate the key", "whenever a link has travelled further than you meant it to, and the old one stops opening the document from that moment."],
        ["A database dump yields bytes.", "Markdrop stores ciphertext it has no key for, so a subpoena or a rogue operator gets exactly that and nothing more."],
      ])),
      row(aside(
        "What it does not do",
        "The link <em>is</em> the key. Anyone you forward it to can read the document, and so can anyone who finds it in your browser history. Encryption takes us out of the set of people who can read your document; it doesn&rsquo;t take out anyone you send it to. There&rsquo;s also no recovery: signing in gives you control of the record, never the contents.",
        "warning",
      ), "8px 32px 0"),
      row(button(`${SITE}/new`, "Publish something encrypted"), "20px 32px 0"),
      section("02 &middot; Workspaces and your own domain", "docs.yourcompany.com",
        "Publish to your own domain, under your own name, with a library your team shares. One DNS record and we issue the certificate.", true),
      row(points([
        ["Your domain, your brand.", "Your name, logo and colour on every page and every link preview, with the option to drop Markdrop branding entirely."],
        ["Share with exactly who you mean.", "Anyone with the link, only the people you name, or everyone in the workspace. You can name someone outside your company by email, and take it back whenever you like."],
        ["A shared library.", "Documents and files your team can all reach, in folders that nest as deep as you need, with owner, admin, member and viewer roles. Your private documents stay private: putting something in the library is always a choice."],
      ])),
      row(`${button(`${SITE}/settings/workspaces`, "Create a workspace")}
            <p style="font-size:13px;line-height:1.6;color:${MUTED};margin:12px 0 0">It takes about a minute, and a domain is optional.</p>`, "20px 32px 32px"),
    ],
  }),
};

/** A blank campaign on the shell: replace the heading and body. */
export const BLANK: EmailTemplate = {
  id: "blank",
  label: "Blank campaign",
  description: "The shell with a heading, a paragraph and a button",
  subject: "",
  html: shell({
    title: "Markdrop",
    preheader: "One line that shows after the subject in the inbox.",
    rows: [
      row(`${eyebrow("Eyebrow")}
            ${heading("Heading")}
            ${p("Hi {{name}}, write the message here.")}`, "0 32px", true),
      row(button(SITE, "Open Markdrop"), "4px 32px 32px"),
    ],
  }),
};

export const TEMPLATES: EmailTemplate[] = [ARTIFACTS_ANNOUNCEMENT, ENCRYPTION_AND_WORKSPACES, BLANK];
