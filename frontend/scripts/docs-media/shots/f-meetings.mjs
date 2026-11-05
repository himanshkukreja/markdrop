/**
 * Docs media, group F: Meetings (/workspaces/meetings-*). Shot format: ../shots.mjs.
 *
 * Connect Google Meet (/workspaces/meetings-auto-import): the dialog, the ready script, and the
 * Meetings page once the script has sent a call (Riya connects, then the shot posts Google Meet's
 * transcript and Gemini's notes to the inbox exactly as the Apps Script does). The same files are
 * also written by the real-stack e2e (frontend/e2e/pages/real/meetings-auto.mjs with DOCS_MEDIA=1).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, "../../../../backend/tests/fixtures/meetings");
const PAGE = "/workspaces/meetings-auto-import";

/** Calls the sandbox API as a demo user (Bearer: a minted session token, or `raw` as given). */
async function api(h, method, p, body, { who = "riya", raw = null } = {}) {
  const token = raw || (await h.sandbox("/__sandbox/mint", { email: h.fx.users[who].email })).token;
  const res = await fetch(`${h.API}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
  return res.json();
}

const hub = (fx) => `/meetings/${fx.workspace.id}`;

/** Riya not connected: the dialog offers Make my script. */
async function fresh(h) {
  await api(h, "DELETE", "/api/v1/meetings/connection");
}

async function openDialog(h) {
  await h.loc("[data-testid='meet-create']").waitFor({ timeout: 20000 });
  await h.sleep(700); // the md-pop animation
  await h.page.mouse.move(5, 5);
}

export default [
  {
    id: "meetings-connect-dialog",
    page: PAGE,
    name: "connect-dialog",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `${hub(fx)}?connect=1`,
    prepare: async (h) => {
      await fresh(h);
      await h.page.reload();
      await openDialog(h);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },
  {
    id: "meetings-connect-script",
    page: PAGE,
    name: "connect-script",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `${hub(fx)}?connect=1`,
    prepare: async (h) => {
      await fresh(h);
      await h.page.reload();
      await openDialog(h);
      await h.loc("[data-testid='meet-create']").click();
      await h.loc("[data-testid='meet-script']").waitFor({ timeout: 15000 });
      await h.sleep(500);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },
  {
    id: "meetings-connected",
    page: PAGE,
    name: "connected",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => hub(fx),
    prepare: async (h) => {
      const ws = h.fx.workspace.id;
      const { token } = await api(h, "POST", "/api/v1/meetings/connection", { workspace: ws, restricted: false });
      const send = (file_id, title, file, kind) => api(h, "POST", "/api/v1/meetings/inbox", {
        source: "google-meet-script", file_id, title, created: "2026-11-04T05:20:00.000Z", kind_hint: kind,
        text: readFileSync(path.join(FIX, file), "utf8"), doc_url: `https://docs.google.com/document/d/${file_id}/edit`,
      }, { raw: token });
      await send("1DocsMediaTranscriptAbcdefgh", "Weekly product sync (2026-11-04 10:00 GMT+05:30) - Transcript", "google_meet_transcript.txt", "transcript");
      // The notes pair with the transcript's meeting once its page exists (the import runs in the background).
      for (let i = 0; ; i++) {
        try {
          await send("1DocsMediaNotesAbcdefghijklm", "Weekly product sync - 2026/11/04 10:00 GMT+05:30 - Notes by Gemini", "gemini_notes.txt", "notes");
          break;
        } catch (e) {
          if (i >= 20 || !/404/.test(String(e))) throw e;
          await h.sleep(1000);
        }
      }
      // The script's run report (the status line under "Google Meet connected"), as script v3 sends it.
      await api(h, "POST", "/api/v1/meetings/inbox/status", {
        phase: "done", version: 3, mode: "run", include_shared: true, found: 79, sent: 60, remaining: 19,
        skipped: { title: 12, writing: 2 }, shared_drives: "off", drive_project: "123456789",
      }, { raw: token });
      // Maya imports from her Google account into the same workspace ("Also importing here").
      await api(h, "POST", "/api/v1/meetings/connection", { workspace: ws, restricted: false }, { who: "maya" });
      await h.page.reload();
      await h.loc("[data-testid='meet-connection']").waitFor({ timeout: 20000 });
      await h.loc("[data-testid='meeting-card']").first().waitFor();
      await h.sleep(600);
      await h.page.mouse.move(5, 5);
    },
    crop: { union: [".mt-hub__head", "[data-testid='meetings-list']"], pad: 16 },
  },
];
