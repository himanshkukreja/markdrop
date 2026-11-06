/**
 * Markdrop · Google Meet auto-import (script version 3)
 *
 * Sends the Google Meet transcripts and Gemini meeting notes you can open in Google Drive to
 * Markdrop, which turns each call into a page in the Meetings folder of "{{WORKSPACE_NAME}}".
 *
 * What it does, every 15 minutes:
 *   1. Looks for Google Docs created in the last LOOKBACK_HOURS that look like a Meet transcript
 *      ("… - Transcript") or Gemini's notes ("… - Notes by Gemini"), in your Drive, in the ones
 *      shared with you (a meeting someone else organized lives in THEIR Drive) and in shared drives.
 *   2. Skips the ones it already sent (it remembers their ids in this project's properties), and
 *      waits for a Doc that changed in the last QUIET_MINUTES (Google may still be writing it).
 *   3. Reads each one's text (every tab) and sends it to Markdrop, for up to about 4½ minutes (Google
 *      gives a run 6): a big backlog takes a run or two, or Run → syncMeetings to send the next batch
 *      now. A failure is tried again next run.
 *   4. Tells Markdrop how the run went (how many Docs it found, skipped and why), so the Meetings
 *      page can show it. Markdrop never sees the Docs it skipped, only the counts.
 *
 * Not sure it finds your meetings? Run → check: it lists what it would send and why it skips the
 * rest, without sending anything (View → Logs / Execution log).
 *
 * What it can't do: change, move or delete anything in your Drive. It asks Google for read-only
 * Drive access (drive.readonly), permission to call Markdrop (script.external_request) and to
 * schedule itself (script.scriptapp). The token below only imports meetings into that one
 * workspace; it can't read or change anything else. Disconnect in Markdrop and it stops.
 *
 * Past meetings: setup brings in the last BACKFILL_DAYS days once (oldest first; nobody is
 * notified about them). To do it again later, run backfill (it uses BACKFILL_DAYS, else 30 days).
 *
 * Shared drives: the search for meetings in shared drives uses the Drive API, which Google leaves off
 * in a script's own project. That's optional: without it the script searches your Drive and the
 * files shared with you (meetings someone else organized are still imported). To search shared
 * drives too, open the link the log gives you and click Enable.
 *
 * Check now (optional): Markdrop's "Check for new meetings" button runs this script right away instead
 * of waiting for the next 15-minute run. Turn it on once: Deploy → New deployment → Web app (Execute as:
 * Me, Who has access: Anyone) → Deploy, then paste the Web app URL in Markdrop (Meetings › Turn on Check
 * now). The web app does nothing for a caller without the key Markdrop gives this script (doPost), at
 * most once a minute, and only looks at the last LOOKBACK_HOURS.
 *
 * Set up: Run → setup (once), and allow. That's all. Updating from an older version: replace all
 * of this file with the new one, save, and Run → setup again.
 */

var SCRIPT_VERSION = 4;
var MARKDROP_ENDPOINT = '{{ENDPOINT}}';
var MARKDROP_TOKEN = '{{TOKEN}}';

var LOOKBACK_HOURS = 48;      // how far back to look (raise it once to import older meetings)
var INCLUDE_SHARED = '{{INCLUDE_SHARED}}';  // true: also meetings shared with you (organized by someone else)
var MAX_PER_RUN = 0;          // 0 = no fixed cap, the time budget decides (else: at most this many a run)
var QUIET_MINUTES = 10;       // a Doc changed this recently may still be being written: next run
var BACKFILL_DAYS = '{{BACKFILL_DAYS}}';  // setup also brings in this many days of past meetings (0: none)

// What Google calls them, in the languages Meet writes them in. A title ends with one of these,
// usually after the meeting's name and time: "Weekly sync - 2026/11/04 10:00 IST - Notes by Gemini".
var TRANSCRIPT_WORDS = 'Transcript|Transcription|Transcripci[oó]n|Transcri[cç][aã]o|Transkript|Trascrizione|' +
  'Transcriptie|Transkrypcja|Transkripsiyon|Транскрипция|Стенограмма|文字起こし|文字记录|轉錄|트랜스크립트|' +
  'ट्रांसक्रिप्ट|प्रतिलेख';
var NOTES_WORDS = 'Notes by Gemini|Notes de Gemini|Notas de Gemini|Notas do Gemini|Notizen von Gemini|' +
  'Note di Gemini|Notities van Gemini|Notatki Gemini|Gemini|Notes|Notas|Notizen|Note|Notities|Notatki|Meeting notes';
var TRANSCRIPT_TITLE = new RegExp('[-–—(|:]\\s*(' + TRANSCRIPT_WORDS + ')\\s*\\)?\\s*$', 'i');
var NOTES_TITLE = new RegExp('[-–—(|:]\\s*(' + NOTES_WORDS + ')\\s*\\)?\\s*$', 'i');
// Gemini's notes, wherever the words sit ("Notes by Gemini", "Gemini によるメモ", "Gemini के नोट्स").
var GEMINI_NOTES = /(notes?|notas|notizen|notities|notatki|メモ|笔记|筆記|नोट)[^\n]{0,12}gemini|gemini[^\n]{0,12}(notes?|notas|notizen|notities|notatki|メモ|笔记|筆記|नोट)/i;
// Meet puts the call's date and time in the title ("2026/11/04 10:00 IST", "(2026-11-04 10:00 GMT+05:30)").
var DATED_TITLE = /\d{1,4}\s*[\/.\-年]\s*\d{1,2}\s*[\/.\-月]\s*\d{1,4}|\b\d{1,2}:\d{2}\b/;
// What Drive is searched for (Drive matches the start of a word: "Transcrip" finds "Transcription").
var SEARCH_WORDS = ['Transcrip', 'Transkript', 'Trascrizione', 'Transkrypcja', 'Transkripsiyon', 'Notes', 'Notas',
  'Notizen', 'Note', 'Notities', 'Notatki', 'Gemini', 'Транскрипция', 'Стенограмма', '文字起こし', 'ट्रांसक्रिप्ट'];
// The folder Meet saves into: "Meet Recordings" (and its translations).
var MEET_FOLDER = /^(Meet Recordings|Grabaciones de Meet|Gravações do Meet|Meet-Aufzeichnungen|Enregistrements Meet|Registrazioni di Meet|Meet-opnamen|Nagrania z Meet|Meet の録画|Meet 录音|Meet Kayıtları|Записи Meet)$/i;
var DOC_MIME = 'application/vnd.google-apps.document';
// A run has 6 minutes: it sends for about 4½ (at most HARD_CAP Docs); the rest wait for the next run.
var TIME_BUDGET_MS = 4.5 * 60 * 1000;
var HARD_CAP = 200;
var DRIVE_API_PAGE = 'https://console.developers.google.com/apis/api/drive.googleapis.com/overview';
// Check now (doPost): a quick run (about a minute at most), at most once a minute, that sends a Doc
// Google finished writing a couple of minutes ago (a scheduled run waits QUIET_MINUTES).
var NOW_BUDGET_MS = 70 * 1000;
var NOW_QUIET_MINUTES = 2;
var NOW_GAP_MS = 60 * 1000;
// The token this execution calls Markdrop with. A scheduled run uses the one in this file (and keeps a
// copy in the project's properties); the web app reads that copy, so a deployment made with an older
// copy of this file still works after "Get the new script" + setup.
var ACTIVE_TOKEN_ = MARKDROP_TOKEN;

function auth_() {
  return 'Bearer ' + ACTIVE_TOKEN_;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Check now: Markdrop calls this (the web app) when someone presses "Check for new meetings". It runs
 * only for Markdrop's key (handed to this script by Markdrop with each run), at most once a minute,
 * and answers how it went: {ok, found, sent, results, skipped, remaining} or {ok: false, error}.
 */
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}') || {}; } catch (err) { body = {}; }
  var key = props.getProperty('check_key');
  if (!key || typeof body.key !== 'string' || body.key !== key) {
    return json_({ ok: false, error: key ? 'bad_key' : 'no_key', version: SCRIPT_VERSION });
  }
  var last = Number(props.getProperty('now_at') || 0);
  if (Date.now() - last < NOW_GAP_MS) {
    return json_({ ok: false, error: 'too_soon', retry_in: Math.ceil((NOW_GAP_MS - (Date.now() - last)) / 1000), version: SCRIPT_VERSION });
  }
  props.setProperty('now_at', String(Date.now()));
  var st;
  try {
    st = run_('now');
  } catch (err) {
    return json_({ ok: false, error: 'failed', message: String(err).slice(0, 300), version: SCRIPT_VERSION });
  }
  if (!st) return json_({ ok: false, error: 'busy', version: SCRIPT_VERSION });
  if (st.disconnected) return json_({ ok: false, error: 'disconnected', version: SCRIPT_VERSION });
  return json_({
    ok: true, version: SCRIPT_VERSION, found: st.found, sent: st.sent, results: st.results, skipped: st.skipped,
    remaining: st.remaining, errors: st.errors.length, error: st.errors.length ? st.errors[0].error : null
  });
}

/** The web app opened in a browser: says what it is (it runs nothing). */
function doGet() {
  return ContentService.createTextOutput('This is your Markdrop meetings script (version ' + SCRIPT_VERSION + '). To turn on ' +
    '"Check for new meetings", paste this page\'s address in Markdrop: Meetings › Turn on Check now.');
}

/** Run this once: it schedules syncMeetings every 15 minutes, then runs it now (and, when
 *  BACKFILL_DAYS is set, starts bringing in the past meetings too). */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncMeetings') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncMeetings').timeBased().everyMinutes(15).create();
  if (BACKFILL_DAYS > 0) startBackfill_(BACKFILL_DAYS);
  run_('setup');
}

/**
 * Imports past meetings once: the transcripts and Gemini notes of the last `days` days (when run
 * from the editor: BACKFILL_DAYS, else 30), oldest first, as many as a run has time for, over the next runs.
 * Markdrop skips the ones it already has, and notifies nobody about them.
 */
function backfill(days) {
  var n = typeof days === 'number' && days > 0 ? days : (BACKFILL_DAYS > 0 ? BACKFILL_DAYS : 30);
  startBackfill_(Math.min(n, 366));
  run_('backfill');
}

/** Lists what the next run would send, and why it skips the rest. Sends no Docs. */
function check() {
  var props = PropertiesService.getScriptProperties();
  var st = newStats_('check');
  var since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
  var from = props.getProperty('backfill_since');
  if (from && new Date(from) < since) since = new Date(from);
  var found = scan_(props, since, st, true);
  console.log('Markdrop check (script v' + SCRIPT_VERSION + ', shared meetings ' + (INCLUDE_SHARED ? 'included' : 'NOT included') +
    ', since ' + since.toISOString() + ')');
  found.todo.forEach(function (c) { console.log('WOULD SEND  ' + c.kind + '  "' + c.name + '"'); });
  found.skipped.forEach(function (c) { console.log('skip (' + c.reason + ')  "' + c.name + '"'); });
  console.log('Would send ' + found.todo.length + '. Skipped: ' + summary_(st.skipped) + '.');
  if (!found.todo.length && !st.skipped.title && !st.skipped.not_yours && !st.skipped.already_sent) {
    console.log('No Meet transcripts or Gemini notes found. Is transcription or "Take notes with Gemini" on in your ' +
      'calls, and does the organizer share the Docs with attendees?');
  }
  st.found = found.todo.length + (st.skipped.already_sent || 0) + (st.skipped.writing || 0);
  status_('done', st);
}

function startBackfill_(days) {
  PropertiesService.getScriptProperties()
    .setProperty('backfill_since', new Date(Date.now() - days * 24 * 3600 * 1000).toISOString());
}

/** Sends what's new, then (while a backfill is going) the next past meetings. Safe to run by hand. */
function syncMeetings() {
  run_('run');
}

/** One run → its stats (null: another run is going). 'now' (Check now): quick, no backfill. */
function run_(mode) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(mode === 'now' ? 5000 : 1000)) return null;  // a run is still going
  var st = newStats_(mode);
  var now = mode === 'now';
  try {
    var props = PropertiesService.getScriptProperties();
    if (now) {
      ACTIVE_TOKEN_ = props.getProperty('markdrop_token') || MARKDROP_TOKEN;
    } else {
      ACTIVE_TOKEN_ = MARKDROP_TOKEN;
      if (props.getProperty('markdrop_token') !== MARKDROP_TOKEN) props.setProperty('markdrop_token', MARKDROP_TOKEN);
    }
    // As many as fit in the time budget (and under the cap); the rest wait for the next run.
    var budget = { left: MAX_PER_RUN > 0 ? Math.min(MAX_PER_RUN, HARD_CAP) : HARD_CAP,
      until: st.startedAt + (now ? NOW_BUDGET_MS : TIME_BUDGET_MS) };
    var hello = status_('start', st);
    if (hello === 'stop') return st;
    // Docs someone asked for by link in Markdrop come first.
    if (hello && hello.queue && hello.queue.length && sendQueued_(props, hello.queue, st, budget) === 'stop') return st;
    var recent = sendSince_(props, new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000), false, budget, st);
    if (recent !== 'stop' && !now) {
      var from = props.getProperty('backfill_since');
      if (from) {
        // Out of time already: still looked at, to count what waits for the next run.
        var past = sendSince_(props, new Date(from), true, budget, st);
        if (past === 'all') {
          props.deleteProperty('backfill_since');
          console.log('Backfill finished.');
        }
      }
      forgetOld_(props);
    }
    console.log(runSummary_(st));
    if (!st.stopped) status_('done', st);
    return st;
  } catch (e) {
    st.errors.push({ title: '', error: String(e).slice(0, 300) });
    status_('done', st);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function newStats_(mode) {
  return {
    mode: mode, found: 0, sent: 0, stopped: false, disconnected: false, startedAt: Date.now(), seen: {}, waiting: {}, remaining: 0,
    sharedDrives: null, driveProject: null, driveOffSaid: false,
    results: { imported: 0, attached: 0, duplicate: 0, ignored: 0 },
    skipped: { already_sent: 0, too_old: 0, not_yours: 0, title: 0, writing: 0 },
    errors: [], queue_done: [], queue_failed: [], search: ''
  };
}

/** "Found 79 meeting Docs. Sent 60 of 79 · 19 more in the next run (every 15 min) — or run syncMeetings now. Skipped: …" */
function runSummary_(st) {
  var head = 'Found ' + st.found + ' meeting Docs, sent ' + st.sent + '.';
  if (st.remaining > 0) {
    head = 'Found ' + st.found + ' meeting Docs. Sent ' + st.sent + ' of ' + Math.max(st.found, st.sent + st.remaining) +
      ' · ' + st.remaining + ' more in the next run (every 15 min) — or run syncMeetings now.';
  }
  return head + ' Skipped: ' + summary_(st.skipped) + '.';
}

/** Time (and the cap) left in this run for one more Doc. */
function hasBudget_(budget) {
  return budget.left > 0 && Date.now() < budget.until;
}

/** One Doc that waits for the next run (counted once, whichever sweep found it). */
function waits_(st, id) {
  if (!st.waiting[id]) {
    st.waiting[id] = true;
    st.remaining++;
  }
}

function summary_(skipped) {
  var parts = [];
  Object.keys(skipped).forEach(function (k) { if (skipped[k]) parts.push(skipped[k] + ' ' + k.replace(/_/g, ' ')); });
  return parts.length ? parts.join(', ') : 'none';
}

/** Tells Markdrop how a run is going ('start' → {queue, latest}; 'done'). Never fails a run. */
function status_(phase, st) {
  try {
    var res = UrlFetchApp.fetch(MARKDROP_ENDPOINT + '/status', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: auth_() },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        phase: phase, version: SCRIPT_VERSION, mode: st.mode, include_shared: INCLUDE_SHARED === true,
        lookback_hours: LOOKBACK_HOURS, found: st.found, sent: st.sent, results: st.results,
        skipped: st.skipped, errors: st.errors.slice(0, 5), search: st.search, remaining: st.remaining,
        shared_drives: st.sharedDrives, drive_project: st.driveProject,
        queue_done: st.queue_done, queue_failed: st.queue_failed.slice(0, 20)
      })
    });
    var code = res.getResponseCode();
    if (code === 401) { disconnected_(st); return 'stop'; }
    if (code >= 200 && code < 300) {
      var body = JSON.parse(res.getContentText() || '{}');
      // The key Markdrop's "Check for new meetings" calls the web app with (doPost).
      if (body.check_key && typeof body.check_key === 'string') {
        var props = PropertiesService.getScriptProperties();
        if (props.getProperty('check_key') !== body.check_key) props.setProperty('check_key', body.check_key);
      }
      if (phase === 'start' && body.latest_version && body.latest_version > SCRIPT_VERSION) {
        console.warn('A newer version of this script is available: in Markdrop, Meetings › Connect Google Meet › Get the new script.');
      }
      return body;
    }
  } catch (e) {
    console.warn('Could not tell Markdrop how the run went: ' + e);
  }
  return null;
}

/** Markdrop answered 401: this token was revoked. A scheduled run stops the schedule; the web app (which
 *  may be an older deployment, reading an older copy of the token) only says so. */
function disconnected_(st) {
  st.disconnected = true;
  if (st.mode !== 'now') unschedule_();
}

function unschedule_() {
  console.warn('Markdrop says this script is disconnected. Removing its schedule.');
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

// ── Finding meeting Docs ──────────────────────────────────────────────────────

/** A Drive v3 call with this script's own (read-only) access. */
function drive_(path, params) {
  var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/' + path + '?' + qs, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    var said = res.getContentText();
    var err = new Error('Drive answered ' + code + ': ' + said.slice(0, 200));
    // Google leaves the Drive API off in a script's own Cloud project: optional (shared drives only).
    if (code === 403 && /has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(said)) {
      err.driveOff = true;
      var m = /project[= \/]+([a-z0-9-]{1,40})/i.exec(said);
      err.project = m ? m[1] : null;
    }
    throw err;
  }
  return JSON.parse(res.getContentText());
}

/**
 * The Drive API is off for this script's project → true (and says so once a day, as information:
 * it's optional). Anything else → false.
 */
function driveOff_(e, st) {
  if (!e || !e.driveOff) return false;
  st.sharedDrives = 'off';
  st.driveProject = e.project || st.driveProject;
  if (st.driveOffSaid) return true;
  st.driveOffSaid = true;
  var props = PropertiesService.getScriptProperties();
  var today = new Date().toISOString().slice(0, 10);
  if (st.mode !== 'check' && props.getProperty('drive_off_said') === today) return true;
  props.setProperty('drive_off_said', today);
  console.info('Shared-drive search is off (optional: enable the Drive API for this script\'s project: ' +
    DRIVE_API_PAGE + (st.driveProject ? '?project=' + st.driveProject : '') + '). Using your Drive and files shared ' +
    'with you — meetings shared with you are still imported.');
  return true;
}

var FIELDS = 'id,name,mimeType,createdTime,modifiedTime,webViewLink,parents,driveId,owners(me,displayName,emailAddress)';

/** Docs changed after `since` that might be meetings: by title, or inside a Meet Recordings folder. */
function candidates_(since, st) {
  var words = SEARCH_WORDS.map(function (w) { return "name contains '" + w + "'"; });
  var folders = meetFolders_(st);
  folders.forEach(function (id) { words.push("'" + id + "' in parents"); });
  var q = "mimeType = '" + DOC_MIME + "' and trashed = false and modifiedTime > '" + since.toISOString().slice(0, 19) +
    "' and (" + words.join(' or ') + ')';
  st.search = 'drive-v3';
  var out = [];
  try {
    var token = null;
    do {
      var params = { q: q, corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true',
        pageSize: '200', fields: 'nextPageToken,files(' + FIELDS + ')' };
      if (token) params.pageToken = token;
      var page = drive_('files', params);
      (page.files || []).forEach(function (f) { out.push(fromV3_(f, folders)); });
      token = page.nextPageToken;
    } while (token && out.length < 2000);
    st.sharedDrives = 'on';
    return out;
  } catch (e) {
    // Drive's API through this script's token didn't work: DriveApp (your Drive and shared with you).
    if (!driveOff_(e, st)) console.warn('Drive search: ' + e + '; using DriveApp instead.');
    out = [];
    st.search = 'driveapp';
    var v2 = "mimeType = '" + DOC_MIME + "' and trashed = false and modifiedDate > '" + since.toISOString().slice(0, 19) +
      "' and (" + SEARCH_WORDS.map(function (w) { return "title contains '" + w + "'"; }).join(' or ') + ')' +
      (INCLUDE_SHARED === true ? '' : " and 'me' in owners");
    var files = DriveApp.searchFiles(v2);
    while (files.hasNext() && out.length < 2000) out.push(fromDriveApp_(files.next()));
    return out;
  }
}

function fromV3_(f, folders) {
  var owner = (f.owners || [])[0] || null;
  return {
    id: f.id, name: f.name || '', mime: f.mimeType || DOC_MIME, created: new Date(f.createdTime), modified: new Date(f.modifiedTime),
    url: f.webViewLink || ('https://docs.google.com/document/d/' + f.id + '/edit'),
    // In a shared drive nobody owns it: it counts as yours to send.
    mine: f.driveId ? true : !!(owner && owner.me),
    owner: owner ? { name: owner.displayName || '', email: owner.emailAddress || '', me: !!owner.me } : null,
    inMeetFolder: (f.parents || []).some(function (p) { return folders.indexOf(p) >= 0; })
  };
}

function fromDriveApp_(file) {
  var owner = null;
  try { owner = file.getOwner(); } catch (e) { owner = null; }
  var mime = DOC_MIME;
  try { mime = (file.getMimeType && file.getMimeType()) || DOC_MIME; } catch (e) { mime = DOC_MIME; }
  return {
    id: file.getId(), name: file.getName(), mime: mime, created: file.getDateCreated(), modified: file.getLastUpdated(),
    // DriveApp can't tell whose it is without another permission: the search above already left out
    // other people's Docs when INCLUDE_SHARED is off.
    url: file.getUrl(), mine: true,
    owner: owner ? { name: owner.getName() || '', email: owner.getEmail() || '', me: null } : null,
    inMeetFolder: false
  };
}

/** Ids of the Meet Recordings folders this person can see (remembered for a day). */
function meetFolders_(st) {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('meet_folders');
  if (cached) {
    var c = JSON.parse(cached);
    if (Date.now() - c.at < 24 * 3600 * 1000) return c.ids;
  }
  var ids = [];
  try {
    var page = drive_('files', { q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false and name contains 'Meet'",
      corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', pageSize: '50', fields: 'files(id,name)' });
    (page.files || []).forEach(function (f) { if (MEET_FOLDER.test(f.name || '')) ids.push(f.id); });
  } catch (e) {
    if (!driveOff_(e, st)) console.warn('Could not look for the Meet Recordings folder: ' + e);
  }
  ids = ids.slice(0, 10);
  props.setProperty('meet_folders', JSON.stringify({ at: Date.now(), ids: ids }));
  return ids;
}

/** 'transcript' | 'notes' | 'unknown' (in a Meet folder: Markdrop decides) | null (not a meeting Doc). */
function kindOf_(c) {
  var name = String(c.name || '').trim();
  if (c.mime && c.mime !== DOC_MIME) return null;
  var gemini = GEMINI_NOTES.test(name);
  // Someone else's Doc must look like Meet's own: Gemini's notes, or the call's date in the title.
  if (!c.mine && !gemini && !DATED_TITLE.test(name) && !c.inMeetFolder) return null;
  if (TRANSCRIPT_TITLE.test(name)) return 'transcript';
  if (gemini || NOTES_TITLE.test(name)) return 'notes';
  return c.inMeetFolder ? 'unknown' : null;
}

/** Sorts the candidates changed after `since` into what to send now and why the rest wait. */
function scan_(props, since, st, verbose) {
  var settled = new Date(Date.now() - (st.mode === 'now' ? NOW_QUIET_MINUTES : QUIET_MINUTES) * 60 * 1000);
  var todo = [];
  var skipped = [];
  var more = false;
  var seen = {};
  candidates_(since, st).forEach(function (c) {
    if (seen[c.id]) return;
    seen[c.id] = true;
    var kind = kindOf_(c);
    var reason = null;
    if (!kind) reason = 'title';
    else if (c.created < since) reason = 'too_old';
    else if (!c.mine && INCLUDE_SHARED !== true) reason = 'not_yours';
    else if (props.getProperty('sent:' + c.id)) reason = 'already_sent';
    else if (c.modified > settled) { reason = 'writing'; more = true; }
    if (reason) {
      st.skipped[reason]++;
      if (verbose) skipped.push({ name: c.name, reason: reason });
      return;
    }
    c.kind = kind;
    todo.push(c);
  });
  todo.sort(function (a, b) { return a.created.getTime() - b.created.getTime(); });
  return { todo: todo, skipped: skipped, more: more };
}

/**
 * Sends the meeting Docs created after `since` that weren't sent yet, oldest first, while the
 * run's budget (time, cap) lasts → 'all' (nothing left), 'more' (some wait for the next run) or 'stop'.
 */
function sendSince_(props, since, backfill, budget, st) {
  var found = scan_(props, since, st, false);
  found.todo.forEach(function (c) {
    if (!st.seen[c.id]) { st.seen[c.id] = true; st.found++; }
  });
  var more = found.more;
  for (var i = 0; i < found.todo.length; i++) {
    if (!hasBudget_(budget)) {
      for (var j = i; j < found.todo.length; j++) waits_(st, found.todo[j].id);
      return 'more';
    }
    var result = send_(found.todo[i], backfill, false, st);
    if (result === 'stop') return 'stop';
    if (result === 'done') {
      props.setProperty('sent:' + found.todo[i].id, String(Date.now()));
      budget.left--;
    } else {
      more = true;
    }
  }
  return more ? 'more' : 'all';
}

/** The Docs someone pasted a link to in Markdrop (Markdrop couldn't open them; this script can). */
function sendQueued_(props, queue, st, budget) {
  for (var i = 0; i < queue.length; i++) {
    var id = String(queue[i].file_id || queue[i]);
    if (!hasBudget_(budget)) { waits_(st, id); continue; }
    var c;
    try {
      c = fromV3_(drive_('files/' + encodeURIComponent(id), { supportsAllDrives: 'true', fields: FIELDS }), []);
    } catch (e) {
      // The Drive API is off for this project (optional): DriveApp reads the file just as well.
      var viaApp = null;
      if (driveOff_(e, st)) {
        try { viaApp = fromDriveApp_(DriveApp.getFileById(id)); } catch (e2) { viaApp = null; }
      }
      if (!viaApp) {
        st.queue_failed.push({ file_id: id, error: /\b404\b/.test(String(e)) || e.driveOff ? 'not_found' : 'unreadable' });
        continue;
      }
      c = viaApp;
    }
    c.kind = c.mime === DOC_MIME ? (kindOf_(c) || 'unknown') : 'unknown';
    if (c.mime !== DOC_MIME && !/^text\/|subrip|vtt/.test(c.mime)) {
      st.queue_failed.push({ file_id: id, error: 'not_a_doc' });
      continue;
    }
    var result = send_(c, false, true, st);
    if (result === 'stop') return 'stop';
    if (result === 'done') {
      props.setProperty('sent:' + id, String(Date.now()));
      st.queue_done.push(id);
      budget.left--;
    } else {
      st.queue_failed.push({ file_id: id, error: 'retry' });
    }
  }
  return 'ok';
}

/** 'done' (sent, or Markdrop will never take it), 'retry' (next run) or 'stop'. */
function send_(c, backfill, requested, st) {
  var text;
  try {
    text = c.mime && c.mime !== DOC_MIME ? fileText_(c.id) : docText_(c.id);
  } catch (e) {
    console.warn('Could not read "' + c.name + '": ' + e);
    st.errors.push({ title: c.name, error: 'Could not read it: ' + String(e).slice(0, 200) });
    return 'retry';
  }
  var res;
  try {
    res = UrlFetchApp.fetch(MARKDROP_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: auth_() },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        source: 'google-meet-script',
        version: SCRIPT_VERSION,
        file_id: c.id,
        title: c.name,
        created: c.created.toISOString(),
        kind_hint: c.kind,
        text: text,
        doc_url: c.url,
        owner: c.owner,
        backfill: backfill === true,
        requested: requested === true
      })
    });
  } catch (e) {
    console.warn('Markdrop unreachable: ' + e);
    st.errors.push({ title: c.name, error: 'Markdrop unreachable' });
    st.stopped = true;
    return 'stop';
  }
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) {
    console.log('Sent "' + c.name + '": ' + res.getContentText().slice(0, 200));
    st.sent++;
    try {
      var r = JSON.parse(res.getContentText()).status;
      if (r in st.results) st.results[r]++;
    } catch (e) { /* counted as sent */ }
    return 'done';
  }
  if (code === 401) {
    // Disconnected in Markdrop (the token was revoked): stop running.
    disconnected_(st);
    st.stopped = true;
    return 'stop';
  }
  var said = res.getContentText().slice(0, 300);
  if (code === 413 || code === 422) {
    console.warn('Markdrop can\'t import "' + c.name + '" (' + code + '): ' + said);
    st.errors.push({ title: c.name, error: code + ': ' + said.slice(0, 200) });
    return 'done';
  }
  console.warn('Markdrop answered ' + code + ' for "' + c.name + '"; trying again next run. ' + said);
  st.errors.push({ title: c.name, error: code + ': ' + said.slice(0, 200) });
  return code === 429 || code === 403 || code >= 500 ? 'stop' : 'retry';
}

/** A Doc's text, every tab: headings as "#", bullets as "- ", people as "Name <email>". */
function docText_(id) {
  try {
    var doc = Docs.Documents.get(id, { includeTabsContent: true });
    var out = [];
    var tabs = [];
    (function walk(list) {
      (list || []).forEach(function (t) { tabs.push(t); walk(t.childTabs); });
    })(doc.tabs);
    if (!tabs.length) bodyText_(doc.body, out);
    tabs.forEach(function (t, i) {
      if (i > 0) out.push('=== Tab: ' + ((t.tabProperties && t.tabProperties.title) || 'Tab') + ' ===');
      bodyText_(t.documentTab && t.documentTab.body, out);
    });
    return out.join('\n');
  } catch (e) {
    // The Docs service is off: Drive's plain-text export (the first tab only).
    var res = UrlFetchApp.fetch('https://docs.google.com/document/d/' + id + '/export?format=txt', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw new Error('export answered ' + res.getResponseCode());
    return res.getContentText();
  }
}

/** A text file's content (a .vtt, .srt or .txt transcript someone put in Drive). */
function fileText_(id) {
  var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) +
    '?alt=media&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    // The Drive API is off for this project: DriveApp has the same file.
    try { return DriveApp.getFileById(id).getBlob().getDataAsString().slice(0, 2000000); } catch (e) { /* below */ }
    throw new Error('Drive answered ' + res.getResponseCode());
  }
  return res.getContentText().slice(0, 2000000);
}

function bodyText_(body, out) {
  ((body && body.content) || []).forEach(function (el) {
    var p = el.paragraph;
    if (p) {
      var text = (p.elements || []).map(function (pe) {
        if (pe.textRun) return pe.textRun.content || '';
        if (pe.person) {
          var pp = pe.person.personProperties || {};
          return pp.email ? (pp.name || '') + ' <' + pp.email + '>' : (pp.name || '');
        }
        if (pe.richLink) return (pe.richLink.richLinkProperties || {}).title || '';
        return '';
      }).join('').replace(/\u000b/g, '\n').replace(/\n+$/, '');
      var style = (p.paragraphStyle && p.paragraphStyle.namedStyleType) || '';
      if (text && style === 'TITLE') text = '# ' + text;
      else if (text && style.indexOf('HEADING_') === 0) text = '#'.repeat(Math.min(6, Number(style.slice(-1)) + 1)) + ' ' + text;
      else if (text && p.bullet) text = '- ' + text;
      out.push(text);
    } else if (el.table) {
      (el.table.tableRows || []).forEach(function (row) {
        out.push((row.tableCells || []).map(function (cell) {
          return (cell.content || []).map(function (c) {
            return ((c.paragraph && c.paragraph.elements) || []).map(function (pe) {
              return ((pe.textRun && pe.textRun.content) || '').trim();
            }).filter(Boolean).join(' ');
          }).filter(Boolean).join(' ');
        }).join(' | '));
      });
    }
  });
}

/** Forgets ids sent long ago (older than the lookback can find), so the list stays small. */
function forgetOld_(props) {
  var cutoff = Date.now() - 3 * LOOKBACK_HOURS * 3600 * 1000;
  var all = props.getProperties();
  var backfilling = !!all.backfill_since;
  Object.keys(all).forEach(function (k) {
    // While a backfill is going, keep everything (it looks further back than the lookback).
    if (!backfilling && k.indexOf('sent:') === 0 && Number(all[k]) < cutoff) props.deleteProperty(k);
  });
}
