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

/** The named person's decision (`null` clears it). */
export function signOff(slug: string, block: string, option: string | null): Promise<SignoffState> {
  return call<SignoffState>(`/api/v1/documents/${enc(slug)}/signoffs/${enc(block)}`, { method: "POST", body: JSON.stringify({ option }) });
}
