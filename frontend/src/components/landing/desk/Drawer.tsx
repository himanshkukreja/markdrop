"use client";

import { useEffect, useRef, useState } from "react";
import LoopVideo from "@/components/guides-landing/LoopVideo";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { track } from "@/lib/track";
import { Icon, VSCodeIcon } from "../ds";
import s from "./Sections.module.css";
import { SnapSection } from "@/components/marketing/snap/Snap";

const VSCODE_URL = "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop";

/**
 * 6 · Your tools. The copy names each way in (VS Code, AI apps over MCP, the CLI, sending a file
 * device to device), with a link for each. The desk: a drawer that slides open when the section
 * comes into view (or with its button); inside, the real tools, recorded with fictional Acme data on
 * the sandbox stack. Each is a muted loop (LoopVideo: poster first, plays only on screen, paused
 * under reduced motion). From 900px the drawer is drawn at 720 × 680 and scaled to fit (.fitCanvas).
 */
export default function Drawer() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const auto = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setOpen(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting) && !auto.current) {
          auto.current = true;
          setOpen(true);
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const toggle = () => {
    auto.current = true;
    setOpen((o) => {
      track("landing_drawer", { open: !o });
      return !o;
    });
  };

  return (
    <SnapSection id="tools" ref={ref} labelledBy="tools-h">
      <div className={`${s.split} ${s.splitRev}`}>
        <div className={s.copy}>
          <span className={s.eyebrow}>Editor, terminal, AI</span>
          <h2 id="tools-h" className={s.h2}>
            Publish from where you already work.
          </h2>
          <p className={s.lede}>Your editor, your terminal and your AI app can all publish to Markdrop, and update the same link later.</p>
          <ul className={s.points}>
            <li>
              <span className={s.pointIcon}>
                <VSCodeIcon size={18} />
              </span>
              <span>
                <b>VS Code:</b> save the file and the page updates; edit on the web and your file follows.{" "}
                <a className={s.more} href={VSCODE_URL} data-cta="tools_vscode">
                  Get the extension
                </a>
              </span>
            </li>
            <li>
              <Icon name="sparkle" />
              <span>
                <b>AI apps:</b> Claude, ChatGPT, Cursor and others publish and update links through Markdrop&apos;s MCP server.{" "}
                <a className={s.more} href="/mcp" data-cta="tools_mcp">
                  Connect an AI app
                </a>
              </span>
            </li>
            <li>
              <Icon name="terminal" />
              <span>
                <b>Terminal:</b> <code>markdrop upload</code> gives you a link; <code>markdrop replace</code> adds a version to it.{" "}
                <a className={s.more} href={docsUrl(DOCS_PAGES.cliInstall)} data-cta="tools_cli">
                  Install the CLI
                </a>
              </span>
            </li>
            <li>
              <Icon name="send" />
              <span>
                <b>Send a file</b> of any size straight to another device. Nothing is stored, and neither of you needs an account.{" "}
                <a className={s.more} href={docsUrl(DOCS_PAGES.sendFiles)} data-cta="tools_send">
                  How sending works
                </a>
              </span>
            </li>
          </ul>
        </div>

        <div className={s.fitBox} style={{ "--cw": "720px", "--ch": "700px" } as React.CSSProperties}>
          <div className={s.fitCanvas}>
            <div className={s.drawerBox}>
              <div className={s.drawerFront}>
                <span className={s.handle} aria-hidden="true">
                  <span />
                </span>
                <button type="button" className="md-btn md-btn--secondary md-btn--sm" onClick={toggle} aria-expanded={open} aria-controls="tools-drawer">
                  {open ? "Close the drawer" : "Open the drawer"}
                  <Icon name={open ? "minus" : "plus"} />
                </button>
              </div>
              <div id="tools-drawer" className={s.drawer} data-open={open ? "" : undefined} inert={!open}>
                <div>
                  <div className={s.tray}>
                    <div className={s.tool} style={{ "--r": "-0.8deg" } as React.CSSProperties}>
                      <span className={s.toolHead}>
                        <VSCodeIcon size={18} />
                        VS Code
                      </span>
                      <div className={s.toolShot}>
                        <LoopVideo src="/landing-desk/vscode" w={1100} h={948} label="VS Code with the Markdrop extension: Publish to Markdrop in the status bar shows Published to markdrop.in/release-notes; then an edit to the file, and the status bar says Markdrop: synced." />
                      </div>
                    </div>
                    <div className={s.tool} style={{ "--r": "0.6deg" } as React.CSSProperties}>
                      <span className={s.toolHead}>
                        <Icon name="sparkle" />
                        Your AI app
                      </span>
                      <div className={s.toolShot}>
                        <LoopVideo src="/landing-desk/ai-chat" w={760} h={742} label="An AI app asked to turn meeting notes into a Markdrop doc: it calls Markdrop's publish_document tool and answers with the link markdrop.in/launch-sync." />
                      </div>
                    </div>
                    <div className={`${s.tool} ${s.toolWide}`} style={{ "--r": "0.3deg" } as React.CSSProperties}>
                      <span className={s.toolHead}>
                        <Icon name="terminal" />
                        Terminal
                      </span>
                      <div className={s.toolShot}>
                        <LoopVideo src="/landing-desk/terminal" w={1600} h={370} label="The markdrop CLI: markdrop upload demo.mp4 publishes it at markdrop.in/demo; markdrop replace demo demo-v2.mp4 makes version 2 on the same link." />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SnapSection>
  );
}
