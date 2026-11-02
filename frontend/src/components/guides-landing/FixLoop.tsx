"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { guideEvents } from "@/lib/guidesEvents";
import f from "./FixLoop.module.css";

/**
 * "Then fix it, right in the page." Four steps beside a sample Acme docs page that Guides has
 * annotated: readers leave at a section (1), a drafted fix offered as a suggestion with Accept and
 * Discard (2), the fix accepted and in progress (3), and the "Fixed on publish" stamp (4). The steps
 * and the suggestion's buttons drive the page. Facts from docs/guides/fix-list (42% of 310 measured
 * readers; about 4% per section elsewhere; In progress, then Fixed by the next publish; Came back).
 * Step 4 is counted as guide_landing_demo {step: "published"}.
 */

const STEPS = [
  { title: "Readers leave here", body: "42% of 310 readers stop at one section" },
  { title: "Guides drafts a fix", body: "Written from the evidence, as a suggestion" },
  { title: "You accept it", body: "Keep editing, or discard it" },
  { title: "Fixed on publish", body: "The item closes when the page goes live" },
];

const NOTES = [
  { title: "Readers leave here", body: "42% of 310 measured readers stopped at Install the CLI. Elsewhere about 4% stop per section.", meta: "High impact · Confident", y: 214 },
  { title: "Draft a fix", body: "Rewrite the section: shorter, with the exact commands readers were missing.", meta: "Uses one of the guide's AI uses", y: 236 },
  { title: "In progress", body: "The fix is in the page. It's marked fixed the next time you publish it.", meta: "Fix list · In progress", y: 214 },
  { title: "Fixed", body: "Published. Guides keeps watching: if readers still leave here, the item comes back.", meta: "Fix list · Fixed", y: 214 },
];

export default function FixLoop({ actions }: { actions?: ReactNode }) {
  const [step, setStep] = useState(1);
  const go = (n: number) => {
    setStep(n);
    if (n === 4) guideEvents.landingDemo("published");
  };
  const note = NOTES[step - 1];
  const hot = step <= 2;

  return (
    <div className={f.grid}>
      <div className={f.copy}>
        <span className={f.kick}>How a fix happens</span>
        <h2 id="fix-loop-title" className={f.h2}>Then fix it, right in the page.</h2>
        <p className={f.lede}>
          Every drop-off comes with its evidence and a drafted fix. You review it like a pull request; it&apos;s marked fixed when you
          publish.
        </p>
        <div className={f.steps} role="group" aria-label="The loop, step by step">
          {STEPS.map((s, i) => {
            const n = i + 1;
            return (
              <button
                key={s.title}
                type="button"
                className={f.step}
                data-on={step === n || undefined}
                data-done={step > n || undefined}
                aria-pressed={step === n}
                onClick={() => go(n)}
              >
                <i aria-hidden="true">{n}</i>
                <span>
                  <b>{s.title}</b>
                  <small>{s.body}</small>
                </span>
              </button>
            );
          })}
        </div>
        {actions && <div className={f.actions}>{actions}</div>}
      </div>

      <div className={f.visual}>
        <div className={f.box}>
          <div className={f.art}>
            <div className={f.doc} aria-label="A sample Acme docs page, annotated by Guides (fictional data)" role="group">
              <aside className={f.side} aria-hidden="true">
                <div className={f.brand}>
                  <i>A</i>Acme Docs
                </div>
                <small>Get started</small>
                <ul>
                  <li>Introduction</li>
                  <li data-on="">Quickstart</li>
                  <li>Concepts</li>
                </ul>
                <small>Guides</small>
                <ul>
                  <li>Connect Postgres</li>
                  <li>Alert rules</li>
                  <li>API keys</li>
                </ul>
              </aside>
              <div className={f.page}>
                <div className={f.crumb}>Get started › Quickstart</div>
                <h3 className={f.title}>Quickstart</h3>
                <p>Ship your first alert in five minutes.</p>

                <div className={f.sec}>
                  <div className={f.rail} aria-hidden="true">
                    <span style={{ height: 46 }} />
                    <b>95%</b>
                  </div>
                  <h4>Before you start</h4>
                  <p>You need an Acme account and Node 20 or later.</p>
                </div>

                <div className={f.sec} data-hot={hot || undefined} data-fixed={step === 4 || undefined}>
                  <div className={f.rail} data-hot={hot || undefined} aria-hidden="true">
                    <span style={{ height: 40 }} />
                    <b>92%</b>
                  </div>
                  {step === 4 && <span className={f.stamp}>Fixed on publish</span>}
                  <h4>Install the CLI</h4>
                  {step <= 2 ? (
                    <p>Install the CLI with your package manager and configure it for your workspace.</p>
                  ) : (
                    <>
                      <p>Install it, then sign in (it opens your browser):</p>
                      <div className={f.code}>
                        npm install -g @acme/cli
                        <br />
                        acme login
                      </div>
                    </>
                  )}
                  {step === 2 && (
                    <div className={f.sug}>
                      <div className={f.sugHead}>
                        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" />
                        </svg>
                        Suggested fix · from 131 readers&apos; drop-off
                      </div>
                      <div className={f.sugBody}>
                        Install it, then sign in
                        <br />
                        (it opens your browser):
                        <br />
                        {"  "}npm install -g @acme/cli
                        <br />
                        {"  "}acme login
                      </div>
                      <div className={f.sugFoot}>
                        <button type="button" className={`${f.mini} ${f.primary}`} onClick={() => go(3)}>
                          Accept
                        </button>
                        <button type="button" className={f.mini} onClick={() => go(1)}>
                          Discard
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className={f.sec}>
                  <div className={f.rail} aria-hidden="true">
                    <span style={{ height: 22, opacity: 0.55 }} />
                    <b>49%</b>
                  </div>
                  <h4>Create a project</h4>
                  <p>Run acme init in an empty folder and follow the prompts.</p>
                </div>
              </div>
            </div>

            <div key={step} className={f.note} style={{ "--ny": `${note.y}px` } as CSSProperties} aria-live="polite">
              <b>{note.title}</b>
              {note.body}
              <small>{note.meta}</small>
            </div>
            <div className={f.miss}>
              <span>0 results</span>
              <code>&quot;sso&quot;</code>
              searched 18 times
            </div>
          </div>
        </div>
        <p className={f.cap}>A sample page with fictional data.</p>
      </div>
    </div>
  );
}
