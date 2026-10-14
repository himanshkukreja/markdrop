import Link from "next/link";
import type { ChangeEvent, CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { ICONS } from "@/components/ui/icons";
import { deriveView, HOST, NOTE_MAX, PATH, type State } from "./model";
import s from "./KeyLab.module.css";

/**
 * Key Lab, presentational. No hooks and no "use client": the server renders it with no handlers as the
 * static first frame, and Game renders it with handlers. Every focusable control has a stable id, so
 * LazyIsland can hand focus from the poster to the game.
 *
 * Icons draw from the design-system glyph data (`components/ui/icons`, server-safe) with the DS
 * `.md-icon` stroke style; the badge, button and progress use the DS classes, because
 * `components/ui/primitives` can't be imported from a server component yet (it has no "use client").
 */

export interface Handlers {
  toggleDemo?: () => void;
  stageDown?: () => void;
  stageFocus?: () => void;
  note?: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  showServer?: () => void;
  showBrowser?: () => void;
  toggleKey?: () => void;
  rotate?: () => void;
  toggleSignin?: () => void;
  closeSignin?: () => void;
  panelKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  chipClick?: () => void;
  chipKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
  chipPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
  chipPointerMove?: (e: PointerEvent<HTMLButtonElement>) => void;
  chipPointerUp?: (e: PointerEvent<HTMLButtonElement>) => void;
  chipPointerCancel?: (e: PointerEvent<HTMLButtonElement>) => void;
}

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

function Ico({ name, size, className }: { name: keyof typeof ICONS; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={cx("md-icon", className)} style={size ? { fontSize: size } : undefined}>
      <path d={ICONS[name]} />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M9 5v14M15 5v14" />
    </svg>
  );
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  );
}

export default function View({ state, on }: { state: State; on?: Handlers }) {
  const vm = deriveView(state);
  const chipText = (
    <>
      {vm.chipHead}
      <span className={s.kmid}>{vm.chipMid}</span>…
    </>
  );
  const chipStyle = vm.drag
    ? ({ "--dx": `${vm.drag.dx.toFixed(1)}px`, "--dy": `${vm.drag.dy.toFixed(1)}px`, "--tilt": `${vm.tilt.toFixed(1)}deg` } as CSSProperties)
    : undefined;
  const ab = (v: "" | "A" | "B", a: string, b: string) => (v === "A" ? a : v === "B" ? b : false);

  return (
    <div className={cx(s.root, vm.demoOn && s.demo, vm.paused && s.paused)}>
      <div className={s.tools}>
        <button id="kl-demo" type="button" className={s.tbtn} onClick={on?.toggleDemo}>
          {vm.demoOn ? <PauseGlyph /> : <PlayGlyph />}
          <span>{vm.demoOn ? "Pause demo" : "Play demo"}</span>
        </button>
      </div>

      <div className={s.body}>
        <div id="kl-stage" className={s.stage} onPointerDown={on?.stageDown} onFocus={on?.stageFocus}>
          {/* Left: the note */}
          <div className={cx(s.col, s.colNote)}>
            <div className={s.field}>
              <div className={s.lab}>
                <label className={s.lt} htmlFor="kl-note">
                  Your note
                </label>
                <span className={s.livedot}>
                  <i />
                  Updates as you type
                </span>
              </div>
              <textarea
                id="kl-note"
                className={s.ta}
                spellCheck={false}
                maxLength={NOTE_MAX}
                aria-describedby="kl-note-hint"
                {...(on?.note ? { value: state.note, onChange: on.note } : { defaultValue: state.note })}
              />
              <div id="kl-note-hint" className={s.hint}>
                The first line becomes the title. It is sealed too.
              </div>
            </div>
            <div className={s.meta}>
              <span className={s.ic}>
                <Ico name="key" size={16} />
              </span>
              <span>
                <b>AES-256-GCM, in your browser</b>
                Only ciphertext is uploaded. The key never leaves the link.
              </span>
            </div>
          </div>

          {/* Middle: the link, split at the # */}
          <div className={cx(s.col, s.colLink)}>
            <div className={s.lab}>
              <span className={s.lt}>Your link</span>
              {vm.keyIn ? (
                <span className="md-badge md-badge--success">
                  <Ico name="key" />
                  End-to-end encrypted
                </span>
              ) : (
                <span className="md-badge md-badge--warning">
                  <Ico name="alert" />
                  Key missing
                </span>
              )}
            </div>
            <div className={s.linkrow}>
              <div className={s.seg}>
                <div className={cx(s.bar, s.barL)}>
                  <span className={s.url}>
                    <span className={s.mu}>{HOST}</span>
                    {PATH}
                  </span>
                </div>
                <div className={s.ann}>Sent to the server</div>
              </div>
              <div className={cx(s.seg, s.segF)}>
                <div className={cx(s.bar, s.barR)}>
                  <span className={cx(s.ghost, vm.keyOut && s.ghostOn, vm.slotHot && s.ghostHot)} aria-hidden="true">
                    <span className={s.sp}>
                      <Ico name="key" />
                      <span>{chipText}</span>
                    </span>
                    <span className={s.gt}>#k= ?</span>
                  </span>
                  <button
                    id="kl-key"
                    type="button"
                    className={cx(s.chip, vm.keyOut && s.chipOut, vm.drag && s.chipDrag)}
                    style={chipStyle}
                    aria-label={vm.chipAria}
                    onClick={on?.chipClick}
                    onKeyDown={on?.chipKeyDown}
                    onPointerDown={on?.chipPointerDown}
                    onPointerMove={on?.chipPointerMove}
                    onPointerUp={on?.chipPointerUp}
                    onPointerCancel={on?.chipPointerCancel}
                  >
                    <span className={cx(s.chipi, vm.wiggle ? s.hw : ab(vm.squash, s.qA, s.qB))}>
                      <Ico name="key" />
                      <span className={cx(s.kt, ab(vm.roll, s.kA, s.kB))}>{chipText}</span>
                    </span>
                    <span className={cx(s.rip, ab(vm.ripple, s.rA, s.rB))} aria-hidden="true" />
                  </button>
                  {vm.hintOn && (
                    <span className={s.hintlab} aria-hidden="true">
                      Drag me out
                    </span>
                  )}
                </div>
                <div className={cx(s.ann, s.annK)}>Stays in your browser</div>
              </div>
            </div>
            <div className={s.old}>
              {vm.old && (
                <>
                  <span className={s.ic}>
                    <Ico name="x" size={14} />
                  </span>
                  <span className={cx(s.olds, ab(vm.strike, s.sA, s.sB))}>{vm.old}</span>
                  <span className={s.stop}>stops working</span>
                </>
              )}
            </div>
            <div className={cx(s.tray, vm.trayHot && s.trayHot, vm.keyOut && s.trayKey, ab(vm.trayFlash, s.fA, s.fB))}>
              <span className={s.trayi} aria-hidden="true">
                <Ico name={vm.keyOut ? "chevronUp" : "chevronDown"} size={16} />
              </span>
              <span className={s.trayt}>{vm.trayText}</span>
            </div>
            <div className={s.acts}>
              <button id="kl-keybtn" type="button" className={s.btn} data-on={vm.keyOut ? "" : undefined} onClick={on?.toggleKey}>
                <Ico name="key" />
                {vm.keyBtnLabel}
              </button>
              <button id="kl-rotate" type="button" className={s.btn} onClick={on?.rotate}>
                <Ico name="refresh" />
                Rotate key
              </button>
              <button id="kl-signbtn" type="button" className={s.btn} aria-pressed={vm.signin} onClick={on?.toggleSignin}>
                <Ico name="user" />
                Try signing in
              </button>
            </div>
            <p className={s.status} aria-live="polite">
              <span className={s.ic}>
                <Ico name="info" size={14} />
              </span>
              <span>{vm.status}</span>
            </p>
          </div>

          {/* Right: what each side sees */}
          <div className={s.panel} onKeyDown={on?.panelKeyDown}>
            <div className={s.seg2} role="group" aria-label="Choose whose view to show">
              <button id="kl-view-server" type="button" className={s.sbtn} aria-pressed={vm.isServer} onClick={on?.showServer}>
                What Markdrop&rsquo;s server sees
              </button>
              <button id="kl-view-browser" type="button" className={s.sbtn} aria-pressed={!vm.isServer} onClick={on?.showBrowser}>
                What your browser sees
              </button>
            </div>
            <div className={s.pbody}>
              {vm.isServer && (
                <div className={cx(s.vin, vm.swapped && s.vinIn)}>
                  <div className={s.phead}>
                    <span className={s.pt}>Stored on Markdrop</span>
                    <span className="md-badge md-badge--neutral">Illustration, not real ciphertext</span>
                  </div>
                  <div className={s.row}>
                    <span className={s.k}>Request</span>
                    <span className={s.v}>
                      {`GET ${PATH}  Host: ${HOST}`}
                      <small>No #k= in it. Browsers keep the fragment to themselves.</small>
                    </span>
                  </div>
                  <div className={s.row}>
                    <span className={s.k}>Title</span>
                    <span className={s.v}>{vm.titleSealed}</span>
                  </div>
                  <div className={s.scroll} role="img" aria-label="Encrypted body, illustrated">
                    <div className={cx(s.ct, ab(vm.ctFlash, s.ctA, s.ctB))} style={{ "--d": `${vm.scrollSecs}s` } as CSSProperties} aria-hidden="true">
                      {vm.scroll.map((t, i) => (
                        <span key={i}>{t}</span>
                      ))}
                    </div>
                  </div>
                  <div className={s.pfoot}>
                    <span className={s.ic}>
                      <Ico name="key" />
                    </span>
                    <span>{vm.serverFoot}</span>
                  </div>
                </div>
              )}

              {vm.browserOk && (
                <div className={cx(s.vin, vm.swapped && s.vinIn)}>
                  <span className={s.tab}>{vm.title}</span>
                  <div className={s.chrome}>
                    <span className={s.ic}>
                      <Ico name="lock" size={12} />
                    </span>
                    <span>
                      <span className={s.mu}>{HOST}</span>
                      {PATH}
                    </span>
                    <span className={s.frag}>
                      <Ico name="key" size={11} />
                      <span className={s.fragT}>{vm.fragShort}</span>
                    </span>
                  </div>
                  <div className={cx(s.art, vm.swapped && s.artIn)}>
                    <h3 className={s.ah}>{vm.title}</h3>
                    {vm.blocks.map((b) =>
                      b.li ? (
                        <div key={b.id} className={s.ali}>
                          {b.t}
                        </div>
                      ) : (
                        <p key={b.id} className={s.ap}>
                          {b.t}
                        </p>
                      ),
                    )}
                  </div>
                  <div className={cx(s.pfoot, s.ok)}>
                    <span className={s.ic}>
                      <Ico name="checkCircle" />
                    </span>
                    <span>Decrypted in your browser with the key from the link.</span>
                  </div>
                </div>
              )}

              {vm.browserMissing && (
                <div className={cx(s.vin, vm.swapped && s.vinIn)}>
                  <span className={s.tab}>Encrypted document</span>
                  <div className={s.chrome}>
                    <span className={s.ic}>
                      <Ico name="lock" size={12} />
                    </span>
                    <span>
                      <span className={s.mu}>{HOST}</span>
                      {PATH}
                    </span>
                  </div>
                  <div className={s.miss}>
                    <div className={s.missbg} aria-hidden="true">
                      {vm.still.map((t, i) => (
                        <span key={i}>{t}</span>
                      ))}
                    </div>
                    <div className={s.missc}>
                      <span className={s.lockc}>
                        <Ico name="lock" size={24} />
                      </span>
                      <b>This link is missing its key</b>
                      <p>Everything after the # is gone, so your browser has nothing to decrypt with. Put the key back to read the note.</p>
                    </div>
                  </div>
                </div>
              )}

              {vm.signin && (
                <div className={s.sign}>
                  <div className={s.signc} role="note" aria-labelledby="kl-signin-title">
                    <span className={s.signIc}>
                      <Ico name="userX" size={20} />
                    </span>
                    <b id="kl-signin-title">Signing in does not unlock it</b>
                    <p>The key lives only in the link. Markdrop never had it, so there is nothing your account could unlock.</p>
                    <p>Lose the link and you lose the document. Keep it somewhere safe.</p>
                    <button id="kl-signin-ok" type="button" className={s.btn} onClick={on?.closeSignin}>
                      Got it
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer: checklist + CTA */}
        <div className={s.foot}>
          <div className={s.check}>
            <div className={s.cmeta}>
              <div className={s.cmetaTop}>
                <b>Try all four</b>
                <span className={s.count}>{vm.doneN} of 4 tried</span>
              </div>
              <div
                className={s.bar3}
                role="progressbar"
                aria-label="Things tried"
                aria-valuemin={0}
                aria-valuemax={4}
                aria-valuenow={vm.doneN}
                aria-valuetext={`${vm.doneN} of 4 tried`}
              >
                <i style={{ width: `${(vm.doneN / 4) * 100}%` }} />
              </div>
              {vm.complete && (
                <span className={cx("md-badge md-badge--success", s.done)}>
                  <Ico name="checkCircle" />
                  Lab complete
                </span>
              )}
            </div>
            <ol className={s.steps} aria-label="Things to try">
              {vm.steps.map((st) => (
                <li key={st.id} className={cx(s.step, st.done && s.stepDone)}>
                  {st.done ? (
                    <span className={s.tick} aria-hidden="true">
                      <Ico name="check" />
                    </span>
                  ) : (
                    <span className={s.num} aria-hidden="true">
                      {st.n}
                    </span>
                  )}
                  <span>
                    {st.t}
                    <span className={s.sr}>{st.done ? ", done" : ", not tried yet"}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className={s.cta}>
            <span className={cx(s.ctaw, vm.complete && s.lit)}>
              <Link id="kl-cta" data-cta="toy_key_lab_new" href="/new?encrypt=1" className="md-btn md-btn--primary md-btn--lg">
                <Ico name="key" />
                Publish encrypted
              </Link>
            </span>
            <p>For documents, no account needed. Uploaded files use a password or access level instead.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
