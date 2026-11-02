"use client";

import { useId, useState } from "react";
import { Alert, Button, CopyButton, Icon, RadioGroup, cx } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { docsErrorMessage, startGuideExport, type GuideExport } from "@/lib/docsSites";
import { formatBytes } from "../format";
import { useSite } from "../SiteContext";
import { SectionHeader, SettingsCard } from "./SettingsShell";
import { blurbOf } from "./sections";

export const SELF_HOST_IMAGE = "ghcr.io/himanshkukreja/markdrop-guides";

/** The command that serves an exported folder (the same one the docs and the zip's README give). */
export function dockerRun(folder: string): string {
  return `docker run --rm -p 8080:8080 \\\n  -v "$PWD/${folder}:/site:ro" \\\n  -v markdrop-guides-data:/data \\\n  ${SELF_HOST_IMAGE}`;
}

/** What a self-hosted copy keeps, and what stays with Markdrop (docs: /guides/self-hosting). */
const WORKS = [
  "Every page, the sidebar, tabs and redirects",
  "Your theme, custom theme, fonts and logo",
  "Search, link previews and light/dark mode",
  "The changelog with its RSS feed",
  "The API reference, Try it included",
  "Videos and the Markdrop files your pages embed",
  "llms.txt, a Markdown copy of each page and the MCP server",
];
const NEEDS_MARKDROP = [
  "The editor, reviews and roles: you edit the Markdown files",
  "Ask AI: it runs on Markdrop's API, for the guide's Markdrop addresses only",
  "Insights, the Fix list and \"Did this page help?\"",
  "Private pages, passwords and members-only sign-in",
  "GitHub sync and one-click publishing",
];

/**
 * Settings › Export & self-host: download the guide as the content folder the open-source engine
 * builds (the live publish or the drafts; private content left out or made public), and how to run
 * it with one docker command. Admins only (backend/app/routers/docs_site_export.py).
 */
export default function ExportSection() {
  const { site, isAdmin } = useSite();
  const uid = useId();
  const published = !!(site.live_build_id || site.live_build);
  const [source, setSource] = useState<GuideExport["source"]>(published ? "published" : "drafts");
  const [privacy, setPrivacy] = useState<GuideExport["private"]>("omit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<GuideExport | null>(null);
  const folder = (site.slug || "my-guide").toLowerCase();
  const gated = site.settings.access.level !== "public";

  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const out = await startGuideExport(site.id, { source, private: privacy });
      setDone(out);
      // An attachment: the browser saves it as it arrives and stays on this page.
      window.location.assign(out.url);
    } catch (e) {
      setError(docsErrorMessage(e, "The export didn't start. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader title="Export & self-host" description={blurbOf("export")} />

      {!isAdmin ? (
        <SettingsCard>
          <p className="text-body text-text-secondary">Only Guides admins can export a guide.</p>
        </SettingsCard>
      ) : (
        <SettingsCard
          id="export"
          title="Download the content folder"
          description={<>Every page as Markdown, with the sidebar, theme, brand, redirects, changelog, API reference and the images and files your pages use. It&apos;s the folder the open-source engine builds, so you can leave or keep a copy any time.</>}
        >
          {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}
          {gated && (
            <Alert tone="warning" title="A self-hosted copy has no sign-in">
              This guide is {site.settings.access.level === "password" ? "password-protected" : "members-only"} here. On your own server anyone who can reach it can read it, unless you put your own sign-in in front.
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <p id={`${uid}-src`} className="text-body-strong text-text">What to export</p>
              <RadioGroup
                name={`${uid}-source`}
                aria-labelledby={`${uid}-src`}
                value={source}
                onChange={(v) => setSource(v as GuideExport["source"])}
                options={[
                  { value: "published", label: "The live guide", description: published ? "What readers see now." : "Publish the guide first.", disabled: !published },
                  { value: "drafts", label: "The drafts", description: "Everything as it is in the editor, unpublished changes included." },
                ]}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <p id={`${uid}-pv`} className="text-body-strong text-text">Private pages and sections</p>
              <RadioGroup
                name={`${uid}-private`}
                aria-labelledby={`${uid}-pv`}
                value={privacy}
                onChange={(v) => setPrivacy(v as GuideExport["private"])}
                options={[
                  { value: "omit", label: "Leave them out", description: "A self-hosted guide has no reader sign-in." },
                  { value: "public", label: "Include them as public pages", description: "Anyone who can open your copy reads them." },
                ]}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" iconLeft="download" loading={busy} onClick={() => void download()}>Download .zip</Button>
            {done && (
              <p className="text-[13px] text-text-muted" role="status">
                <span className="ph-sensitive ph-mask">{done.filename}</span>: {done.pages} page{done.pages === 1 ? "" : "s"}, {done.files} file{done.files === 1 ? "" : "s"}, {formatBytes(done.bytes)}.{" "}
                <a className="font-semibold text-accent-text underline-offset-2 hover:underline" href={done.url}>Download again</a>
              </p>
            )}
          </div>
          {done && done.notes.length > 0 && (
            <ul className="flex flex-col gap-1 text-[13px] text-text-secondary">
              {done.notes.map((n) => (
                <li key={n} className="flex gap-2"><Icon name="info" size={14} className="mt-0.5 shrink-0 text-text-muted" />{n}</li>
              ))}
            </ul>
          )}
        </SettingsCard>
      )}

      <SettingsCard
        id="self-host"
        title="Run it on your own server"
        description={<>The engine behind Markdrop Guides is open source (MIT). Unzip the folder, then serve it with one command. <ReadMore topic="studioSelfHost">Self-hosting steps</ReadMore></>}
      >
        <div className="relative min-w-0 rounded-lg border border-border bg-surface-raised">
          <pre className="ph-no-capture overflow-x-auto p-3.5 pr-24 font-mono text-[13px] leading-5 text-text"><code>{dockerRun(folder)}</code></pre>
          <div className="absolute right-2 top-2">
            <CopyButton text={dockerRun(folder).replace(/\\\n\s*/g, "")} label="Copy" size="sm" variant="secondary" announceText="Command copied" />
          </div>
        </div>
        <p className="text-[13px] text-text-muted">
          Then open <code className="font-mono">http://localhost:8080</code>. Set <code className="font-mono">url</code> in <code className="font-mono">site.json</code> to the address readers will use, and point your own domain at the server. No Docker? The docs show how to run it with Node 22.
        </p>
      </SettingsCard>

      <SettingsCard id="self-host-compare" title="What your copy does">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <List title="Works on your server" icon="check" items={WORKS} tone="ok" />
          <List title="Stays with Markdrop" icon="x" items={NEEDS_MARKDROP} tone="muted" />
        </div>
      </SettingsCard>
    </>
  );
}

function List({ title, icon, items, tone }: { title: string; icon: string; items: string[]; tone: "ok" | "muted" }) {
  return (
    <div className="min-w-0">
      <p className="mb-2 text-body-strong text-text">{title}</p>
      <ul className="flex flex-col gap-1.5">
        {items.map((t) => (
          <li key={t} className="flex gap-2 text-body text-text-secondary">
            <Icon name={icon} size={15} className={cx("mt-0.5 shrink-0", tone === "ok" ? "text-success" : "text-text-muted")} />
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}
