/** Types for openapi.mjs (the generated API reference). */

export type ApiAuth = "token" | "optional" | "none" | "session";

export interface ApiField {
  name: string;
  type: string;
  /** May be null (shown for response fields; in a request, null means "leave it out"). */
  nullable: boolean;
  required: boolean;
  description: string;
  constraints: string;
  enum?: unknown[];
  default?: unknown;
  binary?: boolean;
  kind: "string" | "number" | "boolean" | "array" | "object";
  children?: ApiField[];
  /** The description's example (auto mode). */
  example?: unknown;
}

export interface ApiParam {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  /** `X-Edit-Secret` for headers, the name otherwise. */
  display: string;
  required: boolean;
  type: string;
  description: string;
  constraints: string;
  enum?: unknown[];
  default?: unknown;
  kind: "string" | "number" | "boolean";
  /** The description's example (auto mode). */
  example?: unknown;
}

export interface ApiResponse {
  status: string;
  description: string;
  schema?: string;
  fields?: ApiField[];
}

export interface ApiSample {
  label: string;
  lang: string;
  code: string;
}

export interface ApiRequestValues {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  header: Record<string, unknown>;
  body?: unknown;
  files?: Record<string, string>;
}

/** A security scheme an operation takes (auto mode). */
export interface ApiSecurityScheme {
  /** Its key in components.securitySchemes. */
  id: string;
  kind: "bearer" | "basic" | "apiKey" | "other";
  in: "header" | "query" | "cookie";
  /** Header, query parameter or cookie name ("Authorization" for bearer and basic). */
  name: string;
  label: string;
  /** The environment variable samples read it from. */
  env: string;
  format?: string;
  description: string;
  /** In the operation's first security requirement: what the samples send. */
  primary: boolean;
}

export interface ApiServer {
  url: string;
  description?: string;
}

export interface ApiOperation {
  key: string;
  operationId?: string;
  method: string;
  apiPath: string;
  server: string;
  url: string;
  title: string;
  slug: string;
  /** Docs path, e.g. /api/documents/publish-a-document. */
  path: string;
  group: { id: string; title: string };
  tags: string[];
  summary: string;
  description: string;
  auth: ApiAuth;
  authLabel: string;
  editSecret: boolean;
  readPassword: boolean;
  rateLimits: string[];
  params: ApiParam[];
  body: { contentType: string; required: boolean; schema?: string; fields: ApiField[] } | null;
  responses: ApiResponse[];
  /** Media type of a success body ("none" for 204). */
  returns: string;
  cli: string | null;
  mcp: string | null;
  guide: { label: string; href: string } | null;
  deprecated: boolean;
  keywords: string[];
  samples: ApiSample[];
  example: ApiRequestValues;
  markdown: string;
  /** Auto mode: the schemes it takes (none when empty). */
  security?: ApiSecurityScheme[];
  /** Auto mode: every server it can be sent to (the first is `server`). */
  servers?: ApiServer[];
}

export interface ApiGroup {
  id: string;
  title: string;
  description?: string;
  ops: ApiOperation[];
}

export interface ApiReference {
  groups: ApiGroup[];
  ops: ApiOperation[];
  problems: string[];
  /** Auto mode: the reference's front page. */
  overview?: { title: string; description: string; markdown: string };
}

export function slugify(s: string): string;
export function humanize(id: unknown): string;
export function serversOf(list: unknown): ApiServer[];
export function headerName(n: string): string;
export function tidyDocstring(s: string): string;
export function requestUrl(op: Pick<ApiOperation, "apiPath" | "server">, values: ApiRequestValues): string;
/** What curlCommand reads of an operation (Try it passes a trimmed copy). */
export interface ApiRequestShape {
  method: string;
  apiPath: string;
  server: string;
  auth: ApiAuth;
  body: { contentType: string; fields: Array<{ name: string; binary?: boolean }> } | null;
  security?: ApiSecurityScheme[];
}
/** Token wording: the env var samples read, the token's prefix, whose sign-in a session route takes. */
export interface ApiAuthWording {
  tokenEnv?: string;
  tokenPrefix?: string;
  sessionHost?: string;
}
/** `credentials`: {scheme id: value} for an operation with `security` (basic: "user:password"). */
export function curlCommand(op: ApiRequestShape, values: ApiRequestValues, opts?: { token?: string; tokenEnv?: string; credentials?: Record<string, string> }): string;
export function authSentence(op: ApiOperation, auth?: ApiAuthWording): string;
export function operationMarkdown(op: ApiOperation, auth?: ApiAuthWording): string;
export function samplesMarkdown(op: Pick<ApiOperation, "samples">): string;
export function buildApiReference(
  spec: unknown,
  overlay?: unknown,
  opts?: {
    server?: string;
    base?: string;
    /** Vendor extension with auth and rate limits (default "x-docs"). */
    extension?: string;
    /** Someone else's description, no overlay (see openapi.mjs). */
    auto?: boolean;
    /** The overview's fallback title (auto mode). */
    title?: string;
  } & ApiAuthWording,
): ApiReference;
