// Runs the generated Google Meet script (Code.gs) against fake Apps Script services, for
// tests/test_meetings_auto.py. Usage: node meeting_script_harness.js <script.gs> <scenario.json>
// The scenario: {files: [{id, name, created, modified, owned, doc?, text?}], responses: [code…],
// runs: ["setup" | "syncMeetings" …], docsFails?: bool}. Prints a JSON report.
const fs = require("fs");
const vm = require("vm");

const [scriptPath, scenarioPath] = process.argv.slice(2);
const code = fs.readFileSync(scriptPath, "utf8");
const sc = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));

const report = { posts: [], triggers: [], deletedTriggers: 0, searches: [], logs: [], exports: [] };
const props = {};
let triggers = [];
const responses = (sc.responses || []).slice();

function fileObj(f) {
  return {
    getId: () => f.id,
    getName: () => f.name,
    getDateCreated: () => new Date(f.created),
    getUrl: () => `https://docs.google.com/document/d/${f.id}/edit`,
  };
}

const sandbox = {
  console: {
    log: (m) => report.logs.push(String(m)),
    warn: (m) => report.logs.push("WARN " + String(m)),
  },
  Date, JSON, Object, Number, String, Math, RegExp, Error,
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
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
  },
  DriveApp: {
    searchFiles: (q) => {
      report.searches.push(q);
      const since = /modifiedDate > '([^']+)'/.exec(q)[1];
      const onlyMine = q.includes("'me' in owners");
      const hits = sc.files.filter((f) => new Date(f.modified) > new Date(since + "Z") && (!onlyMine || f.owned !== false));
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
      if (url.includes("/export?format=txt")) {
        report.exports.push(url);
        const id = /document\/d\/([^/]+)\/export/.exec(url)[1];
        const f = sc.files.find((x) => x.id === id);
        return { getContentText: () => f.text || "", getResponseCode: () => 200 };
      }
      const status = responses.length ? responses.shift() : 200;
      report.posts.push({ url, auth: opts.headers.Authorization, method: opts.method, body: JSON.parse(opts.payload), status });
      return { getResponseCode: () => status, getContentText: () => JSON.stringify({ status: status < 300 ? "imported" : "error" }) };
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "Code.gs" });
for (const fn of sc.runs || ["setup"]) vm.runInContext(fn + "()", sandbox);
report.triggers = triggers.map((t) => ({ fn: t.fn, every: t.every }));
report.sent = Object.keys(props).filter((k) => k.startsWith("sent:")).map((k) => k.slice(5)).sort();
report.constants = vm.runInContext("({endpoint: MARKDROP_ENDPOINT, token: MARKDROP_TOKEN, lookback: LOOKBACK_HOURS})", sandbox);
process.stdout.write(JSON.stringify(report));
