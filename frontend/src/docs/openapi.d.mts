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
}

export function slugify(s: string): string;
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
}
/** Token wording: the env var samples read, the token's prefix, whose sign-in a session route takes. */
export interface ApiAuthWording {
  tokenEnv?: string;
  tokenPrefix?: string;
  sessionHost?: string;
}
export function curlCommand(op: ApiRequestShape, values: ApiRequestValues, opts?: { token?: string; tokenEnv?: string }): string;
export function authSentence(op: ApiOperation, auth?: ApiAuthWording): string;
export function operationMarkdown(op: ApiOperation, auth?: ApiAuthWording): string;
export function samplesMarkdown(op: Pick<ApiOperation, "samples">): string;
export function buildApiReference(
  spec: unknown,
  overlay?: unknown,
  opts?: { server?: string; base?: string; /** Vendor extension with auth and rate limits (default "x-docs"). */ extension?: string } & ApiAuthWording,
): ApiReference;
