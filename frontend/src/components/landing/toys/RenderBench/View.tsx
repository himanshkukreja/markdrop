import Link from "next/link";
import type { CSSProperties, FocusEvent, KeyboardEvent, PointerEvent } from "react";
import { deriveView, type Action, type FileId, type State } from "./model";
import { cx, Drop, FileIcon, Icon } from "./parts";
import s from "./RenderBench.module.css";

/**
 * Render Bench, presentational half. Pure: no hooks, no "use client". The server renders it with no
 * handlers as the static first frame (the poster); the client Game renders it with handlers. Every
 * focusable control has a stable `id`, so LazyIsland can hand focus from the poster to the game.
 */

export const ROOT_ID = "rb-root";
export const FRAME_ID = "rb-frame";
export const PP_ID = "rb-pp";
export const ADD_ID = "rb-f-add";
export const RELOCK_ID = "rb-relock";
export const GATE_BTN_ID = "rb-gate-btn";
export const VID_TOGGLE_ID = "rb-vid-toggle";

export interface Handlers {
  dispatch: (a: Action) => void;
  /** Click on a card (ignored right after a drag). */
  pick: (id: FileId) => void;
  /** Arrow keys move focus along the shelf; index 7 is "Your own file". */
  cardKey: (e: KeyboardEvent<HTMLElement>, i: number) => void;
  cardDown: (e: PointerEvent<HTMLButtonElement>, id: FileId) => void;
  pointerMove: (e: PointerEvent<HTMLButtonElement>) => void;
  pointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
  pointerCancel: () => void;
  /** These three move focus to the control that replaces the one that disappears. */
  unlock: () => void;
  relock: () => void;
  vidBig: () => void;
  focusIn: (e: FocusEvent<HTMLDivElement>) => void;
  focusOut: (e: FocusEvent<HTMLDivElement>) => void;
}

const tint = (t: string) => ({ "--tint": t }) as CSSProperties;

function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="md-progress md-progress--sm">
      <div className="md-progress__track" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
        <div className="md-progress__bar" style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}

function Tri() {
  return <span className={s.tri} aria-hidden="true" />;
}
function Bars() {
  return (
    <span className={s.bars} aria-hidden="true">
      <i />
      <i />
    </span>
  );
}

type VM = ReturnType<typeof deriveView>;

function Viewer({ vm, on }: { vm: VM; on?: Handlers }) {
  const act = (a: Action) => (on ? () => on.dispatch(a) : undefined);

  if (vm.view === "html") {
    return (
      <div className={s.vh}>
        <div className={s.vhOrb} aria-hidden="true" />
        <div className={s.vhNav}>
          <span className={s.vhLogo} />
          <span className={s.vhBrand}>Fieldkit</span>
          <span>Tour</span>
          <span className={s.vhWideOnly}>Guides</span>
          <span className={s.vhWideOnly}>Changelog</span>
          <span className={s.vhCta}>Join the beta</span>
        </div>
        <div className={s.vhHero}>
          <span className={s.vhKick}>Launch week</span>
          <p className={s.vhH}>Plan the whole launch on one page.</p>
          <p className={s.vhP}>Dates, owners and checklists for launch day, in one place the whole team can open.</p>
          <div className={s.vhBtns}>
            <span className={s.vhB1}>Get started</span>
            <span className={s.vhB2}>Watch the tour</span>
          </div>
        </div>
        <div className={s.vhCards} aria-hidden="true">
          {[s.vhCi1, s.vhCi2, s.vhCi3].map((c, i) => (
            <div key={i} className={s.vhC}>
              <span className={cx(s.vhCi, c)} />
              <span className={s.vhL} style={{ width: ["70%", "60%", "75%"][i] }} />
              <span className={s.vhL} style={{ width: ["90%", "85%", "80%"][i] }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (vm.view === "pdf") {
    const pdf = vm.pdf;
    return (
      <div className={s.vcol}>
        <div className={s.vt}>
          <FileIcon id="pdf" size={14} />
          <span className={s.nm}>q3-report.pdf</span>
          <span className={s.sp} />
          <button type="button" id="rb-pdf-prev" className={s.vbtn} aria-label="Previous page" onClick={act({ type: "PDF_PAGE", dir: -1 })} disabled={pdf.atStart}>
            <Icon name="chevronLeft" size={16} />
          </button>
          <span className={s.pgLabel}>{pdf.label}</span>
          <button type="button" id="rb-pdf-next" className={s.vbtn} aria-label="Next page" onClick={act({ type: "PDF_PAGE", dir: 1 })} disabled={pdf.atEnd}>
            <Icon name="chevronRight" size={16} />
          </button>
          <span className={cx(s.mu, s.vtWideOnly)}>100%</span>
        </div>
        <div className={s.vpArea}>
          <div className={cx(s.pg, pdf.flip === "A" ? s.fA : s.fB)}>
            <span className={s.pgK}>Q3 REPORT</span>
            <span className={s.pgH}>{pdf.title}</span>
            <span className={s.pgL} style={{ width: "92%" }} />
            <span className={s.pgL} style={{ width: "80%" }} />
            <div className={s.pgCh} aria-hidden="true">
              {pdf.bars.map((h, i) => (
                <span key={i} className={s.pgBar} style={{ transform: "scaleY(" + h / 100 + ")" }} />
              ))}
            </div>
            <span className={s.pgL} style={{ width: "96%" }} />
            <span className={s.pgL} style={{ width: "88%" }} />
            <span className={s.pgL} style={{ width: "70%" }} />
            <span className={s.pgL} style={{ width: "84%" }} />
            <span className={s.pgN}>{pdf.page}</span>
          </div>
        </div>
      </div>
    );
  }

  if (vm.view === "xlsx") {
    const sh = vm.sheet;
    return (
      <div className={s.vcol}>
        <div className={s.vt}>
          <FileIcon id="xlsx" size={14} />
          <span className={s.nm}>q3-budget.xlsx</span>
          <span className={s.sp} />
          <span className={s.vtag}>
            <Icon name="table" size={12} />2 sheets
          </span>
        </div>
        {sh.tab === "Budget" ? (
          <>
            <div className={s.fx}>
              <span className={s.fxNb}>{sh.name}</span>
              <span className={s.fxF}>fx</span>
              <span>{sh.formula}</span>
            </div>
            <div className={s.grid} id="rb-grid" tabIndex={0} role="region" aria-label="Budget sheet">
              <div className={s.gridIn}>
                <div className={s.frz}>
                  <div className={cx(s.gr, s.grLet)} aria-hidden="true">
                    <span />
                    <span>A</span>
                    <span>B</span>
                    <span>C</span>
                    <span>D</span>
                    <span>E</span>
                  </div>
                  <div className={cx(s.gr, s.grHdr)}>
                    <span>1</span>
                    <span>Item</span>
                    <span>Q1</span>
                    <span>Q2</span>
                    <span>Q3</span>
                    <span>Total</span>
                  </div>
                </div>
                {sh.rows.map((r) => (
                  <button
                    key={r.n}
                    type="button"
                    id={"rb-row-" + r.n}
                    className={cx(s.gr, s.grRow, r.sel && s.grSel)}
                    aria-pressed={r.sel}
                    aria-label={r.aria}
                    onClick={act({ type: "SEL_ROW", n: r.n })}
                  >
                    <span>{r.n}</span>
                    <span>{r.item}</span>
                    <span>{r.q1}</span>
                    <span>{r.q2}</span>
                    <span>{r.q3}</span>
                    <span>{r.total}</span>
                  </button>
                ))}
                <div className={cx(s.gr, s.grTot)}>
                  <span>{sh.totN}</span>
                  <span>Total</span>
                  <span>{sh.t1}</span>
                  <span>{sh.t2}</span>
                  <span>{sh.t3}</span>
                  <span>{sh.tt}</span>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className={s.grid}>
            <p className={s.notes}>Notes: Q3 includes the launch event and two new hires. Hosting grew with traffic. Contingency covers one late invoice.</p>
          </div>
        )}
        <div className={s.tabs}>
          <button type="button" id="rb-tab-budget" className={s.stab} aria-pressed={sh.tab === "Budget"} onClick={act({ type: "SHEET_TAB", tab: "Budget" })}>
            Budget
          </button>
          <button type="button" id="rb-tab-notes" className={s.stab} aria-pressed={sh.tab === "Notes"} onClick={act({ type: "SHEET_TAB", tab: "Notes" })}>
            Notes
          </button>
        </div>
      </div>
    );
  }

  if (vm.view === "docx") {
    return (
      <div className={s.vcol}>
        <div className={s.vt}>
          <FileIcon id="docx" size={14} />
          <span className={s.nm}>proposal.docx</span>
          <span className={s.sp} />
          <span className={s.mu}>3 pages</span>
        </div>
        <div className={s.vdArea} id="rb-docx" tabIndex={0} role="region" aria-label="Word document, rendered">
          <div className={s.paper}>
            <p className={s.dH1}>Office move proposal</p>
            <p className={s.dMeta}>Prepared for the design team · Draft 2</p>
            <p className={s.dH2}>Summary</p>
            <p className={s.dP}>We move the design team to the third floor in March, next to engineering, with one shared review room.</p>
            <p className={s.dH2}>Goals</p>
            <ul className={s.dUl}>
              <li>Shorter walks between design and engineering</li>
              <li>A review room anyone can book</li>
              <li>No downtime during the move</li>
            </ul>
            <p className={s.dH2}>Timeline</p>
            <div className={s.dTb}>
              <span className={s.th}>Phase</span>
              <span className={s.th}>When</span>
              <span>Planning</span>
              <span>January</span>
              <span>Fit-out</span>
              <span>February</span>
              <span>Move</span>
              <span>March</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (vm.view === "mp4") {
    const v = vm.vid;
    return (
      <div className={s.vcol}>
        <div className={s.vvStage}>
          <div className={s.vvScene} style={{ transform: "translateX(-" + v.shift + "px)" }} aria-hidden="true">
            <span className={cx(s.vvO, s.vvO1)} />
            <span className={cx(s.vvO, s.vvO2)} />
            <span className={cx(s.vvO, s.vvO3)} />
          </div>
          <div className={s.vvCap}>
            <b>Product demo</b>
            <span>{v.chapter}</span>
          </div>
          {!v.playing && (
            <button type="button" id="rb-vid-big" className={s.vvBig} aria-label="Play demo-clip.mp4" onClick={on?.vidBig}>
              <Tri />
            </button>
          )}
        </div>
        <div className={s.vvCtl}>
          <button type="button" id={VID_TOGGLE_ID} className={s.vbtn} aria-label={v.aria} onClick={act({ type: "VID_TOGGLE" })}>
            {v.playing ? <Bars /> : <Tri />}
          </button>
          <span>{v.time}</span>
          <input
            type="range"
            id="rb-vid-seek"
            min={0}
            max={48}
            step={1}
            value={v.t}
            readOnly={!on}
            onChange={on ? (e) => on.dispatch({ type: "VID_SEEK", t: Number(e.currentTarget.value) }) : undefined}
            aria-label="Seek in the video"
            aria-valuetext={v.time}
          />
          <span className={s.vtag}>1080p</span>
        </div>
      </div>
    );
  }

  if (vm.view === "zip") {
    const z = vm.zip;
    return (
      <div className={s.vz}>
        <div className={s.vzNav}>
          <span className={s.vzLogo} />
          <span className={s.vzBrand}>Field guide</span>
          <span className={s.vzWideOnly}>Docs</span>
          <span className={s.vzWideOnly}>Examples</span>
          <span className={s.vzSrch} />
        </div>
        <div className={s.vzBody}>
          <div className={s.vzSide}>
            <span className={s.vzK}>docs-site.zip</span>
            {z.files.map((f, i) => (
              <button key={f.id} type="button" id={"rb-zip-" + i} className={s.vzF} aria-pressed={f.pressed} onClick={act({ type: "ZIP_PAGE", id: f.id })}>
                <Icon name="code" size={12} />
                {f.id}
              </button>
            ))}
            <span className={s.vzD}>
              <Icon name="folder" size={12} />
              assets/
            </span>
            <span className={cx(s.vzD, s.vzIn)}>style.css</span>
            <span className={cx(s.vzD, s.vzIn)}>logo.svg</span>
          </div>
          <div className={cx(s.vzMain, z.flip === "A" ? s.pA : s.pB)}>
            <span className={s.vzCrumb}>{z.crumb}</span>
            <p className={s.vzH}>{z.title}</p>
            <p className={s.vzP}>{z.lead}</p>
            <span className={s.vzL} style={{ width: "88%" }} />
            <span className={s.vzL} style={{ width: "76%" }} />
            <span className={s.vzL} style={{ width: "82%" }} />
            {z.code && <div className={s.vzCode}>{z.code}</div>}
          </div>
        </div>
      </div>
    );
  }

  // png
  return (
    <div className={s.vcol}>
      <div className={s.vt}>
        <FileIcon id="png" size={14} />
        <span className={s.nm}>cover.png</span>
        <span className={cx(s.mu, s.vtWideOnly)}>1600 × 900</span>
        <span className={s.sp} />
        <button type="button" id="rb-img-zoom" className={cx(s.vbtn, s.vbtnWide)} onClick={act({ type: "IMG_ZOOM" })}>
          {vm.img.label}
        </button>
      </div>
      <div className={s.viArea}>
        <div className={cx(s.img, vm.img.zoom && s.imgZ)} role="img" aria-label="Cover image: hills under a pale sky at sunrise">
          <span className={s.imgSun} />
          <span className={s.imgM1} />
          <span className={s.imgM2} />
        </div>
      </div>
    </div>
  );
}

export default function View({ state, on }: { state: State; on?: Handlers }) {
  const vm = deriveView(state);
  const act = (a: Action) => (on ? () => on.dispatch(a) : undefined);

  return (
    <div id={ROOT_ID} className={cx(s.root, vm.paused && s.isPaused)} onFocus={on?.focusIn} onBlur={on?.focusOut}>
      {/* Meter: the section's progress. Beside the heading at desktop, above the stage below that. */}
      <div className={cx(s.meter, vm.meter.all && s.meterAll)} role="group" aria-label={vm.meter.aria}>
        <div className={s.mTop}>
          <span className={s.mK}>Rendered</span>
          <span className={s.mV}>
            <b>{vm.meter.n}</b> of 7 file types
          </span>
        </div>
        <div className={s.pips} aria-hidden="true">
          {vm.pips.map((p) => (
            <span key={p.id} className={cx(s.pip, p.on && s.pipOn, p.on && p.isNew && s.pipNew)} style={tint(p.tint)} title={p.title}>
              <FileIcon id={p.id} size={16} />
            </span>
          ))}
        </div>
        <Progress value={vm.meter.n} max={7} label="File types rendered" />
        {vm.meter.all ? (
          <span className={s.mDone}>
            <Icon name="checkCircle" size={14} />
            All seven rendered. Your files are next.
          </span>
        ) : (
          <span className={s.mSub}>{vm.meter.sub}</span>
        )}
      </div>

      <div className={s.stage}>
        {/* Shelf */}
        <section className={s.shelf} aria-label="File shelf">
          <div className={s.shHd}>
            <span className={s.shT}>Your files</span>
            <span className={s.shS}>
              <span className={s.fine}>Click one, or drag it</span>
              <span className={s.coarse}>Tap one to render it</span>
            </span>
          </div>
          <div className={s.plank}>
            {vm.cards.map((c, i) => (
              <button
                key={c.id}
                type="button"
                id={c.domId}
                className={cx(s.rc, c.cur && s.rcCur, c.lift && s.rcLift)}
                style={tint(c.tint)}
                aria-pressed={c.cur}
                aria-label={c.aria}
                onClick={on ? () => on.pick(c.id) : undefined}
                onKeyDown={on ? (e) => on.cardKey(e, i) : undefined}
                onPointerDown={on ? (e) => on.cardDown(e, c.id) : undefined}
                onPointerMove={on?.pointerMove}
                onPointerUp={on?.pointerUp}
                onPointerCancel={on?.pointerCancel}
              >
                <span className={s.rcDoc}>
                  <FileIcon id={c.id} size={20} />
                  <span className={s.rcExt}>{c.ext}</span>
                </span>
                <span className={s.rcTx}>
                  <span className={s.rcN}>{c.file}</span>
                  <span className={s.rcT}>{c.type}</span>
                </span>
                {c.done && (
                  <span className={s.rcOk} aria-hidden="true">
                    <Icon name="check" size={12} />
                  </span>
                )}
              </button>
            ))}
            <Link href="/upload" data-cta="toy_render_bench_add" id={ADD_ID} className={cx(s.rc, s.rcAdd)} onKeyDown={on ? (e) => on.cardKey(e, vm.cards.length) : undefined}>
              <Icon name="plus" size={18} />
              <span className={s.rcN}>Your own file</span>
              <span className={s.rcT}>Upload a file</span>
            </Link>
          </div>
          <p className={cx(s.tip, s.fineOnly)}>
            Enter or Space renders the focused file. <kbd className="md-kbd">←</kbd>
            <kbd className="md-kbd">→</kbd>
            <kbd className="md-kbd">↑</kbd>
            <kbd className="md-kbd">↓</kbd> move along the shelf.
          </p>
        </section>

        {/* The browser: address bar, then the file as a visitor sees it */}
        <div className={s.mid}>
          <div id={FRAME_ID} className={cx(s.frame, vm.hot && s.frameHot)} role="region" aria-label="Browser preview of the link">
            <div className={s.chrome}>
              <span className={s.dots} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <div className={cx(s.addr, vm.addr.flash === "A" && s.flA, vm.addr.flash === "B" && s.flB)} role="img" aria-label={vm.addr.aria}>
                <span className={cx(s.ai, vm.addr.locked && s.aiLk)}>
                  <Icon name={vm.addr.icon} size={14} />
                </span>
                {vm.addr.placeholder && <span className={cx(s.ph, s.lnk)}>{vm.addr.ph}</span>}
                {vm.addr.hasLink && (
                  <span className={s.lnk}>
                    <span className={s.host}>{vm.addr.host}</span>
                    <span className={s.pth}>{vm.addr.path}</span>
                  </span>
                )}
                {vm.addr.typing && <span className={s.caret} />}
              </div>
              <span className={cx(s.chip, vm.chip.prot && s.chipProt)}>
                <Icon name={vm.chip.icon} size={12} />
                {vm.chip.text}
              </span>
              <button type="button" id="rb-copy" className={cx(s.copy, vm.copy.done && s.copyOk)} onClick={act({ type: "COPY" })} disabled={vm.copy.disabled} aria-label={vm.copy.aria}>
                <Icon name={vm.copy.icon} size={14} />
                {vm.copy.text}
              </button>
            </div>

            <div className={s.viewport}>
              {/* The viewer carries its own theme (Preview theme), independent of the page. */}
              <div className={s.vwrap} data-theme={vm.vtheme}>
                <div className={cx(s.vbody, vm.body.dim && s.dim, vm.body.land === "A" && s.lA, vm.body.land === "B" && s.lB)}>
                  {vm.showGate && (
                    <div className={s.gate}>
                      <div className={s.gateGh} aria-hidden="true">
                        <span style={{ width: "42%" }} />
                        <span />
                        <span style={{ width: "86%" }} />
                        <span style={{ width: "74%" }} />
                        <span />
                        <span style={{ width: "64%" }} />
                      </div>
                      <div className={cx(s.gateC, vm.gate.pop && s.gateCIn)}>
                        <span className={s.gateWho}>What a visitor sees</span>
                        <span className={cx(s.gateG, vm.gate.amber && s.gateGAmber)}>
                          <Icon name={vm.gate.icon} size={20} />
                        </span>
                        <p className={s.gateT}>{vm.gate.title}</p>
                        <p className={s.gateB}>{vm.gate.body}</p>
                        {vm.gate.isPw && (
                          <div className={s.gateIn} aria-hidden="true">
                            Password
                          </div>
                        )}
                        <button type="button" id={GATE_BTN_ID} className={s.gateBtn} onClick={on?.unlock}>
                          {vm.gate.btn}
                        </button>
                      </div>
                    </div>
                  )}
                  {vm.showView && <Viewer vm={vm} on={on} />}
                  {vm.showView && vm.showUnlocked && (
                    <div className={s.ulk}>
                      <Icon name="checkCircle" size={14} />
                      {vm.unlockTag}
                      <button type="button" id={RELOCK_ID} onClick={on?.relock}>
                        Lock again
                      </button>
                    </div>
                  )}
                </div>

                {vm.fly.show && (
                  <div className={s.fly}>
                    <Drop className={s.drop} />
                    <span className={s.dropRip} aria-hidden="true" />
                    <div className={s.flyR}>
                      <span className={s.flyI}>
                        <FileIcon id={vm.fly.id} size={22} />
                      </span>
                      <div className={s.flyTx}>
                        <div className={s.flyN}>{vm.fly.file}</div>
                        <div className={s.flyS}>{vm.fly.label}</div>
                      </div>
                    </div>
                    <Progress value={vm.fly.prog} max={100} label={vm.fly.label} />
                  </div>
                )}
              </div>

              {vm.hot && (
                <div className={s.hotov}>
                  <div className={s.hotT}>
                    <Drop width={28} height={36} />
                    Drop it. It renders.
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className={s.belt}>
            {vm.attract ? (
              <>
                <span className={s.beltDemo}>
                  <span className={s.demoDot} aria-hidden="true" />
                  {vm.beltDemo}
                </span>
                <button type="button" id={PP_ID} className={s.pp} aria-label={vm.pp.aria} onClick={act({ type: "TOGGLE_PAUSE" })}>
                  {vm.paused ? <Tri /> : <Bars />}
                  {vm.pp.text}
                </button>
                {/* Reduced motion never runs the demo; the poster shows the hand-over line instead. */}
                <span className={s.beltRest}>
                  <b>Your turn.</b> <span className={s.fine}>Drag a file onto the browser, or click it</span>
                  <span className={s.coarse}>Tap a file to render it</span>.
                </span>
              </>
            ) : (
              <span>
                <b>{vm.beltLead}</b> <span className={s.fine}>{vm.beltText}</span>
                <span className={s.coarse}>{vm.beltTouch}</span>
                {vm.beltWide && <span className={s.wideOnly}>{vm.beltWide}</span>}.
              </span>
            )}
          </div>
        </div>

        {/* Link settings */}
        <section className={s.ctl} aria-label="Link settings">
          <div className={s.ctlH}>
            <b>Link settings</b>
            <span>Change them and watch what a visitor sees.</span>
          </div>
          <div className={s.ctlAcc}>
            <div className={s.gl} id="rb-acc">
              Who can open it
            </div>
            <div className={s.opts} role="group" aria-labelledby="rb-acc">
              {vm.access.map((o) => (
                <button key={o.id} type="button" id={"rb-acc-" + o.id} className={s.opt} aria-pressed={o.pressed} onClick={act({ type: "ACCESS", access: o.id })}>
                  <span className={s.optI}>
                    <Icon name={o.icon} size={14} />
                  </span>
                  <span className={s.optTx}>
                    <b>{o.label}</b>
                    <span>{o.sub}</span>
                  </span>
                  <span className={s.rad} aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            id="rb-pw"
            className={cx(s.sw, vm.pw.limited && s.swLim)}
            aria-checked={vm.pw.on}
            aria-label={vm.pw.aria}
            onClick={act({ type: "TOGGLE_PW" })}
          >
            <span className={s.optI}>
              <Icon name="lock" size={14} />
            </span>
            <span className={s.optTx}>
              <b>Password</b>
              <span>{vm.pw.sub}</span>
            </span>
            <span className={s.swTrack} aria-hidden="true">
              <span className={s.swKnob} />
            </span>
          </button>
          <div className={s.ctlVt}>
            <div className={s.gl} id="rb-vt">
              Preview theme
            </div>
            <div className={s.seg} role="group" aria-labelledby="rb-vt">
              <button type="button" id="rb-vt-light" aria-pressed={vm.vtheme === "light"} onClick={act({ type: "VTHEME", vtheme: "light" })}>
                <Icon name="sun" size={14} />
                Light
              </button>
              <button type="button" id="rb-vt-dark" aria-pressed={vm.vtheme === "dark"} onClick={act({ type: "VTHEME", vtheme: "dark" })}>
                <Icon name="moon" size={14} />
                Dark
              </button>
            </div>
          </div>
          <div className={cx(s.note, vm.note.warn && s.noteWarn, vm.note.nudge === "A" && s.nA, vm.note.nudge === "B" && s.nB)}>
            <span className={s.ni}>
              <Icon name={vm.note.warn ? "alert" : "info"} size={14} />
            </span>
            <span>{vm.note.text}</span>
          </div>
        </section>
      </div>

      {vm.ghost && (
        <div className={s.ghost} style={{ left: vm.ghost.x - 75, top: vm.ghost.y - 28 }} aria-hidden="true">
          <FileIcon id={vm.ghost.id} size={18} />
          {vm.ghost.file}
        </div>
      )}

      <p className={s.sr} aria-live="polite">
        {vm.live}
      </p>
    </div>
  );
}
