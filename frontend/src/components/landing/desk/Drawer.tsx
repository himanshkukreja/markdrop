"use client";

import { useEffect, useRef, useState } from "react";
import LoopVideo from "@/components/guides-landing/LoopVideo";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { track } from "@/lib/track";
import { Icon, VSCodeIcon } from "../ds";
import s from "./Sections.module.css";

const VSCODE_URL = "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop";

/**
 * 5 · "The good tools are in the drawer." The drawer slides open when it scrolls into view (or with
 * its button); inside, the real tools, recorded with fictional Acme data on the sandbox stack: VS Code
 * with the Markdrop extension, an AI app calling Markdrop's MCP tools, and the markdrop CLI. Each is a
 * muted loop (LoopVideo: poster first, plays only on screen, paused under reduced motion).
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
    <section id="tools" ref={ref} aria-labelledby="tools-h" className={s.section}>
      <div className={s.headRow} style={{ marginBottom: 32 }}>
        <div className={s.headCol} style={{ maxWidth: 720 }}>
          <span className={s.eyebrow}>Editor, terminal, AI</span>
          <h2 id="tools-h" className={s.h2}>
            The good tools are in the drawer.
          </h2>
        </div>
        <button type="button" className="md-btn md-btn--secondary md-btn--md" onClick={toggle} aria-expanded={open} aria-controls="tools-drawer">
          {open ? "Close the drawer" : "Open the drawer"}
          <Icon name={open ? "minus" : "plus"} />
        </button>
      </div>
      <div className={s.drawerBox}>
        <div id="tools-drawer" className={s.drawer} data-open={open ? "" : undefined} inert={!open}>
          <div>
            <div className={s.tray}>
              <div className={s.tool} style={{ "--r": "-0.8deg" } as React.CSSProperties}>
                <span className={s.toolHead}>
                  <VSCodeIcon size={20} />
                  VS Code
                </span>
                <div className={s.toolShot}>
                  <LoopVideo src="/landing-desk/vscode" w={1100} h={948} label="VS Code with the Markdrop extension: Publish to Markdrop in the status bar shows Published to markdrop.in/release-notes; then an edit to the file, and the status bar says Markdrop: synced." />
                </div>
                <p className={s.toolText}>
                  Publish from the status bar. Save the file and the page updates; edit on the web and the file on your disk follows.{" "}
                  <a className={s.more} href={VSCODE_URL} data-cta="tools_vscode">
                    Get the extension
                  </a>
                </p>
              </div>
              <div className={s.tool} style={{ "--r": "0.6deg" } as React.CSSProperties}>
                <span className={s.toolHead}>
                  <Icon name="sparkle" />
                  Your AI app
                </span>
                <div className={s.toolShot}>
                  <LoopVideo src="/landing-desk/ai-chat" w={760} h={742} label="An AI app asked to turn meeting notes into a Markdrop doc: it calls Markdrop's publish_document tool and answers with the link markdrop.in/launch-sync." />
                </div>
                <p className={s.toolText}>
                  Claude, ChatGPT or Cursor, over MCP. Ask it to publish and it hands you the link; ask for a fix later and the same link updates.{" "}
                  <a className={s.more} href="/mcp" data-cta="tools_mcp">
                    Connect an AI app
                  </a>
                </p>
              </div>
              <div className={`${s.tool} ${s.toolWide}`} style={{ "--r": "0.3deg" } as React.CSSProperties}>
                <div className={s.toolShot}>
                  <LoopVideo src="/landing-desk/terminal" w={1600} h={370} label="The markdrop CLI: markdrop upload demo.mp4 publishes it at markdrop.in/demo; markdrop replace demo demo-v2.mp4 makes version 2 on the same link." />
                </div>
                <span className={s.toolHead}>
                  <Icon name="terminal" />
                  Terminal
                </span>
                <p className={s.toolText}>
                  <code>markdrop upload</code> gives you a link. <code>markdrop replace</code> keeps it and adds a version. <code>markdrop send</code> goes straight to their device.{" "}
                  <a className={s.more} href={docsUrl(DOCS_PAGES.cliInstall)} data-cta="tools_cli">
                    Install the CLI
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className={s.handle} aria-hidden="true">
          <span />
        </div>
      </div>
    </section>
  );
}
