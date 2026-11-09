/**
 * Sign-off blocks (backend routers/signoffs.py): their state for this viewer, and the named
 * person's decision. The decision lives on the server, never in the page's Markdown.
 */
import { API_BASE, getToken } from "@/lib/api";
import { PagesApiError } from "@/lib/pages";
import type { SignoffTone } from "@/lib/signoff.mjs";

export interface SignoffPerson {
  id: string | null;
  /** Null outside the page's circle (as for `:person` mentions). */
  name: string | null;
  avatar: string | null;
}

export interface SignoffEvent {
  action: "signed" | "changed" | "cleared" | "removed";
  option: string | null;
  was: string | null;
  by: string | null;
  at: string | null;
}

export interface SignoffState {
  block: string;
  label: string;
  options: string[];
  lock: "above" | null;
  person: SignoffPerson | null;
  option: string | null;
  tone: SignoffTone | null;
  signed_at: string | null;
  signed_by: SignoffPerson | null;
  /** This viewer is the person it names. */
  can_sign: boolean;
  /** A workspace admin may remove the signed block. */
  can_remove: boolean;
  history: SignoffEvent[];
  /** Comment threads on the page (only for people who can see the comments): how many are open now, and
   *  what the sign-off recorded when it was given (the sign-off guard). */
  comments?: null | {
    open_now: number;
    record: null | {
      open: number;
      resolved: number;
      resolved_threads: Array<{ id: string; excerpt: string; resolved_by: string | null; resolved_at: string | null }>;
      open_threads: Array<{ id: string; excerpt: string }>;
    };
  };
}

const enc = encodeURIComponent;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const t = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...init,
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    });
  } catch {
    throw new PagesApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const detail = body?.detail;
    throw new PagesApiError(typeof detail === "string" ? detail : `Request failed (${res.status})`, res.status, body ?? {});
  }
  return (await res.json()) as T;
}

export async function getSignoffs(slug: string): Promise<SignoffState[]> {
  const r = await call<{ signoffs: SignoffState[] }>(`/api/v1/documents/${enc(slug)}/signoffs`);
  return r.signoffs ?? [];
}

/** The named person's decision (`null` clears it). While comment threads are open on the page the server
 *  answers 409 `open_comments` unless `acknowledgeOpenComments` (the person confirmed). */
export function signOff(slug: string, block: string, option: string | null, acknowledgeOpenComments = false): Promise<SignoffState> {
  return call<SignoffState>(`/api/v1/documents/${enc(slug)}/signoffs/${enc(block)}`, {
    method: "POST",
    body: JSON.stringify({ option, ...(acknowledgeOpenComments ? { acknowledge_open_comments: true } : {}) }),
  });
}
