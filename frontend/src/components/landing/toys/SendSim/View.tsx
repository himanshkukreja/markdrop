import type { CSSProperties, FocusEvent, KeyboardEvent, Ref } from "react";
import { ICONS, type IconName } from "@/components/ui/icons";
import { derive, N_PILL_X, RELAY_SENTENCE, STAGE_H, STAGE_W, TABS, type CopyTarget, type FileId, type FileKind, type NetId, type State, type Tab, type VM } from "./model";
import s from "./SendSim.module.css";

/**
 * Send Sim, presentational. No hooks and no "use client": the server renders it with no handlers as
 * the static first frame (inside <LazyIsland>), and Game renders it with handlers. Every focusable
 * control has a stable id, so focus survives the poster-to-game swap.
 */
export interface Handlers {
  addFile(): void;
  removeFile(id: FileId): void;
  pickNet(id: NetId): void;
  send(): void;
  keep(): void;
  end(): void;
  confirmKey(e: KeyboardEvent<HTMLButtonElement>): void;
  addPerson(): void;
  removePerson(): void;
  tab(t: Tab): void;
  tabKey(e: KeyboardEvent<HTMLButtonElement>): void;
  copy(which: CopyTarget, text: string): void;
  toggleDemo(): void;
  /** Keyboard focus inside the toy holds the attract demo (so nothing moves under the focus ring). */
  focusIn(e: FocusEvent<HTMLDivElement>): void;
  focusOut(e: FocusEvent<HTMLDivElement>): void;
}

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");
type Vars = CSSProperties & Record<`--${string}`, string>;

function Ic({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className={cx(s.ic, className)}>
      <path d={ICONS[name]} />
    </svg>
  );
}

const KIND: Record<FileKind, { icon: IconName; cls: string }> = {
  image: { icon: "image", cls: s.kImage },
  pdf: { icon: "doc", cls: s.kPdf },
  video: { icon: "film", cls: s.kVideo },
  sheet: { icon: "table", cls: s.kSheet },
  archive: { icon: "archive", cls: s.kArchive },
  doc: { icon: "lines", cls: s.kDoc },
};
function FileGlyph({ kind, size }: { kind: FileKind; size: number }) {
  const k = KIND[kind];
  return <Ic name={k.icon} size={size} className={k.cls} />;
}

const PILL_ST: Record<string, string> = { waiting: s.pWaiting, joining: s.pJoining, receiving: s.pReceiving, done: s.pDone };
const WIRE_ST: Record<string, string> = { waiting: s.wWaiting, joining: s.wJoining, receiving: s.wReceiving, done: s.wDone };

function Demo({ vm, on, id }: { vm: VM; on?: Handlers; id: string }) {
  return (
    <>
      <span className={s.demoT}>
        {vm.captionReduced ? (
          <>
            <span className={s.capMotion}>{vm.caption}</span>
            <span className={s.capReduced}>{vm.captionReduced}</span>
          </>
        ) : (
          vm.caption
        )}
      </span>
      {vm.pp.show && (
        <button type="button" id={id} className={cx(s.pp, vm.pp.motionOnly && s.motionOnly)} onClick={on?.toggleDemo}>
          {vm.pp.glyph === "reset" ? <Ic name="rotate" size={14} /> : <span className={cx(s.ppi, vm.pp.glyph === "pause" ? s.ppiPause : s.ppiPlay)} aria-hidden="true" />}
          {vm.pp.text}
        </button>
      )}
    </>
  );
}

export default function View({ state, on, rootRef }: { state: State; on?: Handlers; rootRef?: Ref<HTMLDivElement> }) {
  const vm = derive(state);
  const stageVars: Vars = { "--nh": vm.narrow.h + "px", "--nt": vm.narrow.top0 + "px" };

  return (
    <div ref={rootRef} className={cx(s.toy, vm.frozen && s.frozen)} onFocus={on?.focusIn} onBlur={on?.focusOut}>
      {/* ── Left: the files tray, their network, Send ── */}
      <div className={s.left} role="group" aria-label="Your send">
        <div className={s.card}>
          <div className={s.cardH}>
            <span className={s.cardT}>Files</span>
            <span className={s.muted}>{vm.filesMeta}</span>
          </div>
          <ul className={s.flist} aria-label="Files to send">
            {vm.fileRows.map((f) => (
              <li key={f.key} className={cx(s.frow, f.fx && s.fx)}>
                <span className={s.fi}><FileGlyph kind={f.kind} size={16} /></span>
                <span className={s.fname}>{f.name}</span>
                <span className={s.fsize}>{f.size}</span>
                <button type="button" id={f.domId} className={s.x} aria-label={f.aria} aria-disabled={f.locked || undefined} onClick={on ? () => on.removeFile(f.id) : undefined}>
                  <Ic name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" id="ss-addfile" className={cx(s.add, vm.addFile.dis && s.dis)} aria-disabled={vm.addFile.dis || undefined} aria-label={vm.addFile.aria} onClick={on?.addFile}>
            <Ic name="plus" size={14} />
            Add a file
          </button>
          {vm.note && vm.note.where === "files" && (
            <p className={s.note}>
              <span className={s.noteIc}><Ic name="info" size={14} /></span>
              <span>{vm.note.text}</span>
            </p>
          )}
        </div>

        <div className={s.card}>
          <div className={s.cardH}>
            <span className={s.cardT} id="ss-net-l">Their network</span>
            <span className={s.muted}>Pick one</span>
          </div>
          <div className={cx(s.chips, vm.nets.length === 2 && s.chips2)} role="group" aria-labelledby="ss-net-l">
            {vm.nets.map((n) => (
              <button key={n.id} type="button" id={"ss-net-" + n.id} className={cx(s.chip, n.on && s.on)} aria-pressed={n.on} aria-label={n.aria} onClick={on ? () => on.pickNet(n.id) : undefined}>
                <span className={s.chipN}>{n.name}</span>
                <span className={s.chipR}><Ic name={n.relay ? "wave" : "arrowRight"} size={12} />{n.route}</span>
              </button>
            ))}
          </div>
          <p className={s.hint}>{vm.netHint}</p>
        </div>

        <button type="button" id="ss-send" className={cx(s.send, vm.send.end && s.end)} onClick={on?.send}>
          <span className={s.drop} aria-hidden="true" />
          {vm.send.text}
        </button>
      </div>

      {/* ── Centre: the playable stage ── */}
      <div className={s.stageCol}>
        <div className={s.demoM}><Demo vm={vm} on={on} id="ss-pp-m" /></div>
        <div className={s.stage} role="group" aria-label="Send simulation" style={stageVars}>
          <div className={s.linkcard}>
            {vm.sharing ? (
              <div key={vm.linkKey} className={cx(s.lcIn, vm.linkFx && s.fx)}>
                <div className={s.qr} aria-hidden="true">
                  <svg viewBox="0 0 21 21" shapeRendering="crispEdges"><path d={vm.qrD} /></svg>
                </div>
                <div className={s.lcTxt}>
                  <div className={s.lcTop}>
                    <span className={cx(s.badge, s.badgeOk)}><span className={s.badgeDot} />Sharing</span>
                    <span className={s.muted}>{vm.shareStatus}</span>
                  </div>
                  <div className={s.link}><span className={s.linkH}>markdrop.in</span>/share/{vm.linkId}</div>
                  <div className={s.lcRow}>
                    <span className={s.fakeBtn} aria-hidden="true"><Ic name="copy" size={14} />Copy link</span>
                    <span className={s.muted}>or scan the QR code</span>
                  </div>
                </div>
              </div>
            ) : (
              <div key={vm.linkKey} className={cx(s.lcIn, vm.linkFx && s.fx)}>
                <div className={s.qrPh} aria-hidden="true"><Ic name="link" size={20} /></div>
                <div className={s.lcTxt}>
                  <span className={s.muted}>{vm.setupStatus}</span>
                  <div className={cx(s.link, s.linkPh)}>
                    <span>markdrop.in/share/</span>
                    <span aria-hidden="true">······</span>
                    <span className={s.sr}>(no link yet)</span>
                  </div>
                  <span className={s.muted}>Press Send to get a link and a QR code.</span>
                </div>
              </div>
            )}
          </div>

          <div className={s.world}>
            <svg className={s.wsvg} width={STAGE_W} height={STAGE_H} viewBox={"0 0 " + STAGE_W + " " + STAGE_H} aria-hidden="true" focusable="false">
              {vm.people.map((p) => <path key={p.id} d={p.d} className={cx(s.wire, WIRE_ST[p.st])} />)}
            </svg>
            <svg className={s.wsvgN} width={N_PILL_X} height={vm.narrow.h} viewBox={"0 0 " + N_PILL_X + " " + vm.narrow.h} aria-hidden="true" focusable="false">
              {vm.people.map((p) => <path key={p.id} d={p.dn} className={cx(s.wire, WIRE_ST[p.st])} />)}
            </svg>

            {vm.packets.map((k) => {
              const v: Vars = { "--pd": "path('" + k.d + "')", "--pn": "path('" + k.dn + "')", "--rest": k.rest + "%", animationDuration: k.dur + "s", animationDelay: "-" + k.delay + "s" };
              return <span key={k.key} className={s.pk} style={v} aria-hidden="true" />;
            })}

            <div className={s.sender}>
              <div className={s.scr} aria-hidden="true">{vm.senderFiles.map((id) => <span key={id} className={s.sf} />)}</div>
              <div className={s.base} aria-hidden="true" />
              <div className={s.youTx}>
                <span className={s.you}>You</span>
                <span className={s.youS}><span>{vm.sizeLine.count}</span><span className={s.youSep}> · </span><span>{vm.sizeLine.size}</span></span>
              </div>
            </div>

            {vm.relay.show && (
              <div className={cx(s.relay, vm.relay.used && s.used, vm.relay.on && s.relayOn)}>
                <div className={s.relayC}>
                  <Ic name="wave" size={20} />
                  <span className={s.lock}><Ic name="lock" size={10} /></span>
                </div>
                <span className={s.relayT}>Encrypted relay</span>
                <span className={s.relayS}>{vm.relay.text}</span>
              </div>
            )}

            <div className={s.people} role="list" aria-label="People with the link">
              {vm.people.map((p) => {
                const v: Vars = { "--x": p.x + "px", "--y": p.y - 26 + "px", "--ny": p.ny - 26 + "px" };
                return (
                  <div key={p.id} role="listitem" className={cx(s.pill, PILL_ST[p.st], p.fx && s.fx, p.rip && s.rip)} style={v}>
                    <div className={s.pillR}>
                      <span className={cx(s.avatar, p.neutral && s.avatarN)} aria-hidden="true">{p.initials}</span>
                      <span className={s.pillTx} aria-hidden="true">
                        <span className={s.pillN}>{p.first}</span>
                        <span className={s.pillS}>{p.status}</span>
                      </span>
                      <span className={cx(s.pillRoute, p.relay ? s.routeRelay : s.routeDirect)} title={p.routeName} aria-hidden="true">
                        <Ic name={p.relay ? "wave" : "arrowRight"} size={12} />
                      </span>
                      <span className={s.sr}>{p.name}. {p.sr}</span>
                    </div>
                    <div className={cx(s.prog, p.done && s.progDone)} aria-hidden="true"><span style={{ width: p.pv + "%" }} /></div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={s.bar}>
            <div className={s.barL}>
              <span className={s.cardT}>{vm.peopleCount}</span>
              {vm.note && vm.note.where === "people" ? (
                <span className={s.barNote}><span className={s.noteIc}><Ic name="info" size={12} /></span><span>{vm.note.text}</span></span>
              ) : (
                <span className={s.muted}>Anyone with the link can join, up to 10.</span>
              )}
            </div>
            <div className={s.barBtns}>
              <button type="button" id="ss-rmp" className={cx(s.pbtn, vm.rmPerson.dis && s.dis)} aria-disabled={vm.rmPerson.dis || undefined} onClick={on?.removePerson}>
                <Ic name="minus" size={14} />Remove a person
              </button>
              <button type="button" id="ss-addp" className={cx(s.pbtn, s.pbtnAdd, vm.addPerson.dis && s.dis)} aria-disabled={vm.addPerson.dis || undefined} onClick={on?.addPerson}>
                <Ic name="plus" size={14} />Add a person
              </button>
            </div>
          </div>

          {vm.confirm.open && (
            <div className={s.confirm}>
              <div className={s.dlg} role="alertdialog" aria-modal="true" aria-labelledby="ss-cf-t" aria-describedby="ss-cf-b">
                <h3 id="ss-cf-t" className={s.dlgT}>End sharing?</h3>
                <p id="ss-cf-b" className={s.dlgB}>{vm.confirm.body}</p>
                {vm.confirm.who.length > 0 && (
                  <div className={s.dlgWho}>{vm.confirm.who.map((w) => <span key={w} className={cx(s.badge, s.badgeWarn)}>{w}</span>)}</div>
                )}
                <div className={s.dlgRow}>
                  <button type="button" id="ss-keep" className={s.dbtn} onClick={on?.keep} onKeyDown={on?.confirmKey}>Keep sharing</button>
                  <button type="button" id="ss-end" className={cx(s.dbtn, s.danger)} onClick={on?.end} onKeyDown={on?.confirmKey}>End sharing</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Right: their side, what Markdrop keeps, the route ── */}
      <div className={s.right} role="group" aria-label="How it works">
        <div className={cx(s.card, s.tabsCard)}>
          <div className={s.tabsH}>
            <span className={s.cardT}>On their side</span>
            <div className={s.tabs} role="tablist" aria-label="Receive in">
              {TABS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="tab"
                  id={"ss-tab-" + t.value}
                  className={s.tab}
                  aria-selected={vm.tab === t.value}
                  aria-controls={"ss-panel-" + t.value}
                  tabIndex={vm.tab === t.value ? 0 : -1}
                  onClick={on ? () => on.tab(t.value) : undefined}
                  onKeyDown={on?.tabKey}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className={s.pane} role="tabpanel" id="ss-panel-browser" aria-labelledby="ss-tab-browser" tabIndex={0} hidden={vm.tab !== "browser"}>
            <div className={s.mini}>
              <div className={s.miniBar}><span className={s.dots} aria-hidden="true"><span /><span /><span /></span><span>{vm.linkShort}</span></div>
              <div className={s.miniBody}>
                {vm.recvFiles.map((rf) => (
                  <div key={rf.id} className={s.rrow}><FileGlyph kind={rf.kind} size={14} /><span className={s.rn}>{rf.name}</span><span className={s.rz}>{rf.size}</span></div>
                ))}
                {vm.recvMore && <span className={s.muted}>{vm.recvMore}</span>}
                <span className={s.save} aria-hidden="true">Save all</span>
              </div>
            </div>
            <p className={s.cap}>They open the link or scan the QR code.</p>
          </div>
          <div className={s.pane} role="tabpanel" id="ss-panel-cli" aria-labelledby="ss-tab-cli" hidden={vm.tab !== "cli"}>
            <div className={s.cli}>
              <div className={s.cliH}>
                <span className={s.muted}>Send a file or a folder</span>
                <button type="button" id="ss-copy-send" className={s.copy} aria-label={vm.copied === "send" ? "Copied the send command" : "Copy the send command"} onClick={on ? () => on.copy("send", vm.sendCmd) : undefined}>
                  <Ic name={vm.copied === "send" ? "check" : "copy"} size={14} />{vm.copied === "send" ? "Copied" : "Copy"}
                </button>
              </div>
              <code className={s.code}><span className={s.pr} aria-hidden="true">$</span>{vm.sendCmd}</code>
            </div>
            <div className={s.cli}>
              <div className={s.cliH}>
                <span className={s.muted}>Receive in a terminal</span>
                <button type="button" id="ss-copy-get" className={s.copy} aria-label={vm.copied === "get" ? "Copied the receive command" : "Copy the receive command"} onClick={on ? () => on.copy("get", vm.getCmd) : undefined}>
                  <Ic name={vm.copied === "get" ? "check" : "copy"} size={14} />{vm.copied === "get" ? "Copied" : "Copy"}
                </button>
              </div>
              <code className={s.code}><span className={s.pr} aria-hidden="true">$</span>{vm.getCmd}</code>
            </div>
            <p className={s.cap}>Browsers and terminals share one link.</p>
          </div>
        </div>

        <div className={s.card}>
          <div className={s.cardH}>
            <span className={s.cardT}>What Markdrop keeps</span>
            <span className={s.muted}>Never the files</span>
          </div>
          <dl className={s.keeps}>
            <div className={s.keepRow}><dt className={s.kl}><span className={s.ki}><Ic name="check" size={12} /></span>File names</dt><dd className={s.kv}>{vm.keeps.names}</dd></div>
            <div className={s.keepRow}><dt className={s.kl}><span className={s.ki}><Ic name="check" size={12} /></span>Size</dt><dd className={s.kv}>{vm.keeps.size}</dd></div>
            <div className={s.keepRow}><dt className={s.kl}><span className={s.ki}><Ic name="check" size={12} /></span>Count</dt><dd className={s.kv}>{vm.keeps.count}</dd></div>
            <div className={s.keepRow}><dt className={s.kl}><span className={cx(s.ki, s.kiNo)}><Ic name="x" size={12} /></span>The files</dt><dd className={cx(s.kv, s.kvNo)}>Never stored</dd></div>
          </dl>
          <p className={s.keepAlso}>Also file types, a hashed IP, your account if signed in, and connection details.</p>
        </div>

        <div className={s.card}>
          <div className={s.cardH}>
            <span className={s.cardT}>Route</span>
            <span className={s.muted}>Per person</span>
          </div>
          <div className={cx(s.route, vm.routes.direct.dim && s.dim)}>
            <div className={s.routeH}><span className={cx(s.badge, s.badgeOk)}><Ic name="arrowRight" size={12} />Direct</span><span className={s.muted}>{vm.routes.direct.count}</span></div>
            <p>Device to device, when the network allows.</p>
          </div>
          {vm.routes.relay.show && (
            <div className={cx(s.route, vm.routes.relay.dim && s.dim)}>
              <div className={s.routeH}><span className={cx(s.badge, s.badgeInfo)}><Ic name="wave" size={12} />Relayed</span><span className={s.muted}>{vm.routes.relay.count}</span></div>
              <p>{RELAY_SENTENCE}</p>
            </div>
          )}
          <div className={s.enc}><span className={s.encIc}><Ic name="lock" size={12} /></span>Encrypted device to device</div>
        </div>
      </div>

      {/* ── Footer: a small goal and the demo control ── */}
      <div className={s.foot}>
        <div className={s.goalW} role="group" aria-label="Deliveries by network">
          <span className={s.goalL}>{vm.goal.label}</span>
          {vm.goal.chips.map((g) => (
            <span key={g.id} className={cx(s.goal, g.on && s.goalOn)}>
              <Ic name={g.on ? "check" : "minus"} size={12} />
              {g.name}
              <span className={s.sr}>{g.on ? ", delivered" : ", not yet"}</span>
            </span>
          ))}
          <span className={s.goalN}>{vm.goal.count}</span>
          {vm.goal.all && <span className={cx(s.badge, s.badgeOk, s.badgeMd)}><Ic name="check" size={12} />Every network tried</span>}
        </div>
        <div className={s.demo}><Demo vm={vm} on={on} id="ss-pp" /></div>
      </div>

      <p className={s.sr} aria-live="polite">{vm.live}</p>
    </div>
  );
}
