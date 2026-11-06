// Runs the generated Google Meet script (Code.gs) against fake Apps Script services, for
// tests/test_meetings_auto.py. Usage: node meeting_script_harness.js <script.gs> <scenario.json>
// The scenario: {files: [{id, name, created, modified, owned, owner?, parents?, driveId?, mime?, doc?, text?}],
// folders?: [{id, name}], responses: [code…] (the inbox's answers), statusResponses?: [{code, body}…],
// queue?: [file ids] (handed out by the first 'start' status), runs: ["setup" | "syncMeetings" | "check" …],
// docsFails?: bool, driveFails?: bool (Drive v3 errors: the script falls back to DriveApp),
// driveOff?: bool (Drive v3 answers Google's 403 "Drive API has not been used in project … or it is disabled").
// The clock is fake: it starts at `now` (ISO; default the real time), each delivery to the inbox takes
// `sendMs` (default 0) and `runGapMs` passes between runs (default 0). `locked`: another run holds the
// script lock. A run like "doPost({...})" (Check now) has its answer in report.returns (JSON parsed).
// Prints a JSON report.
const fs = require("fs");
const vm = require("vm");

const [scriptPath, scenarioPath] = process.argv.slice(2);
const code = fs.readFileSync(scriptPath, "utf8");
const sc = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));

const report = { posts: [], statuses: [], triggers: [], deletedTriggers: 0, searches: [], v3: [], logs: [], exports: [], returns: [] };
const DRIVE_OFF = JSON.stringify({ error: { code: 403, message: "Google Drive API has not been used in project 1034426400429 " +
  "before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=1034426400429 then retry.",
  errors: [{ reason: "accessNotConfigured" }], status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } });

// The fake clock: `new Date()` and `Date.now()` read it; explicit dates are real.
let clock = sc.now ? new Date(sc.now).getTime() : Date.now();
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}

const statusResponses = (sc.statusResponses || []).slice();
let queue = (sc.queue || []).slice();

function v3File(f) {
  const owned = f.owned !== false;
  return {
    id: f.id, name: f.name, mimeType: f.mime || "application/vnd.google-apps.document",
    createdTime: f.created, modifiedTime: f.modified, webViewLink: `https://docs.google.com/document/d/${f.id}/edit`,
    parents: f.parents || [], driveId: f.driveId,
    owners: f.driveId ? undefined : [owned ? { me: true, displayName: "Me", emailAddress: "me@acme.test" }
      : Object.assign({ me: false, displayName: "Gautam", emailAddress: "gautam@acme.test" }, f.owner || {})],
  };
}

function driveV3(url) {
  if (sc.driveOff) return { getResponseCode: () => 403, getContentText: () => DRIVE_OFF };
  if (sc.driveFails) return { getResponseCode: () => 403, getContentText: () => "Drive API off" };
  const u = new URL(url);
  const q = u.searchParams.get("q") || "";
  report.v3.push({ path: u.pathname, q, corpora: u.searchParams.get("corpora"), all: u.searchParams.get("includeItemsFromAllDrives") });
  const ok = (body) => ({ getResponseCode: () => 200, getContentText: () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const m = /\/drive\/v3\/files\/([^/?]+)/.exec(u.pathname);
  if (m) {
    const f = sc.files.find((x) => x.id === decodeURIComponent(m[1]));
    if (!f) return { getResponseCode: () => 404, getContentText: () => "not found" };
    if (u.searchParams.get("alt") === "media") return ok(f.text || "");
    return ok(v3File(f));
  }
  if (q.includes("vnd.google-apps.folder")) return ok({ files: sc.folders || [] });
  const since = /modifiedTime > '([^']+)'/.exec(q)[1];
  const hits = sc.files.filter((f) => new Date(f.modified) > new Date(since + "Z") &&
    (f.listed !== false) && (!(f.parents || []).length || true));
  return ok({ files: hits.map(v3File) });
}
const props = {};
let triggers = [];
const responses = (sc.responses || []).slice();

function fileObj(f) {
  return {
    getId: () => f.id,
    getName: () => f.name,
    getDateCreated: () => new Date(f.created),
    getLastUpdated: () => new Date(f.modified),
    getUrl: () => `https://docs.google.com/document/d/${f.id}/edit`,
    getOwner: () => (f.owned === false ? { getName: () => "Gautam", getEmail: () => "gautam@acme.test" }
      : { getName: () => "Me", getEmail: () => "me@acme.test" }),
    getMimeType: () => f.mime || "application/vnd.google-apps.document",
    getBlob: () => ({ getDataAsString: () => f.text || "" }),
  };
}

const sandbox = {
  console: {
    log: (m) => report.logs.push(String(m)),
    warn: (m) => report.logs.push("WARN " + String(m)),
    info: (m) => report.logs.push("INFO " + String(m)),
  },
  Date: FakeDate, JSON, Object, Number, String, Math, RegExp, Error, encodeURIComponent,
  LockService: { getScriptLock: () => ({ tryLock: () => !sc.locked, releaseLock: () => {} }) },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: (text) => ({ text, mime: "text/plain", setMimeType(m) { this.mime = m; return this; } }),
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
      getProperties: () => Object.assign({}, props),
    }),
  },
  ScriptApp: {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); report.deletedTriggers++; },
    newTrigger: (fn) => {
      const t = { fn, every: null, getHandlerFunction: () => fn };
      return { timeBased: () => ({ everyMinutes: (n) => ({ create: () => { t.every = n; triggers.push(t); return t; } }) }) };
    },
    getOAuthToken: () => "fake-oauth",
    getService: () => ({ getUrl: () => sc.webAppUrl || null }),
  },
  DriveApp: {
    getFileById: (id) => {
      const f = sc.files.find((x) => x.id === id);
      if (!f) throw new Error("No item with the given ID could be found.");
      return fileObj(f);
    },
    searchFiles: (q) => {
      report.searches.push(q);
      const since = /modifiedDate > '([^']+)'/.exec(q)[1];
      const onlyMine = q.includes("'me' in owners");
      const hits = sc.files.filter((f) => new Date(f.modified) > new Date(since + "Z") && (!onlyMine || f.owned !== false) && f.listed !== false);
      let i = 0;
      return { hasNext: () => i < hits.length, next: () => fileObj(hits[i++]) };
    },
  },
  Docs: {
    Documents: {
      get: (id, opts) => {
        if (sc.docsFails) throw new Error("Docs service is off");
        if (!opts || opts.includeTabsContent !== true) throw new Error("tabs not asked for");
        const f = sc.files.find((x) => x.id === id);
        if (!f.doc) throw new Error("no doc");
        return f.doc;
      },
    },
  },
  UrlFetchApp: {
    fetch: (url, opts) => {
      if (url.startsWith("https://www.googleapis.com/drive/v3/")) return driveV3(url);
      if (url.endsWith("/status")) {
        const body = JSON.parse(opts.payload);
        report.statuses.push(Object.assign({ auth: opts.headers.Authorization }, body));
        const r = statusResponses.length ? statusResponses.shift() : { code: 200 };
        let out = r.body || { ok: true, latest_version: 3 };
        if (body.phase === "start" && !r.body) { out = Object.assign({ queue: queue.map((id) => ({ file_id: id })) }, out); queue = []; }
        return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(out) };
      }
      if (url.includes("/export?format=txt")) {
        report.exports.push(url);
        const id = /document\/d\/([^/]+)\/export/.exec(url)[1];
        const f = sc.files.find((x) => x.id === id);
        return { getContentText: () => f.text || "", getResponseCode: () => 200 };
      }
      const status = responses.length ? responses.shift() : 200;
      clock += sc.sendMs || 0;
      report.posts.push({ url, auth: opts.headers.Authorization, method: opts.method, body: JSON.parse(opts.payload), status });
      return { getResponseCode: () => status, getContentText: () => JSON.stringify({ status: status < 300 ? "imported" : "error" }) };
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "Code.gs" });
(sc.runs || ["setup"]).forEach((fn, i) => {
  if (i) clock += sc.runGapMs || 0;
  const out = vm.runInContext(fn.includes("(") ? fn : fn + "()", sandbox);
  if (out && typeof out.text === "string") {
    let v = out.text;
    try { v = JSON.parse(out.text); } catch (e) { /* text */ }
    report.returns.push({ run: fn, mime: out.mime, body: v });
  }
});
report.triggers = triggers.map((t) => ({ fn: t.fn, every: t.every }));
report.props = Object.keys(props).filter((k) => !k.startsWith("sent:"));
report.propValues = Object.fromEntries(report.props.map((k) => [k, props[k]]));
report.sent = Object.keys(props).filter((k) => k.startsWith("sent:")).map((k) => k.slice(5)).sort();
report.constants = vm.runInContext("({endpoint: MARKDROP_ENDPOINT, token: MARKDROP_TOKEN, lookback: LOOKBACK_HOURS, version: SCRIPT_VERSION, maxPerRun: MAX_PER_RUN, shared: INCLUDE_SHARED})", sandbox);
process.stdout.write(JSON.stringify(report));
