const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";

export interface DocumentCreateResponse {
  slug: string;
  url: string;
  title: string | null;
  content: string;
  edit_secret: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentResponse {
  slug: string;
  url: string;
  title: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

export async function createDocument(title: string, content: string): Promise<DocumentCreateResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title.trim() || null, content }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to create document" }));
    throw new Error(err.detail);
  }
  return res.json();
}

export async function getDocument(slug: string): Promise<DocumentResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error("Document not found");
    throw new Error("Failed to fetch document");
  }
  return res.json();
}

export async function updateDocument(
  slug: string,
  title: string,
  content: string,
  editSecret: string
): Promise<DocumentResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-edit-secret": editSecret,
    },
    body: JSON.stringify({ title: title.trim() || null, content }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to update" }));
    throw new Error(err.detail);
  }
  return res.json();
}

export async function deleteDocument(slug: string, editSecret: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}`, {
    method: "DELETE",
    headers: { "x-edit-secret": editSecret },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to delete" }));
    throw new Error(err.detail);
  }
}
