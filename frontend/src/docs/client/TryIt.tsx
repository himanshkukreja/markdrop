"use client";

/**
 * Try it (board ApiRef, right column): a form generated from the operation's schema that builds the
 * exact `curl` command for the request, ready to run in a terminal.
 *
 * It does not send the request. The API answers cross-origin requests only from markdrop.in's own
 * origins (and docs.markdrop.in only for /api/v1/docs/*), so a browser on this page can't read
 * the response; the command runs anywhere instead. The token never leaves the browser: it lives
 * in sessionStorage for this tab and only goes into the command you copy. The preview masks it.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Badge, Button, Icon, Input, Select, Switch, Textarea, copyText, useToast } from "@/components/ui";
import { curlCommand, type ApiAuth, type ApiRequestValues } from "../openapi.mjs";

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

export function mask(token: string): string {
  if (!token) return "";
  const head = token.startsWith("mdk_") ? "mdk_" : token.slice(0, 2);
  return `${head}••••${token.slice(-4)}`;
}

const asText = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

type Values = Record<string, string>;

function initial(op: TryItOperation): { path: Values; query: Values; header: Values; body: Values } {
  const ex = op.example;
  const bodyEx = (ex.body && typeof ex.body === "object" && !Array.isArray(ex.body) ? ex.body : {}) as Record<string, unknown>;
  const pick = (src: Record<string, unknown>, names: string[]) => Object.fromEntries(names.filter((n) => src[n] !== undefined).map((n) => [n, asText(src[n])]));
  return {
    path: pick(ex.path, op.params.filter((p) => p.in === "path").map((p) => p.name)),
    query: pick(ex.query, op.params.filter((p) => p.in === "query").map((p) => p.name)),
    header: pick(ex.header, op.params.filter((p) => p.in === "header").map((p) => p.name)),
    body: pick(bodyEx, op.body?.fields.map((f) => f.name) ?? []),
  };
}

/** Form strings → the request values curlCommand takes (JSON fields parsed when they parse). */
function toRequest(op: TryItOperation, v: ReturnType<typeof initial>): { values: ApiRequestValues; error?: string } {
  let error: string | undefined;
  const body: Record<string, unknown> = {};
  const files: Record<string, string> = {};
  for (const f of op.body?.fields ?? []) {
    const raw = v.body[f.name];
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
      placeholder={field.binary ? "path/to/file.png" : field.default !== undefined ? asText(field.default) : undefined}
      autoComplete="off"
      spellCheck={false}
    />
  );
}

export function TryIt({ op }: { op: TryItOperation }) {
  const uid = useId().replace(/:/g, "");
  const toasts = useToast();
  const [values, setValues] = useState(() => initial(op));
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => setToken(readToken()), []);

  const wantsToken = op.auth === "token" || op.auth === "optional";
  const { values: req, error } = useMemo(() => toRequest(op, values), [op, values]);
  const command = useMemo(() => curlCommand(op, req, { token: token || undefined }), [op, req, token]);
  const shown = useMemo(() => (token ? command.split(token).join(mask(token)) : command), [command, token]);

  const set = (where: keyof typeof values, name: string, v: string) => setValues((s) => ({ ...s, [where]: { ...s[where], [name]: v } }));

  const params = op.params.filter((p) => p.in !== "cookie");
  const bodyFields = op.body?.fields ?? [];
  const shownBody = all ? bodyFields : bodyFields.filter((f) => f.required || values.body[f.name] !== undefined);
  const hidden = bodyFields.length - shownBody.length;

  return (
    <form
      className="dx-tryit"
      aria-labelledby={`${uid}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        void copyText(command).then((ok) => (ok ? toasts.success(token ? "Command copied, with your token" : "Command copied") : toasts.error("Couldn't copy. Select the command and copy it.")));
      }}
    >
      <div className="dx-tryit__head">
        <strong id={`${uid}-h`} className="dx-tryit__title">
          Try it
        </strong>
        {wantsToken && token && (
          <Badge tone="info" size="sm" icon="lock">
            Token {mask(token)}
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
            placeholder="mdk_…"
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
            Kept in this tab only. Without one, the command reads <code className="dx-icode">$MARKDROP_TOKEN</code>.{" "}
            <a href="https://markdrop.in/settings/tokens" target="_blank" rel="noopener noreferrer">
              Create a token
            </a>
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
            <FieldInput id={id} field={f} value={values.body[f.name] ?? ""} onChange={(v) => set("body", f.name, v)} />
          </div>
        );
      })}
      {hidden > 0 && (
        <Switch label={`Show all ${bodyFields.length} body fields`} checked={all} onChange={(e) => setAll(e.target.checked)} />
      )}

      <div className="dx-tryit__cmd">
        <div className="dx-tryit__cmdhead">
          <span>Your request</span>
          {error && <span className="dx-tryit__err">{error}</span>}
        </div>
        <pre className="dx-tryit__pre" aria-label="The curl command for this request">
          <code>{shown}</code>
        </pre>
      </div>

      <div className="dx-tryit__actions">
        <Button type="submit" variant="primary" size="sm" iconLeft="copy">
          Copy command
        </Button>
      </div>
      <p className="dx-tryit__note">
        <Icon name="info" />
        <span>
          The API accepts browser requests only from markdrop.in, so this page can’t send it for you. Run the command in a terminal.
        </span>
      </p>
    </form>
  );
}
