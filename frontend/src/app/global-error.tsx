"use client";

/**
 * Last-resort boundary for when the root layout itself fails (REVAMP_PLAN 7.22). It replaces the
 * whole document, so it can't rely on the token stylesheet, the fonts or the providers: critical CSS
 * is inline, both themes follow prefers-color-scheme (the values are the token values for dark and
 * Mist light, copied here on purpose), and the links are plain <a>.
 */
const CSS = `
:root{color-scheme:dark;--bg:#030712;--surface:#101828;--border:#1e2939;--text:#f3f4f6;--text2:#d1d5dc;--accent:#155dfc;--on-accent:#fff;--ring:#2b7fff}
@media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#E3E7ED;--surface:#EBEEF2;--border:#CDD4DE;--text:#111A2C;--text2:#2B3546;--accent:#2150D8;--on-accent:#fff;--ring:#2F6FEB}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:48px 16px}
.box{max-width:480px;width:100%;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center}
h1{margin:0;font-size:30px;line-height:36px;font-weight:700;letter-spacing:-.02em}
p{margin:0;font-size:16px;line-height:24px;color:var(--text2)}
.row{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.btn{display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 20px;border-radius:8px;font:inherit;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--text2)}
`;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong · Markdrop</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <main>
          <div className="box">
            <svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="8" fill="#0f172a" />
              <text x="3" y="23" fontSize="18" fontWeight="700" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fill="#f1f5f9">m</text>
              <circle cx="27" cy="20" r="4" fill="#3b82f6" />
            </svg>
            <h1>Something went wrong on this page</h1>
            <p>Your work in other tabs is safe. Try again, or go back to where you were.</p>
            <div className="row">
              <button type="button" className="btn primary" onClick={() => reset()}>Try again</button>
              <a className="btn" href="/">Go to the home page</a>
            </div>
            {error.digest && <code>Error reference {error.digest}</code>}
          </div>
        </main>
      </body>
    </html>
  );
}
