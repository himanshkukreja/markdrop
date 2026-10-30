"use client";

/**
 * Try it (board ApiRef, right column): a form generated from the operation's schema that sends the
 * request to the live API and shows the response, and builds the same request as a `curl` command.
 *
 * The API answers the docs origins on its public routes without credentials (backend
 * middleware/docs_cors.py), so the request carries no cookie: only what the form says, plus the
 * token the reader pasted, as `Authorization: Bearer`. The token lives in sessionStorage for this
 * tab, is masked on screen and never logged. Nothing is sent until the reader asks: the Send
 * button or ⌘/Ctrl+Enter. A request that changes something (anything but GET) needs a one-time
 * "Changes are real" confirmation per page.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge, Button, Checkbox, Icon, Input, Kbd, Select, Switch, Textarea, copyText, useToast } from "@/components/ui";
import { curlCommand, headerName, requestUrl, type ApiAuth, type ApiRequestValues } from "../openapi.mjs";
import { useDocsSite } from "./site";

export interface TryItOperation {
  method: string;
  apiPath: string;
  server: string;
  auth: ApiAuth;
  params: Array<{ name: string; in: string; display: string; required: boolean; enum?: string[]; kind: string; default?: unknown }>;
  body: {
    contentType: string;
    required: boolean;
    fields: Array<{ name: string; required: boolean; kind: string; enum?: string[]; default?: unknown; binary?: boolean }>;
  } | null;
  example: ApiRequestValues;
}

const TOKEN_KEY = "docs_api_token";
/** Shown in full up to this many characters; the copy button always copies everything. */
const SHOW_MAX = 200_000;
const TIMEOUT_MS = 30_000;
/** A test document's lifetime, when the operation creates something that can expire. */
const TEST_EXPIRY = "1d";

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveToken(v: string) {
  try {
    if (v) sessionStorage.setItem(TOKEN_KEY, v);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: kept in memory only */
  }
}

export function mask(token: string, prefix = ""): string {
  if (!token) return "";
  const head = prefix && token.startsWith(prefix) ? prefix : token.slice(0, 2);
  return `${head}••••${token.slice(-4)}`;
}

const asText = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

type Values = Record<string, string>;
type FormValues = { path: Values; query: Values; header: Values; body: Values };

/** Creates something that can expire: pre-filled to expire, so test documents delete themselves. */
function testExpiry(op: TryItOperation): boolean {
  return op.method.toUpperCase() === "POST" && !!op.body?.fields.some((f) => f.name === "expires_in" && f.enum?.includes(TEST_EXPIRY));
}

function initial(op: TryItOperation): FormValues {
  const ex = op.example;
  const bodyEx = (ex.body && typeof ex.body === "object" && !Array.isArray(ex.body) ? ex.body : {}) as Record<string, unknown>;
  const pick = (src: Record<string, unknown>, names: string[]) => Object.fromEntries(names.filter((n) => src[n] !== undefined).map((n) => [n, asText(src[n])]));
  const body = pick(bodyEx, op.body?.fields.map((f) => f.name) ?? []);
  if (testExpiry(op)) body.expires_in = TEST_EXPIRY;
  return {
    path: pick(ex.path, op.params.filter((p) => p.in === "path").map((p) => p.name)),
    query: pick(ex.query, op.params.filter((p) => p.in === "query").map((p) => p.name)),
    header: pick(ex.header, op.params.filter((p) => p.in === "header").map((p) => p.name)),
    body,
  };
}

/** Form strings → the request values (JSON fields parsed when they parse). */
function toRequest(op: TryItOperation, v: FormValues, fileNames: Record<string, string>): { values: ApiRequestValues; error?: string } {
  let error: string | undefined;
  const body: Record<string, unknown> = {};
  const files: Record<string, string> = {};
  for (const f of op.body?.fields ?? []) {
    const raw = f.binary ? fileNames[f.name] : v.body[f.name];
    if (raw === undefined || raw === "") continue;
    if (f.binary) files[f.name] = raw;
    else if (f.kind === "boolean") body[f.name] = raw === "true";
    else if (f.kind === "number") body[f.name] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
    else if (f.kind === "array" || f.kind === "object") {
      try {
        body[f.name] = JSON.parse(raw);
      } catch {
        error = `${f.name} isn't valid JSON yet.`;
        body[f.name] = raw;
      }
    } else body[f.name] = raw;
  }
  const hasBody = !!op.body && (op.body.required || Object.keys(body).length > 0);
  return { values: { path: v.path, query: v.query, header: v.header, body: hasBody ? body : undefined, files }, error };
}

const STATUS: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
  410: "Gone", 413: "Content Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Content", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};
const statusTone = (s: number) => (s < 300 ? "success" : s < 400 ? "info" : s < 500 && s !== 429 ? "warning" : "danger");

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Result =
  | {
      kind: "response";
      status: number;
      statusText: string;
      ms: number;
      url: string;
      headers: Array<[string, string]>;
      contentType: string;
      bytes: number;
      /** Pretty-printed JSON or text; null for a binary body. */
      text: string | null;
      json: boolean;
      image?: string;
    }
  | { kind: "error"; ms: number; url: string; title: string; message: string };

function FieldInput({ id, field, value, onChange }: { id: string; field: { name: string; kind: string; enum?: string[]; binary?: boolean; default?: unknown }; value: string; onChange: (v: string) => void }) {
  if (field.enum?.length)
    return (
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.default !== undefined ? `Default (${asText(field.default)})` : "Leave out"}</option>
        {field.enum.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </Select>
    );
  if (field.kind === "boolean")
    return (
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.default !== undefined ? `Default (${asText(field.default)})` : "Leave out"}</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    );
  if (field.kind === "array" || field.kind === "object" || field.name === "content" || value.includes("\n"))
    return <Textarea id={id} mono rows={field.name === "content" ? 4 : 3} value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.kind === "array" ? "[ ]" : field.kind === "object" ? "{ }" : undefined} spellCheck={false} />;
  return (
    <Input
      id={id}
      size="sm"
      mono
      type={field.kind === "number" ? "number" : "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.default !== undefined ? asText(field.default) : undefined}
      autoComplete="off"
      spellCheck={false}
    />
  );
}

function ResponsePanel({ result, onClear }: { result: Result; onClear: () => void }) {
  const toasts = useToast();
  if (result.kind === "error")
    return (
      <section className="dx-tryit__resp dx-tryit__resp--error" aria-label="Response" aria-live="polite">
        <div className="dx-tryit__resphead">
          <Badge tone="danger" size="sm" icon="alertCircle">
            No response
          </Badge>
          <span className="dx-tryit__meta">{result.ms} ms</span>
          <span className="dx-tryit__spacer" />
          <button type="button" className="dx-tryit__iconbtn" aria-label="Clear the response" onClick={onClear}>
            <Icon name="x" />
          </button>
        </div>
        <div className="dx-tryit__errbody">
          <strong>{result.title}</strong>
          <p>{result.message}</p>
        </div>
      </section>
    );
  const shown = result.text !== null && result.text.length > SHOW_MAX ? result.text.slice(0, SHOW_MAX) : result.text;
  return (
    <section className="dx-tryit__resp" aria-label="Response" aria-live="polite">
      <div className="dx-tryit__resphead">
        <Badge tone={statusTone(result.status)} size="sm" dot className="dx-tryit__status">
          {result.status} {result.statusText}
        </Badge>
        <span className="dx-tryit__meta">{result.ms} ms</span>
        <span className="dx-tryit__meta">{fmtBytes(result.bytes)}</span>
        <span className="dx-tryit__spacer" />
        {result.text !== null && result.text !== "" && (
          <button
            type="button"
            className="dx-tryit__iconbtn"
            aria-label="Copy the response body"
            title="Copy"
            onClick={() => void copyText(result.text ?? "").then((ok) => (ok ? toasts.success("Response copied") : toasts.error("Couldn't copy. Select the text and copy it.")))}
          >
            <Icon name="copy" />
          </button>
        )}
        <button type="button" className="dx-tryit__iconbtn" aria-label="Clear the response" title="Clear" onClick={onClear}>
          <Icon name="x" />
        </button>
      </div>
      {result.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="dx-tryit__img" src={result.image} alt="The image the API returned" />
      ) : result.text === null ? (
        <p className="dx-tryit__empty">
          {result.contentType || "Binary"} body, {fmtBytes(result.bytes)}. Use the command to save it to a file.
        </p>
      ) : result.text === "" ? (
        <p className="dx-tryit__empty">No body.</p>
      ) : (
        <pre className="dx-tryit__pre dx-tryit__body" tabIndex={0} aria-label="Response body">
          <code>{shown}</code>
          {shown !== result.text && <span className="dx-tryit__trunc">{"\n"}… shortened here. Copy gets the whole body.</span>}
        </pre>
      )}
      <details className="dx-tryit__headers">
        <summary>
          <Icon name="chevronRight" className="dx-details__chev" />
          Response headers ({result.headers.length})
        </summary>
        <dl>
          {result.headers.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="dx-tryit__hint">A browser shows only the headers the API makes readable. The command shows them all with <code className="dx-icode">-i</code>.</p>
      </details>
    </section>
  );
}

export function TryIt({ op }: { op: TryItOperation }) {
  const uid = useId().replace(/:/g, "");
  const toasts = useToast();
  const [values, setValues] = useState(() => initial(op));
  const [token, setToken] = useState("");
  const { tryIt } = useDocsSite();
  // Markdrop's own docs send to NEXT_PUBLIC_API_URL when set (local and preview backends); others to the operation's server.
  const sendTo = tryIt.sendTo || op.server;
  const [showToken, setShowToken] = useState(false);
  const [all, setAll] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [mac, setMac] = useState(true);
  const files = useRef<Record<string, File>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const abort = useRef<AbortController | null>(null);
  const imageUrl = useRef<string | null>(null);
  const respRef = useRef<HTMLDivElement | null>(null);
  // A new answer scrolls into view (the right column scrolls on its own on wide screens).
  useEffect(() => {
    if (result) respRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [result]);
  useEffect(() => {
    setToken(readToken());
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
    return () => {
      abort.current?.abort();
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    };
  }, []);

  const method = op.method.toUpperCase();
  const writes = method !== "GET" && method !== "HEAD";
  const wantsToken = op.auth === "token" || op.auth === "optional";
  const multipart = op.body?.contentType === "multipart/form-data";
  const { values: req, error } = useMemo(() => toRequest(op, values, fileNames), [op, values, fileNames]);
  const command = useMemo(() => curlCommand(op, req, { token: token || (op.auth === "optional" ? "" : undefined), tokenEnv: tryIt.tokenEnv }), [op, req, token, tryIt.tokenEnv]);
  const shown = useMemo(() => (token ? command.split(token).join(mask(token, tryIt.tokenPrefix)) : command), [command, token, tryIt.tokenPrefix]);
  const missing = op.params.filter((p) => p.in === "path" && p.required && !values.path[p.name]).map((p) => p.name);
  const blocked = missing.length ? `Fill in ${missing.join(", ")} first.` : error;
  const canSend = !sending && !blocked && (!writes || confirmed);

  const set = (where: keyof FormValues, name: string, v: string) => setValues((s) => ({ ...s, [where]: { ...s[where], [name]: v } }));

  const params = op.params.filter((p) => p.in !== "cookie");
  const bodyFields = op.body?.fields ?? [];
  const shownBody = all ? bodyFields : bodyFields.filter((f) => f.required || values.body[f.name] !== undefined || fileNames[f.name] !== undefined);
  const hidden = bodyFields.length - shownBody.length;

  const send = useCallback(async () => {
    if (!canSend) return;
    const url = requestUrl({ apiPath: op.apiPath, server: sendTo }, req);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token && (wantsToken || op.auth === "session")) headers.Authorization = `Bearer ${token}`;
    for (const [k, v] of Object.entries(req.header)) if (v !== undefined && v !== "") headers[headerName(k)] = String(v);
    let body: BodyInit | undefined;
    if (op.body && multipart) {
      const fd = new FormData();
      for (const f of op.body.fields) {
        if (f.binary) {
          if (files.current[f.name]) fd.append(f.name, files.current[f.name]);
        } else {
          const v = (req.body as Record<string, unknown> | undefined)?.[f.name];
          if (v !== undefined) fd.append(f.name, typeof v === "string" ? v : JSON.stringify(v));
        }
      }
      body = fd;
    } else if (op.body && req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }

    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), TIMEOUT_MS);
    if (imageUrl.current) {
      URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = null;
    }
    setSending(true);
    const t0 = performance.now();
    try {
      const res = await fetch(url, { method, headers, body, credentials: "omit", mode: "cors", cache: "no-store", signal: ctrl.signal });
      const buf = await res.arrayBuffer();
      const ms = Math.round(performance.now() - t0);
      const contentType = res.headers.get("content-type") ?? "";
      let text: string | null = null;
      let json = false;
      let image: string | undefined;
      if (contentType.startsWith("image/")) {
        image = URL.createObjectURL(new Blob([buf], { type: contentType }));
        imageUrl.current = image;
      } else if (!buf.byteLength) text = "";
      else if (/json|^text\/|xml|csv|javascript|event-stream/.test(contentType) || !contentType) {
        text = new TextDecoder().decode(buf);
        if (/json/.test(contentType)) {
          try {
            text = JSON.stringify(JSON.parse(text), null, 2);
            json = true;
          } catch {
            /* not JSON after all: shown as text */
          }
        }
      }
      setResult({
        kind: "response",
        status: res.status,
        statusText: res.statusText || STATUS[res.status] || "",
        ms,
        url,
        headers: [...res.headers.entries()],
        contentType: contentType.split(";")[0],
        bytes: buf.byteLength,
        text,
        json,
        image,
      });
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const timedOut = ctrl.signal.aborted && (ctrl.signal.reason as DOMException | undefined)?.name === "TimeoutError";
      if (ctrl.signal.aborted && !timedOut) return; // replaced by a newer request, or the page closed
      setResult(
        timedOut
          ? { kind: "error", ms, url, title: "No answer after 30 seconds", message: "The API didn't answer in time. Try again, or run the command in a terminal." }
          : {
              kind: "error",
              ms,
              url,
              title: "The browser couldn't reach the API",
              message: `${navigator.onLine === false ? "You look offline. " : ""}The request to ${new URL(url).host} failed before an answer came back: the API may be unreachable, or a browser extension or network filter blocked it. ${e instanceof Error && e.message ? `(${e.message}) ` : ""}The command below sends the same request from a terminal.`,
            },
      );
    } finally {
      clearTimeout(timer);
      if (abort.current === ctrl) abort.current = null;
      setSending(false);
    }
  }, [canSend, op, req, token, wantsToken, method, multipart, sendTo]);

  return (
    <form
      className="dx-tryit"
      aria-labelledby={`${uid}-h`}
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        }
      }}
    >
      <div className="dx-tryit__head">
        <strong id={`${uid}-h`} className="dx-tryit__title">
          Try it
        </strong>
        {wantsToken && token && (
          <Badge tone="info" size="sm" icon="lock">
            Token {mask(token, tryIt.tokenPrefix)}
          </Badge>
        )}
      </div>

      {wantsToken && (
        <div className="dx-tryit__field">
          <label htmlFor={`${uid}-token`} className="dx-tryit__label">
            API token{op.auth === "optional" ? " (optional)" : ""}
          </label>
          <Input
            id={`${uid}-token`}
            size="sm"
            mono
            type={showToken ? "text" : "password"}
            value={token}
            placeholder={tryIt.tokenPrefix ? `${tryIt.tokenPrefix}…` : "Your API token"}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setToken(e.target.value.trim());
              saveToken(e.target.value.trim());
            }}
            suffix={
              <button type="button" className="dx-tryit__eye" aria-label={showToken ? "Hide the token" : "Show the token"} onClick={() => setShowToken((x) => !x)}>
                <Icon name={showToken ? "eyeOff" : "eye"} />
              </button>
            }
          />
          <span className="dx-tryit__hint">
            {op.auth === "optional" ? "Leave it empty to send the request anonymously. " : ""}Kept in this tab only, and sent only to the API.
            {tryIt.tokenHelpUrl && (
              <>
                {" "}
                <a href={tryIt.tokenHelpUrl} target="_blank" rel="noopener noreferrer">
                  Create a token
                </a>
              </>
            )}
          </span>
        </div>
      )}

      {params.map((p) => {
        const id = `${uid}-${p.in}-${p.name}`;
        const where = p.in as "path" | "query" | "header";
        return (
          <div key={id} className="dx-tryit__field">
            <label htmlFor={id} className="dx-tryit__label">
              <code>{p.display}</code>
              {p.required && <span className="dx-tryit__req">required</span>}
            </label>
            <FieldInput id={id} field={p} value={values[where]?.[p.name] ?? ""} onChange={(v) => set(where, p.name, v)} />
          </div>
        );
      })}

      {shownBody.map((f) => {
        const id = `${uid}-body-${f.name}`;
        return (
          <div key={id} className="dx-tryit__field">
            <label htmlFor={id} className="dx-tryit__label">
              <code>{f.name}</code>
              {f.required && <span className="dx-tryit__req">required</span>}
            </label>
            {f.binary ? (
              <input
                id={id}
                type="file"
                className="dx-tryit__file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) files.current[f.name] = file;
                  else delete files.current[f.name];
                  setFileNames((s) => {
                    const next = { ...s };
                    if (file) next[f.name] = file.name;
                    else delete next[f.name];
                    return next;
                  });
                }}
              />
            ) : (
              <FieldInput id={id} field={f} value={values.body[f.name] ?? ""} onChange={(v) => set("body", f.name, v)} />
            )}
            {f.name === "expires_in" && testExpiry(op) && <span className="dx-tryit__hint">Set to {TEST_EXPIRY}: test documents delete themselves.</span>}
          </div>
        );
      })}
      {hidden > 0 && <Switch label={`Show all ${bodyFields.length} body fields`} checked={all} onChange={(e) => setAll(e.target.checked)} />}

      <div className="dx-tryit__cmd">
        <div className="dx-tryit__cmdhead">
          <span>Your request</span>
          {error && <span className="dx-tryit__err">{error}</span>}
        </div>
        <pre className="dx-tryit__pre" aria-label="The curl command for this request">
          <code>{shown}</code>
        </pre>
      </div>

      {writes && (
        <div className="dx-tryit__warn" role="note">
          <div className="dx-tryit__warnline">
            <Icon name="alert" />
            <span>This calls the live API as you. Changes are real.</span>
          </div>
          <Checkbox label="I understand, send real requests from this page" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        </div>
      )}

      <div className="dx-tryit__actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          iconLeft="copy"
          onClick={() => void copyText(command).then((ok) => (ok ? toasts.success(token ? "Command copied, with your token" : "Command copied") : toasts.error("Couldn't copy. Select the command and copy it.")))}
        >
          Copy command
        </Button>
        <Button type="button" variant="primary" size="sm" iconLeft="send" loading={sending} disabled={!canSend} onClick={() => void send()} aria-keyshortcuts="Meta+Enter Control+Enter">
          Send request
        </Button>
      </div>
      <p className="dx-tryit__note">
        {blocked ? (
          <>
            <Icon name="info" />
            <span>{blocked}</span>
          </>
        ) : writes && !confirmed ? (
          <>
            <Icon name="info" />
            <span>Tick the box above to send. Or copy the command and run it in a terminal.</span>
          </>
        ) : (
          <>
            <Icon name="info" />
            <span>
              Sends to <code className="dx-icode">{sendTo.replace(/^https?:\/\//, "")}</code> from your browser. <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd> <Kbd>↵</Kbd> sends too.
            </span>
          </>
        )}
      </p>

      <div ref={respRef} className="dx-tryit__respwrap">
        {result && <ResponsePanel result={result} onClear={() => setResult(null)} />}
      </div>
    </form>
  );
}
