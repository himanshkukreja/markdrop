import type { CSSProperties, KeyboardEvent } from "react";
import Link from "next/link";
import { ICONS } from "@/components/ui/icons";
import s from "./DomainStudio.module.css";
import { deriveView, type CheckKey, type Chrome, type CopyKey, type InviteRole, type LogoShape, type State, type ViewAs } from "./model";

/**
 * Domain Studio, presentational only (no hooks, no "use client"): the server renders it with no
 * handlers as the section's static first frame, and Game renders it with handlers. Every focusable
 * control has a stable id, so LazyIsland can carry focus from the poster into the game.
 */
export type Handlers = {
  togglePlay: () => void;
  company: (v: string) => void;
  domain: (v: string) => void;
  pickAcc: (i: number) => void;
  accKey: (e: KeyboardEvent<HTMLButtonElement>, i: number) => void;
  pickLogo: (i: number) => void;
  logoKey: (e: KeyboardEvent<HTMLButtonElement>, i: number) => void;
  chrome: (v: Chrome) => void;
  toggleSignin: () => void;
  viewAs: (v: ViewAs) => void;
  addedTxt: () => void;
  addedCname: () => void;
  backDns: () => void;
  restartDns: () => void;
  copy: (key: CopyKey) => void;
  email: (v: string) => void;
  emailKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  role: (r: InviteRole) => void;
  invite: () => void;
  check: (k: CheckKey) => void;
  reset: () => void;
};

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

/** Design-system icon glyph (ICONS is plain data, so this stays server-safe). */
function Ic({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="md-icon" style={{ fontSize: size }}>
      <path d={ICONS[name]} />
    </svg>
  );
}

const SHAPE: Record<LogoShape, string> = { circle: s.mCircle, square: s.mSquare, outline: s.mOutline, diamond: s.mDiamond };

function Mono({ shape, txt, size }: { shape: LogoShape; txt: string; size?: "sm" | "big" | "xl" }) {
  return (
    <span className={cx(s.mono, size && s[size], SHAPE[shape])}>
      <span className={s.monoT}>{txt}</span>
    </span>
  );
}

const par = (p: "" | "a" | "b", a: string, b: string) => (p === "a" ? a : p === "b" ? b : "");

export default function View({ state, on }: { state: State; on?: Handlers }) {
  const vm = deriveView(state);
  const { dns } = vm;
  const brandVars = { "--brand": vm.brand.base, "--ink-d": vm.brand.inkDark, "--ink-l": vm.brand.inkLight } as CSSProperties;
  const logoWrap = cx(s.lw, par(vm.brandLogo.pop, s.pa, s.pb));

  const copyBtn = (key: CopyKey) => {
    const c = dns.copy[key];
    return (
      <button type="button" id={c.id} className={cx(s.cpb, c.ok && s.ok)} aria-label={c.aria} onClick={on && (() => on.copy(key))}>
        <Ic name={c.ok ? "check" : "copy"} />
      </button>
    );
  };

  return (
    <div className={s.root} id="ds-root">
      <div className={s.tools}>
        <button type="button" id="ds-play" className={s.ppb} onClick={on?.togglePlay}>
          <span className={vm.playing ? s.glPause : s.glPlay} aria-hidden="true" />
          <span>{vm.ppText}</span>
        </button>
      </div>

      <div className={s.stg} style={brandVars}>
        {/* ── Make it yours ── */}
        <section className={cx(s.pan, s.cp)} aria-labelledby="ds-cp-h">
          <div className={s.panH}>
            <h3 className={s.panT} id="ds-cp-h">
              Make it yours
            </h3>
            <span className={s.panK}>Changes show live</span>
          </div>

          <div className={cx("md-field", s.field)}>
            <label className="md-field__label" htmlFor="ds-name">
              Company name
            </label>
            <input
              id="ds-name"
              className={cx("md-input", s.inp)}
              type="text"
              value={vm.company}
              onChange={on && ((e) => on.company(e.target.value))}
              readOnly={!on}
              maxLength={28}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="ds-name-h"
            />
            <div className="md-field__hint" id="ds-name-h">
              Shows in the site header and the link preview.
            </div>
          </div>

          <div className={cx("md-field", s.field)}>
            <label className="md-field__label" htmlFor="ds-dom">
              Domain
            </label>
            <input
              id="ds-dom"
              className={cx("md-input", s.inp, s.inpMono, vm.dom.invalid && "md-input--invalid")}
              type="text"
              inputMode="url"
              value={vm.domainRaw}
              onChange={on && ((e) => on.domain(e.target.value))}
              readOnly={!on}
              maxLength={64}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={vm.dom.invalid}
              aria-describedby="ds-dom-h"
            />
            <div className={cx("md-field__hint", vm.dom.invalid && s.bad)} id="ds-dom-h">
              {vm.dom.hint}
            </div>
          </div>

          <div className={s.grp} role="group" aria-labelledby="ds-acc-l">
            <div className={s.grpL} id="ds-acc-l">
              Accent <span className={s.grpV}>{vm.accName}</span>
            </div>
            <div className={s.sws}>
              {vm.swatches.map((w, i) => (
                <button
                  key={w.id}
                  type="button"
                  id={w.id}
                  className={cx(s.sw, w.on && s.on)}
                  style={{ background: w.base }}
                  aria-pressed={w.on}
                  aria-label={w.aria}
                  onClick={on && (() => on.pickAcc(i))}
                  onKeyDown={on && ((e) => on.accKey(e, i))}
                >
                  <span className={cx(s.rip, par(w.rip, s.ra, s.rb))} aria-hidden="true" />
                  <span className={s.swCk} aria-hidden="true">
                    <Ic name="check" />
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className={s.grp} role="group" aria-labelledby="ds-lg-l">
            <div className={s.grpL} id="ds-lg-l">
              Logo <span className={s.grpV}>{vm.logoName}</span>
            </div>
            <div className={s.lgs}>
              {vm.logos.map((l, i) => (
                <button
                  key={l.id}
                  type="button"
                  id={l.id}
                  className={cx(s.lg, l.on && s.on)}
                  aria-pressed={l.on}
                  aria-label={l.aria}
                  onClick={on && (() => on.pickLogo(i))}
                  onKeyDown={on && ((e) => on.logoKey(e, i))}
                >
                  <span aria-hidden="true">
                    <Mono shape={l.shape} txt={l.txt} />
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className={s.grp} role="group" aria-labelledby="ds-ch-l">
            <div className={s.grpL} id="ds-ch-l">
              Viewer chrome
            </div>
            <div className={s.seg}>
              {vm.chromeOpts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  id={c.id}
                  className={cx(s.sgB, c.on && s.on)}
                  aria-pressed={c.on}
                  onClick={on && (() => on.chrome(c.v))}
                >
                  <span className={s.sgM}>{c.t}</span>
                  <span className={s.sgS}>{c.sub}</span>
                </button>
              ))}
            </div>
          </div>

          <button type="button" id="ds-signin" className={s.swr} aria-pressed={vm.signin.on} onClick={on?.toggleSignin}>
            <span>
              <span className={s.swrL}>Require sign-in</span>
              <span className={s.swrH}>{vm.signin.hint}</span>
            </span>
            <span className={cx(s.trk, vm.signin.on && s.on)} aria-hidden="true" />
          </button>
        </section>

        {/* ── What visitors see ── */}
        <section className={s.pv} aria-labelledby="ds-pv-h">
          <div className={s.pvTop}>
            <h3 className={s.panT} id="ds-pv-h">
              What visitors see
            </h3>
            {vm.signin.on && (
              <div className={cx(s.seg, s.segS)} role="group" aria-label="Preview as">
                <span className={s.segL}>View as</span>
                {vm.viewOpts.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    id={o.id}
                    className={cx(s.sgB, o.on && s.on)}
                    aria-pressed={o.on}
                    onClick={on && (() => on.viewAs(o.v))}
                  >
                    {o.t}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={s.br}>
            <div className={s.brBar}>
              <span className={s.brDots} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <div className={s.brUrl}>
                <span className={s.brIc} aria-hidden="true">
                  <Ic name="globe" size={14} />
                </span>
                <span className={cx(s.brHost, vm.url.placeholder && s.ph)}>{vm.url.host}</span>
                <span className={s.brPath}>/handbook/onboarding</span>
              </div>
              <span className={cx(s.brSt, vm.url.live ? s.live : s.pend)}>
                <span className={s.stDot} aria-hidden="true" />
                {vm.url.st}
              </span>
              <span className={cx(s.drp, par(vm.drop, s.da, s.db))} aria-hidden="true">
                <span className={s.drpD} />
                <span className={s.drpR} />
              </span>
            </div>

            <div className={s.brPg}>
              <span className={cx(s.wash, par(vm.wash, s.wa, s.wb))} aria-hidden="true" />
              {vm.chromeFull && (
                <div className={s.siteH}>
                  <span className={logoWrap} aria-hidden="true">
                    <Mono shape={vm.brandLogo.shape} txt={vm.brandLogo.txt} />
                  </span>
                  <span className={s.siteN}>{vm.name}</span>
                  <span className={s.siteNav} aria-hidden="true">
                    <span className={s.on}>Handbook</span>
                    <span className={s.navX}>Guides</span>
                    <span className={s.navX}>Changelog</span>
                  </span>
                </div>
              )}
              {vm.showDoc && (
                <div className={cx(s.doc, vm.docBare && s.bare)}>
                  <div className={s.crumb}>
                    handbook<span aria-hidden="true">/</span>onboarding
                  </div>
                  <div className={s.docH}>Onboarding guide</div>
                  <p className={s.docP}>
                    Welcome to {vm.name}. Start with the <span className={s.lnk}>setup checklist</span>, then read how the team
                    works.
                  </p>
                  <div className={s.docCall}>
                    <b>Your first week</b>
                    <span className={s.bars} aria-hidden="true">
                      <i style={{ width: "92%" }} />
                      <i style={{ width: "70%" }} />
                    </span>
                  </div>
                  <div className={s.docBars} aria-hidden="true">
                    <i style={{ width: "96%" }} />
                    <i style={{ width: "86%" }} />
                    <i style={{ width: "58%" }} />
                  </div>
                  <span className={s.bbtn}>Open the checklist</span>
                </div>
              )}
              {vm.gate && (
                <div className={s.gate}>
                  <span className={logoWrap} aria-hidden="true">
                    <Mono shape={vm.brandLogo.shape} txt={vm.brandLogo.txt} size="big" />
                  </span>
                  <div className={s.gateT}>Sign in to read</div>
                  <div className={s.gateS}>{vm.gateLine}</div>
                  <span className={s.bbtn}>Sign in</span>
                </div>
              )}
            </div>
          </div>

          <div className={s.lcw}>
            <div className={s.lcL}>Link preview</div>
            <div className={s.lc}>
              <span className={s.lcBar} aria-hidden="true" />
              <div className={s.lcB}>
                <div className={s.lcSite}>
                  <span aria-hidden="true">
                    <Mono shape={vm.brandLogo.shape} txt={vm.brandLogo.txt} size="sm" />
                  </span>
                  <span>{vm.name}</span>
                </div>
                <div className={s.lcT}>{vm.card.title}</div>
                <div className={s.lcD}>{vm.card.desc}</div>
                <div className={s.lcU}>{vm.card.url}</div>
              </div>
              <div className={s.lcImg} aria-hidden="true">
                <span className={logoWrap}>
                  <Mono shape={vm.brandLogo.shape} txt={vm.brandLogo.txt} size="xl" />
                </span>
              </div>
            </div>
          </div>
        </section>

        <div className={s.rc}>
          {/* ── Connect your domain ── */}
          <section className={cx(s.pan, s.dns)} aria-labelledby="ds-dns-h">
            <div className={s.panH}>
              <h3 className={s.panT} id="ds-dns-h">
                Connect <span className={s.monoI}>{dns.host}</span>
              </h3>
              <span className={s.panK}>{dns.stepText}</span>
            </div>
            <div className={s.stw} aria-hidden="true">
              <span className={s.stpFill} style={{ width: dns.fillPct + "%" }} />
              <ol className={s.stp}>
                {dns.nodes.map((nd) => (
                  <li key={nd.t} className={cx(s.sn, nd.done && s.done, nd.cur && s.cur, nd.live && s.liveN)}>
                    <span className={s.snC}>{nd.done ? <Ic name="check" size={12} /> : nd.num}</span>
                    <span className={s.snT}>{nd.t}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className={s.dnsb} id="ds-dns-body" tabIndex={-1}>
              {dns.step === 0 && (
                <>
                  <div className={cx(s.recH, dns.noteBad && s.bad)}>
                    <span className={s.rt}>TXT</span>
                    <span>{dns.txtNote}</span>
                  </div>
                  <div className={s.rec}>
                    <span className={s.rk}>Name</span>
                    <code className={s.rv}>{dns.txtName}</code>
                    {copyBtn("txtName")}
                  </div>
                  <div className={s.rec}>
                    <span className={s.rk}>Value</span>
                    <code className={s.rv}>{dns.txtVal}</code>
                    {copyBtn("txtVal")}
                  </div>
                </>
              )}
              {dns.step === 1 && (
                <>
                  <div className={s.recH}>
                    <span className={s.rt}>CNAME</span>
                    <span>Routes {dns.host} to Markdrop.</span>
                  </div>
                  <div className={s.rec}>
                    <span className={s.rk}>Name</span>
                    <code className={s.rv}>{dns.cnName}</code>
                    {copyBtn("cnName")}
                  </div>
                  <div className={s.rec}>
                    <span className={s.rk}>Target</span>
                    <code className={s.rv}>{dns.cnTarget}</code>
                    {copyBtn("cnVal")}
                  </div>
                </>
              )}
              {dns.step === 2 && (
                <>
                  <div className={s.recH}>Looking up both records for {dns.host}.</div>
                  <div className={s.vr}>
                    <span className={s.vrI}>{dns.v1.ok ? <Ic name="check" /> : <span className={s.spin} aria-hidden="true" />}</span>
                    <span>
                      TXT <code>_markdrop-verify</code> {dns.v1.t}
                    </span>
                  </div>
                  <div className={s.vr}>
                    <span className={s.vrI}>{dns.v2.ok ? <Ic name="check" /> : <span className={s.spin} aria-hidden="true" />}</span>
                    <span>
                      CNAME to <code>{dns.cnTarget}</code> {dns.v2.t}
                    </span>
                  </div>
                  <div className={s.pbar} aria-hidden="true">
                    <span style={{ width: dns.pbPct + "%" }} />
                  </div>
                </>
              )}
              {dns.step === 3 && (
                <>
                  <div className={s.lv}>
                    <span className={s.lvI}>
                      <Ic name="check" size={20} />
                    </span>
                    <span>
                      <span className={s.lvT}>{dns.host} is live</span>
                      <span className={s.lvS}>Visitors reach your workspace there.</span>
                    </span>
                  </div>
                  <div className={s.vr}>
                    <span className={s.vrI}>
                      <Ic name="check" />
                    </span>
                    <span>TXT proved you own it</span>
                  </div>
                  <div className={s.vr}>
                    <span className={s.vrI}>
                      <Ic name="check" />
                    </span>
                    <span>
                      CNAME routes it to <code>{dns.cnTarget}</code>
                    </span>
                  </div>
                </>
              )}
              <div className={s.dnsAct}>
                {dns.step === 1 && (
                  <button key="back" type="button" id="ds-dns-back" className="md-btn md-btn--ghost md-btn--lg" onClick={on?.backDns}>
                    Back
                  </button>
                )}
                {dns.step !== 2 && (
                  <button
                    key="go"
                    type="button"
                    id="ds-dns-go"
                    className={cx("md-btn", dns.step === 3 ? "md-btn--secondary" : "md-btn--primary", "md-btn--lg", s.grow)}
                    onClick={on && (dns.step === 0 ? on.addedTxt : dns.step === 1 ? on.addedCname : on.restartDns)}
                  >
                    {dns.step === 0 ? "I added the TXT record" : dns.step === 1 ? "I added the CNAME" : "Start over"}
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* ── People and roles ── */}
          <section className={cx(s.pan, s.rl)} aria-labelledby="ds-rl-h">
            <div className={s.panH}>
              <h3 className={s.panT} id="ds-rl-h">
                People and roles
              </h3>
              <span className={s.panK}>{vm.peopleN}</span>
            </div>
            <div className={s.lad} role="img" aria-label="Roles, least to most access: viewer, member, admin, owner">
              {vm.ladder.map((l) => (
                <span key={l.t} className={s.ladI}>
                  <span className={cx(s.ld, l.on && s.on)}>{l.t}</span>
                  {l.sep && <span className={s.ladS}>&lt;</span>}
                </span>
              ))}
            </div>
            <label className={s.sr} htmlFor="ds-em">
              Email to invite
            </label>
            <input
              id="ds-em"
              className={cx("md-input", s.inp, vm.em.invalid && "md-input--invalid")}
              type="email"
              value={vm.email}
              onChange={on && ((e) => on.email(e.target.value))}
              onKeyDown={on?.emailKey}
              readOnly={!on}
              placeholder="name@example.com"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={vm.em.invalid}
              aria-describedby="ds-em-h"
            />
            <div className={s.inv2}>
              <div className={cx(s.seg, s.segR)} role="group" aria-label="Role for this person">
                {vm.roleOpts.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    id={r.id}
                    className={cx(s.sgB, r.on && s.on)}
                    aria-pressed={r.on}
                    onClick={on && (() => on.role(r.v))}
                  >
                    {r.t}
                  </button>
                ))}
              </div>
              <button type="button" id="ds-invite" className="md-btn md-btn--secondary md-btn--lg" onClick={on?.invite}>
                Invite
              </button>
            </div>
            <div className={cx(s.emH, vm.em.invalid && s.bad)} id="ds-em-h">
              {vm.em.hint}
            </div>
            <ul className={s.mem} aria-label="People in this workspace">
              {vm.members.map((m) => (
                <li key={m.key} className={cx(s.mr, par(m.anim, s.na, s.nb))}>
                  <span className={s.av} aria-hidden="true">
                    {m.av}
                  </span>
                  <span className={s.memE}>{m.email}</span>
                  <span className={cx("md-badge", m.owner ? "md-badge--info" : "md-badge--neutral")}>{m.role}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {/* ── Launch checklist ── */}
      <div className={cx(s.bar, vm.finale && s.fin)}>
        <div className={s.ckl}>
          <div className={s.cklH}>
            <span className={s.cklT} id="ds-ckl-t">
              Launch checklist
            </span>
            <span className={s.cklN}>{vm.score}</span>
          </div>
          <div className={s.mtr} aria-hidden="true">
            {vm.segs.map((done, i) => (
              <span key={i} className={done ? s.on : undefined} />
            ))}
          </div>
        </div>
        <ul className={s.cks} aria-labelledby="ds-ckl-t">
          {vm.checks.map((c) => (
            <li key={c.k}>
              <button type="button" id={c.id} className={cx(s.ck, c.on && s.on)} aria-label={c.aria} onClick={on && (() => on.check(c.k))}>
                <span className={s.ckI} aria-hidden="true">
                  <Ic name="check" size={12} />
                </span>
                {c.t}
              </button>
            </li>
          ))}
        </ul>
        <div className={s.cta}>
          <button type="button" id="ds-reset" className="md-btn md-btn--ghost md-btn--lg" onClick={on?.reset}>
            Reset
          </button>
          <span className={cx(s.ctaw, vm.finale && s.fin)}>
            <Link id="ds-cta" data-cta="toy_domain_studio_enterprise" href="/enterprise" className="md-btn md-btn--primary md-btn--lg">
              Create a workspace
              <Ic name="arrowRight" />
            </Link>
          </span>
        </div>
      </div>

      <div className={s.sr} aria-live="polite" aria-atomic="true">
        {vm.live}
      </div>
    </div>
  );
}
