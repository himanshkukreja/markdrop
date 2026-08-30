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
  html: `<div style="background:#f6f7f9;padding:32px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
             style="width:560px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">

        <tr>
          <td style="background:linear-gradient(135deg,#0b1220,#1e3a8a);padding:34px 34px 30px">
            <div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-.02em">
              mark<span style="color:#60a5fa">drop</span>
            </div>
            <div style="display:inline-block;margin-top:18px;padding:4px 10px;border-radius:999px;
                        background:rgba(251,191,36,.18);color:#fcd34d;font-size:11px;font-weight:700;
                        letter-spacing:.08em;text-transform:uppercase">Just shipped</div>
            <div style="font-size:26px;line-height:1.25;font-weight:800;color:#ffffff;margin-top:12px">
              Share more than markdown
            </div>
            <div style="font-size:15px;line-height:1.6;color:#c7d2fe;margin-top:8px">
              Markdrop now hosts your files as <strong style="color:#fff">rendered</strong> pages — not downloads.
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:26px 34px 8px">
            <div style="font-size:15px;line-height:1.6;color:${INK}">
              Hi {{name}}, you can now publish a file and get a link that opens the
              content itself — full screen, on any device, with no download prompt.
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:8px 34px 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${feature("&#127760;", "HTML pages", "Paste a page or upload a zipped site with its own CSS and JS. It renders exactly as built.")}
              ${feature("&#128196;", "PDFs", "Read in the browser with selectable, copyable text — no plugin, no download.")}
              ${feature("&#128202;", "Spreadsheets", "Excel and CSV open as a clean table, one tab per sheet.")}
              ${feature("&#128221;", "Word documents", "A .docx renders as a readable page anyone can open.")}
            </table>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:28px 34px 6px">
            <a href="https://markdrop.in/upload"
               style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;
                      padding:13px 30px;border-radius:9px;font-weight:700;font-size:15px">
              Publish an artifact
            </a>
          </td>
        </tr>

        <tr>
          <td style="padding:18px 34px 30px">
            <div style="background:#f9fafb;border:1px solid ${LINE};border-radius:10px;padding:14px 16px">
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
          <td style="padding:0 34px 30px">
            <div style="border-top:1px solid ${LINE};padding-top:18px;font-size:12px;line-height:1.6;color:#9ca3af">
              You're getting this because you have a Markdrop account.
              <a href="{{unsubscribe_url}}" style="color:#9ca3af">Unsubscribe</a>
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</div>`,
};
