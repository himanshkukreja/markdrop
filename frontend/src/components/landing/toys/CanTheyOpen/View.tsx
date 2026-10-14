import type { PointerEvent as ReactPointerEvent, Ref } from "react";
import Link from "next/link";
import { ICONS, type IconName } from "@/components/ui/icons";
import { deriveView, type DevId, type State, type ThingId, type ViewModel } from "./model";
import s from "./CanTheyOpen.module.css";

/**
 * Presentational half of "Can they open it?" (board: PlayCanTheyOpen.dc.html). No hooks, no state:
 * the server renders `<View state={initialState} />` as the static first frame, and the client Game
 * renders the same tree with handlers. Every focusable control has a stable id, so LazyIsland can
 * hand focus from the static frame to the live one.
 */
export type Handlers = {
  root?: Ref<HTMLDivElement>;
  pickDev?: (id: DevId) => void;
  pickThing?: (id: ThingId) => void;
  thingDown?: (id: ThingId, e: ReactPointerEvent<HTMLButtonElement>) => void;
  togglePause?: () => void;
  pointerMove?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  pointerUp?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  pointerCancel?: (e: ReactPointerEvent<HTMLDivElement>) => void;
};

export const TITLE_ID = "can-they-open-title";

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

function Ico({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={cx("md-icon", className)} style={{ fontSize: size }}>
      <path d={ICONS[name]} />
    </svg>
  );
}

/* ── Device screens (decorative: the lane notes carry the meaning) ────── */
function SheetRows({ total }: { total?: boolean }) {
  return (
    <div className={s.sh}>
      <span className={cx(s.shH, s.shN)}>Team</span><span className={s.shH}>Q1</span><span className={s.shH}>Q2</span><span className={s.shH}>Q3</span>
      <span className={s.shN}>Design</span><span>12</span><span>14</span><span>15</span>
      <span className={s.shN}>Eng</span><span>30</span><span>31</span><span>33</span>
      <span className={s.shN}>Ops</span><span>8</span><span>9</span><span>9</span>
      {total && (<><span className={cx(s.shN, s.shT)}>Total</span><span className={s.shT}>50</span><span className={s.shT}>54</span><span className={s.shT}>57</span></>)}
    </div>
  );
}

function DocBody({ preview }: { preview?: boolean }) {
  return (
    <div className={cx(s.vDoc, preview && s.pv)}>
      {preview && <span className={s.pvTag}>Read-only preview</span>}
      <b className={s.vDocH}>Proposal</b>
      <span className={s.vDocSub}>For the Example team</span>
      <span className={s.vDocS}>Scope</span>
      <span className={s.bar} style={{ width: "92%" }} />
      <span className={s.bar} style={{ width: "76%" }} />
      <span className={s.vDocS}>Timeline</span>
      <span className={s.bar} style={{ width: "84%" }} />
      {!preview && <span className={s.bar} style={{ width: "58%" }} />}
    </div>
  );
}

function Checkout({ bare }: { bare?: boolean }) {
  if (bare) {
    return (
      <div className={s.vBare}>
        <b>Checkout</b>
        <span className={s.bimg}>image</span>
        <u>Step 2 of 3</u>
        <span>Email [ ]</span>
        <span>Card [ ]</span>
        <span>[Place order]</span>
        <em>Styles and scripts did not load</em>
      </div>
    );
  }
  return (
    <div className={s.vHtml}>
      <div className={s.vhTop}><b>Checkout</b><span>Step 2 of 3</span></div>
      <div className={s.vhSt}><span /><span /><span className={s.off} /></div>
      <div className={s.vhF}>Email<i /></div>
      <div className={s.vhF}>Card<i /></div>
      <span className={s.vhBtn}>Place order</span>
    </div>
  );
}

function Centered({ icon, title, line, warn }: { icon: IconName; title: string; line: string; warn?: boolean }) {
  return (
    <div className={s.vCtr}>
      <span className={cx(s.ci, warn && s.ciWarn)}><Ico name={icon} size={16} /></span>
      <b>{title}</b>
      <span>{line}</span>
    </div>
  );
}

function AttachmentScreen({ v }: { v: ViewModel }) {
  const { A, T } = v;
  switch (A.k) {
    case "raw":
      return (
        <div className={s.vRaw}>
          <span><i>#</i> Trip notes</span>
          <span><i>**</i>Day 1<i>**</i>: train to the coast</span>
          <span><i>- [ ]</i> Book the train</span>
          <span><i>- [x]</i> Pack chargers</span>
          <span><i>&gt;</i> Leave by 8</span>
        </div>
      );
    case "preview":
      return T.id === "xlsx" ? (
        <div className={s.pv}>
          <span className={s.pvTag}>Read-only preview</span>
          <SheetRows />
          <p className={s.shNote}>Sheet 1 of 3 shown</p>
        </div>
      ) : (
        <DocBody preview />
      );
    case "app":
      return (
        <div className={s.vCtr}>
          <span className={s.ci}><Ico name={T.icon} size={16} /></span>
          <b>{T.file}</b>
          <span>{A.line}</span>
          <span className={s.fake}>Find an app</span>
        </div>
      );
    case "download":
      return (
        <div className={s.vDl}>
          <div className={s.dlRow}>
            <Ico name="download" size={14} />
            <span><b>{T.file}</b><span>{T.size} · Downloaded</span></span>
          </div>
          <span className={s.dlNo}>{A.line}</span>
        </div>
      );
    case "big":
      return <Centered icon="inbox" title="Nothing arrived" line="launch-video.mp4 is 1.2 GB, too large to attach." />;
    case "folder":
      return (
        <div className={s.vFold}>
          <span className={cx(s.fr, s.frTop)}><Ico name="folder" size={12} />microsite</span>
          <span className={cx(s.fr, s.frIn)}><Ico name="code" size={12} />index.html</span>
          <span className={cx(s.fr, s.frIn)}><Ico name="doc" size={12} />styles.css</span>
          <span className={cx(s.fr, s.frIn)}><Ico name="code" size={12} />app.js</span>
          <span className={cx(s.fr, s.frIn)}><Ico name="folder" size={12} />images</span>
        </div>
      );
    case "nowhere":
      return <Centered icon="inbox" title="No mail app here" line={`A TV browser has nowhere to open or save ${T.file}.`} />;
    case "local":
      return <Checkout />;
    case "bare":
      return <Checkout bare />;
  }
}

function LinkScreen({ v }: { v: ViewModel }) {
  switch (v.L.k) {
    case "md":
      return (
        <div className={s.vMd}>
          <b className={s.vMdH}>Trip notes</b>
          <p><b>Day 1</b>: train to the coast</p>
          <span className={s.ck}><i />Book the train</span>
          <span className={cx(s.ck, s.ckOn)}><i />Pack chargers</span>
          <span className={s.q}>Leave by 8</span>
        </div>
      );
    case "sheet":
      return (
        <div>
          <SheetRows total />
          <div className={s.stabs}><span className={s.stabOn}>Summary</span><span>Hiring</span><span>Notes</span></div>
        </div>
      );
    case "doc":
      return <DocBody />;
    case "send":
      return (
        <div className={s.vSend}>
          <div className={s.sdH}>Receiving<span className="md-badge md-badge--success"><Ico name="arrowRight" size={12} />Direct</span></div>
          <div className={s.sdF}>
            <Ico name="film" size={14} />
            <span><b>launch-video.mp4</b><span>1.2 GB</span></span>
          </div>
          <div className="md-progress md-progress--sm"><div className="md-progress__track"><div className="md-progress__bar" style={{ width: "64%" }} /></div></div>
          <span className={s.sdN}><Ico name="lock" size={11} />Encrypted device to device</span>
        </div>
      );
    case "tvsend":
      return <Centered icon="alert" warn title="Nowhere to save it" line="A device-to-device send saves the file. This screen has nowhere to keep it." />;
    case "site":
      return (
        <div>
          <div className={s.zNav}><b>Microsite</b><span className={s.zOn}>Home</span><span>Docs</span><span>Blog</span></div>
          <div className={s.zBody}>
            <div className={s.zSide}><span className={s.bar} /><span className={s.bar} style={{ width: "80%" }} /><span className={s.bar} style={{ width: "60%" }} /></div>
            <div className={s.zMain}><span className={s.zHero} /><span className={cx(s.bar, s.barInk)} style={{ width: "64%" }} /><span className={s.bar} /><span className={s.bar} style={{ width: "82%" }} /></div>
          </div>
        </div>
      );
    case "html":
      return <Checkout />;
  }
}

const VERDICT_CLASS = { ok: s.vdOk, part: s.vdPart, fail: s.vdFail } as const;
const MARK_CLASS = { ok: s.mkOk, part: s.mkPart, fail: s.mkFail, no: s.mkNo } as const;
const DEV_GLYPH: Record<DevId, string> = { phone: s.dgPhone, tablet: s.dgTablet, laptop: s.dgLaptop, linux: s.dgLinux, tv: s.dgTv };
const DEV_FRAME: Record<DevId, string> = { phone: s.devPhone, tablet: s.devTablet, laptop: s.devLaptop, linux: s.devLinux, tv: s.devTv };

export default function View({ state, on }: { state: State; on?: Handlers }) {
  const v = deriveView(state);
  const { D, T, A, L, score } = v;
  const frame = cx(s.dev, DEV_FRAME[D.id]);

  return (
    <div
      ref={on?.root}
      className={cx(s.root, v.parity === "a" && s.ra, v.parity === "b" && s.rb)}
      onPointerMove={on?.pointerMove}
      onPointerUp={on?.pointerUp}
      onPointerLeave={on?.pointerCancel}
      onPointerCancel={on?.pointerCancel}
    >
      <div className={s.backdrop} aria-hidden="true"><div className={s.dots} /><div className={s.pool} /></div>

      <div className={cx(s.wrap, "mx-auto max-w-marketing px-4 sm:px-6")}>
        <header className={s.hd}>
          <div>
            <p className={s.eb}><span className={s.drop} aria-hidden="true" />Attachments or links</p>
            <h2 id={TITLE_ID} className={s.h2}>Stop sending things people can&apos;t open.</h2>
            <p className={s.lead}>Pick who is on the other end and what you are sending. The same file travels twice: once as an attachment, once as a Markdrop link.</p>
          </div>
          <div className={s.hdCtl}>
            <button id="cto-pause" type="button" className={s.pp} onClick={on?.togglePause}>
              {v.playing ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M9 5v14M15 5v14" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
              )}
              <span>{v.playing ? "Pause demo" : "Play demo"}</span>
            </button>
          </div>
        </header>

        <div className={s.stage}>
          <div className={s.pick}>
            <p className={cx(s.gl, s.glDev)} id="cto-dev"><b>1</b>Who is opening it?</p>
            <div className={s.devs} role="group" aria-labelledby="cto-dev">
              {v.devices.map((d) => (
                <button
                  key={d.id}
                  id={`cto-dev-${d.id}`}
                  type="button"
                  className={cx(s.dv, d.on && s.on, d.done && s.done)}
                  aria-pressed={d.on}
                  aria-label={d.aria}
                  onClick={on?.pickDev ? () => on.pickDev?.(d.id) : undefined}
                >
                  <span className={cx(s.dg, DEV_GLYPH[d.id])} aria-hidden="true" />
                  <span className={s.dvT}>
                    <b className={s.dvLong}>{d.label}</b>
                    <b className={s.dvShort}>{d.short}</b>
                    <span className={s.dvSub}>{d.sub}</span>
                  </span>
                  <span className={s.dvN} aria-hidden="true">{d.count}</span>
                </button>
              ))}
            </div>

            <p className={cx(s.gl, s.glThing)} id="cto-thing"><b>2</b>What are you sending?</p>
            <div className={s.things} role="group" aria-labelledby="cto-thing">
              {v.things.map((t) => (
                <button
                  key={t.id}
                  id={`cto-thing-${t.id}`}
                  type="button"
                  className={cx(s.th, t.on && s.on)}
                  aria-pressed={t.on}
                  aria-label={t.aria}
                  onClick={on?.pickThing ? () => on.pickThing?.(t.id) : undefined}
                  onPointerDown={on?.thingDown ? (e) => on.thingDown?.(t.id, e) : undefined}
                >
                  <span className={s.thR}>
                    <span className={t.kind === "Document" ? s.tintDoc : s.tintArt}><Ico name={t.icon} size={14} /></span>
                    <span className={s.thSz}>{t.size}</span>
                    <span className={s.thK}>{t.kind}</span>
                  </span>
                  <span className={s.thF}>{t.file}</span>
                </button>
              ))}
            </div>
            <p className={cx(s.tip, v.demoOn && s.tipDemo)}>
              {v.demoOn ? (
                "Playing a demo. Pick anything to take over."
              ) : (
                <>
                  <span className={s.tipFine}>Tap a file to send it both ways, or drag it onto the lanes.</span>
                  <span className={s.tipCoarse}>Tap a file to send it both ways.</span>
                </>
              )}
            </p>
          </div>

          <div className={cx(s.lanes, v.hot && s.hot)} data-cto-lanes="">
            <section className={s.lane} aria-label="As an attachment">
              <div className={s.lnH}>
                <span className={s.lnT}><span className={s.lnIc}><Ico name="inbox" size={14} /></span>As an attachment</span>
                <span className={cx(s.vd, VERDICT_CLASS[A.v])}><Ico name={A.vicon} size={12} />{A.vlabel}</span>
              </div>
              <div className={s.trk} aria-hidden="true">
                <span className={s.trkE}>You</span>
                <div className={s.trkL}>
                  <span className={s.line} />
                  {A.k === "big" && <span className={s.wall} />}
                  <span className={cx(s.chip, s.chipA, A.k === "big" ? s.back : s.go)}><Ico name={T.icon} size={12} /><span className={s.chipX}>{T.file}</span></span>
                </div>
                <span className={cx(s.trkE, s.trkR)}>{D.short}</span>
              </div>
              <div className={s.sw} aria-hidden="true">
                <div className={frame}>
                  <div className={s.scr}>
                    <div className={s.chrome}><span className={s.pth}>{A.chrome}</span></div>
                    <div className={cx(s.bd, s.arr)}><AttachmentScreen v={v} /></div>
                  </div>
                </div>
              </div>
              <div className={s.nt}>
                <b>{A.title}</b>
                <span className={s.ntX}>{A.text}</span>
                {/* Fair to attachments: the usual outcome, not the only one (size caps and a TV with no mail app have no better app). */}
                {A.v !== "ok" && A.k !== "big" && A.k !== "nowhere" && <div className={s.ntF}><span className={s.ntFine}>The usual result with the apps the device came with. Other apps can do better.</span></div>}
              </div>
            </section>

            <section className={cx(s.lane, s.laneL)} aria-label="As a Markdrop link">
              <div className={s.lnH}>
                <span className={s.lnT}><span className={s.lnIc}><Ico name="link" size={14} /></span>As a Markdrop link</span>
                <span className={cx(s.vd, VERDICT_CLASS[L.v])}><Ico name={L.vicon} size={12} />{L.vlabel}</span>
              </div>
              <div className={s.trk} aria-hidden="true">
                <span className={s.trkE}>You</span>
                <div className={s.trkL}>
                  <span className={s.line} />
                  <span className={cx(s.chip, s.chipL, s.go)}><Ico name="link" size={12} /><span className={s.chipX}>markdrop.in/{L.path}</span></span>
                  {L.v === "ok" && <span className={s.rip} />}
                </div>
                <span className={cx(s.trkE, s.trkR)}>{D.short}</span>
              </div>
              <div className={s.sw} aria-hidden="true">
                <div className={frame}>
                  <div className={s.scr}>
                    <div className={s.chrome}><span className={s.mu}>markdrop.in/</span><span className={s.pth}>{L.path}</span></div>
                    <div className={cx(s.bd, s.arr)}><LinkScreen v={v} /></div>
                  </div>
                </div>
              </div>
              <div className={s.nt}>
                <b>{L.title}</b>
                <span className={s.ntX}>{L.text}</span>
                <div className={s.ntF}>
                  <span className={s.pill}><span className={s.pillIc}><Ico name="link" size={12} /></span><span className={s.mu}>markdrop.in/</span>{L.path}</span>
                  <span className={cx(s.req, L.reqTone === "success" && s.reqOk)}>{L.req}</span>
                </div>
              </div>
            </section>
          </div>
        </div>

        <div className={s.bot}>
          <div className={cx(s.sc, score.fin && s.fin)}>
            <div className={s.scC}>
              <span className={s.scK}>{score.where}</span>
              <span className={s.scL}>{score.lText}</span>
              <span className={s.scA}>{score.aText}</span>
              <span className={s.scG}>{score.goal}</span>
            </div>
            <div className={s.grid} aria-hidden="true">
              <div className={s.gLab}><span>Link</span><span>Attachment</span></div>
              {v.cols.map((c) => (
                <div key={c.id} className={cx(s.col, c.cur && s.cur)}>
                  <span className={s.colE}><span className={s.colDot}>.</span>{c.ext.slice(1)}</span>
                  <span className={cx(s.mk, MARK_CLASS[c.lc])} />
                  <span className={cx(s.mk, MARK_CLASS[c.ac])} />
                </div>
              ))}
            </div>
            <div className={s.lg} aria-hidden="true">
              <span><span className={cx(s.mk, s.mkOk)} />Opened</span>
              <span><span className={cx(s.mk, s.mkPart)} />Opened, not as sent</span>
              <span><span className={cx(s.mk, s.mkFail)} />Did not open</span>
            </div>
          </div>

          <div className={s.cta}>
            <p className={s.ctaK}>Next time, send the link.</p>
            <p className={s.ctaL}>Drop it. <span>It renders.</span></p>
            <div className={s.ctaB}>
              <span className={s.glow}>
                <Link id="cto-start" data-cta="toy_can_they_open_start" href="/new" className="md-btn md-btn--primary md-btn--lg">Start writing<Ico name="arrowRight" size={16} /></Link>
              </span>
              <Link id="cto-upload" data-cta="toy_can_they_open_upload" href="/upload" className="md-btn md-btn--secondary md-btn--lg"><Ico name="upload" size={16} />Upload a file</Link>
            </div>
            <p className={s.ctaNote}>Writing needs no account. Uploading a file needs a free one.</p>
          </div>
        </div>
      </div>

      {v.ghost && (
        <div className={s.ghost} style={{ left: v.ghost.x, top: v.ghost.y }} aria-hidden="true">
          <Ico name={v.ghost.icon} size={14} />{v.ghost.label}
        </div>
      )}
      <p className="sr-only" aria-live="polite">{v.live}</p>
    </div>
  );
}
