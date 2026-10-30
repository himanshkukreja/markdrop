/**
 * Orbit hero, presentational. No hooks, no "use client": the server renders it as the static poster
 * (no `on`: the stage and the HUD are inert and aria-hidden, the ambient loops hold still), and the
 * client Game renders it with handlers. Everything it draws comes from deriveView(state).
 */
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { COPY, GLYPHS_DESKTOP, GLYPHS_MOBILE, STARS_DESKTOP, STARS_MOBILE, BURST, TOTAL, type FeatId, type FileId, type Form, type MoonId } from "./data";
import { deriveDesktop, deriveMobile, type CardVM } from "./derive";
import type { Aim, State } from "./model";
import { Badge, ButtonLink, DropSvg, FileIcon, Glyph, Icon, MarkdropMark, Progress } from "./ds";
import { Diorama, MobilePane, StationPanes, k, v } from "./scenes";
import { P2P_RELAY_LIVE } from "@/lib/marketingFlags";
import SampleSlug from "../SampleSlug";

export interface On {
  padClick(e: MouseEvent): void;
  padDown(e: PointerEvent<HTMLButtonElement>): void;
  padMove(e: PointerEvent<HTMLButtonElement>): void;
  padUp(e: PointerEvent<HTMLButtonElement>): void;
  padCancel(): void;
  padAim(on: boolean, e?: FocusEvent | PointerEvent): void;
  stageFocus(e: FocusEvent): void;
  stageBlur(e: FocusEvent): void;
  station(e: MouseEvent): void;
  aim(at: Aim | null, e?: PointerEvent): void;
  tile(id: FileId, e: MouseEvent): void;
  tileKey(i: number, e: KeyboardEvent): void;
  moon(id: MoonId, e: MouseEvent): void;
  moonFocus(id: MoonId, e: FocusEvent): void;
  moonKey(i: number, e: KeyboardEvent): void;
  pip(id: FeatId, e: MouseEvent): void;
  pause(): void;
  relay(): void;
  reset(): void;
  encrypt(): void;
  /* mobile */
  stageDown(e: PointerEvent<HTMLDivElement>): void;
  stageMove(e: PointerEvent<HTMLDivElement>): void;
  stageUp(e: PointerEvent<HTMLDivElement>): void;
  stageCancel(): void;
  courier(e: MouseEvent): void;
  spin(dir: 1 | -1, e: MouseEvent): void;
  sheet(open: boolean): void;
}

const isExternal = (href: string) => /^https?:\/\//.test(href);
const PauseSvg = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M9 5v14M15 5v14" /></svg>;
const PlaySvg = () => <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>;
/** Props that make a poster region still and silent; the game passes nothing. */
const still = (poster: boolean) => (poster ? { inert: true, "aria-hidden": true as const } : {});

export default function View({ state, form, on }: { state: State; form?: Form; on?: On }) {
  return (form ?? state.form) === "mobile" ? <MobileView state={state} on={on} /> : <DesktopView state={state} on={on} />;
}

/* ── The info card (desktop column card and the mobile sheet share the body) ── */

function CardBody({ c, hint, form, titleId, on, sheetX }: { c: CardVM; hint: string; form: Form; titleId: string; on?: On; sheetX?: ReactNode }) {
  const C = COPY[form];
  const cta = (href: string, label: string, view: string, variant: "primary" | "secondary") => (
    <ButtonLink href={href} variant={variant} iconRight={form === "desktop" ? "arrowRight" : undefined} data-cta={"card_" + view}
      {...(isExternal(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{label}</ButtonLink>
  );
  return (
    <div className={k("card-in", c.anim && "c" + c.anim)}>
      <div className={k("card-hd")}>
        <span className={k("card-ico")} style={{ color: c.cat }}><Glyph icon={c.icon} size={16} /></span>
        <span className={k("card-eb")}>{c.eyebrow}</span>
        {form === "desktop"
          ? c.req && <span className={k("card-req")}><Badge tone={c.tone} icon={c.reqIcon}>{c.req}</Badge></span>
          : <span className={k("card-x")}>{c.req && <Badge tone={c.tone} icon={c.reqIcon}>{c.req}</Badge>}{sheetX}</span>}
      </div>
      <h2 id={titleId} className={k("card-t")}>{c.title}</h2>
      <p className={k("card-p")}>{c.line}</p>
      {c.isIntro && (
        <div className={k("irows")}>
          <div className={k("irow")}><span className={k("irow-i")} style={{ color: "var(--cat-document)" }}><Icon name="lines" size={14} /></span><span className={k("it")}>Write or paste markdown<SampleSlug slug="release-notes" className={k("lk")}>markdrop.in/release-notes</SampleSlug></span><Badge tone="success">No account</Badge></div>
          <div className={k("irow")}><span className={k("irow-i")} style={{ color: "var(--cat-artifact)" }}><Icon name="upload" size={14} /></span><span className={k("it")}>{form === "desktop" ? "Upload an HTML page, PDF, sheet or video" : "Upload an HTML page or a PDF"}<SampleSlug slug="launch-page" className={k("lk")}>markdrop.in/launch-page</SampleSlug></span><Badge tone="info">Free account</Badge></div>
        </div>
      )}
      {c.hasLink && (
        <div className={k("lchip")}><Icon name="link" size={14} /><SampleSlug slug={c.path} host={c.host}><span><span className={k("mu")}>{c.host}</span>{c.path}</span></SampleSlug>{c.frag && <span className={k("frag")}>{c.frag}</span>}</div>
      )}
      {c.note && (
        <div className={k("note", c.warn && "warn")}>
          <Icon name={c.noteIcon} size={14} />
          <span>{c.note}{c.noteLink && <><a href={c.noteLink.href}>{c.noteLink.text}</a>.</>}</span>
        </div>
      )}
      {form === "mobile" && hint && !c.note && !c.isIntro && (
        <span className={k("hint")}><Icon name="bulb" size={14} /><span>{hint}</span></span>
      )}
      {form === "desktop" ? (
        <div className={k("card-ft")}>
          {c.isFin && <>
            {cta("/new", "Start writing", c.id, "primary")}
            <button type="button" className={k("gbtn")} onClick={on?.reset}><Icon name="wave" size={14} />Play again</button>
          </>}
          {c.isCombo && <button type="button" className={k("gbtn", "go")} onClick={on?.encrypt}><Icon name="lock" size={14} />{C.encryptCta}</button>}
          {!c.isFin && cta(c.href, c.cta, c.id, "secondary")}
          {hint && <span className={k("hint")}><Icon name="bulb" size={14} /><span>{hint}</span></span>}
        </div>
      ) : null}
    </div>
  );
}

/* ══ Desktop (≥768) ═══════════════════════════════════════════════════ */

function DesktopView({ state, on }: { state: State; on?: On }) {
  const vm = deriveDesktop(state);
  const poster = !on;
  const c = vm.card;
  return (
    <div className={k("dk", vm.paused && "is-paused", vm.fin && "is-fin", vm.dragging && "is-drag", poster && "poster")}>
      <section className={k("card")} aria-labelledby={poster ? "orbit-card-t0" : "orbit-card-t"}>
        <CardBody c={c} hint={vm.hint} form="desktop" titleId={poster ? "orbit-card-t0" : "orbit-card-t"} on={on} />
      </section>

      <div className={k("world")}>
        {/* The game stage. Keyboard focus inside it holds the demo; arrow keys act on the focused moon or file. */}
        <div className={k("world-box")} role="group" aria-label={vm.stageLabel} onFocus={on?.stageFocus} onBlur={on?.stageBlur} {...still(poster)}>
          <div className={k("sw")} data-sw="">
            {/* the lead line: the card captions whatever just unfolded on the stage */}
            {!vm.fin && (
              <>
                <svg className={k("conn")} width="1440" height="1000" viewBox="0 0 1440 1000" aria-hidden="true"><path d="M 552 702 C 640 702 680 788 756 788" /><circle cx="552" cy="702" r="3" /></svg>
                <div className={k("conn-dot", vm.connDot && "c" + vm.connDot)} aria-hidden="true"><i /></div>
              </>
            )}

            {/* the launch pad comes first in the tab order: one key walks all eight features */}
            <div className={k("pad-wrap")}>
              <div className={k("pad-rim")} aria-hidden="true" />
              <div className={k("pad-top")} aria-hidden="true" />
              <button type="button" className={k("pad")} aria-label={vm.padLabel}
                onClick={on?.padClick} onPointerDown={on?.padDown} onPointerMove={on?.padMove} onPointerUp={on?.padUp} onPointerCancel={on?.padCancel}
                onPointerEnter={on && ((e) => on.padAim(true, e))} onPointerLeave={on && ((e) => on.padAim(false, e))}
                onFocus={on && ((e) => on.padAim(true, e))} onBlur={on && (() => on.padAim(false))}>
                <span className={k("pad-drop", vm.padDrop && "r" + vm.padDrop)} aria-hidden="true">
                  <span className={k("pad-bob", "loop")}><DropSvg w={28} h={36} eyes pathCls={k("drop-p")} eyeCls={k("drop-eye")} blinkCls={k("blink", "loop")} /></span>
                </span>
              </button>
              <span className={k("carry", vm.carry.anim && "c" + vm.carry.anim)} aria-hidden="true"><Glyph icon={vm.carry.icon} size={12} />{vm.carry.text}</span>
              <span className={k("pad-lbl")} aria-hidden="true"><span>Click or drag the drop</span><b>{vm.padNext}</b></span>
            </div>

            {/* starfield of markdown glyphs + glow */}
            <div aria-hidden="true">
              {STARS_DESKTOP.map((s, i) => (
                <span key={i} className={k("star", s.tw && "tw", s.tw && "loop")} style={{ left: s.x, top: s.y, fontSize: s.fs, opacity: s.op, animationDelay: s.tw ? `-${s.delay}s` : undefined }}>{s.g}</span>
              ))}
            </div>
            <div className={k("glow")} aria-hidden="true" />

            {/* orbit, back half + outer glyph ring */}
            <svg className={k("rings")} width="1440" height="1000" viewBox="0 0 1440 1000" aria-hidden="true" style={{ zIndex: 5 }}>
              <ellipse className={k("ring-d")} cx="990" cy="390" rx="440" ry="190" />
              <path className={k("ring-b")} d="M 618 390 A 372 150 0 0 1 1362 390" />
            </svg>
            <div aria-hidden="true">
              {GLYPHS_DESKTOP.map((g) => <span key={g.g} className={k("glm", "loop")} style={v({ "--o": g.o + "%" })}>{g.g}</span>)}
            </div>

            {/* constellation through the moons you found */}
            {vm.cons.show && (
              <svg className={k("cons", vm.cons.anim && "c" + vm.cons.anim)} width="1440" height="1000" viewBox="0 0 1440 1000" aria-hidden="true"><polyline points={vm.cons.pts} /></svg>
            )}

            {/* the planet */}
            <div aria-hidden="true">
              <div className={k("disc-sh")} />
              <div className={k("disc-rim")} />
              <div className={k("disc-top")}><div className={k("disc-grid")} /><div className={k("disc-ring")} /></div>
              <div className={k("disc-band", vm.band.armed && "armed")}>{vm.band.text}</div>
              <div className={k("stand-b")} />
              <div className={k("stand")} />
            </div>

            {/* the artifact station: the rendered file (visual; the button over it is the real target) */}
            <div className={k("station")} aria-hidden="true">
              <div className={k("scr-side")} />
              <div className={k("scr")}>
                <div className={k("scr-in")} style={v({ "--pd": vm.pd })}>
                  <StationPanes file={vm.file.id} />
                  {vm.combo && <span className={k("scr-lock")}><Badge tone="warning" icon="lock">Password instead</Badge></span>}
                </div>
              </div>
            </div>

            {/* the link pill on top of the station */}
            <div className={k("pill", vm.fin && "fin-pill")} style={v({ "--pd": vm.pd })} aria-hidden="true">
              <span className={k("pill-mk")}>
                <MarkdropMark size={32} />
                <span className={k("pk-abs", vm.pk)} />
                <span className={k("pk-drop", vm.pk)}><DropSvg w={10} h={13} pathCls={k("drop-p")} /></span>
                <span className={k("pk-rip", vm.pk)} />
              </span>
              <span className={k("pill-url", vm.pk)}><span className={k("mu")}>markdrop.in/</span>{vm.pill.path}</span>
              <Badge tone={vm.pill.tone} icon={vm.pill.icon}>{vm.pill.badge}</Badge>
              <span className={k("pill-copy")}><Icon name="copy" size={14} /></span>
            </div>

            {/* the screen is a real button: it renders the next file type */}
            <button type="button" className={k("station-hit", vm.station.next && "next")} data-target="station" aria-label={vm.station.aria}
              onClick={on?.station} onPointerEnter={on && ((e) => on.aim({ k: "station" }, e))} onPointerLeave={on && (() => on.aim(null))}>
              <span className={k("st-ring")} aria-hidden="true" />
              <span className={k("st-cap")} aria-hidden="true"><Icon name="upload" size={12} />{vm.station.cap}</span>
            </button>

            {/* the rack: five real buttons */}
            <div role="group" aria-label="Files to render">
              {vm.tiles.map((f) => (
                <button key={f.id} type="button" id={poster ? undefined : "po-file-" + f.id} className={k("tile", f.seen && "seen", f.cur && "cur", f.armed && "armed")}
                  style={v({ left: f.left, top: f.top, "--tint": f.tint })} data-target={"file:" + f.id} aria-label={f.aria} aria-pressed={f.pressed}
                  onClick={on && ((e) => on.tile(f.id, e))} onKeyDown={on && ((e) => on.tileKey(f.i, e))}
                  onPointerEnter={on && ((e) => on.aim({ k: "file", id: f.id }, e))} onPointerLeave={on && (() => on.aim(null))}>
                  <span className={k("tile-side")} aria-hidden="true" />
                  <span className={k("tile-face")} aria-hidden="true"><span className={k("tile-band")} /><span className={k("tile-fold")} /><FileIcon name={f.name} mime={f.mime} size={18} /><span className={k("tile-ext")}>{f.ext}</span></span>
                  <span className={k("tile-seen")} aria-hidden="true"><Icon name="check" size={10} /></span>
                  <span className={k("tile-lock")} aria-hidden="true"><Icon name="lock" size={10} /></span>
                </button>
              ))}
            </div>

            {/* orbit, front half */}
            <svg className={k("rings")} width="1440" height="1000" viewBox="0 0 1440 1000" aria-hidden="true" style={{ zIndex: 22 }}>
              <path className={k("ring-f")} d="M 618 390 A 372 150 0 0 0 1362 390" />
            </svg>

            {/* the seven moons */}
            <div role="group" aria-label="Feature moons">
              {vm.moons.map((m) => (
                <div key={m.id} className={k("moon", m.fin && "fin")} style={v({
                  "--t": m.deg + "deg", "--cat": m.cat, "--fx": m.fx.toFixed(1) + "px", "--fy": m.fy.toFixed(1) + "px",
                  "--x": m.x.toFixed(1) + "px", "--y": m.y.toFixed(1) + "px", "--s": m.s.toFixed(3), "--op": m.op.toFixed(3), "--ls": (1 / m.s).toFixed(3), zIndex: m.z,
                })}>
                  <div className={k("moon-fin")}>
                    <button type="button" id={poster ? undefined : "po-moon-" + m.id} className={k("moon-btn", m.found && "found", m.docked && "docked", m.next && "next")}
                      data-target={"moon:" + m.id} aria-label={m.aria} aria-pressed={m.pressed}
                      onClick={on && ((e) => on.moon(m.id, e))} onFocus={on && ((e) => on.moonFocus(m.id, e))} onKeyDown={on && ((e) => on.moonKey(m.i, e))}
                      onPointerEnter={on && ((e) => on.aim({ k: "moon", id: m.id }, e))} onPointerLeave={on && (() => on.aim(null))}>
                      <span className={k("moon-next", "loop")} aria-hidden="true" />
                      <span className={k("moon-ring")} aria-hidden="true" />
                      <span className={k("moon-ball")} aria-hidden="true"><Glyph icon={m.icon} size={22} /></span>
                      <span className={k("moon-chk")} aria-hidden="true"><Icon name="check" size={10} /></span>
                      <span className={k("moon-lbl")} aria-hidden="true">{m.label}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* finale: the mark forms around the core */}
            {vm.fin && (
              <div className={k("fin")} aria-hidden="true">
                <svg className={k("fin-frame", "anim")} width="1440" height="1000" viewBox="0 0 1440 1000" aria-hidden="true"><rect x="800" y="180" width="380" height="320" rx="70" /></svg>
                <div className={k("fin-mark", "anim")}>
                  <MarkdropMark size={300} />
                  <span className={k("fin-drop", "anim")}><DropSvg w={28} h={36} pathCls={k("drop-p")} /></span>
                  <span className={k("fin-rip", "anim")} />
                </div>
              </div>
            )}

            {/* Dioramas (one mounts at a time; mounting replays it) */}
            <div className={k("dio-wrap")}>
              <Diorama key={vm.dioN} dock={vm.fin ? null : vm.dock} a={vm.dioN > 0} file={vm.file} combo={vm.combo} send={vm.send} onRelay={P2P_RELAY_LIVE && on ? on.relay : undefined} />
            </div>

            {/* the launch: drop arc, dock ripple, file flight */}
            <div className={k("dfly", vm.dfly.anim && "f" + vm.dfly.anim)} style={{ offsetPath: vm.dfly.path }} aria-hidden="true">
              <div className={k("dfly-in")}><DropSvg w={22} h={28} eyes pathCls={k("drop-p")} eyeCls={k("drop-eye")} /></div>
            </div>
            <div className={k("dock-rip", vm.dockRip && "r" + vm.dockRip)} aria-hidden="true" />
            <div className={k("ffly", vm.ffly.anim && "f" + vm.ffly.anim)} style={v({ offsetPath: vm.ffly.path, "--fd": vm.ffly.fd, "--tint": vm.ffly.file.tint })} aria-hidden="true">
              <div className={k("ffly-in")}><FileIcon name={vm.ffly.file.name} mime={vm.ffly.file.mime} size={16} /></div>
            </div>

            {/* the route preview: where the drop will go, shown before you commit */}
            {vm.aim.show && (
              <svg className={k("aim", vm.aim.tgt && "tgt")} width="1440" height="1000" viewBox="0 0 1440 1000" aria-hidden="true"><path d={vm.aim.d} /><circle cx={vm.aim.x} cy={vm.aim.y} r={vm.aim.r} /></svg>
            )}
            {vm.ghost && (
              <div className={k("ghost")} style={{ transform: `translate(${Math.round(vm.ghost.x - 13)}px, ${Math.round(vm.ghost.y - 17)}px)` }} aria-hidden="true">
                <DropSvg w={26} h={34} eyes pathCls={k("drop-p")} eyeCls={k("drop-eye")} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Discovery HUD */}
      <div className={k("hud")} role="group" aria-label="Discovery" {...still(poster)}>
        <button type="button" className={k("pp")} aria-label={vm.ppAria} onClick={on?.pause}>
          {vm.paused ? <PlaySvg /> : <PauseSvg />}<span>{vm.ppText}</span>
        </button>
        <div className={k("cnt")}>
          <span className={k("cnt-t")}><b>{vm.count} of {TOTAL}</b> discovered</span>
          <Progress value={vm.count} max={TOTAL} label="Features discovered" />
        </div>
        <div className={k("pips")}>
          {vm.pips.map((p) => (
            <button key={p.id} type="button" className={k("pip", p.found && "found", p.on && "on", p.star && "star-pip")} style={v({ "--cat": p.cat })}
              title={p.quest} aria-pressed={p.on} aria-label={p.aria} onClick={on && ((e) => on.pip(p.id, e))}>
              <span className={k("pip-dot")} aria-hidden="true" />{p.label}
            </button>
          ))}
        </div>
        <div className={k("ach")}>
          {vm.achs.map((a) => <span key={a.id} className={k("ach-i", a.on && "on")} role="img" aria-label={a.aria} title={a.title}><Icon name={a.icon} size={14} /></span>)}
        </div>
      </div>

      {!poster && <p className={k("sr")} role="status" aria-live="polite">{vm.announce}</p>}
    </div>
  );
}

/* ══ Mobile (<768) ════════════════════════════════════════════════════ */

function Courier({ vm, on }: { vm: ReturnType<typeof deriveMobile>; on?: On }) {
  return (
    <button type="button" className={k("courier")} aria-label={vm.courierAria} onClick={on?.courier}>
      <span className={k("cour-d", vm.courDrop && "r" + vm.courDrop)} aria-hidden="true">
        <span className={k("cour-bob", "loop")}><DropSvg w={22} h={28} eyes pathCls={k("drop-p")} eyeCls={k("drop-eye")} blinkCls={k("blink", "loop")} /></span>
      </span>
      <span className={k("cour-t")} aria-hidden="true"><span className={k("cour-k")}>{vm.carry.kicker}</span><span className={k("cour-l")}>{vm.carry.text}</span></span>
    </button>
  );
}

function MobileView({ state, on }: { state: State; on?: On }) {
  const vm = deriveMobile(state);
  const poster = !on;
  const c = vm.card;
  const pp = (
    <button type="button" className={k("pp")} aria-label={vm.ppAria} onClick={on?.pause}>{vm.paused ? <PlaySvg /> : <PauseSvg />}</button>
  );
  return (
    <div className={k("mb", vm.paused && "is-paused", vm.fin && "is-fin", vm.isPlay && "is-play", poster && "poster")}>
      <div className={k("stage-col")}>
        <div className={k("stage-box")} data-stage="">
          <div className={k("stage-sc")} style={v({ "--sc": vm.sc })}>
            {/* The game stage. Swipe spins the orbit (or flips files when you start on the screen or the rack). */}
            <div className={k("stage")} role="group" aria-label={vm.stageLabel} onFocus={on?.stageFocus} onBlur={on?.stageBlur}
              onPointerDown={on?.stageDown} onPointerMove={on?.stageMove} onPointerUp={on?.stageUp} onPointerCancel={on?.stageCancel} {...still(poster)}>
              <div aria-hidden="true">
                {STARS_MOBILE.map((s, i) => (
                  <span key={i} className={k("star", s.tw && "tw", s.tw && "loop")} style={{ left: s.x, top: s.y, fontSize: s.fs, opacity: s.op, animationDelay: s.tw ? `-${s.delay}s` : undefined }}>{s.g}</span>
                ))}
              </div>
              <div className={k("glow")} aria-hidden="true" />
              <svg className={k("rings")} width="390" height="344" viewBox="0 0 390 344" aria-hidden="true" style={{ zIndex: 5 }}>
                <ellipse className={k("ring-d")} cx="195" cy="192" rx="186" ry="100" />
                <path className={k("ring-b")} d="M 31 192 A 164 78 0 0 1 359 192" />
              </svg>
              <div aria-hidden="true">
                {GLYPHS_MOBILE.map((g) => <span key={g.g} className={k("glm", "loop")} style={v({ "--o": g.o + "%" })}>{g.g}</span>)}
              </div>
              {vm.cons.show && (
                <svg className={k("cons", vm.cons.anim && "c" + vm.cons.anim)} width="390" height="344" viewBox="0 0 390 344" aria-hidden="true"><polyline points={vm.cons.pts} /></svg>
              )}

              {/* the planet */}
              <div aria-hidden="true">
                <div className={k("disc-sh")} />
                <div className={k("disc-rim")} />
                <div className={k("disc-top")}><div className={k("disc-grid")} /><div className={k("disc-ring")} /></div>
                <div className={k("disc-band", vm.band.armed && "armed")}>{vm.band.text}</div>
                <div className={k("stand-b")} />
                <div className={k("stand")} />
              </div>

              {/* the screen: every feature renders here (visual; the button over it is the real target) */}
              <div className={k("station")} aria-hidden="true">
                <div className={k("scr-side")} />
                <div className={k("scr")}>
                  <div className={k("scr-in")}>
                    <span className={k("scr-wm")}><MarkdropMark size={28} /></span>
                    <div className={k("scl")}>
                      <MobilePane key={vm.screenN} screen={vm.screen} a={vm.screenN > 0} pd={vm.pd} send={vm.send} />
                    </div>
                    {vm.combo && <span className={k("scr-lock")}><Badge tone="warning" icon="lock">Password instead</Badge></span>}
                  </div>
                </div>
              </div>

              {/* the link pill: the real link shape for whatever the screen shows */}
              <div className={k("pill", vm.fin && "fin-pill")} style={v({ "--pd": vm.pd })} aria-hidden="true">
                <span className={k("pill-mk")}>
                  <MarkdropMark size={26} />
                  <span className={k("pk-abs", vm.pk)} />
                  <span className={k("pk-drop", vm.pk)}><DropSvg w={8} h={11} pathCls={k("drop-p")} /></span>
                  <span className={k("pk-rip", vm.pk)} />
                </span>
                <span className={k("pill-url", vm.pk)}><span className={k("mu")}>{vm.pill.host}</span>{vm.pill.path}{vm.pill.frag && <span className={k("frag")}>{vm.pill.frag}</span>}</span>
                {vm.pill.badge && <Badge tone={vm.pill.tone} icon={vm.pill.icon}>{vm.pill.badge}</Badge>}
              </div>

              {/* the screen is a real button: it renders the next file type (swipe it to flip types) */}
              <button type="button" className={k("station-hit", vm.station.next && "next")} data-swipe="file" aria-label={vm.station.aria} onClick={on?.station}>
                <span className={k("st-ring")} aria-hidden="true" />
                <span className={k("st-cap")} aria-hidden="true"><Icon name="upload" size={12} />{vm.station.cap}</span>
              </button>

              {/* the rack: five real buttons */}
              <div role="group" aria-label="Files to render">
                {vm.tiles.map((f) => (
                  <button key={f.id} type="button" id={poster ? undefined : "pm-file-" + f.id} className={k("tile", f.seen && "seen", f.cur && "cur", f.armed && "armed")}
                    style={v({ left: f.left, top: f.top, "--tint": f.tint })} data-swipe="file" aria-label={f.aria} aria-pressed={f.pressed}
                    onClick={on && ((e) => on.tile(f.id, e))} onKeyDown={on && ((e) => on.tileKey(f.i, e))}>
                    <span className={k("tile-side")} aria-hidden="true" />
                    <span className={k("tile-face")} aria-hidden="true"><span className={k("tile-band")} /><span className={k("tile-fold")} /><FileIcon name={f.name} mime={f.mime} size={16} /><span className={k("tile-ext")}>{f.ext}</span></span>
                    <span className={k("tile-seen")} aria-hidden="true"><Icon name="check" size={10} /></span>
                    <span className={k("tile-lock")} aria-hidden="true"><Icon name="lock" size={10} /></span>
                  </button>
                ))}
              </div>

              <svg className={k("rings")} width="390" height="344" viewBox="0 0 390 344" aria-hidden="true" style={{ zIndex: 22 }}>
                <path className={k("ring-f")} d="M 31 192 A 164 78 0 0 0 359 192" />
              </svg>

              {/* the seven moons */}
              <div role="group" aria-label="Feature moons">
                {vm.moons.map((m) => (
                  <div key={m.id} className={k("moon", m.fin && "fin")} style={v({
                    "--t": m.deg + "deg", "--cat": m.cat, "--fx": m.fx.toFixed(1) + "px", "--fy": m.fy.toFixed(1) + "px",
                    "--x": m.x.toFixed(1) + "px", "--y": m.y.toFixed(1) + "px", "--s": m.s.toFixed(3), "--op": m.op.toFixed(3), zIndex: m.z,
                  })}>
                    <div className={k("moon-fin")}>
                      <button type="button" id={poster ? undefined : "pm-moon-" + m.id} className={k("moon-btn", m.found && "found", m.docked && "docked", m.next && "next")}
                        aria-label={m.aria} aria-pressed={m.pressed}
                        onClick={on && ((e) => on.moon(m.id, e))} onFocus={on && ((e) => on.moonFocus(m.id, e))} onKeyDown={on && ((e) => on.moonKey(m.i, e))}>
                        <span className={k("moon-next", "loop")} aria-hidden="true" />
                        <span className={k("moon-ring")} aria-hidden="true" />
                        <span className={k("moon-ball")} aria-hidden="true"><Glyph icon={m.icon} size={20} /></span>
                        <span className={k("moon-chk")} aria-hidden="true"><Icon name="check" size={10} /></span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* finale: the moons frame the mark, a drop lands in its dot, drops burst out */}
              {vm.fin && (
                <div className={k("fin")} aria-hidden="true">
                  <svg className={k("fin-frame", "anim")} width="390" height="344" viewBox="0 0 390 344" aria-hidden="true"><rect x="95" y="30" width="200" height="148" rx="38" /></svg>
                  <div className={k("fin-mark", "anim")}>
                    <MarkdropMark size={140} />
                    <span className={k("fin-drop", "anim")}><DropSvg w={13} h={17} pathCls={k("drop-p")} /></span>
                    <span className={k("fin-rip", "anim")} />
                  </div>
                  {BURST.map((b, i) => (
                    <span key={i} className={k("fwd", "anim", "c" + b.c)} style={v({ "--a": b.a + "deg", "--d": b.d + "px", "--dl": b.dl + "s" })}>
                      <svg viewBox="0 0 14 18" aria-hidden="true" focusable="false"><path d="M7 0.5c0 0 6 7.4 6 10.6a6 6 0 0 1-12 0C1 7.9 7 0.5 7 0.5z" /></svg>
                    </span>
                  ))}
                </div>
              )}

              {/* file flight from the rack into the screen; dock ripple at the front seat */}
              <div className={k("ffly", vm.ffly.anim && "f" + vm.ffly.anim)} style={v({ offsetPath: vm.ffly.path, "--fd": vm.ffly.fd, "--tint": vm.ffly.file.tint })} aria-hidden="true">
                <div className={k("ffly-in")}><FileIcon name={vm.ffly.file.name} mime={vm.ffly.file.mime} size={14} /></div>
              </div>
              <div className={k("dock-rip", vm.dockRip && "r" + vm.dockRip)} aria-hidden="true" />

              {/* the caption row: spin buttons + the nameplate of what is on show */}
              <div className={k("cap-row")}>
                <button type="button" className={k("cyc")} aria-label={vm.prevAria} onClick={on && ((e) => on.spin(-1, e))}><Icon name="chevronLeft" size={18} /></button>
                <div className={k("capc", vm.cap.anim && "c" + vm.cap.anim)} style={v({ "--cat": vm.cap.cat })} aria-hidden="true">
                  <Glyph icon={vm.cap.icon} size={14} /><span>{vm.cap.label}</span><span className={k("sep")}>{vm.cap.sep}</span><span className={k("tl", vm.cap.mono && "mono")}>{vm.cap.tail}</span>
                </div>
                <button type="button" className={k("cyc")} aria-label={vm.nextAria} onClick={on && ((e) => on.spin(1, e))}><Icon name="chevronRight" size={18} /></button>
              </div>

              {/* the courier drop in flight (stage-local: from the courier to the moon or the screen) */}
              <div className={k("dfly", vm.dfly.anim && "f" + vm.dfly.anim)} style={{ offsetPath: vm.dfly.path }} aria-hidden="true">
                <div className={k("dfly-in")}><DropSvg w={20} h={26} eyes pathCls={k("drop-p")} eyeCls={k("drop-eye")} /></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Hero HUD (above the fold): pause, meter, courier */}
      {vm.isHero && (
        <div className={k("hhud", vm.heroAnim && "c" + vm.heroAnim)} role="group" aria-label="Discovery" {...still(poster)}>
          {pp}
          <div className={k("meter")}>
            <span className={k("meter-t")}><span className={k("meter-h")}>{vm.heroHint}</span><span><b>{vm.count} of {TOTAL}</b></span></span>
            <Progress value={vm.count} max={TOTAL} label="Features discovered" />
          </div>
          <Courier vm={vm} on={on} />
        </div>
      )}

      {/* Play HUD (fixed under the header): pause + the passport of eight stamps */}
      {vm.isPlay && (
        <div className={k("phud")} role="group" aria-label="Discovery">
          <div className={k("phud-r1")}>
            {pp}
            <div className={k("stamps")}>
              {vm.stamps.map((p) => (
                <button key={p.id} type="button" className={k("stamp", p.got && "got", p.on && "on", p.big && "big")} style={v({ "--cat": p.cat })}
                  aria-label={p.aria} aria-pressed={p.on} onClick={on && ((e) => on.pip(p.id, e))}>
                  <span className={k("stamp-c", p.got && "anim")} aria-hidden="true"><Glyph icon={p.icon} size={16} /></span>
                  <span className={k("stamp-n")} aria-hidden="true">{p.n}</span>
                </button>
              ))}
            </div>
          </div>
          <div className={k("phud-r2")}>
            <span className={k("cnt-t")}><b>{vm.count} of {TOTAL}</b> discovered</span>
            <Progress value={vm.count} max={TOTAL} label="Features discovered" className={k("prog")} />
            <div className={k("ach")}>
              {vm.achs.map((a) => <span key={a.id} className={k("ach-i", a.on && "on")} role="img" aria-label={a.aria} title={a.title}><Icon name={a.icon} size={10} /></span>)}
            </div>
          </div>
        </div>
      )}

      {/* Bottom sheet (non-modal, no focus trap): what the last move taught */}
      {vm.sheetOpen && (
        <section className={k("sheet")} aria-labelledby="orbit-sheet-t">
          <div className={k("sheet-in")}>
            <span className={k("grab")} aria-hidden="true" />
            <CardBody c={c} hint={vm.hint} form="mobile" titleId="orbit-sheet-t" on={on}
              sheetX={<button type="button" className={k("xbtn")} aria-label="Close details" onClick={on && (() => on.sheet(false))}><Icon name="x" size={18} /></button>} />
            <div className={k("card-ft")}>
              {c.isFin && <button type="button" className={k("gbtn")} onClick={on?.reset}><Icon name="wave" size={14} />Play again</button>}
              {c.isCombo && <button type="button" className={k("gbtn", "go")} onClick={on?.encrypt}><Icon name="lock" size={14} />{COPY.mobile.encryptCta}</button>}
              {vm.showTry && (
                <ButtonLink href={c.href} variant="secondary" data-cta={"card_" + c.id}
                  {...(isExternal(c.href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{c.cta}</ButtonLink>
              )}
              {vm.showRelay && (
                <button type="button" className={k("gbtn", "icon")} aria-label={vm.relayAria} aria-pressed={vm.relayPressed} onClick={on?.relay}><Icon name="wave" size={16} /></button>
              )}
              <span className={k("sp")} />
              {vm.showCourier && <Courier vm={vm} on={on} />}
            </div>
          </div>
        </section>
      )}

      {/* Peek (sheet closed): reopen the details, the hint, the courier */}
      {vm.showPeek && (
        <div className={k("peek")}>
          <button type="button" className={k("xbtn")} aria-label={vm.openAria} onClick={on && (() => on.sheet(true))}><Icon name="chevronUp" size={18} /></button>
          <span className={k("peek-h")}>{vm.hint || c.title}</span>
          <Courier vm={vm} on={on} />
        </div>
      )}

      {/* Sticky CTA: the job is one tap away while you play */}
      {vm.isPlay && (
        <div className={k("sticky")}>
          <div className={k("sticky-in")}>
            <span className={k("cta-wrap")}><ButtonLink href="/new" variant="primary" block iconRight="arrowRight" data-cta="sticky_start">Start writing</ButtonLink></span>
            <span className={k("sticky-n")}>No account<br />for markdown</span>
          </div>
        </div>
      )}

      {!poster && <p className={k("sr")} role="status" aria-live="polite">{vm.announce}</p>}
    </div>
  );
}
