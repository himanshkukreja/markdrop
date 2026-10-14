import type { KeyboardEvent, ReactNode } from "react";
import { ICONS } from "@/components/ui/icons";
import { DOC_HOST, DOC_PATH, EXTENSION_URL, deriveView, type Block, type State, type Tone } from "./model";
import s from "./SyncDesk.module.css";

/**
 * Sync Desk, presentational only (no hooks, no "use client"): the server renders it with no handlers
 * as the static first frame, and the client Game renders it with handlers. Every focusable control
 * has a stable id so LazyIsland can hand focus from the poster to the game.
 */

export interface Handlers {
  type: (value: string) => void;
  edKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  edFocus: () => void;
  edScroll: (top: number) => void;
  keepMine: () => void;
  useWeb: () => void;
  mergeManual: () => void;
  backToDiff: () => void;
  saveMerge: () => void;
  toggleDemo: () => void;
  webEdit: () => void;
  editBoth: () => void;
}

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

/* Local glyphs: the DS component modules use client hooks, so this server-rendered view draws the
   same icon paths (components/ui/icons.ts, plain data) and the same marks inline. */
function Glyph({ name, size }: { name: keyof typeof ICONS; size: number }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="md-icon" style={{ fontSize: size }}>
      <path d={ICONS[name]} />
    </svg>
  );
}

function VSCodeGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M17.583 2.25 9.21 10.313 4.2 6.52 2 7.58v8.84l2.2 1.06 5.01-3.793 8.373 8.063L22 19.79V4.21l-4.417-1.96zM4.2 13.98V10.02L6.6 12l-2.4 1.98zm13.383 2.19L12.28 12l5.303-4.17v8.34z" />
    </svg>
  );
}

function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--logo-ground)" />
      <text x="3" y="23" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontSize="18" fontWeight="700" fill="var(--logo-ink)">
        m
      </text>
      <circle cx="27" cy="20" r="4" fill="var(--logo-dot)" />
    </svg>
  );
}

const TONE: Record<Tone, string> = { ok: s.ok, busy: s.busy, warn: s.warn, idle: "" };
const FLY: Record<"" | "a" | "b", string> = { "": "", a: s.fa, b: s.fb };
const HIT: Record<"" | "a" | "b", string> = { "": "", a: s.hitA, b: s.hitB };
const BLOCK: Record<Block["kind"], string> = { h1: s.pgH1, h2: s.pgH2, h3: s.pgH3, li: s.pgLi, p: s.pgP, gap: s.pgGap, empty: cx(s.pgP, s.pgEmpty) };

function Segs({ block }: { block: Block }): ReactNode {
  return block.segs.map((g, i) => (
    <span key={i} className={g.k === "b" ? s.b : g.k === "cd" ? s.cd : undefined}>
      {g.t}
    </span>
  ));
}

export default function View({ state, on }: { state: State; on?: Handlers }) {
  const v = deriveView(state);
  const busyAttr = v.busy ? "true" : "false";

  return (
    <div className={s.sd}>
      <div className={s.head}>
        <header className={s.hd}>
          <p className={s.eb}>
            <VSCodeGlyph size={14} />
            VS Code sync
          </p>
          <h2 id="sync-desk-title" className={s.h2x}>
            Edit in VS Code. The page keeps up.
          </h2>
          <p className={s.lead}>Publish a markdown file from your editor and keep working there. Save, and the page updates. Edit on the web, and your file updates.</p>
        </header>

        <div className={cx(s.goal, v.goal.done && s.done)} role="group" aria-labelledby="sd-goal-h">
          <p className={s.goalH}>
            <span id="sd-goal-h">Sync three ways</span>
            <span className={s.goalN}>{v.goal.count}</span>
          </p>
          <div className={s.goalBar} aria-hidden="true">
            <span style={{ width: v.goal.pct + "%" }} />
          </div>
          <ul className={s.goalL}>
            {v.goal.items.map((g) => (
              <li key={g.key} className={cx(s.gi, g.on && s.on)}>
                <span className={s.ck} aria-hidden="true">
                  <Glyph name="check" size={12} />
                </span>
                <span>{g.label}</span>
                <span className={s.sr}>{g.on ? ", done" : ", not yet"}</span>
              </li>
            ))}
          </ul>
          <p className={s.goalF}>{v.goal.caption}</p>
        </div>
      </div>

      <div id="sd-stage" className={s.stage}>
        {/* VS Code window */}
        <div className={cx(s.win, s.winEd, HIT[v.edHit])} role="group" aria-label="VS Code window editing roadmap.md">
          <div className={s.tb}>
            <span className={s.dots} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className={s.tbT}>
              <VSCodeGlyph size={14} />
              roadmap.md · q4-plan
            </span>
          </div>
          <div className={s.body}>
            <div className={s.act} aria-hidden="true">
              <span className={s.ai}>
                <Glyph name="doc" size={20} />
              </span>
              <span className={s.ai}>
                <Glyph name="search" size={20} />
              </span>
              <span className={s.ai}>
                <Glyph name="code" size={20} />
              </span>
              <span className={cx(s.ai, s.on)}>
                <Mark size={20} />
              </span>
            </div>
            <div className={s.main}>
              <div className={s.tabs}>
                <div className={s.tab}>
                  <span className={s.tabI} aria-hidden="true">
                    <Glyph name="lines" size={14} />
                  </span>
                  roadmap.md
                  {v.tabDirty ? (
                    <span className={s.dd} role="img" aria-label="Unsaved changes" />
                  ) : (
                    <span className={s.tx} aria-hidden="true">
                      <Glyph name="x" size={12} />
                    </span>
                  )}
                </div>
                <div className={s.tabR}>
                  {v.edNote ? (
                    <span className={s.note}>{v.edNote}</span>
                  ) : (
                    <span className={s.lk}>
                      <Glyph name="link" size={12} />
                      <span className={s.lkT}>
                        {DOC_HOST}
                        {DOC_PATH}
                      </span>
                    </span>
                  )}
                </div>
              </div>

              {v.merge && (
                <div className={s.mb}>
                  <span className={s.mbT}>
                    <b>Merging.</b> Both versions are in the file. Keep what you want, then save.
                  </span>
                  <button type="button" id="sd-back" className={cx(s.btn, s.gh)} onClick={on?.backToDiff}>
                    Back to the diff
                  </button>
                  <button type="button" id="sd-save-merge" className={cx(s.btn, s.pri)} onClick={on?.saveMerge}>
                    Save merge
                  </button>
                </div>
              )}

              {v.showEd && (
                <div className={s.area}>
                  <div className={s.gut} aria-hidden="true">
                    <div className={s.gutIn} style={v.scrollTop ? { transform: `translateY(-${v.scrollTop}px)` } : undefined}>
                      {Array.from({ length: v.gut }, (_, i) => (
                        <span key={i}>{i + 1}</span>
                      ))}
                    </div>
                  </div>
                  <label htmlFor="sd-editor" className={s.sr}>
                    roadmap.md, markdown you can edit
                  </label>
                  <textarea
                    id="sd-editor"
                    className={s.ta}
                    spellCheck={false}
                    wrap="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    value={v.ed}
                    readOnly={!on}
                    onChange={on ? (e) => on.type(e.target.value) : undefined}
                    onKeyDown={on?.edKey}
                    onFocus={on?.edFocus}
                    onScroll={on ? (e) => on.edScroll(e.currentTarget.scrollTop) : undefined}
                  />
                </div>
              )}

              {v.showDiff && (
                <div className={s.df} role="region" aria-label="Conflict in roadmap.md">
                  <div className={s.dfH}>
                    <span className={s.dfIc}>
                      <Glyph name="alert" size={16} />
                    </span>
                    <div>
                      <div className={s.dfT}>roadmap.md changed in VS Code and on the web</div>
                      <div className={s.dfS}>{v.df.sub}</div>
                    </div>
                  </div>
                  <div className={s.dfCh}>
                    <span>
                      <i className={cx(s.kd, s.kdMine)} aria-hidden="true" />
                      <span className={s.dfChT}>Yours · VS Code</span>
                    </span>
                    <span>
                      <i className={cx(s.kd, s.kdWeb)} aria-hidden="true" />
                      <span className={s.dfChT}>
                        Web · {DOC_HOST}
                        {DOC_PATH}
                      </span>
                    </span>
                  </div>
                  <div id="sd-diff" className={s.dfB} tabIndex={0} role="group" aria-label="Line by line, yours on the left, web on the right">
                    {v.df.rows.map((r, i) => (
                      <div key={i} className={s.dr} data-changed={r.lk !== "same" || undefined}>
                        <span className={cx(s.dl, r.lk === "mine" && s.mine, r.lk === "pad" && s.pad)} aria-hidden={r.lk === "pad" || undefined}>
                          {r.lk === "mine" && <span className={s.sr}>Yours only: </span>}
                          {r.l}
                        </span>
                        <span className={cx(s.dl, r.rk === "web" && s.web, r.rk === "pad" && s.pad)} aria-hidden={r.rk === "pad" || r.rk === "same" || undefined}>
                          {r.rk === "web" && <span className={s.sr}>Web only: </span>}
                          {r.r}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className={s.dfA}>
                    <button type="button" id="sd-keep" className={s.btn} onClick={on?.keepMine}>
                      <i className={cx(s.kd, s.kdMine)} aria-hidden="true" />
                      Keep mine
                    </button>
                    <button type="button" id="sd-use-web" className={s.btn} onClick={on?.useWeb}>
                      <i className={cx(s.kd, s.kdWeb)} aria-hidden="true" />
                      Use web
                    </button>
                    <button type="button" id="sd-merge" className={s.btn} onClick={on?.mergeManual}>
                      <span className={s.bi}>
                        <Glyph name="edit" size={14} />
                      </span>
                      Merge manually
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className={s.sb}>
            <span className={s.sbVs} aria-hidden="true">
              <VSCodeGlyph size={12} />
            </span>
            <span className={cx(s.sbi, TONE[v.sb.tone])}>
              <Mark size={12} />
              <span className={s.sdot} aria-hidden="true" />
              {v.sb.text}
            </span>
            <span className={s.sbSp} />
            <span className={s.sbLang}>Markdown</span>
            <span>{v.sb.ln}</span>
          </div>
        </div>

        {/* Channel between the two windows (decorative; the status bar and announcements carry the meaning) */}
        <div className={s.ch} aria-hidden="true">
          <div className={s.halo} />
          <div className={cx(s.chl, s.chlUp)}>
            <b>Save in VS Code</b>
            <span>file to page</span>
          </div>
          <svg className={s.chSvg} width="192" height="452" viewBox="0 0 192 452" focusable="false">
            <path className={cx(s.arc, v.arcUp && s.on)} d="M 4 176 C 56 92 136 92 188 176" />
            <path className={cx(s.arc, v.arcDn && s.on)} d="M 188 276 C 136 360 56 360 4 276" />
            <circle className={s.port} cx="4" cy="176" r="3.5" />
            <circle className={s.port} cx="188" cy="176" r="3.5" />
            <circle className={s.port} cx="4" cy="276" r="3.5" />
            <circle className={s.port} cx="188" cy="276" r="3.5" />
          </svg>
          <svg className={cx(s.lane, s.laneL)} focusable="false">
            <line className={cx(s.arc, v.arcUp && s.on)} x1="1" y1="0" x2="1" y2="100%" />
          </svg>
          <svg className={cx(s.lane, s.laneR)} focusable="false">
            <line className={cx(s.arc, v.arcDn && s.on)} x1="1" y1="100%" x2="1" y2="0" />
          </svg>
          <div className={cx(s.drop, s.dropUp, FLY[v.drops.up])}>
            <i />
          </div>
          <div className={cx(s.drop, s.dropDn, FLY[v.drops.dn])}>
            <i />
          </div>
          <div className={cx(s.drop, s.dropCl, FLY[v.drops.cl])}>
            <i />
          </div>
          <div className={cx(s.drop, s.dropCr, FLY[v.drops.cl])}>
            <i />
          </div>
          <div className={cx(s.hub, v.hub.tone === "busy" && s.busy, v.hub.tone === "warn" && s.warn, v.hub.fx && s[v.hub.fx])}>
            <span className={s.hubK}>Page</span>
            <span className={s.hubN}>
              rev {v.hub.from}
              {v.hub.moving && (
                <>
                  <span className={s.hubAr}>→</span>
                  <span className={s.hubTo}>{v.hub.to}</span>
                </>
              )}
            </span>
          </div>
          <div className={cx(s.hubSt, TONE[v.hub.tone])}>
            <span className={s.sdot} />
            {v.hub.st}
          </div>
          <div className={cx(s.chl, s.chlDn)}>
            <b>Edit on the web</b>
            <span>page to file</span>
          </div>
        </div>

        {/* Published page */}
        <div className={cx(s.win, s.winBr, HIT[v.brHit])} role="group" aria-label={`Published page at ${DOC_HOST}${DOC_PATH}`}>
          <div className={s.chr}>
            <span className={s.dots} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div className={s.addr}>
              <span className={s.ic} aria-hidden="true">
                <Glyph name="globe" size={12} />
              </span>
              <span className={s.host}>{DOC_HOST}</span>
              <span>{DOC_PATH}</span>
            </div>
            <span className={s.livep}>
              <span className={cx(s.ld, v.liveDot && s.pulse)} aria-hidden="true" />
              Live
            </span>
          </div>
          <div className={s.pg} tabIndex={0} role="group" aria-label="Page content">
            {v.pgWarn && (
              <div className={s.pw}>
                <Glyph name="alert" size={14} />
                Changed in two places. Resolve it in VS Code.
              </div>
            )}
            {v.blocks.map((bl, i) =>
              bl.kind === "gap" ? (
                <div key={i} className={s.pgGap} />
              ) : (
                <div key={i} className={cx(BLOCK[bl.kind], bl.fresh && s.fresh)}>
                  {bl.kind === "li" && <span className={s.bul} aria-hidden="true" />}
                  <span className={s.bt}>
                    <Segs block={bl} />
                  </span>
                </div>
              ),
            )}
          </div>
          <div className={s.pf}>
            <span className={s.pfR}>rev {v.rev}</span>
            <span aria-hidden="true">·</span>
            <span>{v.pageSrc}</span>
            <span className={s.pfSp} />
            <span className={s.pfV}>
              <VSCodeGlyph size={12} />
              {v.pfSync}
            </span>
          </div>
        </div>

        <div className={s.hint}>
          <p>
            Type in roadmap.md. Here it saves 800 ms after you stop typing, or press{" "}
            <span className={s.nw}>
              <kbd className="md-kbd">⌘</kbd> <kbd className="md-kbd">S</kbd>
            </span>{" "}
            <span className={s.nw}>
              (<kbd className="md-kbd">Ctrl</kbd> <kbd className="md-kbd">S</kbd>
            </span>{" "}
            on Windows) to save now.
          </p>
          <p className={s.hintS}>In VS Code, the page updates each time you save the file.</p>
        </div>

        <div className={s.demo}>
          <button type="button" id="sd-demo" className={cx(s.btn, s.gh)} onClick={on?.toggleDemo}>
            <span className={v.demo.playing ? s.gPause : s.gPlay} aria-hidden="true" />
            {v.demo.label}
          </button>
        </div>

        <div className={s.acts}>
          <button type="button" id="sd-web-edit" className={s.btn} aria-disabled={busyAttr} onClick={on?.webEdit}>
            <span className={s.bi}>
              <Glyph name="globe" size={16} />
            </span>
            Edit on the web
          </button>
          <button type="button" id="sd-edit-both" className={s.btn} aria-disabled={busyAttr} onClick={on?.editBoth}>
            <span className={s.bi}>
              <Glyph name="zap" size={16} />
            </span>
            Edit both at once
          </button>
          <p className={s.actsS}>Change the page, or change both sides at once to see what happens in a conflict.</p>
        </div>
      </div>

      <div className={s.rule} aria-hidden="true" />
      <div className={s.cta}>
        <div className={s.ctaRow}>
          <span className={s.ctaB}>
            <a id="sd-get-extension" data-cta="toy_sync_desk_extension" className="md-btn md-btn--primary md-btn--lg" href={EXTENSION_URL} target="_blank" rel="noopener noreferrer">
              Get the extension
              <Glyph name="external" size={16} />
              <span className={s.sr}> (opens in a new tab)</span>
            </a>
          </span>
          <span className="md-badge md-badge--info">
            <Glyph name="user" size={12} />
            Free account
          </span>
        </div>
        <p className={s.ctaT}>
          Publish from the editor, then keep writing. Every page gets a link like <span className={s.mono}>markdrop.in/your-slug</span>.
        </p>
        <a id="sd-publish-web" data-cta="toy_sync_desk_web" className={cx("md-btn md-btn--ghost md-btn--lg", s.ctaGhost)} href="/new">
          Publish on the web
        </a>
      </div>

      <div className={s.sr} aria-live="polite">
        {v.live}
      </div>
    </div>
  );
}
