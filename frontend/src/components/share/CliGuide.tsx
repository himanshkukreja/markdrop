"use client";

/** "Prefer the terminal? Use the CLI" (REVAMP_PLAN 7.16): pill Tabs Send/Receive, a CommandBlock, and the install rows. */
import { useState } from "react";
import { Disclosure, Icon, Tabs, cx } from "@/components/ui";
import { CommandBlock } from "@/components/kit/CommandBlock";
import ui from "./share.module.css";

export const INSTALL = [
  { os: "macOS", cmd: "brew install himanshkukreja/tap/markdrop" },
  { os: "Linux and macOS", cmd: "curl -fsSL https://github.com/himanshkukreja/markdrop/releases/latest/download/install.sh | sh" },
  { os: "Windows (PowerShell)", cmd: "irm https://github.com/himanshkukreja/markdrop/releases/latest/download/install.ps1 | iex" },
];

const PERKS: Array<[string, string]> = [
  ["Whole folders", "Point it at a directory: it's zipped, sent, and unzipped on arrival."],
  ["No size limit", "Streams straight to disk, so browser memory doesn't cap it."],
  ["Scriptable", "-o picks where to save, -y accepts without asking."],
  ["Works with the browser", "Same protocol as this page, so a terminal and a browser can trade files."],
];

export default function CliGuide({ className }: { className?: string }) {
  const [tab, setTab] = useState<"send" | "receive">("send");
  return (
    <section id="cli" aria-labelledby="share-cli" className={cx("min-w-0 rounded-2xl border border-border bg-surface p-5", ui.card, className)}>
      <h2 id="share-cli" className="flex items-center gap-2 text-h4 text-text">
        <Icon name="terminal" size={16} className="text-accent-text" />
        Prefer the terminal? Use the CLI
      </h2>
      <p className="mt-1 text-caption text-text-secondary">
        Install once, then send and receive from your shell. It works with the browser both ways.
      </p>

      <Tabs className="mt-4" variant="pill" size="sm" idPrefix="share-cli" aria-label="CLI direction" value={tab}
        onChange={(v) => setTab(v as "send" | "receive")}
        items={[{ value: "send", label: "Send" }, { value: "receive", label: "Receive" }]} />

      <div className="mt-3" role="tabpanel" id={`share-cli-panel-${tab}`} aria-labelledby={`share-cli-tab-${tab}`}>
        {tab === "send" ? (
          <>
            <CommandBlock command="markdrop send report.pdf" />
            <p className="mt-2 text-caption text-text-secondary">
              Prints a share link and a QR code. Open it in a browser or another terminal. Pass a folder to send a whole directory.
            </p>
          </>
        ) : (
          <>
            <CommandBlock command="markdrop get <room-id | link>" />
            <p className="mt-2 text-caption text-text-secondary">
              Takes a bare ID or a full markdrop.in/share link. Add <code className="font-mono text-accent-text">-o</code> to choose where to save, <code className="font-mono text-accent-text">-y</code> to skip the prompt.
            </p>
          </>
        )}
      </div>

      <ul className="mt-4 grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {PERKS.map(([t, d]) => (
          <li key={t} className="flex gap-2 text-caption text-text-secondary">
            <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent-text" />
            <span><strong className="font-semibold text-text">{t}.</strong> {d}</span>
          </li>
        ))}
      </ul>

      <Disclosure className="mt-4" summary="Install the CLI">
        <div className="mt-3 space-y-3">
          {INSTALL.map(({ os, cmd }) => <CommandBlock key={os} label={os} command={cmd} />)}
        </div>
      </Disclosure>
    </section>
  );
}
