import { API_BASE, getToken } from "@/lib/api";

/** What the handoff page shows before handing a reader to a workspace's own domain. */
export interface HandoffConsent {
  host: string;
  site_name: string | null;
  /** False for members of the workspace that owns the host, or after a remembered yes. */
  needs_consent: boolean;
  name: string | null;
  email: string;
}

/** A failure with the HTTP status (0 = network), so the page can tell "sign in again" from "unknown site". */
export class HandoffError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function auth(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function getHandoffConsent(host: string): Promise<HandoffConsent> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/auth/tenant-token/consent?host=${encodeURIComponent(host)}`, {
      headers: auth(),
      cache: "no-store",
    });
  } catch {
    throw new HandoffError(0, "network");
  }
  if (!res.ok) throw new HandoffError(res.status, "consent");
  return res.json();
}

/** Mint the scoped token. `consent` is the reader's yes on this page (remembered for this host). */
export async function mintHandoffToken(host: string, consent: boolean, remember: boolean): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/auth/tenant-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ host, consent, remember }),
    });
  } catch {
    throw new HandoffError(0, "network");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new HandoffError(res.status, typeof body?.detail === "string" ? body.detail : "mint");
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new HandoffError(500, "mint");
  return data.token;
}
