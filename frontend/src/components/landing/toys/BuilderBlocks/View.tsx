import type React from "react";
import { ICONS, type IconName } from "@/components/ui/icons";
import { BLOCKS, BY, PITCH, ROOT_ID, TOTAL, derive, type Block, type BlockId, type PreviewMode, type State } from "./model";
import s from "./BuilderBlocks.module.css";

/**
 * Builder Blocks, presentational. No hooks and no "use client": the server renders it with
 * `initialState` and no handlers as the static first frame; Game renders it with handlers.
 * Every focusable control has a stable id so LazyIsland can carry focus across the swap.
 */

export interface Handlers {
  togglePause: () => void;
  startOver: () => void;
  toggleChip: (id: BlockId) => void;
  move: (id: BlockId, dir: -1 | 1, kind: "up" | "dn") => void;
  remove: (id: BlockId) => void;
  gripKey: (e: React.KeyboardEvent<HTMLButtonElement>, id: BlockId) => void;
  gripDown: (e: React.PointerEvent<HTMLButtonElement>, id: BlockId) => void;
  gripMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
  gripUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
  gripCancel: () => void;
  setView: (v: PreviewMode) => void;
  slug: (e: React.ChangeEvent<HTMLInputElement>) => void;
  publish: () => void;
  download: () => void;
  stageFocus: () => void;
  stageBlur: (e: React.FocusEvent<HTMLDivElement>) => void;
}

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

/** The DS icon geometry (components/ui/icons.ts is plain data, safe on the server). */
function I({ name, size }: { name: IconName; size: number }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="md-icon" style={{ fontSize: size }}>
      <path d={ICONS[name]} />
    </svg>
  );
}

function FlowGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <rect x="1" y="2" width="6" height="5" rx="1.5" />
      <rect x="11" y="2" width="6" height="5" rx="1.5" />
      <rect x="6" y="11" width="6" height="5" rx="2.5" />
      <path d="M7 4.5h4M4 7v2.5q0 1 1 1.5l1 .5M14 7v2.5q0 1-1 1.5l-1 .5" />
    </svg>
  );
}

function Tile({ b, size }: { b: Block; size: number }) {
  return (
    <span className={s.tile} aria-hidden="true">
      {b.icon ? <I name={b.icon as IconName} size={size} /> : null}
      {b.glyph === "flow" ? <FlowGlyph size={size + 2} /> : null}
      {b.glyph === "sum" ? <span className={s.sum} style={size < 16 ? { fontSize: 16 } : undefined}>&#8721;</span> : null}
    </span>
  );
}

const TOKEN_CLS: Record<string, string> = { h: s.tH, f: s.tF, c: s.tC, m: s.tM, d: s.tD, l: s.tL, t: s.tT };

/* Rendered README blocks: static, pre-drawn HTML/SVG. No Mermaid or KaTeX on the landing page. */
function Rendered({ id }: { id: BlockId }) {
  switch (id) {
    case "title":
      return (
        <>
          <div className={s.h1}>my-project</div>
          <p className={s.p}>Turn a folder of notes into a site you can share.</p>
        </>
      );
    case "badges":
      return (
        <div className={s.shs}>
          <span className={s.sh}><span className={s.shK}>build</span><span className={cx(s.shV, s.shOk)}>passing</span></span>
          <span className={s.sh}><span className={s.shK}>license</span><span className={cx(s.shV, s.shAc)}>MIT</span></span>
          <span className={s.sh}><span className={s.shK}>version</span><span className={cx(s.shV, s.shNt)}>1.2.0</span></span>
        </div>
      );
    case "install":
      return (
        <>
          <div className={s.hh}>Install</div>
          <pre className={s.pre}><span className={s.pr}>$ </span>npm install my-project</pre>
        </>
      );
    case "usage":
      return (
        <>
          <div className={s.hh}>Usage</div>
          <p className={cx(s.p, s.pLead)}>Build the docs folder into a site:</p>
          <pre className={s.pre}><span className={s.pr}>$ </span>npx my-project build ./docs --out ./site</pre>
        </>
      );
    case "mermaid":
      return (
        <>
          <div className={s.hh}>How it works</div>
          <div className={s.fig}>
            <svg className={s.figWide} viewBox="0 0 460 146" role="img" aria-label="Flowchart: Notes to Build to Site, and Site back to Notes on watch">
              <rect x="8" y="24" width="112" height="44" rx="8" className={s.svgBox} />
              <text x="64" y="51" textAnchor="middle" className={s.svgText}>Notes</text>
              <path d="M120 46H166" className={s.svgEdge} />
              <path d="M164 41L173 46L164 51Z" className={s.svgHead} />
              <rect x="174" y="24" width="112" height="44" rx="8" className={s.svgBuild} />
              <text x="230" y="51" textAnchor="middle" className={s.svgText}>Build</text>
              <path d="M286 46H332" className={s.svgEdge} />
              <path d="M330 41L339 46L330 51Z" className={s.svgHead} />
              <rect x="340" y="24" width="112" height="44" rx="22" className={s.svgSite} />
              <text x="396" y="51" textAnchor="middle" className={s.svgText}>Site</text>
              <path d="M396 68C396 128 64 128 64 78" className={s.svgBack} />
              <path d="M59 80L64 70L69 80Z" className={s.svgHead} />
              <rect x="199" y="103" width="62" height="20" rx="4" className={s.svgLabelBg} />
              <text x="230" y="117" textAnchor="middle" className={s.svgLabel}>watch</text>
            </svg>
            <svg className={s.figTall} viewBox="0 0 240 236" role="img" aria-label="Flowchart: Notes to Build to Site, and Site back to Notes on watch">
              <rect x="40" y="8" width="112" height="44" rx="8" className={s.svgBox} />
              <text x="96" y="35" textAnchor="middle" className={s.svgText}>Notes</text>
              <path d="M96 52V82" className={s.svgEdge} />
              <path d="M91 80L96 89L101 80Z" className={s.svgHead} />
              <rect x="40" y="90" width="112" height="44" rx="8" className={s.svgBuild} />
              <text x="96" y="117" textAnchor="middle" className={s.svgText}>Build</text>
              <path d="M96 134V164" className={s.svgEdge} />
              <path d="M91 162L96 171L101 162Z" className={s.svgHead} />
              <rect x="40" y="172" width="112" height="44" rx="22" className={s.svgSite} />
              <text x="96" y="199" textAnchor="middle" className={s.svgText}>Site</text>
              <path d="M152 194C214 194 214 30 162 30" className={s.svgBack} />
              <path d="M164 25L154 30L164 35Z" className={s.svgHead} />
              <rect x="170" y="102" width="62" height="20" rx="4" className={s.svgLabelBg} />
              <text x="201" y="116" textAnchor="middle" className={s.svgLabel}>watch</text>
            </svg>
          </div>
          <div className={s.by}><I name="info" size={12} />Drawn from text. Rendered by Mermaid on the real page.</div>
        </>
      );
    case "math":
      return (
        <>
          <div className={s.hh}>Ranking</div>
          <p className={cx(s.p, s.pLead)}>Search results are ordered by a weighted score:</p>
          <div className={s.tex} role="img" aria-label="score equals the sum of w i times x i, over the sum of w i">
            <span aria-hidden="true">score</span>
            <span aria-hidden="true">=</span>
            <span className={s.frac} aria-hidden="true">
              <span className={s.fracN}>&#8721;<sub>i</sub> <i>w</i><sub>i</sub><i>x</i><sub>i</sub></span>
              <span className={s.fracD}>&#8721;<sub>i</sub> <i>w</i><sub>i</sub></span>
            </span>
          </div>
          <div className={s.by}><I name="info" size={12} />Written in LaTeX. Typeset by KaTeX on the real page.</div>
        </>
      );
    case "table":
      return (
        <>
          <div className={s.hh}>Options</div>
          <table className={s.tbl}>
            <thead><tr><th>Flag</th><th>Default</th><th>What it does</th></tr></thead>
            <tbody>
              <tr><td><code>--out</code></td><td>./site</td><td>Where the site goes</td></tr>
              <tr><td><code>--watch</code></td><td>off</td><td>Rebuild when files change</td></tr>
              <tr><td><code>--base</code></td><td>/</td><td>Path prefix for links</td></tr>
            </tbody>
          </table>
        </>
      );
    case "license":
      return (
        <>
          <div className={s.hh}>License</div>
          <p className={cx(s.p, s.pFlat)}>MIT. See LICENSE for details.</p>
        </>
      );
  }
}

export default function View({ state, on }: { state: State; on?: Handlers }) {
  const d = derive(state);
  const { stack, drag } = state;
  const inPar = d.par === "a" ? s.inA : s.inB;
  const mvPar = d.par === "a" ? s.mvA : s.mvB;
  const flPar = d.fpar === "a" ? s.flA : s.flB;
  const rendered = state.view === "rendered";

  return (
    <div className={s.root} id={ROOT_ID}>
      {/* Demo control */}
      <div className={s.demoBar}>
        {state.attract ? (
          <span className={s.demoOn}>
            <span className={cx("md-badge md-badge--info", s.badge)}><span className="md-badge__dot" />Demo</span>
            <span className={s.say} aria-hidden="true">{state.demoSay}</span>
            <button type="button" id="bb-pause" className={s.ctl} onClick={on?.togglePause}>
              {state.paused ? "Play demo" : "Pause demo"}
            </button>
          </span>
        ) : null}
        <button type="button" id="bb-start-over" className={cx(s.ctl, s.ghost)} onClick={on?.startOver}>Start over</button>
      </div>

      <div className={s.stage} onFocus={on?.stageFocus} onBlur={on?.stageBlur}>
        {/* Palette */}
        <div className={s.pal}>
          <div className={s.colh}>
            <h3 id="bb-pal-h">Blocks</h3>
            <span className={s.cap}>Click to add, again to remove</span>
          </div>
          <div className={s.chips} role="group" aria-labelledby="bb-pal-h">
            {BLOCKS.map((b) => {
              const isOn = stack.includes(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  id={`bb-chip-${b.id}`}
                  className={cx(s.chip, isOn && s.on, d.demoId === b.id && s.ring)}
                  aria-pressed={isOn}
                  onClick={on ? () => on.toggleChip(b.id) : undefined}
                >
                  <Tile b={b} size={16} />
                  <span className={s.ct}>
                    <span className={s.cl}>{b.label}</span>
                    <span className={s.cs}>{b.sub}</span>
                  </span>
                  <span className={s.cst} aria-hidden="true"><I name={isOn ? "check" : "plus"} size={14} /></span>
                </button>
              );
            })}
          </div>
          <p className={s.note}>Each block is a section template in the real builder. Diagrams and math are written as text, then drawn on the page.</p>
        </div>

        {/* Stack */}
        <div className={s.tray}>
          <div className={cx(s.colh, s.trayHead)}>
            <h3 id="bb-stk-h">Your README</h3>
            <span className={s.count}>
              <span><b>{d.used}</b> of {TOTAL} blocks used</span>
              <span className={s.pips} aria-hidden="true">
                {BLOCKS.map((b, i) => <span key={b.id} className={cx(s.pip, i < d.used && s.pipOn)} />)}
              </span>
            </span>
          </div>
          <div className={cx(s.list, drag && s.dragging)} role="group" aria-labelledby="bb-stk-h">
            {d.isEmpty ? (
              <div className={s.empty}><b>Your README is empty</b><span>Add a block from the left. Title is a good first one.</span></div>
            ) : null}
            {stack.map((id, i) => {
              const b = BY[id];
              let cls = s.row;
              let style: React.CSSProperties | undefined;
              if (drag) {
                if (id === drag.id) {
                  cls = cx(cls, s.lift);
                  style = { transform: `translateY(${Math.round(drag.dy)}px) scale(1.02)` };
                } else {
                  let sh = 0;
                  if (drag.from < drag.to && i > drag.from && i <= drag.to) sh = -PITCH;
                  if (drag.to < drag.from && i >= drag.to && i < drag.from) sh = PITCH;
                  style = { transform: `translateY(${sh}px)` };
                }
              } else {
                const f = state.anim.from[id];
                if (f) {
                  cls = cx(cls, mvPar);
                  style = { ["--from" as string]: `${f}px` } as React.CSSProperties;
                } else if (state.anim.inId === id) {
                  cls = cx(cls, inPar);
                }
              }
              if (d.demoId === id) cls = cx(cls, s.ring);
              return (
                <div key={id} className={cls} style={style} data-row={id}>
                  <button
                    type="button"
                    id={`bb-grip-${id}`}
                    className={s.grip}
                    aria-label={`Reorder ${b.label}, position ${i + 1} of ${d.used}. Use arrow up and arrow down.`}
                    onKeyDown={on ? (e) => on.gripKey(e, id) : undefined}
                    onPointerDown={on ? (e) => on.gripDown(e, id) : undefined}
                    onPointerMove={on?.gripMove}
                    onPointerUp={on?.gripUp}
                    onPointerCancel={on?.gripCancel}
                  >
                    <span className={s.dots} aria-hidden="true"><span /><span /><span /><span /><span /><span /></span>
                  </button>
                  <Tile b={b} size={14} />
                  <span className={s.rl}>
                    <span className={s.rlText}>{b.label}</span>
                    {/* The tag names the renderer; skip it when the label already does ("Mermaid diagram"), where the board clips it to "Merm". */}
                    {b.tag && !b.label.includes(b.tag) ? <span className={s.rtag}>{b.tag}</span> : null}
                  </span>
                  <button
                    type="button"
                    id={`bb-up-${id}`}
                    className={s.ib}
                    aria-label={`Move ${b.label} up`}
                    aria-disabled={i === 0}
                    onClick={on ? () => on.move(id, -1, "up") : undefined}
                  >
                    <I name="chevronUp" size={16} />
                  </button>
                  <button
                    type="button"
                    id={`bb-dn-${id}`}
                    className={s.ib}
                    aria-label={`Move ${b.label} down`}
                    aria-disabled={i === d.used - 1}
                    onClick={on ? () => on.move(id, 1, "dn") : undefined}
                  >
                    <I name="chevronDown" size={16} />
                  </button>
                  <button
                    type="button"
                    id={`bb-rm-${id}`}
                    className={cx(s.ib, s.rm)}
                    aria-label={`Remove ${b.label}`}
                    onClick={on ? () => on.remove(id) : undefined}
                  >
                    <I name="x" size={16} />
                  </button>
                </div>
              );
            })}
          </div>
          <div
            className={cx(s.checks, d.done && s.checksDone, state.cheer > 0 && d.done && (state.cheer % 2 ? s.cheerA : s.cheerB))}
            role="group"
            aria-label="README checklist"
          >
            {d.checks.map((c) => (
              <span key={c.t} className={cx(s.ck, c.ok && s.ckOk)}>
                <I name={c.ok ? "check" : "minus"} size={12} />
                {c.t}
                <span className={s.sr}>{c.ok ? ", done" : ", not yet"}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Preview */}
        <div className={s.pv}>
          <div className={s.pvtop}>
            <div className={s.seg} role="group" aria-label="Preview mode">
              <button type="button" id="bb-seg-rendered" className={s.sg} aria-pressed={rendered} onClick={on ? () => on.setView("rendered") : undefined}>
                Rendered
              </button>
              <button type="button" id="bb-seg-source" className={s.sg} aria-pressed={!rendered} onClick={on ? () => on.setView("source") : undefined}>
                Markdown source
              </button>
            </div>
            <span className={cx("md-badge md-badge--neutral", s.badge)}>Live preview</span>
          </div>

          <div className={s.page}>
            <div className={s.chrome} aria-hidden="true">
              <span className={s.chromeDots}><span /><span /><span /></span>
              <span>README.md</span>
              <span className={s.chromeR}>{d.lineText}</span>
            </div>
            <div
              id="bb-body"
              className={s.body}
              tabIndex={0}
              role="region"
              aria-label={rendered ? "Rendered README preview" : "Markdown source of README.md"}
            >
              {rendered ? (
                <>
                  {d.isEmpty ? <div className={s.none}><b>Nothing to render yet</b><span>Add a block and it shows up here.</span></div> : null}
                  <div className={s.md}>
                    {stack.map((id) => (
                      <div key={id} className={cx(s.pvb, state.flash.id === id && flPar)} data-pv={id}>
                        <Rendered id={id} />
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {d.isEmpty ? <div className={s.none}><b>README.md is empty</b><span>Add a block to write its Markdown.</span></div> : null}
                  <div className={s.src}>
                    {d.lines.map((l) => (
                      <div
                        key={l.n}
                        className={cx(s.ln, l.tk && TOKEN_CLS[l.tk], l.blk && state.flash.id === l.blk && flPar)}
                        data-pv={l.first ?? undefined}
                      >
                        <span className={s.no}>{l.n}</span>
                        <span className={s.tx}>{l.t}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className={s.out}>
            <div className={s.orow}>
              <label htmlFor="bb-slug" className={s.sr}>Link name</label>
              <div className={cx(s.field, state.pub && s.lock)}>
                <span className={s.preHost} aria-hidden="true">markdrop.in/</span>
                <input
                  id="bb-slug"
                  className={s.in}
                  type="text"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={state.slug}
                  onChange={on?.slug}
                  readOnly={!on}
                  aria-describedby="bb-slug-hint"
                />
              </div>
              <button
                type="button"
                id="bb-publish"
                className={cx("md-btn md-btn--primary md-btn--md", s.pub, d.pubGlow && s.glow)}
                onClick={on?.publish}
              >
                <I name="upload" size={16} />
                {d.pubText}
              </button>
            </div>
            <div className={cx(s.res, d.resKind === "live" && s.resLive, d.resKind === "warn" && s.resWarn)} id="bb-slug-hint">
              {d.resKind === "idle" ? (
                <>
                  <span className={s.ic}><I name="link" size={16} /></span>
                  <span className={s.resText}>{d.resLead} <span className={s.url}>markdrop.in/<b>{d.shownSlug}</b></span></span>
                </>
              ) : null}
              {d.resKind === "warn" ? (
                <>
                  <span className={s.ic}><I name="alert" size={16} /></span>
                  <span className={s.resText}>{state.msg}</span>
                </>
              ) : null}
              {d.resKind === "live" ? (
                <>
                  <span className={cx(s.dropw, s.ic)} aria-hidden="true">
                    <I name="globe" size={16} />
                    <span className={cx(s.drop, state.ripple > 0 && (d.rp === "a" ? s.dropA : s.dropB))} />
                    <span className={cx(s.rip, state.ripple > 0 && (d.rp === "a" ? s.ripA : s.ripB))} />
                  </span>
                  <span className={s.url}>markdrop.in/<b>{d.shownSlug}</b></span>
                  <span className={s.resR}>
                    <span className={s.resCap}>Edit later, same link</span>
                    <span className={cx("md-badge md-badge--success", s.badge)}><span className="md-badge__dot" />Live</span>
                  </span>
                </>
              ) : null}
              {d.resKind === "stale" ? (
                <>
                  <span className={s.ic}><I name="globe" size={16} /></span>
                  <span className={s.url}>markdrop.in/<b>{d.shownSlug}</b></span>
                  <span className={s.resR}>
                    <span className={cx("md-badge md-badge--warning", s.badge)}>Changes not published</span>
                  </span>
                </>
              ) : null}
            </div>
            <div className={cx(s.orow, s.orowWrap)}>
              <button
                type="button"
                id="bb-download"
                className={s.mock}
                aria-disabled="true"
                aria-describedby="bb-mnote"
                onClick={on?.download}
              >
                <I name="download" size={16} />
                Download README.md
              </button>
              <span className={s.mnote} id="bb-mnote">{state.mockNote}</span>
            </div>
          </div>
        </div>
      </div>

      <p className={s.sr} aria-live="polite">{state.live}{state.liveN % 2 ? " " : ""}</p>
    </div>
  );
}
