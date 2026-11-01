"use client";

/**
 * Settings › API reference (ApiReference.dc.html): the OpenAPI file a guide's endpoint pages are
 * generated from.
 *
 * Bring the file (drop it or choose it, or fetch an https URL), see what the checks found (title,
 * version, OpenAPI version, endpoints, groups, servers, sign-in types; each warning with what to do
 * about it), what readers will get (the endpoints by group), how it appears (name, its own tab or the
 * sidebar, Try it, fetch again at every publish for a URL), and publish it. Earlier versions are in a
 * drawer, to restore. Editors and admins change the file; the options are admin settings. Everything
 * reaches readers at the next publish. The description, its URL and its endpoints are the customer's
 * content: masked in session replays (ph-no-capture / ph-sensitive).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Alert, Anchor, Badge, Button, ConfirmDialog, Drawer, Field, Icon, Input, SegmentedControl, Skeleton, Switch, cx, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { docsErrorMessage, primaryAddress, publishSite, updateSite, type ApiReferenceSettings } from "@/lib/docsSites";
import {
  fetchApiSpec, getApiReference, removeApiSpec, restoreApiSpec, startFromSample, uploadApiSpec, type ApiReferenceStatus, type ApiSpecVersion,
} from "@/lib/docsApiReference";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { formatBytes, num, plural, timeAgo } from "../format";
import { useSite } from "../SiteContext";
import { OptionCard } from "./AccessSection";
import { SectionHeader, SettingsCard, SwitchRow } from "./SettingsShell";
import { SECTIONS } from "./sections";

const ACCEPT = ".json,.yaml,.yml,application/json,application/yaml,application/x-yaml,text/yaml";
const METHOD_TONE: Record<string, "success" | "info" | "warning" | "danger" | "neutral"> = {
  GET: "info",
  POST: "success",
  PUT: "warning",
  PATCH: "warning",
  DELETE: "danger",
};

function sourceText(v: ApiSpecVersion) {
  if (v.source.kind === "sample") return <>The sample file (a fictional Northwind API), added</>;
  if (v.source.kind === "url") return <>Fetched from <code className="ph-sensitive ph-mask font-mono [overflow-wrap:anywhere]">{v.source.url}</code></>;
  return <>Uploaded{v.source.filename ? <> as <span className="ph-sensitive ph-mask font-mono">{v.source.filename}</span></> : null}</>;
}

const fileLabel = (v: ApiSpecVersion) => v.source.filename || (v.source.kind === "url" ? "The file" : v.title);

export default function ApiReferenceSection() {
  const { site, setSite, reload, isAdmin, canEdit, base } = useSite();
  const toast = useToast();
  const uid = useId();
  const file = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const [st, setSt] = useState<ApiReferenceStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"" | "upload" | "url" | "remove" | "restore" | "options" | "sample" | "publish">("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"file" | "url">("file");
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const opts: ApiReferenceSettings = st?.settings ?? site.settings.api ?? { spec_id: null, label: "API reference", placement: "tab", try_it: true, refetch: false };
  const [label, setLabel] = useState(opts.label);

  const load = useCallback(() => {
    setLoadError("");
    getApiReference(site.id)
      .then((s) => {
        setSt(s);
        setLabel(s.settings.label);
        if (s.current?.source.kind === "url") setMode("url");
      })
      .catch((e) => setLoadError(docsErrorMessage(e, "The API reference didn't load.")));
  }, [site.id]);
  useEffect(load, [load]);

  /** A new status: the section, and the site's settings (Publishes counts the change). */
  const took = (s: ApiReferenceStatus) => {
    setSt(s);
    setSite({ ...site, settings: { ...site.settings, api: s.settings } });
  };

  async function run(what: typeof busy, fn: () => Promise<ApiReferenceStatus>, done: string) {
    setBusy(what);
    setError("");
    try {
      took(await fn());
      toast.success(done);
      return true;
    } catch (e) {
      setError(docsErrorMessage(e, "That didn't work. Try again."));
      return false;
    } finally {
      setBusy("");
    }
  }

  async function saveOptions(patch: Partial<Omit<ApiReferenceSettings, "spec_id">>, done: string) {
    if (!isAdmin) return;
    setBusy("options");
    setError("");
    try {
      const next = await updateSite(site.id, { settings: { api: patch } });
      setSite(next);
      if (next.settings.api && st) setSt({ ...st, settings: next.settings.api });
      toast.success(done);
    } catch (e) {
      setError(docsErrorMessage(e, "That didn't save. Try again."));
    } finally {
      setBusy("");
    }
  }

  const take = (f: File | undefined | null) => {
    if (!f || !canEdit || busy) return;
    void run("upload", () => uploadApiSpec(site.id, f), "Checked and saved. It goes live when you publish.");
  };

  async function publish() {
    setBusy("publish");
    setError("");
    try {
      await publishSite(site.id, "API reference updated");
      toast.success(<>Publishing the guide with the API reference. Follow it in <Anchor className="underline" href={`${base}/publish`}>Publishes</Anchor>.</>);
      void reload();
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't start the publish. Try again."));
    } finally {
      setBusy("");
    }
  }

  const cur = st?.current ?? null;
  const earlier = (st?.versions ?? []).filter((v) => !v.current);
  const groups = (st?.nav ?? []).filter((g) => g.items.some((it) => it.method));
  const notes = cur ? (cur.notes ?? cur.warnings.map((w) => ({ title: w, fix: "" }))) : [];
  const live = site.status === "live";
  const previewHref = live ? `https://${primaryAddress(site)}${st?.base ?? "/api-reference"}` : null;
  const reviewFirst = site.settings.review.required && !isAdmin;

  const replace = () => {
    if (mode === "file") file.current?.click();
    else urlInput.current?.focus();
  };

  return (
    <>
      <SectionHeader
        title="API reference"
        description={<>{SECTIONS.find((s) => s.id === "api-reference")?.blurb} <ReadMore topic="studioApiReference" /></>}
      />
      {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}
      {loadError && <Alert tone="danger" actions={<Button variant="secondary" size="sm" onClick={load}>Try again</Button>}>{loadError}</Alert>}
      {!st && !loadError && <Skeleton variant="rect" height={180} />}

      {st && canEdit && (
        <SettingsCard
          id="source"
          title="Your OpenAPI file"
          aside={
            <SegmentedControl
              size="sm"
              aria-label="Where the OpenAPI file comes from"
              value={mode}
              onChange={(v) => setMode(v)}
              options={[{ value: "file", label: "Upload a file", icon: "upload" }, { value: "url", label: "From a URL", icon: "link" }]}
            />
          }
        >
          <input
            ref={file}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; take(f); }}
          />
          {mode === "file" ? (
            <div
              role="button"
              tabIndex={0}
              aria-label="Choose an OpenAPI file, or drop one here"
              aria-busy={busy === "upload" || undefined}
              onClick={() => file.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); }}
              className={cx(
                "md-focus flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed p-5 text-center transition-colors",
                cur ? "min-h-[104px]" : "min-h-[150px]",
                over ? "border-accent bg-accent-soft" : cur ? "border-border-strong bg-surface hover:border-accent" : "border-accent bg-accent-soft",
              )}
            >
              <span className="grid size-11 place-items-center rounded-xl bg-surface text-accent-text">
                {busy === "upload" ? <Icon name="clock" size={20} /> : <Icon name="upload" size={20} />}
              </span>
              <strong className="text-body-strong text-text">
                {busy === "upload" ? "Checking the file…" : cur ? "Drop a new file here to replace it, or choose one" : "Drop openapi.yaml or openapi.json here, or choose a file"}
              </strong>
              <span className="text-caption text-text-muted">
                OpenAPI 3.0 or 3.1 · up to {formatBytes(st.limits.max_bytes)} and {num(st.limits.max_operations)} endpoints · we check it before anything changes on your guide
              </span>
            </div>
          ) : (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const u = url.trim();
                if (!u) return;
                void run("url", () => fetchApiSpec(site.id, u), "Fetched and checked. It goes live when you publish.").then((ok) => ok && setUrl(""));
              }}
            >
              <Field label="https:// address of the raw JSON or YAML" htmlFor={`${uid}-url`} className="min-w-0 flex-[1_1_320px]" hint="Fetched from Markdrop's servers: public https addresses only, up to 5 MB and 15 seconds.">
                <Input
                  ref={urlInput}
                  className="ph-sensitive ph-mask"
                  mono
                  type="url"
                  inputMode="url"
                  value={url}
                  placeholder={cur?.source.kind === "url" && cur.source.url ? cur.source.url : "https://api.example.com/openapi.json"}
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <Button type="submit" variant={cur ? "secondary" : "primary"} iconLeft="download" loading={busy === "url"} disabled={!url.trim()} className="mb-[22px]">Fetch and check</Button>
            </form>
          )}
          {!cur && (
            <div className="flex items-start gap-2.5 text-[13px] text-text-secondary">
              <Icon name="info" size={14} className="mt-[3px] shrink-0" />
              <span>
                No file yet? Start from the{" "}
                <button type="button" className="md-focus rounded text-accent-text underline-offset-2 hover:underline disabled:opacity-60" disabled={!!busy}
                  onClick={() => void run("sample", () => startFromSample(site.id), "The Northwind sample is in. Replace it with yours when it's ready.")}>
                  Northwind sample
                </button>
                , or see <a className="text-accent-text underline-offset-2 hover:underline" href={docsUrl(DOCS_PAGES.studioApiExport)} target="_blank" rel="noopener noreferrer">how to export one</a> from FastAPI, Express, Spring or Postman.
              </span>
            </div>
          )}
        </SettingsCard>
      )}
      {st && !canEdit && !cur && <SettingsCard><p className="text-body text-text-secondary">No API reference yet. An editor or admin of this guide adds the OpenAPI file.</p></SettingsCard>}

      {st && cur && (
        <SettingsCard id="result">
          <div className="ph-no-capture flex min-w-0 flex-wrap items-center gap-3">
            <span className={cx("grid size-10 shrink-0 place-items-center rounded-[10px]", notes.length ? "bg-warning-soft text-warning" : "bg-success-soft text-success")}>
              <Icon name={notes.length ? "alert" : "checkCircle"} size={20} />
            </span>
            <div className="flex min-w-0 flex-[1_1_300px] flex-col">
              <h2 className="text-[16px] font-semibold leading-6 text-text [overflow-wrap:anywhere]">
                <span className="ph-sensitive ph-mask">{fileLabel(cur)}</span> {notes.length ? `works, with ${plural(notes.length, "thing")} to look at` : "looks good"}
              </h2>
              <span className="text-[13px] text-text-muted">
                <span className="ph-sensitive ph-mask">{cur.title}{cur.version ? ` ${cur.version}` : ""}</span> · OpenAPI {cur.openapi} · {plural(cur.operations, "endpoint")}{cur.tags ? ` in ${plural(cur.tags, "group")}` : ""} · {cur.servers.length ? plural(cur.servers.length, "server") : "no server"} · checked {timeAgo(cur.created_at)}
              </span>
            </div>
            {canEdit && <Button variant="ghost" size="sm" iconLeft={mode === "file" ? "upload" : "link"} onClick={replace}>Replace</Button>}
            <Button variant="ghost" size="sm" iconLeft="history" onClick={() => setVersionsOpen(true)}>Versions{earlier.length ? ` (${num(earlier.length)})` : ""}</Button>
          </div>
          <dl className="m-0 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {[
              ["Endpoints", num(cur.operations)],
              ["Groups", num(cur.tags)],
              ["Servers", num(cur.servers.length)],
              ["Sign-in", cur.auth?.length ? cur.auth.join(", ") : cur.auth ? "None" : "—"],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0 rounded-lg bg-surface-inset px-3.5 py-3">
                <dt className="text-caption text-text-muted">{k}</dt>
                <dd className="m-0 truncate text-[18px] font-bold text-text" title={v}>{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[13px] text-text-secondary">
            {sourceText(cur)}{cur.created_by_name ? ` by ${cur.created_by_name}` : ""}, {timeAgo(cur.created_at)}. {formatBytes(cur.size)}.
          </p>
          {cur.last_fetch && !cur.last_fetch.ok && (
            <Alert tone="warning" title="The last fetch didn't work">{cur.last_fetch.error} The guide keeps the version above.</Alert>
          )}
          {notes.length > 0 && (
            <div className="ph-no-capture flex flex-col gap-2">
              <h3 className="text-body-strong text-text">{notes.length === 1 ? "1 thing to fix (optional)" : `${num(notes.length)} things to fix (optional)`}</h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {notes.map((n, i) => (
                  <li key={i} className="flex gap-2.5 rounded-lg bg-warning-soft px-3 py-2.5">
                    <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-warning" />
                    <span className="flex min-w-0 flex-col">
                      <strong className="text-body-strong text-text [overflow-wrap:anywhere]">{n.title}</strong>
                      {n.fix && <span className="text-[13px] text-text-secondary [overflow-wrap:anywhere]">{n.fix}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SettingsCard>
      )}

      {st && cur && (
        // Side by side only when the preview still has room for a path and its summary (the settings nav takes a column too).
        <div className="grid grid-cols-1 items-start gap-5 2xl:grid-cols-[minmax(0,1fr)_340px]">
          <SettingsCard
            id="preview"
            title="What readers will get"
            description={`${plural(cur.operations, "endpoint page")}, grouped like this under ${opts.label}.`}
            aside={previewHref
              ? <Button variant="secondary" size="sm" iconRight="external" href={previewHref} target="_blank" rel="noopener noreferrer">Preview the reference</Button>
              : <Button variant="secondary" size="sm" iconRight="external" disabled title="Publish the guide first">Preview the reference</Button>}
          >
            {!live && <p className="text-caption text-text-muted">The guide isn&apos;t published yet: publish it to see the reference on your guide.</p>}
            {live && <p className="text-caption text-text-muted">The preview shows what&apos;s published. Changes here show there after you publish.</p>}
            <div className="ph-no-capture flex flex-col gap-3.5">
              {groups.map((g, i) => (
                <div key={`${g.group}-${i}`} className="flex flex-col gap-1">
                  <strong className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-muted">{g.group}</strong>
                  <ul className="m-0 flex list-none flex-col p-0">
                    {g.items.filter((it) => it.method).map((it) => (
                      <li key={it.page} className="flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                        <Badge size="sm" tone={METHOD_TONE[it.method!] ?? "neutral"} className="mt-px w-[58px] shrink-0 justify-center font-mono">{it.method}</Badge>
                        {/* The path wraps (never cut off); the summary gives way first, the full text on hover. */}
                        <code className="min-w-0 font-mono text-[13px] leading-5 text-text [overflow-wrap:anywhere] sm:max-w-[70%]">{it.path}</code>
                        <span className="ml-auto hidden min-w-0 flex-1 truncate text-right text-[13px] leading-5 text-text-muted sm:block" title={it.title ?? undefined}>{it.title}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </SettingsCard>

          <SettingsCard id="options" title="How it appears">
            <Field label={opts.placement === "tab" ? "Tab name" : "Sidebar group name"} htmlFor={`${uid}-label`}>
              <Input
                value={label}
                maxLength={40}
                disabled={!isAdmin}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                onBlur={() => {
                  const v = label.trim() || "API reference";
                  if (v !== opts.label) void saveOptions({ label: v }, "Name saved.");
                }}
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-text">Where</span>
              <div role="radiogroup" aria-label="Where the API reference appears" className="grid grid-cols-2 gap-2">
                <OptionCard name={`${uid}-placement`} value="tab" checked={opts.placement === "tab"} disabled={!isAdmin || busy === "options"} label="Its own tab" note="Your pages stay under Docs."
                  onChange={() => void saveOptions({ placement: "tab" }, "The API reference gets its own tab.")} />
                <OptionCard name={`${uid}-placement`} value="sidebar" checked={opts.placement === "sidebar"} disabled={!isAdmin || busy === "options"} label="In the sidebar" note="After your pages."
                  onChange={() => void saveOptions({ placement: "sidebar" }, "The API reference goes in the sidebar.")} />
              </div>
            </div>
            <SwitchRow title="Try it" hint={<>Readers call your API from the page. Keys stay in their browser. Your API has to allow your guide&apos;s address (CORS). <ReadMore topic="studioApiCors" /></>}>
              <Switch aria-label="Try it" checked={opts.try_it} disabled={!isAdmin || busy === "options"}
                onChange={(e) => void saveOptions({ try_it: e.target.checked }, e.target.checked ? "Try it is on." : "Try it is off. The code samples stay.")} />
            </SwitchRow>
            <SwitchRow title="Fetch again on every publish" hint={cur.source.kind === "url" ? "Each publish uses the file at the URL as it is then." : "For a file at a URL."}>
              <Switch aria-label="Fetch again on every publish" checked={cur.source.kind === "url" && opts.refetch} disabled={!isAdmin || busy === "options" || cur.source.kind !== "url"}
                onChange={(e) => void saveOptions({ refetch: e.target.checked }, e.target.checked ? "It's fetched again at every publish." : "Publishes use the saved version.")} />
            </SwitchRow>
            {!isAdmin && <p className="text-[13px] text-text-muted">Only Guides admins change these options.</p>}
            {canEdit && (reviewFirst ? (
              <Button variant="primary" block iconLeft="send" href={`${base}/publish`}>Send for review</Button>
            ) : (
              <Button variant="primary" block iconLeft="upload" loading={busy === "publish"} onClick={() => void publish()}>Publish the reference</Button>
            ))}
            {canEdit && <p className="text-caption text-text-muted">Publishing publishes the whole guide, with any other changes waiting.</p>}
          </SettingsCard>
        </div>
      )}

      <Drawer
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        title="Versions"
        description="Every OpenAPI file this guide has had. Restoring one makes it current; it goes live at the next publish."
        width={460}
        footer={cur && canEdit ? <Button variant="ghost" iconLeft="trash" onClick={() => { setVersionsOpen(false); setConfirmRemove(true); }}>Remove the API reference</Button> : undefined}
      >
        <ul className="ph-no-capture m-0 flex list-none flex-col gap-2 p-0">
          {(st?.versions ?? []).map((v) => (
            <li key={v.id} className={cx("flex min-w-0 flex-wrap items-center gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]", v.current ? "border-accent bg-accent-soft" : "border-border")}>
              <span className="min-w-0 flex-1">
                <strong className="ph-sensitive ph-mask text-text">{v.title}</strong> {v.version && <span className="font-mono text-text-muted">v{v.version}</span>}
                <span className="block text-text-muted">
                  {plural(v.operations, "endpoint")} · {v.source.kind === "url" ? "fetched" : v.source.kind === "sample" ? "sample" : "uploaded"} {timeAgo(v.created_at)}
                  {v.created_by_name ? ` by ${v.created_by_name}` : ""}
                </span>
              </span>
              {v.current ? <Badge size="sm" tone="info">Current</Badge> : canEdit && (
                <Button variant="ghost" size="sm" iconLeft="history" loading={busy === "restore"}
                  onClick={() => void run("restore", () => restoreApiSpec(site.id, v.id), "That version is back. It goes live at the next publish.")}>
                  Restore
                </Button>
              )}
            </li>
          ))}
          {!st?.versions.length && <li className="text-body text-text-muted">No versions yet.</li>}
        </ul>
      </Drawer>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove the API reference?"
        body={<>At the next publish, the guide has no pages under <code className="font-mono">/api-reference</code>. The OpenAPI file stays in Versions, so you can bring it back.</>}
        confirmLabel="Remove"
        busy={busy === "remove"}
        onConfirm={async () => {
          if (await run("remove", () => removeApiSpec(site.id), "Removed. The API reference goes at the next publish.")) setConfirmRemove(false);
        }}
      />
    </>
  );
}
