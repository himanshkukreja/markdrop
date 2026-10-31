"use client";

/**
 * Settings › API reference: the OpenAPI file a guide's endpoint pages are generated from.
 *
 * Shows what the current description holds (operations, version, servers, what to look at) and the
 * sidebar it makes; replaces it (upload a JSON or YAML file, or fetch an https URL), removes it,
 * and restores an earlier version. Editors and admins change the description; the options (tab or
 * sidebar, its name, Try it, re-fetch on publish) are admin settings. Everything reaches readers at
 * the next publish. The description, its URL and its endpoints are the customer's content: masked
 * in session replays (ph-no-capture / ph-sensitive).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, Disclosure, Field, Icon, Input, RadioGroup, SegmentedControl, Skeleton, Switch, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { docsErrorMessage, updateSite, type ApiReferenceSettings } from "@/lib/docsSites";
import { fetchApiSpec, getApiReference, removeApiSpec, restoreApiSpec, uploadApiSpec, type ApiReferenceStatus, type ApiSpecVersion } from "@/lib/docsApiReference";
import { formatBytes, num, plural, timeAgo } from "./format";
import { useSite } from "./SiteContext";

const ACCEPT = ".json,.yaml,.yml,application/json,application/yaml,application/x-yaml,text/yaml";
const METHOD_TONE: Record<string, "success" | "info" | "warning" | "danger" | "neutral"> = {
  GET: "success",
  POST: "info",
  PUT: "warning",
  PATCH: "warning",
  DELETE: "danger",
};

function sourceText(v: ApiSpecVersion) {
  if (v.source.kind === "sample") return <>The sample description (a fictional Northwind API). Replace it with yours.</>;
  if (v.source.kind === "url")
    return (
      <>
        Fetched from <code className="ph-sensitive ph-mask font-mono [overflow-wrap:anywhere]">{v.source.url}</code>
      </>
    );
  return (
    <>
      Uploaded{v.source.filename ? <> as <span className="ph-sensitive ph-mask font-mono">{v.source.filename}</span></> : null}
    </>
  );
}

function facts(v: ApiSpecVersion): string {
  return [
    `OpenAPI ${v.openapi}`,
    plural(v.operations, "endpoint"),
    v.tags ? plural(v.tags, "group") : "",
    v.servers.length ? plural(v.servers.length, "server") : "no server",
    formatBytes(v.size),
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function ApiReferenceCard() {
  const { site, setSite, isAdmin, canEdit } = useSite();
  const toast = useToast();
  const uid = useId();
  const file = useRef<HTMLInputElement>(null);
  const [st, setSt] = useState<ApiReferenceStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"" | "upload" | "url" | "remove" | "restore" | "options">("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"file" | "url">("file");
  const [url, setUrl] = useState("");
  const [refetchNew, setRefetchNew] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const opts: ApiReferenceSettings = st?.settings ?? site.settings.api ?? { spec_id: null, label: "API reference", placement: "tab", try_it: true, refetch: false };
  const [label, setLabel] = useState(opts.label);

  const load = useCallback(() => {
    setLoadError("");
    getApiReference(site.id)
      .then((s) => {
        setSt(s);
        setLabel(s.settings.label);
      })
      .catch((e) => setLoadError(docsErrorMessage(e, "The API reference didn't load.")));
  }, [site.id]);
  useEffect(load, [load]);

  /** A new status: the card, and the site's settings (Publish counts the change). */
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

  const cur = st?.current ?? null;
  const pages = st?.nav.reduce((n, g) => n + g.items.length, 0) ?? 0;
  const earlier = (st?.versions ?? []).filter((v) => !v.current);
  const locked = !canEdit;

  return (
    <section id="api-reference" aria-labelledby={`${uid}-h`} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <h2 id={`${uid}-h`} className="min-w-0 flex-1 text-[16px] font-semibold text-text">
          API reference
        </h2>
        {st && (cur ? <Badge tone="success" size="sm" dot>{plural(cur.operations, "endpoint")}</Badge> : <Badge size="sm">Not set up</Badge>)}
      </div>
      <p className="text-body text-text-secondary">
        A page for every endpoint, generated from your OpenAPI 3.0 or 3.1 file: parameters, request and response fields, code samples and Try it. It lives under{" "}
        <code className="font-mono">/api-reference</code> on your guide, and changes go live at the next publish. <ReadMore topic="studioApiReference" />
      </p>
      {error && (
        <Alert tone="danger" onDismiss={() => setError("")}>
          {error}
        </Alert>
      )}
      {loadError && (
        <Alert tone="danger" actions={<Button variant="secondary" size="sm" onClick={load}>Try again</Button>}>
          {loadError}
        </Alert>
      )}
      {!st && !loadError && <Skeleton variant="rect" height={96} />}

      {st && cur && (
        <div className="ph-no-capture flex flex-col gap-3 rounded-lg border border-border px-4 py-3.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <strong className="min-w-0 text-text [overflow-wrap:anywhere]">{cur.title}</strong>
            {cur.version && <span className="font-mono text-[13px] text-text-muted">v{cur.version}</span>}
          </div>
          <p className="text-[13px] text-text-muted">{facts(cur)}</p>
          <p className="text-[13px] text-text-secondary">
            {sourceText(cur)}
            {cur.created_by_name ? ` by ${cur.created_by_name}` : ""}, {timeAgo(cur.created_at)}.
          </p>
          {cur.last_fetch && !cur.last_fetch.ok && (
            <Alert tone="warning" title="The last fetch didn't work">
              {cur.last_fetch.error} The guide keeps the version above.
            </Alert>
          )}
          {cur.warnings.length > 0 && (
            <Alert tone="warning" title={cur.warnings.length === 1 ? "One thing to look at" : `${num(cur.warnings.length)} things to look at`}>
              <ul className="ml-4 list-disc">
                {cur.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}
          <Disclosure summary={`Preview the sidebar (${plural(pages, "page")})`}>
            <ol className="flex flex-col gap-3 pt-2" aria-label="The API reference's sidebar">
              {st.nav.map((g, i) => (
                <li key={`${g.group}-${i}`}>
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">{i === 0 ? opts.label : g.group}</div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {g.items.map((it) => (
                      <li key={it.page} className="flex min-w-0 items-center gap-2 text-[13px]">
                        {it.method ? (
                          <Badge size="sm" tone={METHOD_TONE[it.method] ?? "neutral"} className="w-[58px] shrink-0 justify-center font-mono">
                            {it.method}
                          </Badge>
                        ) : (
                          <Icon name="home" size={14} className="w-[58px] shrink-0 text-text-muted" />
                        )}
                        <span className="min-w-0 truncate text-text" title={it.path ?? undefined}>
                          {it.title}
                        </span>
                        <code className="ml-auto hidden min-w-0 truncate font-mono text-[12px] text-text-muted sm:block">{it.page}</code>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </Disclosure>
        </div>
      )}

      {st && canEdit && (
        <div className="flex flex-col gap-3">
          <SegmentedControl
            size="sm"
            aria-label="Where the OpenAPI file comes from"
            value={mode}
            onChange={(v) => setMode(v)}
            options={[
              { value: "file", label: "Upload a file", icon: "upload" },
              { value: "url", label: "From a URL", icon: "link" },
            ]}
          />
          {mode === "file" ? (
            <div className="flex flex-wrap items-center gap-2.5">
              <input
                ref={file}
                type="file"
                accept={ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void run("upload", () => uploadApiSpec(site.id, f), "OpenAPI file saved. It goes live at the next publish.");
                }}
              />
              <Button variant={cur ? "secondary" : "primary"} size="sm" iconLeft="upload" loading={busy === "upload"} onClick={() => file.current?.click()}>
                {cur ? "Replace with a file" : "Upload an OpenAPI file"}
              </Button>
              <span className="text-[13px] text-text-muted">JSON or YAML, up to {formatBytes(st.limits.max_bytes)} and {num(st.limits.max_operations)} endpoints.</span>
            </div>
          ) : (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                const u = url.trim();
                if (!u) return;
                void run("url", () => fetchApiSpec(site.id, u, isAdmin ? refetchNew : undefined), "Fetched. It goes live at the next publish.").then((ok) => ok && setUrl(""));
              }}
            >
              <Field label="https:// address of the raw JSON or YAML" htmlFor={`${uid}-url`} hint="Fetched from Markdrop's servers: public https addresses only, up to 5 MB and 15 seconds.">
                <Input
                  className="ph-sensitive ph-mask"
                  mono
                  type="url"
                  inputMode="url"
                  value={url}
                  placeholder="https://api.example.com/openapi.json"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              {isAdmin && <Switch label="Fetch it again at every publish" checked={refetchNew} onChange={(e) => setRefetchNew(e.target.checked)} />}
              <Button type="submit" variant={cur ? "secondary" : "primary"} size="sm" iconLeft="download" loading={busy === "url"} disabled={!url.trim()} className="self-start">
                Fetch
              </Button>
            </form>
          )}
        </div>
      )}
      {st && locked && !cur && <p className="text-[13px] text-text-muted">An editor or admin of this guide adds the OpenAPI file.</p>}

      {st && (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <RadioGroup
            name={`${uid}-placement`}
            aria-label="Where the API reference appears"
            value={opts.placement}
            onChange={(v) => void saveOptions({ placement: v as ApiReferenceSettings["placement"] }, v === "tab" ? "The API reference gets its own tab." : "The API reference goes in the sidebar.")}
            options={[
              { value: "tab", label: "Its own tab in the header", description: "Your pages stay under a Docs tab.", disabled: !isAdmin || busy === "options" },
              { value: "sidebar", label: "In the sidebar, after your pages", description: "One list for everything.", disabled: !isAdmin || busy === "options" },
            ]}
          />
          <Field label={opts.placement === "tab" ? "Tab name" : "Sidebar group name"} htmlFor={`${uid}-label`} className="max-w-[320px]">
            <Input
              value={label}
              maxLength={40}
              disabled={!isAdmin}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => {
                const v = label.trim() || "API reference";
                if (v !== opts.label) void saveOptions({ label: v }, "Name saved.");
              }}
            />
          </Field>
          <Switch
            label="Try it on endpoint pages"
            checked={opts.try_it}
            disabled={!isAdmin || busy === "options"}
            onChange={(e) => void saveOptions({ try_it: e.target.checked }, e.target.checked ? "Try it is on." : "Try it is off. The code samples stay.")}
          />
          <p className="text-[13px] text-text-muted">
            Readers send requests from their browser straight to your API, never through Markdrop, and what they type stays in the page. Your API has to allow your guide&apos;s address (CORS) for it to work. <ReadMore topic="studioApiCors" />
          </p>
          {cur?.source.kind === "url" && (
            <Switch
              label="Fetch the OpenAPI file again at every publish"
              checked={opts.refetch}
              disabled={!isAdmin || busy === "options"}
              onChange={(e) => void saveOptions({ refetch: e.target.checked }, e.target.checked ? "It's fetched again at every publish." : "Publishes use the saved version.")}
            />
          )}
          {!isAdmin && <p className="text-[13px] text-text-muted">Only Guides admins change these options.</p>}
        </div>
      )}

      {st && (earlier.length > 0 || cur) && (
        <div className="flex flex-wrap items-center gap-2.5">
          {earlier.length > 0 && (
            <Disclosure className="min-w-0 flex-1" summary={`Earlier versions (${num(earlier.length)})`}>
              <ul className="ph-no-capture flex flex-col gap-2 pt-2">
                {earlier.map((v) => (
                  <li key={v.id} className="flex min-w-0 flex-wrap items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-[13px]">
                    <span className="min-w-0 flex-1">
                      <strong className="text-text">{v.title}</strong> {v.version && <span className="font-mono text-text-muted">v{v.version}</span>}
                      <span className="block text-text-muted">
                        {plural(v.operations, "endpoint")} · {v.source.kind === "url" ? "fetched" : v.source.kind === "sample" ? "sample" : "uploaded"} {timeAgo(v.created_at)}
                        {v.created_by_name ? ` by ${v.created_by_name}` : ""}
                      </span>
                    </span>
                    {canEdit && (
                      <Button variant="ghost" size="sm" iconLeft="history" loading={busy === "restore"} onClick={() => void run("restore", () => restoreApiSpec(site.id, v.id), "That version is back. It goes live at the next publish.")}>
                        Use this version
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
          {cur && canEdit && (
            <Button variant="ghost" size="sm" iconLeft="trash" className="ml-auto" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove the API reference?"
        body={<>At the next publish, the guide has no pages under <code className="font-mono">/api-reference</code>. The OpenAPI file stays in Earlier versions, so you can bring it back.</>}
        confirmLabel="Remove"
        busy={busy === "remove"}
        onConfirm={async () => {
          if (await run("remove", () => removeApiSpec(site.id), "Removed. The API reference goes at the next publish.")) setConfirmRemove(false);
        }}
      />
    </section>
  );
}
