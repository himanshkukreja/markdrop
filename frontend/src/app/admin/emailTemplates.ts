/**
 * Ready-made campaign templates for the admin emailer.
 *
 * Table-based layout with inline styles throughout: Gmail and Outlook strip
 * <style> blocks and ignore flex/grid, so anything structural has to be tables
 * and anything visual has to be an inline attribute. Kept to a single column so
 * it survives narrow mobile clients without media queries.
 */

export interface EmailTemplate {
  subject: string;
  html: string;
}

const BRAND = "#2563eb";
const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";

function feature(icon: string, title: string, body: string): string {
  return `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid ${LINE}">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="40" valign="top" style="font-size:22px;line-height:1">${icon}</td>
              <td valign="top">
                <div style="font-size:15px;font-weight:700;color:${INK};margin-bottom:3px">${title}</div>
                <div style="font-size:14px;line-height:1.55;color:${MUTED}">${body}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
}

export const ARTIFACTS_ANNOUNCEMENT: EmailTemplate = {
  subject: "New in Markdrop: share PDFs, spreadsheets and web pages",
  html: `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Ask clients to render this light in dark mode too. Apple Mail, Outlook and
     Samsung Mail honour "light only" and skip their dark transform entirely.
     Gmail's mobile apps do NOT — they invert regardless, with no supported
     opt-out — which is why the design below is built to survive inversion
     rather than to depend on being obeyed. -->
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>
  :root { color-scheme: light only; supported-color-schemes: light; }
</style>
</head>
<body style="margin:0;padding:0;background-color:#f6f7f9">
<!--
  DELIBERATELY A LIGHT DESIGN.

  Gmail's mobile apps force their own colour inversion and ignore both the
  color-scheme meta above and prefers-color-scheme (those only reach Apple Mail
  and Outlook). Inversion flips white and near-white text to dark while leaving
  saturated colours alone — so a dark panel with white headings came out as dark
  text on blue, unreadable.

  The rule that survives it: never rely on light text. Dark text on a light
  background inverts to light text on a dark background, which reads correctly
  either way. Accents are saturated enough to pass through untouched.
-->
<div style="background-color:#f6f7f9;padding:32px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
             style="width:560px;max-width:100%;background-color:#ffffff;border-radius:14px;overflow:hidden">

        <!-- Accent bar: a block of colour with no text, so inversion is harmless -->
        <tr><td bgcolor="#2563eb" style="background-color:#2563eb;height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>

        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;padding:32px 34px 8px">
            <div style="font-size:20px;font-weight:800;color:#0f172a;letter-spacing:-.02em">
              mark<span style="color:#2563eb">drop</span>
            </div>

            <!-- Saturated fill, dark text: both ends survive inversion -->
            <div style="display:inline-block;margin-top:20px;padding:5px 11px;border-radius:999px;
                        background-color:#fde68a;color:#7c4a03;font-size:11px;font-weight:700;
                        letter-spacing:.08em;text-transform:uppercase">Just shipped</div>

            <div style="font-size:27px;line-height:1.25;font-weight:800;color:#0f172a;margin-top:14px">
              Share more than markdown
            </div>
            <div style="font-size:15px;line-height:1.6;color:#475569;margin-top:10px">
              Markdrop now hosts your files as
              <strong style="color:#0f172a">rendered</strong> pages &mdash; not downloads.
            </div>
          </td>
        </tr>

        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;padding:20px 34px 0">
            <div style="font-size:15px;line-height:1.6;color:${INK}">
              Hi {{name}}, you can now publish a file and get a link that opens the
              content itself &mdash; full screen, on any device, with no download prompt.
            </div>
          </td>
        </tr>

        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;padding:8px 34px 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${feature("&#127760;", "HTML pages", "Paste a page or upload a zipped site with its own CSS and JS. It renders exactly as built.")}
              ${feature("&#128196;", "PDFs", "Read in the browser with selectable, copyable text &mdash; no plugin, no download.")}
              ${feature("&#128202;", "Spreadsheets", "Excel and CSV open as a clean table, one tab per sheet.")}
              ${feature("&#128221;", "Word documents", "A .docx renders as a readable page anyone can open.")}
            </table>
          </td>
        </tr>

        <!-- Bulletproof button: colour on the cell, not a styled anchor -->
        <tr>
          <td bgcolor="#ffffff" align="center" style="background-color:#ffffff;padding:28px 34px 6px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="${BRAND}" style="background-color:${BRAND};border-radius:9px">
                  <a href="https://markdrop.in/upload"
                     style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:700;
                            color:#ffffff;text-decoration:none;border-radius:9px">
                    Publish an artifact
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;padding:18px 34px 30px">
            <div style="background-color:#f1f5f9;border:1px solid ${LINE};border-radius:10px;padding:14px 16px">
              <div style="font-size:13px;font-weight:700;color:${INK};margin-bottom:4px">
                &#128274; Private by design
              </div>
              <div style="font-size:13px;line-height:1.55;color:${MUTED}">
                Artifacts render on a separate domain, so a published page can never reach
                your Markdrop account. Add a password or an expiry and the file itself is
                locked, not just the page around it.
              </div>
            </div>
          </td>
        </tr>

        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;padding:0 34px 30px">
            <div style="border-top:1px solid ${LINE};padding-top:18px;font-size:12px;line-height:1.6;color:#94a3b8">
              You're getting this because you have a Markdrop account.
              <a href="{{unsubscribe_url}}" style="color:#64748b">Unsubscribe</a>
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</div>
</body></html>`,
};
