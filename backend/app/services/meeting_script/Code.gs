/**
 * Markdrop · Google Meet auto-import
 *
 * Sends the Google Meet transcripts and Gemini meeting notes in YOUR Google Drive to Markdrop,
 * which turns each call into a page in the Meetings folder of "{{WORKSPACE_NAME}}".
 *
 * What it does, every 15 minutes:
 *   1. Looks for Google Docs in your Drive, created in the last LOOKBACK_HOURS, whose title looks
 *      like a Meet transcript ("… - Transcript") or Gemini's notes ("… - Notes by Gemini").
 *   2. Skips the ones it already sent (it remembers their ids in this project's properties).
 *   3. Reads each one's text (every tab) and sends it to Markdrop. A failure is tried again next run.
 *
 * What it can't do: change, move or delete anything in your Drive. It asks Google for read-only
 * Drive access (drive.readonly), permission to call Markdrop (script.external_request) and to
 * schedule itself (script.scriptapp). The token below only imports meetings into that one
 * workspace; it can't read or change anything else. Disconnect in Markdrop and it stops.
 *
 * Set up: Run → setup (once), and allow. That's all.
 */

var MARKDROP_ENDPOINT = '{{ENDPOINT}}';
var MARKDROP_TOKEN = '{{TOKEN}}';

var LOOKBACK_HOURS = 48;      // how far back to look (raise it once to import older meetings)
var INCLUDE_SHARED = false;   // true: also Docs other people shared with you (e.g. a teammate's call)
var MAX_PER_RUN = 20;         // a run has 6 minutes; the rest wait for the next one
var TRANSCRIPT_TITLE = /[-–—]\s*Transcript\s*$/i;
var NOTES_TITLE = /(Notes by Gemini|[-–—]\s*Notes)\s*$/i;

/** Run this once: it schedules syncMeetings every 15 minutes, then runs it now. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncMeetings') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncMeetings').timeBased().everyMinutes(15).create();
  syncMeetings();
}

/** Sends what's new. Safe to run by hand any time. */
function syncMeetings() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;  // a run is still going
  try {
    var props = PropertiesService.getScriptProperties();
    var since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
    var q = "mimeType = 'application/vnd.google-apps.document' and trashed = false and modifiedDate > '" +
      since.toISOString().slice(0, 19) + "'" + (INCLUDE_SHARED ? '' : " and 'me' in owners");
    var files = DriveApp.searchFiles(q);
    var sent = 0;
    while (files.hasNext() && sent < MAX_PER_RUN) {
      var file = files.next();
      var id = file.getId();
      var title = file.getName();
      var kind = TRANSCRIPT_TITLE.test(title) ? 'transcript' : NOTES_TITLE.test(title) ? 'notes' : null;
      if (!kind || file.getDateCreated() < since || props.getProperty('sent:' + id)) continue;
      var result = send_(file, kind);
      if (result === 'stop') return;
      if (result === 'done') {
        props.setProperty('sent:' + id, String(Date.now()));
        sent++;
      }
    }
    forgetOld_(props);
  } finally {
    lock.releaseLock();
  }
}

/** 'done' (sent, or Markdrop will never take it), 'retry' (next run) or 'stop'. */
function send_(file, kind) {
  var text;
  try {
    text = docText_(file.getId());
  } catch (e) {
    console.warn('Could not read "' + file.getName() + '": ' + e);
    return 'retry';
  }
  var res;
  try {
    res = UrlFetchApp.fetch(MARKDROP_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + MARKDROP_TOKEN },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        source: 'google-meet-script',
        file_id: file.getId(),
        title: file.getName(),
        created: file.getDateCreated().toISOString(),
        kind_hint: kind,
        text: text,
        doc_url: file.getUrl()
      })
    });
  } catch (e) {
    console.warn('Markdrop unreachable: ' + e);
    return 'stop';
  }
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) {
    console.log('Sent "' + file.getName() + '": ' + res.getContentText().slice(0, 200));
    return 'done';
  }
  if (code === 401) {
    // Disconnected in Markdrop (the token was revoked): stop running.
    console.warn('Markdrop says this script is disconnected. Removing its schedule.');
    ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
    return 'stop';
  }
  if (code === 413 || code === 422) {
    console.warn('Markdrop can\'t import "' + file.getName() + '" (' + code + '): ' + res.getContentText().slice(0, 300));
    return 'done';
  }
  console.warn('Markdrop answered ' + code + ' for "' + file.getName() + '"; trying again next run. ' +
    res.getContentText().slice(0, 300));
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
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
    });
    return res.getContentText();
  }
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
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sent:') === 0 && Number(all[k]) < cutoff) props.deleteProperty(k);
  });
}
