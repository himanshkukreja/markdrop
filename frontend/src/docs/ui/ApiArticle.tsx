/**
 * An API reference page (board ApiRef): method + path + Copy URL, title, what it does, badges
 * (auth, rate limit, MCP tool, CLI), parameters, request body, responses — and on the right the
 * code samples (synced curl / JavaScript / Python / CLI tabs) and Try it. Everything is generated
 * from the OpenAPI description (openapi.mjs); the section ids match the headings of the page's
 * Markdown twin, so search results, "Copy section" and links land on the same places.
 */
import Link from "@/docs/client/Link";
import type { ReactNode } from "react";
import { Badge, CopyButton, Icon } from "@/components/ui";
import { createSlugger } from "@/components/reading/slug";
import { HeadingActions } from "../client/PageActions";
import { TryIt, type TryItOperation } from "../client/TryIt";
import { DocsMarkdown } from "../render/DocsMarkdown";
import { isAppPath } from "../markdown";
import { samplesMarkdown, type ApiField, type ApiOperation, type ApiParam } from "../openapi.mjs";
import { cx } from "../cx";
import { getSite } from "../content";

/** Try it, unless the site turned it off (site.json `tryIt.enabled: false`): the samples stay. */
const tryItOn = () => getSite().tryIt?.enabled !== false;

/** `code`, [links](/a/b) and **bold** in one line of reference prose. */
export function InlineMd({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={k++} className="dx-icode">{m[1]}</code>);
    else if (m[2] !== undefined) {
      const href = m[3];
      out.push(
        isAppPath(href) ? (
          <Link key={k++} href={href}>
            {m[2]}
          </Link>
        ) : (
          <a key={k++} href={href}>
            {m[2]}
          </a>
        ),
      );
    } else out.push(<strong key={k++}>{m[4]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function H2({ id, children }: { id: string; children: string }) {
  return (
    <div className="dx-h dx-h--h2">
      <h2 id={id} className="dx-api__h2">
        {children}
      </h2>
      <HeadingActions id={id} label={children} />
    </div>
  );
}

function fmtDefault(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v) && !v.length) return null;
  return JSON.stringify(v);
}

function FieldRows({ fields, response }: { fields: Array<ApiField | (ApiParam & { children?: undefined })>; response?: boolean }) {
  return (
    <ul className="dx-fields">
      {fields.map((f) => {
        const name = "display" in f ? f.display : f.name;
        const def = fmtDefault(f.default);
        const showEnum = f.enum && !f.type.includes('"');
        const note = [f.description, f.constraints].filter(Boolean).join(" ");
        return (
          <li key={name} className="dx-field">
            <div className="dx-field__head">
              <code className="dx-field__name">{name}</code>
              <span className="dx-field__type">{f.type + (response && "nullable" in f && f.nullable ? " | null" : "")}</span>
              {!response && f.required && (
                <Badge tone="warning" size="sm">
                  Required
                </Badge>
              )}
            </div>
            {(note || showEnum || def) && (
              <p className="dx-field__desc">
                {note && <InlineMd text={note} />}
                {showEnum && (
                  <>
                    {note ? " " : ""}One of {f.enum!.map((e, i) => (
                      <span key={String(e)}>
                        {i > 0 && ", "}
                        <code className="dx-icode">{String(e)}</code>
                      </span>
                    ))}
                    .
                  </>
                )}
                {def && (
                  <>
                    {" "}
                    Default <code className="dx-icode">{def}</code>.
                  </>
                )}
              </p>
            )}
            {"children" in f && f.children?.length ? (
              <details className="dx-field__kids">
                <summary>
                  <Icon name="chevronRight" className="dx-details__chev" />
                  {f.children.length} {f.children.length === 1 ? "field" : "fields"} inside
                </summary>
                <FieldRows fields={f.children} response={response} />
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const STATUS_TONE = (s: string) => (s.startsWith("2") ? "success" : s.startsWith("4") && s !== "429" ? "warning" : "danger");

/** The data Try it needs, nothing more (it ships to the browser). */
function tryItProps(op: ApiOperation): TryItOperation {
  return {
    method: op.method,
    apiPath: op.apiPath,
    server: op.server,
    auth: op.auth,
    params: op.params.map(({ name, in: where, display, required, enum: e, kind, default: d }) => ({ name, in: where, display, required, enum: e as string[] | undefined, kind, default: d })),
    body: op.body
      ? {
          contentType: op.body.contentType,
          required: op.body.required,
          fields: op.body.fields.map(({ name, required, kind, enum: e, default: d, binary }) => ({ name, required, kind, enum: e as string[] | undefined, default: d, binary })),
        }
      : null,
    example: op.example,
    ...(op.security ? { security: op.security } : {}),
    ...(op.servers ? { servers: op.servers } : {}),
  };
}

export function ApiMain({ op }: { op: ApiOperation }) {
  const slug = createSlugger();
  const sections: Array<[ApiParam["in"], string]> = [
    ["path", "Path parameters"],
    ["query", "Query parameters"],
    ["header", "Headers"],
  ];
  const ok = op.responses.filter((r) => r.fields?.length);
  return (
    <>
      <div className="dx-api__lead">
        {op.description && <DocsMarkdown source={op.description} className="dx-api__desc" />}
        <div className="dx-api__badges">
          <Badge icon="lock" tone={op.auth === "token" ? "info" : "neutral"}>
            {op.authLabel}
          </Badge>
          {op.editSecret && <Badge icon="edit">Or edit secret</Badge>}
          {op.rateLimits.map((r) => (
            <Badge key={r} icon="clock">
              {r} per IP
            </Badge>
          ))}
          {op.mcp && (
            <Link href="/ai/tools" className="dx-api__badgelink">
              <Badge icon="zap">MCP: {op.mcp}</Badge>
            </Link>
          )}
          {op.cli && (
            <Link href="/cli/reference" className="dx-api__badgelink">
              <Badge icon="code">CLI: {op.cli.split(" ").slice(0, 2).join(" ")}</Badge>
            </Link>
          )}
        </div>
        {op.guide && (
          <p className="dx-api__guide">
            <Icon name="bulb" />
            <span>
              Guide: <Link href={op.guide.href}>{op.guide.label}</Link>
            </span>
          </p>
        )}
        <a href="#examples" className="dx-api__jump">
          <Icon name="code" />
          {tryItOn() ? "Code samples and Try it" : "Code samples"}
          <Icon name="arrowRight" />
        </a>
      </div>

      {sections.map(([where, title]) => {
        const ps = op.params.filter((p) => p.in === where);
        if (!ps.length) return null;
        return (
          <section key={where} className="dx-api__section">
            <H2 id={slug(title)}>{title}</H2>
            <FieldRows fields={ps} />
          </section>
        );
      })}

      {op.body && (
        <section className="dx-api__section">
          <H2 id={slug("Request body")}>Request body</H2>
          <p className="dx-api__ct">
            <code className="dx-icode">{op.body.contentType}</code>
            {op.body.required ? ", required" : ""}
          </p>
          {op.body.fields.length > 0 && <FieldRows fields={op.body.fields} />}
        </section>
      )}

      <section className="dx-api__section">
        <H2 id={slug("Responses")}>Responses</H2>
        <ul className="dx-responses">
          {op.responses.map((r) => (
            <li key={r.status} className="dx-response">
              <code className={cx("dx-response__code", `dx-response__code--${STATUS_TONE(r.status)}`)}>{r.status}</code>
              <span className="dx-response__text">
                <InlineMd text={r.description} />
              </span>
            </li>
          ))}
        </ul>
        {ok.map((r) => (
          <details key={r.status} className="dx-details dx-api__respfields">
            <summary>
              <Icon name="chevronRight" className="dx-details__chev" />
              <span>
                {r.status} response: {r.fields!.length} {r.fields!.length === 1 ? "field" : "fields"}{r.schema ? ` (${r.schema})` : ""}
              </span>
            </summary>
            <div className="dx-details__body">
              <FieldRows fields={r.fields!} response />
            </div>
          </details>
        ))}
      </section>
      {/* The Markdown twin's "Examples" heading: on wide screens the samples sit in the right column. */}
      <span id={slug("Examples")} className="dx-api__anchor" aria-hidden />
    </>
  );
}

export function ApiAside({ op }: { op: ApiOperation }) {
  return (
    <div className="dx-api__aside">
      <section aria-label="Examples" className="dx-api__samples">
        <DocsMarkdown source={samplesMarkdown(op)} className="dx-api__samplesmd" />
      </section>
      {tryItOn() && <TryIt op={tryItProps(op)} />}
    </div>
  );
}

export function ApiHead({ op }: { op: ApiOperation }) {
  return (
    <div className="dx-api__line">
      <span className="dx-method" data-method={op.method}>
        {op.method}
      </span>
      <code className="dx-api__path">{op.apiPath}</code>
      <CopyButton text={op.url} label="Copy URL" size="sm" variant="ghost" announceText="URL copied" />
    </div>
  );
}
