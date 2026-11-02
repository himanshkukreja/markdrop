import LoopVideo from "@/components/guides-landing/LoopVideo";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { ButtonLink, Icon } from "../ds";
import { SnapSection } from "@/components/marketing/snap/Snap";
import s from "./Sections.module.css";
import v from "./Send.module.css";

/**
 * 7 · Send, peer to peer (markdrop.in/share). The copy says what it does and how it stays private
 * (docs: share/send-files); the desk shows it: the sender's laptop and the receiver's iPhone on the
 * mat with the path between them. Both screens are the real /share flow, recorded for the series
 * video 10 on the local stack (fictional files): the laptop waits for someone to open the link,
 * then the iPhone connects (Direct); the iPhone connects, its files are ready, the photos arrive
 * and "Save 6 photos to your phone" appears (sped up). Muted loops (LoopVideo: poster first, play
 * only on screen, paused under reduced motion). Server HTML; the drawing's labels are aria-hidden
 * (the copy and the loops' text alternatives say it). No speed claims.
 */
export default function Send() {
  return (
    <SnapSection id="send" labelledBy="send-h">
      <div className={s.split}>
        <div className={s.copy}>
          <span className={s.eyebrow}>Send, peer to peer</span>
          <h2 id="send-h" className={s.h2}>
            Hand files straight to another device.
          </h2>
          <p className={s.lede}>Drop files or a whole folder and share the link. They go from your device to theirs while your tab is open, encrypted, and nothing is stored on Markdrop.</p>
          <ul className={s.points}>
            <li>
              <Icon name="qr" />
              <span>
                <b>A link or a QR code</b> for up to 10 people at once, each choosing what to download.
              </span>
            </li>
            <li>
              <Icon name="shield" />
              <span>
                <b>Encrypted in transit</b> (WebRTC, DTLS). If a network blocks the direct path, a relay forwards the encrypted bytes; it can&apos;t read them.
              </span>
            </li>
            <li>
              <Icon name="user" />
              <span>
                <b>No account on either side.</b> On an iPhone, one tap saves the photos to Photos or Files.
              </span>
            </li>
            <li>
              <Icon name="terminal" />
              <span>
                <b>From a terminal:</b> <code>markdrop send</code> and <code>markdrop get</code> work with the browser both ways.
              </span>
            </li>
          </ul>
          <div className={s.btnRow}>
            <ButtonLink href="/share" variant="primary" iconLeft="send" data-cta="send_open">
              Send files
            </ButtonLink>
            <a className={s.more} href={docsUrl(DOCS_PAGES.sendFiles)} data-cta="send_docs">
              How sending works
              <Icon name="arrowRight" />
            </a>
          </div>
        </div>

        <div className={s.fitBox} style={{ "--cw": "760px", "--ch": "600px" } as React.CSSProperties}>
          <div className={s.fitCanvas}>
            <div className={v.mat}>
              <svg className={v.path} viewBox="0 0 760 600" aria-hidden="true">
                <path d="M452 196 C 500 196, 486 330, 520 330" />
              </svg>

              <div className={v.laptop}>
                <span className={v.tag} aria-hidden="true">
                  <Icon name="laptop" />
                  Your laptop · sending
                </span>
                <div className={v.lid}>
                  <div className={v.screen}>
                    <LoopVideo
                      src="/landing-desk/p2p-send"
                      w={1120}
                      h={576}
                      label="Markdrop's Send page on a laptop, sharing 25 files: the link markdrop.in/share/1859caee45 with Copy link and a QR code, waiting for someone to open it; then an iPhone in Safari connects, directly, and is browsing the files."
                    />
                  </div>
                </div>
                <span className={v.base} aria-hidden="true" />
              </div>

              <div className={v.phone}>
                <span className={v.tag} aria-hidden="true">
                  <Icon name="phone" />
                  Their iPhone
                </span>
                <div className={v.phoneBody}>
                  <div className={v.phoneScreen}>
                    <LoopVideo
                      src="/landing-desk/p2p-receive"
                      w={400}
                      h={866}
                      label="The same share opened on an iPhone: Connecting to the sender, then 25 files are ready with a Direct badge; the photos arrive one by one, each with Save, and the button at the bottom reads Save 6 photos to your phone."
                    />
                  </div>
                </div>
              </div>

              <div className={v.legend} aria-hidden="true">
                <span className={v.route} data-on="">
                  <i />
                  Direct, encrypted
                </span>
                <span className={v.route}>
                  <i />
                  Blocked network? Relayed, still encrypted
                </span>
              </div>

              <span className={v.note} aria-hidden="true">
                nothing stored
                <br />
                on our servers.
              </span>
            </div>
          </div>
        </div>
      </div>
    </SnapSection>
  );
}
