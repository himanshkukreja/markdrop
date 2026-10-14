import { ICONS } from "@/components/ui/icons";
import s from "./LinkForge.module.css";
import {
  COPY,
  PW_MAX,
  SLUG_MAX,
  deriveView,
  ghostState,
  type DestId,
  type ExpId,
  type State,
  type TabId,
  type Tone,
  type ViewModel,
} from "./model";

/**
 * Link Forge, presentational. No hooks and no "use client": the server renders it with no handlers
 * as the static first frame, and the client Game renders it with handlers. Every focusable control
 * has a stable id, so LazyIsland can move focus from the poster to the same control in the game.
 */

export interface Handlers {
  togglePause: () => void;
  /** Pointer down on the stage (board `takeOver`); touch is ignored so scrolling never stops the demo. */
  stagePointerDown: (pointerType: string) => void;
  /** A click or tap on the stage. */
  takeOver: () => void;
  pickDest: (id: DestId) => void;
  slugInput: (raw: string) => void;
  slugEnter: () => void;
  useSuggestion: () => void;
  flipPw: () => void;
  pwInput: (v: string) => void;
  togglePwShow: () => void;
  pickExp: (id: ExpId) => void;
  dateChange: (v: string) => void;
  flipEnc: () => void;
  copy: () => void;
  pickTab: (id: TabId) => void;
}

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

const TONE: Record<Tone, string | undefined> = { "": undefined, ok: s.ok, warn: s.warn, bad: s.bad };
const TAG_TONE = { "": undefined, enc: s.tEnc, dom: s.tDom, off: s.tOff, warn: s.tWarn } as const;

/** The design-system line icon (24px grid, 1.8 stroke), drawn locally so this file stays server-safe. */
export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const d = (ICONS as Record<string, string>)[name] ?? "";
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className={cx(s.icon, className)}>
      <path d={d} />
    </svg>
  );
}

/** MarkdropMark (logo colours are fixed tokens; the mark never inverts). */
function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={s.mark}>
      <rect width="32" height="32" rx="8" fill="var(--logo-ground)" />
      <text x="3" y="23" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontSize="18" fontWeight="700" fill="var(--logo-ink)">
        m
      </text>
      <circle cx="27" cy="20" r="4" fill="var(--logo-dot)" />
    </svg>
  );
}

/** The settings card. `ghost` renders the tallest state invisibly, under the real card, to reserve its height. */
function Card({ vm, on, ghost }: { vm: ViewModel; on?: Handlers; ghost?: boolean }) {
  const id = (x: string) => (ghost ? undefined : x);
  const h = ghost ? undefined : on;
  return (
    <div className={cx(s.card, ghost && s.ghost)} aria-hidden={ghost || undefined} inert={ghost || undefined}>
      <div className={s.sec}>
        <div className={s.lab} id={id("lf-dest-l")}>
          Where it lives <small>Workspaces bring your own domain</small>
        </div>
        <div className={s.seg} role="group" aria-labelledby={id("lf-dest-l")}>
          {vm.dests.map((dd) => (
            <button
              key={dd.id}
              id={id("lf-dest-" + dd.id)}
              type="button"
              className={s.segb}
              aria-pressed={dd.pressed}
              onClick={h ? () => h.pickDest(dd.id) : undefined}
            >
              <span className={s.segi}>
                <Icon name={dd.icon} size={18} />
              </span>
              <span className={s.segtx}>
                <span className={s.segt}>{dd.title}</span>
                <span className={s.segm}>{dd.meta}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className={s.sec}>
        <label className={s.lab} htmlFor={id("lf-slug")}>
          Link name <small>{vm.slugCount}</small>
        </label>
        <div className={cx(s.slug, TONE[vm.slugTone])}>
          <span className={cx(s.pre, vm.ws && s.preLong)} aria-hidden="true">
            <span className={s.preHost}>{vm.host}</span>
            <span className={s.preDots}>…</span>
            {vm.prefix}
          </span>
          <input
            id={id("lf-slug")}
            className={s.in}
            type="text"
            value={vm.slug}
            placeholder="leave blank for a random one"
            maxLength={SLUG_MAX}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={id("lf-slug-st")}
            aria-invalid={vm.slugTone === "bad" || undefined}
            readOnly={!h}
            onChange={h ? (e) => h.slugInput(e.currentTarget.value) : undefined}
            onKeyDown={
              h
                ? (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      h.slugEnter();
                    }
                  }
                : undefined
            }
          />
        </div>
        <div id={id("lf-slug-st")} className={cx(s.st, TONE[vm.st.tone])}>
          <span className={s.stI}>
            <Icon name={vm.st.icon} size={14} />
          </span>
          <span>{vm.st.text}</span>
          {vm.st.sug ? (
            <button id={id("lf-sug")} type="button" className={s.sug} onClick={h?.useSuggestion}>
              Use {vm.st.sug}
            </button>
          ) : null}
        </div>
      </div>

      <div className={cx(s.sec, s.div)}>
        <div className={s.row}>
          <div className={s.tx}>
            <span className={s.txb} id={id("lf-pw-l")}>
              Password
            </span>
            <span className={cx(s.txs, vm.pw.subDim && s.dim)}>{vm.pw.sub}</span>
          </div>
          <button
            id={id("lf-pw-sw")}
            type="button"
            className={s.sw}
            role="switch"
            aria-checked={vm.pw.on}
            aria-labelledby={id("lf-pw-l")}
            onClick={h?.flipPw}
          >
            <span className={s.tr}>
              <span className={s.th} />
            </span>
          </button>
        </div>
        {vm.pw.on ? (
          <div>
            <div className={s.pwRow}>
              <label className={s.sr} htmlFor={id("lf-pw")}>
                Password for this link
              </label>
              <input
                id={id("lf-pw")}
                className={s.field}
                type={vm.pw.show ? "text" : "password"}
                value={vm.pw.val}
                placeholder="choose a password"
                maxLength={PW_MAX}
                autoComplete="off"
                data-1p-ignore=""
                data-lpignore="true"
                readOnly={!h}
                onChange={h ? (e) => h.pwInput(e.currentTarget.value) : undefined}
              />
              <button
                id={id("lf-pw-show")}
                type="button"
                className={s.ghostBtn}
                aria-label={vm.pw.show ? "Hide password" : "Show password"}
                onClick={h?.togglePwShow}
              >
                <Icon name={vm.pw.show ? "eyeOff" : "eye"} size={14} />
                {vm.pw.show ? "Hide" : "Show"}
              </button>
            </div>
            <div className={cx(s.hint, vm.pw.hintDim && s.dim)}>{vm.pw.hint}</div>
          </div>
        ) : null}
      </div>

      <div className={cx(s.sec, s.div)}>
        <div className={s.lab} id={id("lf-exp-l")}>
          Expires <small>{vm.expLab}</small>
        </div>
        <div className={s.chips} role="group" aria-labelledby={id("lf-exp-l")}>
          {vm.chips.map((ch) => (
            <button
              key={ch.id}
              id={id("lf-exp-" + ch.id)}
              type="button"
              className={s.chip}
              aria-pressed={ch.pressed}
              onClick={h ? () => h.pickExp(ch.id) : undefined}
            >
              {ch.label}
            </button>
          ))}
        </div>
        {vm.expCustom ? (
          <div className={s.date}>
            <label htmlFor={id("lf-date")}>Stops working on</label>
            <input
              id={id("lf-date")}
              className={s.field}
              type="date"
              min={vm.minDate}
              value={vm.date}
              readOnly={!h}
              onChange={h ? (e) => h.dateChange(e.currentTarget.value) : undefined}
            />
          </div>
        ) : null}
      </div>

      <div className={cx(s.sec, s.div)}>
        <div className={s.row}>
          <div className={s.tx}>
            <span className={s.txb} id={id("lf-enc-l")}>
              Encrypt in this browser
            </span>
            <span className={s.txs}>AES-256-GCM for documents. The key goes in the link after the #.</span>
          </div>
          <button
            id={id("lf-enc-sw")}
            type="button"
            className={s.sw}
            role="switch"
            aria-checked={vm.enc}
            aria-labelledby={id("lf-enc-l")}
            onClick={h?.flipEnc}
          >
            <span className={s.tr}>
              <span className={s.th} />
            </span>
          </button>
        </div>
        {vm.enc ? (
          <div className={s.encW}>
            <span className={s.encWi}>
              <Icon name="alert" size={14} />
            </span>
            <span>
              <b>The link is the key.</b> Lose it and the document is gone. Logging in does not unlock it.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The tallest card, computed once: it only reserves space. */
const GHOST_VM = deriveView(ghostState);

export default function View({ state, on }: { state: State; on?: Handlers }) {
  const vm = deriveView(state);
  const { pill, copy, cv } = vm;
  return (
    <div id="lf-toy" className={s.toy} data-attract={vm.attract ? "" : undefined}>
      <div className={s.head}>
        <div className={s.copyCol}>
          <span className={s.eyebrow}>
            <Icon name="link" size={14} />
            {COPY.eyebrow}
          </span>
          <h2 id="lf-h2" className={s.h2}>
            {COPY.title}
          </h2>
          <p className={s.lead}>{COPY.lead}</p>
        </div>

        <div className={s.side}>
          <div className={s.corner}>
            {vm.sayOn ? (
              <span className={s.say} aria-hidden="true">
                {vm.say}
              </span>
            ) : null}
            <button id="lf-pp" type="button" className={s.pp} onClick={on?.togglePause}>
              <span className={cx(s.dot, vm.running && s.dotRun)} aria-hidden="true" />
              {vm.ppText}
            </button>
          </div>

          <div className={s.meter} role="group" aria-label="Forged link shapes">
            <div className={s.count}>
              <span className={cx(s.num, vm.meter.parity === "a" && s.ca, vm.meter.parity === "b" && s.cb)}>{vm.meter.n}</span>
              <span className={s.numl}>Forged</span>
            </div>
            <div className={s.mr}>
              <div className={s.stamps}>
                {vm.meter.stamps.map((sp) => (
                  <span key={sp.id} className={cx(s.stamp, sp.on && s.stampOn)}>
                    {sp.on ? <Icon name="check" size={12} /> : null}
                    {sp.label}
                    <span className={s.sr}>{sp.srText}</span>
                  </span>
                ))}
              </div>
              <div className={cx(s.mh, vm.meter.done && s.mhDone)}>{vm.meter.hint}</div>
            </div>
          </div>
        </div>
      </div>

      <div
        id="lf-stage"
        className={s.stage}
        data-lf-stage=""
        onPointerDown={on ? (e) => on.stagePointerDown(e.pointerType) : undefined}
        onClick={on?.takeOver}
      >
        <div className={s.cardCell}>
          <Card vm={vm} on={on} />
          <Card vm={GHOST_VM} ghost />
        </div>

        <div className={s.out}>
          <div className={s.outLab}>
            <span>Your link</span>
            <small>{vm.outNote}</small>
          </div>
          <div
            className={cx(
              s.pill,
              pill.parity === "a" && s.fa,
              pill.parity === "b" && s.fb,
              pill.tone === "warn" && s.warn,
              pill.tone === "bad" && s.bad,
            )}
          >
            <span className={s.ring} aria-hidden="true" />
            <span className={cx(s.mk, pill.enc && s.mkEnc)} aria-hidden="true">
              <span className={s.drop} />
              <Icon name={pill.icon} size={20} />
            </span>
            <span className={cx(s.link, pill.long && s.long)} title={pill.full || undefined}>
              <span className={s.lh}>{pill.host}</span>
              <span className={cx(s.lp, pill.random && s.lr)}>{pill.path}</span>
              {pill.frag ? <span className={s.lf}>{pill.frag}</span> : null}
            </span>
            <button
              id="lf-copy"
              type="button"
              className={cx(s.copy, copy.ok && s.copyOk)}
              disabled={copy.disabled}
              aria-label={copy.aria}
              onClick={on?.copy}
            >
              <span className={s.ci}>
                <Icon name={copy.icon} size={16} />
              </span>
              {copy.text}
            </button>
          </div>

          <div className={s.tags}>
            {vm.tags.map((tg) => (
              <span key={tg.key} className={cx(s.tag, TAG_TONE[tg.tone])}>
                <Icon name={tg.icon} size={12} />
                {tg.text}
              </span>
            ))}
          </div>
          <p className={s.sum}>{vm.summary}</p>

          <div className={s.chat}>
            <div className={s.chatH}>
              <div className={s.chatT}>
                <span className={s.chatTb}>Chat preview</span>
                <span className={s.chatTs}>How the link unfurls when you paste it</span>
              </div>
              <div className={s.tabs} role="group" aria-label="Chat preview style">
                {vm.tabs.map((tb) => (
                  <button
                    key={tb.id}
                    id={"lf-tab-" + tb.id}
                    type="button"
                    className={s.tab}
                    aria-pressed={tb.pressed}
                    onClick={on ? () => on.pickTab(tb.id) : undefined}
                  >
                    <Icon name={tb.icon} size={14} />
                    {tb.label}
                  </button>
                ))}
              </div>
            </div>
            <div className={s.chatB}>
              {cv.broken ? <div className={s.broken}>{cv.brokenText}</div> : null}

              {cv.team ? (
                <div className={s.tc}>
                  <span className={s.tcAv} aria-hidden="true">
                    Y
                  </span>
                  <div className={s.tcM}>
                    <div className={s.tcN}>
                      You<span>9:41 AM</span>
                    </div>
                    <div className={s.tcT}>Handbook for Monday, everyone:</div>
                    <span className={s.tcL}>{cv.link}</span>
                    <div className={cx(s.uf, cv.ws && s.ufWs)}>
                      <div className={s.ufSite}>
                        {cv.ws ? (
                          <span className={s.ufLogo} aria-hidden="true">
                            E
                          </span>
                        ) : (
                          <Mark size={18} />
                        )}
                        {cv.site}
                      </div>
                      <div className={s.ufTi}>
                        {cv.lockIcon ? <Icon name={cv.lockIcon} size={14} /> : null}
                        {cv.title}
                      </div>
                      <div className={s.ufSn}>{cv.snip}</div>
                      {cv.wsNote ? (
                        <div className={s.ufMeta}>
                          <Icon name="info" size={12} />
                          Private and sign-in docs unfurl without the title.
                        </div>
                      ) : null}
                    </div>
                    {cv.sealed ? (
                      <div className={s.np}>
                        <span className={s.npI}>
                          <Icon name="eyeOff" size={14} />
                        </span>
                        <span>
                          The card never shows the real title. It is sealed in your browser, and link previews only fetch the
                          part before the #, so the preview never gets the key.
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {cv.phone ? (
                <div className={s.ph}>
                  <div className={s.phF}>
                    <div className={s.phTop}>
                      <span className={s.phAv} aria-hidden="true">
                        S
                      </span>
                      <span className={s.phNm}>Sam</span>
                    </div>
                    <div className={s.phBody}>
                      <div className={s.bubO}>
                        <div className={s.bubPv}>
                          <span className={s.bs}>{cv.siteHost}</span>
                          <span className={s.bt}>
                            {cv.lockIcon ? <Icon name={cv.lockIcon} size={12} /> : null}
                            {cv.title}
                          </span>
                          <span className={s.bd}>{cv.snipShort}</span>
                        </div>
                        <span className={s.bubL}>{cv.link}</span>
                        {cv.sealed ? <span className={s.bubNp}>Title sealed. The preview never sees the key after the #.</span> : null}
                        <span className={s.bubTm}>
                          9:41
                          <Icon name="check" size={12} />
                          <Icon name="check" size={12} />
                        </span>
                      </div>
                      <div className={s.bubI}>{cv.reply}</div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <p className={s.sr} aria-live="polite">
        {vm.live}
      </p>
    </div>
  );
}
