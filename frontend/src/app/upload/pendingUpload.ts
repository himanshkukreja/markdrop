/**
 * Holds a half-filled upload across a sign-in.
 *
 * A signed-out visitor can fill the whole form, and only learns they need an
 * account when they press Publish. Google's flow leaves the page entirely, so
 * without this everything they'd entered — the file, the pasted HTML, the
 * password — was gone when they came back.
 *
 * Two rules keep it from becoming a surprise later:
 *
 *   1. It is written only at the moment Publish is pressed while signed out,
 *      never as an autosave. Someone who merely visits and leaves saves nothing.
 *   2. Reading it consumes it, and anything older than TTL_MS is discarded. So
 *      it restores exactly once, straight after the sign-in it was saved for —
 *      a later visit to /upload always starts empty.
 *
 * IndexedDB rather than sessionStorage because a File can't be serialised into
 * web storage, and a 25 MB upload wouldn't fit in its quota anyway. IndexedDB
 * stores the File object itself.
 */

const DB = "markdrop";
const STORE = "pending-upload";
const KEY = "current";
const TTL_MS = 30 * 60 * 1000;

export interface PendingUpload {
  tab: "paste" | "upload";
  html: string;
  file: File | null;
  title: string;
  customSlug: string;
  expiresIn: string;
  readPassword: string;
  savedAt: number;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    // Private browsing and locked-down profiles can refuse IndexedDB outright.
    // Losing the draft is a worse outcome than a thrown error, but not by much
    // — either way the form still works, so failures stay silent.
    req.onerror = () => resolve(null);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function savePending(data: Omit<PendingUpload, "savedAt">): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    tx(db, "readwrite").put({ ...data, savedAt: Date.now() }, KEY);
  } catch {
    /* best effort */
  }
}

/** Read and delete in one go — a draft is restored at most once. */
export async function consumePending(): Promise<PendingUpload | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    let req: IDBRequest<PendingUpload | undefined>;
    try {
      req = tx(db, "readonly").get(KEY) as IDBRequest<PendingUpload | undefined>;
    } catch {
      return resolve(null);
    }
    req.onsuccess = () => {
      const v = req.result;
      // Delete regardless of freshness: a stale draft should not survive to
      // ambush the next visit either.
      clearPending();
      if (!v || Date.now() - v.savedAt > TTL_MS) return resolve(null);
      resolve(v);
    };
    req.onerror = () => resolve(null);
  });
}

export async function clearPending(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    tx(db, "readwrite").delete(KEY);
  } catch {
    /* best effort */
  }
}
