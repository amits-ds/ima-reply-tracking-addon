/**
 * IMA REPLY TRACKING — Gmail Add-on container
 * -------------------------------------------
 * The small per-person file. The logic lives in the ReplyTrackingLib library (already linked in this
 * project). This file only: reads this person's own secrets/state, and builds the CardService UI,
 * delegating every real computation to ReplyTrackingLib.*.
 *
 * ===================== SETUP (the member pages "Install" explain each click) =====================
 * 1. Deploy → Test deployments → Install add-on.
 * 2. Open Gmail, find the icon in the right-hand sidebar. On first run, authorize the permissions.
 * Optional: Project Settings → Script Properties → GEMINI_API_KEY, or use the add-on's Settings card.
 *
 * LOGGING: events are never sent inline. They are queued in this person's own storage (the OUTBOX) and
 * uploaded in batches to the group's log: at the end of a walk-through, on "Upload now", when the home
 * card opens with events waiting, and by the add-on's check (every 2 hours). A slow or down server
 * therefore never blocks a click, and nothing is lost: events stay queued until the server acknowledges them.
 */

// DEVELOPMENT TOOLS (the "Test Gemini on sample cases" button and its upload of results). false in git and in every release; tools/sync_all.py
// switches it on in the TEST copy only, and `tools/release.py check` refuses a production push if it is not false here.
const DEV_TOOLS = false;
const CODE_VERSION = 'v2'; // bump whenever you redistribute this Code.gs / appsscript.json

// ======================= VERSION CHECK (cached 6h so the homepage stays fast) =======================
function checkVersions() {
  const cache = CacheService.getUserCache();
  const cacheKey = 'verNotices_' + lang_();
  try { const hit = cache.get(cacheKey); if (hit) return JSON.parse(hit); } catch (e) { /* ignore */ }
  const notices = [];
  try {
    const remoteContainer = ReplyTrackingLib.getLatestContainerVersionFromGitHub();
    if (remoteContainer && remoteContainer !== CODE_VERSION) {
      notices.push(t('ver.container', CODE_VERSION, remoteContainer, `<a href="${ReplyTrackingLib.getCodeDownloadUrl()}">`, '</a>'));
    }
    const remoteLibrary = ReplyTrackingLib.getLatestLibraryVersionFromGitHub();
    const localLibrary = ReplyTrackingLib.getLibraryVersion();
    const stripV = s => String(s || '').replace(/^v/i, '');
    if (remoteLibrary && localLibrary && stripV(remoteLibrary) !== stripV(localLibrary)) {
      const editorUrl = `https://script.google.com/d/${ScriptApp.getScriptId()}/edit`;
      notices.push(t('ver.library', localLibrary, remoteLibrary, `<a href="${editorUrl}">`, '</a>', stripV(remoteLibrary)));
    }
  } catch (e) { /* best-effort — never block the homepage */ }
  try { cache.put(cacheKey, JSON.stringify(notices), 6 * 3600); } catch (e) { /* ignore */ }
  return notices;
}

// ======================= PERSONAL SECRETS (read here, never in the library) =======================
function getProp(key) { return PropertiesService.getScriptProperties().getProperty(key) || null; }
function mySenderName() { return getProp('SENDER_NAME') || myEmail(); }
function myApiKey() { return getProp('GEMINI_API_KEY'); }
function myEmail() { return ReplyTrackingLib.getMyEmail(); }

// ======================= PERSONAL STORAGE (this container's own UserProperties) =======================
// Each Properties value is capped at ~9 KB, so nothing big is ever stored as one value:
//   - registry: ONE property per thread ("t_<threadId>")
//   - queues / lists: split into small chunks by putBlob/getBlob
const UP = PropertiesService.getUserProperties();
const CHUNK_CHARS = 2500; // x up to 3 bytes (Hebrew = 2) stays well under 9 KB

function putBlob(name, obj) {
  delBlob(name);
  const s = JSON.stringify(obj);
  const n = Math.max(1, Math.ceil(s.length / CHUNK_CHARS));
  const props = {};
  props[name + '#n'] = String(n);
  for (let i = 0; i < n; i++) props[name + '#' + i] = s.substr(i * CHUNK_CHARS, CHUNK_CHARS);
  UP.setProperties(props);
}
function getBlob(name, fallback) {
  const n = parseInt(UP.getProperty(name + '#n') || '0', 10);
  if (!n) return fallback;
  let s = '';
  for (let i = 0; i < n; i++) s += UP.getProperty(name + '#' + i) || '';
  try { return JSON.parse(s); } catch (e) { return fallback; }
}
function delBlob(name) {
  const n = parseInt(UP.getProperty(name + '#n') || '0', 10);
  for (let i = 0; i < n; i++) UP.deleteProperty(name + '#' + i);
  UP.deleteProperty(name + '#n');
}

// ---- thread registry ----
function migrateOldMap() {
  const old = UP.getProperty('threadMap'); // v1 stored everything in one property
  if (!old) return;
  try {
    const m = JSON.parse(old);
    const props = {};
    Object.keys(m).forEach(id => { if (!UP.getProperty('t_' + id)) props['t_' + id] = JSON.stringify(m[id]); });
    UP.setProperties(props);
  } catch (e) { return; }
  UP.deleteProperty('threadMap');
}
function getThreadMap() {
  migrateOldMap();
  const all = UP.getProperties();
  const map = {};
  Object.keys(all).forEach(k => {
    if (k.indexOf('t_') === 0) { try { map[k.slice(2)] = JSON.parse(all[k]); } catch (e) { /* skip corrupt entry */ } }
  });
  return map;
}
function saveThread(threadId, entry) { UP.setProperty('t_' + threadId, JSON.stringify(entry)); }
function isLogged(entry, msgId) { return (entry.done || []).indexOf(msgId) !== -1; }
function markLogged(entry, msgId) {
  entry.done = entry.done || [];
  if (entry.done.indexOf(msgId) === -1) entry.done.push(msgId);
}

// ---- queue session ----
function startSession(steps) {
  delBlob('judgments');
  putBlob('sessionQueue', steps);
  UP.setProperty('sessionIndex', '0');
}
function loadSession() {
  return { queue: getBlob('sessionQueue', []), index: parseInt(UP.getProperty('sessionIndex') || '0', 10) };
}
function setSessionIndex(i) { UP.setProperty('sessionIndex', String(i)); }
function clearSession() { delBlob('sessionQueue'); delBlob('judgments'); UP.deleteProperty('sessionIndex'); }

// ======================= OUTBOX (events waiting to be uploaded to the gateway) =======================
// One property per event ("o_<hash of eventId>", so re-queueing the same event just overwrites it).
// Events the gateway REJECTS (not retried: they would be rejected again) move to "x_..." for inspection.
const OUTBOX_MAX = 250;     // an event is ~0.7 KB and the UserProperties total quota is ~500 KB
const OUTBOX_BATCH = 50;    // events per upload request (the gateway accepts up to 100)

function outboxKey(eventId) {
  // A short hash, not the id itself: property keys are limited to ~128 chars and status event ids can be long.
  const hex = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(eventId), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  return 'o_' + hex.slice(0, 40);
}
function outboxKeys() { return Object.keys(UP.getProperties()).filter(k => k.indexOf('o_') === 0).sort(); }
function outboxCount() { return outboxKeys().length; }
function rejectedCount() { return Object.keys(UP.getProperties()).filter(k => k.indexOf('x_') === 0).length; }
// The add-on's storage (UserProperties) holds about 500,000 characters in all (measured in the spike). The registry only grows, so
// closed conversations are COMPACTED (compactRegistry_), and a banner still warns if the storage nears its limit.
const STORAGE_WARN_CHARS = 400000;

// ---- registry compaction: hot entry here, cold storage in the group log ----
// A conversation closed for COMPACT_AFTER_DAYS keeps its registry KEY (so the scans still count it as tracked, the coverage
// heartbeat is unchanged, and the card beside its email still shows it) but only a small entry: topic, recipients, subject,
// closed, status and `lastReported` = the date of its last message, which the library treats as "everything up to here is
// logged". The full detail (logged message ids, ratings) is already in the group log; hydrate_() reads it back for ONE
// conversation through the gateway (restore with a threadId) when a card needs it. Compacted only when every message is logged
// (ReplyTrackingLib.compactionWatermark) and nothing of the conversation waits in the outbox or was refused.
const COMPACT_AFTER_DAYS = 30;
function compactRegistry_(budgetMs) {
  const t0 = Date.now(), now = new Date().toISOString();
  const all = UP.getProperties();
  const pendingThreads = new Set();
  Object.keys(all).filter(k => k.indexOf('o_') === 0 || k.indexOf('x_') === 0).forEach(k => {
    try { const v = JSON.parse(all[k]); pendingThreads.add((v.event || v).threadId); } catch (e) { /* unreadable: ignore */ }
  });
  let compacted = 0;
  for (const k of Object.keys(all)) {
    if (k.indexOf('t_') !== 0 || Date.now() - t0 > (budgetMs || 20000)) continue;
    let entry;
    try { entry = JSON.parse(all[k]); } catch (e) { continue; }
    const id = k.slice(2);
    if (!entry.closed || entry.compacted || pendingThreads.has(id)) continue;
    if (!entry.closedSeen) { entry.closedSeen = now; saveThread(id, entry); continue; }   // the clock starts when a check first sees it closed
    if (Date.now() - Date.parse(entry.closedSeen) < COMPACT_AFTER_DAYS * 86400000) continue;
    const mark = cfgLib_().compactionWatermark(id, entry);
    if (!mark) continue;
    const small = { topic: entry.topic || '', recipients: entry.recipients || '', subject: entry.subject || '', closed: true, lastReported: mark, compacted: true };
    if (entry.status) small.status = entry.status;
    saveThread(id, small);
    compacted++;
  }
  return compacted;
}
/** A compacted entry with its detail read back from the group log (one conversation), for a card. Unchanged if not compacted or the log is unreachable. */
function hydrate_(threadId, entry) {
  if (!entry || !entry.compacted) return entry;
  try {
    const r = ReplyTrackingLib.fetchHistory(identityToken(), CODE_VERSION, threadId);
    const h = r && r.ok && (r.threads || []).filter(x => x.threadId === threadId)[0];
    if (!h) return entry;
    return Object.assign({}, entry, { done: (h.done || []).concat(entry.done || []), tags: Object.assign({}, h.tags || {}, entry.tags || {}) });
  } catch (e) { return entry; }   // the thread card then says "rated (the rating is in the group log)"
}
function storageUsed_() { const all = UP.getProperties(); return Object.keys(all).reduce((n, k) => n + k.length + String(all[k]).length, 0); }
/** Events the gateway refused ("x_...") share the ~500 KB property quota with the registry and the outbox: drop them after a while. */
const REJECTED_KEEP_DAYS = 30;
function purgeRejected_(nowMs) {
  const all = UP.getProperties();
  let n = 0;
  Object.keys(all).filter(k => k.indexOf('x_') === 0).forEach(k => {
    let at = NaN;
    try { at = Date.parse(JSON.parse(all[k]).at); } catch (e) { /* unreadable: drop it */ }
    if (isNaN(at) || (nowMs || Date.now()) - at > REJECTED_KEEP_DAYS * 86400000) { UP.deleteProperty(k); n++; }
  });
  return n;
}

/**
 * Queues an event locally (fast, no network). Throws if the backlog is full, so the user sees it instead of data silently piling up.
 * Reading every property to count the outbox costs ~180 ms once it holds a few hundred, so a running counter ("outboxN") is kept;
 * it is re-synced with the real count whenever it says "full" and at the end of every upload.
 */
function enqueueEvent(ev) {
  const key = outboxKey(ev.eventId);
  if (UP.getProperty(key) === null) {
    let n = parseInt(UP.getProperty('outboxN') || '0', 10);
    if (n >= OUTBOX_MAX) n = outboxCount();   // the counter may be stale: check the truth before refusing
    if (n >= OUTBOX_MAX) {
      UP.setProperty('outboxN', String(n));
      throw new Error(t('err.outboxFull', OUTBOX_MAX));
    }
    UP.setProperty('outboxN', String(n + 1));
  }
  UP.setProperty(key, JSON.stringify(ev));
}

function identityToken() { try { return ScriptApp.getIdentityToken(); } catch (e) { return null; } }
/**
 * The gateway call is the one thing in a click that can be slow (measured: usually 3-4 s, but one call took ~35 s, apparently a cold start
 * of the web app; Apps Script gives no way to set a fetch timeout). So an upload is only attempted INSIDE a click when the last one was
 * fast and successful; otherwise events just wait and the user presses "Upload now" (or the background trigger runs).
 */
const INLINE_UPLOAD_MAX_MS = 6000;
function inlineUploadAllowed() {
  const st = getUploadStatus();
  return !st || (st.ok !== false && (st.ms || 0) <= INLINE_UPLOAD_MAX_MS);
}
function setUploadStatus(obj) {
  UP.setProperty('uploadStatus', JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)));
  // When uploads started failing (the home card's banner appears only after a day of failures, not on one slow call).
  if (obj.ok === false) { if (!UP.getProperty('failingSince')) UP.setProperty('failingSince', String(Date.now())); }
  else UP.deleteProperty('failingSince');
}
function getUploadStatus() { try { return JSON.parse(UP.getProperty('uploadStatus') || 'null'); } catch (e) { return null; } }

// ---- group settings (targets, templates, topics, rubric) ----
// The gateway serves them (ReplyTrackingLib.fetchConfig); members have no access to the owner's data Sheet. The last good copy is
// kept HERE (blob `cfg` = { version, tabs }), because the stateless library may not store anything, and handed to the library once
// per execution (ReplyTrackingLib.useConfig) by cfgLib_(). So a click never waits for the gateway, and when the gateway is down the
// cards keep working from the saved copy. Refreshed by the background checks (every LIGHT_CHECK_HOURS), and inside a click only
// when there is no copy yet, or the copy was last confirmed more than CONFIG_STALE_MS ago and the last refresh was quick.
const CONFIG_STALE_MS = 24 * 3600 * 1000;
let _cfgReady = false, _cfgTried = false;   // per execution
/** The library, with the group settings loaded. Use it for every call that reads targets, templates, topics or the rubric. */
function cfgLib_() { ensureConfig_(); return ReplyTrackingLib; }
function ensureConfig_(opts) {
  opts = opts || {};
  if ((_cfgReady || _cfgTried) && !opts.refresh) return;   // at most one gateway try per execution unless asked
  _cfgTried = true;
  let cfg = getBlob('cfg', null);
  const checked = parseInt(UP.getProperty('cfgCheckedAt') || '0', 10);
  if (opts.refresh || !cfg || (Date.now() - checked > CONFIG_STALE_MS && configRefreshQuick_())) cfg = refreshConfig_(cfg);
  if (cfg && cfg.tabs) { ReplyTrackingLib.useConfig(cfg); _cfgReady = true; }
}
/** Asks the gateway for newer settings. Returns the copy to use (the new one, or `cached` when unchanged or unreachable). Never throws. */
function refreshConfig_(cached) {
  const t0 = Date.now();
  let r;
  try { r = ReplyTrackingLib.fetchConfig(identityToken(), CODE_VERSION, cached && cached.version); }
  catch (err) { setConfigStatus({ ok: false, error: String((err && err.message) || err), ms: Date.now() - t0 }); return cached; }
  if (!r || !r.ok) {
    if (r && r.error === 'update_required') UP.setProperty('updateRequired', JSON.stringify(r));
    setConfigStatus({ ok: false, error: (r && r.error) || 'no answer', ms: Date.now() - t0 });
    return cached;
  }
  UP.setProperty('cfgCheckedAt', String(Date.now()));
  setConfigStatus({ ok: true, version: r.version, ms: Date.now() - t0 });
  UP.setProperty('cfgFeatures', JSON.stringify(r.features || {}));   // group switches (evidence upload); missing = all off
  if (r.unchanged && cached) return cached;
  if (!r.config || !r.config.tabs) return cached;
  const fresh = { version: r.version, tabs: r.config.tabs };
  putBlob('cfg', fresh);
  return fresh;
}
/**
 * True when a settings refresh inside a click is unlikely to hang it: the last one answered quickly, or it failed more than an hour
 * ago (so a member whose background checks are off still recovers after an outage).
 */
function configRefreshQuick_() {
  const st = getConfigStatus();
  if (!st) return true;
  if (st.ok === false || (st.ms || 0) > INLINE_UPLOAD_MAX_MS) return Date.now() - (Date.parse(st.at) || 0) > 3600 * 1000;
  return true;
}
function setConfigStatus(obj) { UP.setProperty('cfgStatus', JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj))); }
function getConfigStatus() { try { return JSON.parse(UP.getProperty('cfgStatus') || 'null'); } catch (e) { return null; } }

/**
 * Uploads queued events in batches until the outbox is empty, the gateway refuses, or `maxMs` passes.
 * Returns { sent, duplicates, rejected, remaining, error? }. Never throws.
 */
function flushOutbox(opts) {
  opts = opts || {};
  const maxMs = opts.maxMs || 20000;
  const started = Date.now();
  const lock = LockService.getUserLock();
  if (!lock.tryLock(opts.waitMs || 3000)) return { skipped: 'busy', remaining: outboxCount() };
  const total = { sent: 0, duplicates: 0, rejected: 0, remaining: 0 };
  try {
    UP.setProperty('lastFlushAttempt', String(Date.now()));
    for (;;) {
      const all = UP.getProperties();
      const keys = Object.keys(all).filter(k => k.indexOf('o_') === 0).sort();
      total.remaining = keys.length;
      UP.setProperty('outboxN', String(keys.length));   // re-sync the enqueue counter with the truth
      if (!keys.length) { setUploadStatus({ ok: true, sent: total.sent, duplicates: total.duplicates, rejected: total.rejected, ms: Date.now() - started }); return total; }
      if (Date.now() - started > maxMs) return total;

      let batchKeys = keys.slice(0, OUTBOX_BATCH);
      let events;
      try {
        // Reply events get their email-signature evidence now (re-read from Gmail; not kept in the outbox). If that takes too
        // long only the finished prefix is uploaded this round and the rest stays queued.
        events = ReplyTrackingLib.attachAuthEvidence(batchKeys.map(k => JSON.parse(all[k])), 15000);
        batchKeys = batchKeys.slice(0, events.length);
      } catch (err) {
        total.error = String((err && err.message) || err);
        setUploadStatus({ ok: false, error: total.error, ms: Date.now() - started });
        return total;
      }
      let res;
      try { res = ReplyTrackingLib.postEvents(events, identityToken(), CODE_VERSION); }
      catch (err) {
        total.error = String((err && err.message) || err);
        setUploadStatus({ ok: false, error: total.error, ms: Date.now() - started });
        return total;
      }
      if (!res.ok) {
        // 'paused' (GCP gateway, 21 Nov 2026): the guard paused this member for an admin review; the events stay queued.
        total.error = res.error === 'paused' ? t('up.paused') : res.error + (res.detail ? ' (' + res.detail + ')' : '');
        setUploadStatus({ ok: false, error: total.error });
        if (res.error === 'update_required') UP.setProperty('updateRequired', JSON.stringify(res));
        return total;
      }
      UP.deleteProperty('updateRequired');
      const byId = {};
      (res.results || []).forEach(r => { if (r && r.eventId) byId[r.eventId] = r; });
      let progressed = 0;
      batchKeys.forEach((k, i) => {
        const r = byId[events[i].eventId];
        if (!r) return;   // not acknowledged: keep it queued
        if (r.status === 'accepted') { total.sent++; UP.deleteProperty(k); progressed++; }
        else if (r.status === 'duplicate') { total.duplicates++; UP.deleteProperty(k); progressed++; }
        else {
          total.rejected++; progressed++;
          UP.setProperty('x_' + k.slice(2), JSON.stringify({ event: events[i], reason: r.reason || 'rejected', at: new Date().toISOString() }));
          UP.deleteProperty(k);
        }
      });
      if (!progressed) { total.error = t('err.noAck'); setUploadStatus({ ok: false, error: total.error }); return total; }
    }
  } finally {
    lock.releaseLock();
  }
}

// No separate upload trigger (removed 23 Nov 2026): an add-on may hold only one time-based trigger per user (the check trigger,
// which uploads waiting records every LIGHT_CHECK_HOURS), and add-on triggers may not run more often than hourly.

// ======================= LANGUAGE (Hebrew / English) =======================
// The texts live in the library (ReplyTrackingLib.getStrings), so a wording fix reaches everyone without a new Code.gs.
// Default: Hebrew (members are Israeli doctors); Settings switches to English. The member's Gmail language is NOT detected on purpose:
// both commonEventObject.userLocale ("useLocaleFromApp") and Session.getActiveUserLocale() need the extra script.locale scope
// (verified 17 Nov 2026: the home card failed with "Required permissions: .../auth/script.locale"), and every member would have to re-approve.
// Direction: CardService has no direction setting. Gmail mirrors the whole layout when ITS language is Hebrew; inside a card each line of
// interface text is wrapped in a right-to-left isolate (U+2067..U+2069) in Hebrew mode, and email text in a first-strong isolate
// (U+2068..U+2069), so punctuation, numbers and mixed Hebrew/English stay in the right order whatever language Gmail itself uses.
let _str = null;
const DEFAULT_LANG = 'he';
/**
 * The interface language: the member's choice; before they choose, Gmail's own language (Hebrew Gmail -> Hebrew, any other -> English),
 * and DEFAULT_LANG if Gmail's language is not known yet. Verified 18 Nov 2026: Gmail lays the add-on panel out right-to-left ONLY when
 * Gmail itself is in Hebrew; CardService has no alignment setting (Columns render nothing in Gmail), so Hebrew text in an English Gmail
 * stays left-aligned. Gmail's language comes with every event once the manifest sets useLocaleFromApp (scope script.locale).
 */
function lang_() { return UP.getProperty('lang') || (gmailLocale_() ? (gmailIsHebrew_() ? 'he' : 'en') : DEFAULT_LANG); }
function gmailLocale_() { return UP.getProperty('gmailLocale') || ''; }
function gmailIsHebrew_() { return /^(he|iw)/i.test(gmailLocale_()); }
/** Remembers Gmail's language from an event (entry points call it). */
function noteLocale_(e) {
  const loc = e && e.commonEventObject && e.commonEventObject.userLocale;
  if (loc && loc !== UP.getProperty('gmailLocale')) { UP.setProperty('gmailLocale', loc); _str = null; }
}
/** Hebrew chosen while Gmail is in another language: the panel stays left-to-right. A short note and a link to Gmail's language setting. */
function rtlHint_(section) {
  if (lang_() !== 'he' || !gmailLocale_() || gmailIsHebrew_()) return;
  section.addWidget(para('<i>' + t('set.rtlHint') + '</i>'));
  section.addWidget(CardService.newTextButton().setText(ui(t('set.rtlLink'))).setOpenLink(CardService.newOpenLink().setUrl('https://mail.google.com/mail/#settings/general')));
}
function isRtl_() { return lang_() === 'he'; }
/** Whether Gmail lays the PANEL out right to left: only when Gmail itself is in Hebrew (verified 18 and 20 Nov 2026). Before Gmail's language
 *  is known, assume it matches the add-on's language. Layout decisions (button order, arrow direction) follow this, not the add-on's language. */
function panelRtl_() { return gmailLocale_() ? gmailIsHebrew_() : isRtl_(); }
/** Interface text by key; {0}, {1}… are replaced by the arguments. Unknown keys show the key itself, so a missing text is visible, not fatal. */
function t(key) {
  if (!_str) { try { _str = ReplyTrackingLib.getStrings(lang_()); } catch (e) { _str = {}; } }
  const args = Array.prototype.slice.call(arguments, 1);
  const s = _str[key] === undefined ? key : _str[key];
  return String(s).replace(/\{(\d+)\}/g, (m, i) => args[i] === undefined ? m : String(args[i]));
}
function isolate_(s, open) { return open + String(s).replace(/<br>/g, '⁩<br>' + open) + '⁩'; }
/** Interface text: right-to-left in Hebrew mode, untouched in English mode. */
function ui(s) { return isRtl_() ? isolate_(s, '⁧') : String(s); }
/** Text written by people (emails, subjects): each line takes the direction of its own first letter. */
function userText(s) { return isolate_(s, '⁨'); }
function header(title, subtitle) {
  const h = CardService.newCardHeader().setTitle(ui(title));
  return subtitle ? h.setSubtitle(subtitle) : h;
}
/** A header whose title is text written by people (an email subject): plain text, takes the direction of its first letter. */
function headerUser_(title, subtitle) {
  const h = CardService.newCardHeader().setTitle(userText(title));
  return subtitle ? h.setSubtitle(subtitle) : h;
}

// ======================= SMALL HELPERS =======================
/** HTML-escape for TextParagraph / DecoratedText ONLY. Plain-text widgets (selection items, headers) must NOT be escaped. */
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function nl2br(s) { return String(s).replace(/\r?\n/g, '<br>'); }
function para(text) { return CardService.newTextParagraph().setText(ui(text)); }
/** A paragraph of email text (already escaped): its own direction per line, whatever the interface language. */
function contentPara(html) { return CardService.newTextParagraph().setText(userText(html)); }
function button(text, fn, params) {
  const a = CardService.newAction().setFunctionName(fn);
  if (params) a.setParameters(params);
  return CardService.newTextButton().setText(ui(text)).setOnClickAction(a);
}
/**
 * Two buttons side by side, the first one on the reading side of the add-on's language (right in Hebrew, left in English).
 * Gmail mirrors button sets when Gmail itself is in Hebrew, so swap only when the add-on's language and the panel's direction differ
 * (verified 20 Nov 2026, docs/design/panel-reality-check.md B1: swapping in a Hebrew Gmail put the primary button on the LEFT).
 */
function buttonPair(first, second) {
  return isRtl_() !== panelRtl_() ? CardService.newButtonSet().addButton(second).addButton(first) : CardService.newButtonSet().addButton(first).addButton(second);
}
function note(text) { return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(ui(text))).build(); }
function noteAndUpdate(text, card) {
  return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(ui(text)))
    .setNavigation(CardService.newNavigation().updateCard(card)).build();
}
function pushTo(card) { return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().pushCard(card)).build(); }
function updateTo(card) { return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().updateCard(card)).build(); }

// ======================= SHARED CARD PIECES (redesign, 17 Nov 2026) =======================
/** A Material icon for a DecoratedText; falls back to a built-in icon if this Gmail does not support Material icons in add-ons. */
function icon_(name) {
  try { return CardService.newIconImage().setMaterialIcon(CardService.newMaterialIcon().setName(name)); }
  catch (e) { return CardService.newIconImage().setIcon(CardService.Icon.DESCRIPTION); }
}
/**
 * One row: { icon, top, text, bottom, fn, params, button, wrap }. `text`/`top`/`bottom` are HTML-escaped interface or user text already
 * wrapped by the caller (ui() / userText()). With `fn` the whole row is the click target.
 */
function row_(o) {
  const d = CardService.newDecoratedText().setText(o.text).setWrapText(o.wrap !== false);
  if (o.icon) d.setStartIcon(icon_(o.icon));
  if (o.top) d.setTopLabel(o.top);
  if (o.bottom) d.setBottomLabel(o.bottom);
  if (o.fn) { const a = CardService.newAction().setFunctionName(o.fn); if (o.params) a.setParameters(o.params); d.setOnClickAction(a); }
  if (o.button) d.setButton(o.button);
  if (o.link) d.setOpenLink(CardService.newOpenLink().setUrl(o.link));
  if (o.endIcon) { try { d.setEndIcon(icon_(o.endIcon)); } catch (e) { /* end icons unsupported here: the row still works */ } }
  return d;
}
/** A forward arrow in the add-on's reading direction (left in Hebrew, right in English): marks a row whose tap moves on.
 *  Deliberately follows the add-on's language, not Gmail's layout direction (owner's decision, 20 Nov 2026). */
function forwardIcon_() { return isRtl_() ? 'chevron_left' : 'chevron_right'; }
function filledButton_(text, fn, params) { return button(text, fn, params).setTextButtonStyle(CardService.TextButtonStyle.FILLED); }
/** The bottom bar: one primary (filled) button and an optional secondary one. */
function footer_(builder, primary, secondary) {
  const f = CardService.newFixedFooter().setPrimaryButton(primary.setTextButtonStyle(CardService.TextButtonStyle.FILLED));
  if (secondary) f.setSecondaryButton(secondary);
  builder.setFixedFooter(f);
}
/** The card's ⋮ menu: the less frequent destinations, so the home card itself stays about work. */
function addMenu_(builder) {
  const act = (label, fn) => CardService.newCardAction().setText(label).setOnClickAction(CardService.newAction().setFunctionName(fn));
  builder.addCardAction(act(t('menu.inquiries'), 'onInquiries'));
  builder.addCardAction(act(t('menu.search'), 'onScanManualPrompt'));
  builder.addCardAction(act(t('menu.settings'), 'onSettingsHome'));
  const help = docsUrl_('guide');   // the member guide in the interface language (plan U7)
  if (help) builder.addCardAction(CardService.newCardAction().setText(t('menu.help')).setOpenLink(CardService.newOpenLink().setUrl(help)));
  if (DEV_TOOLS && typeof devMenu_ === 'function') devMenu_(builder, act);   // test copies only (devMenu_ lives in a test-only file)
}
/** A member documentation page in the interface language, or '' (also when the library predates getDocsUrl). */
function docsUrl_(page) {
  try { return ReplyTrackingLib.getDocsUrl(page, lang_()) || ''; } catch (e) { return ''; }
}
/** Rows that open the member documentation (Settings): how to use it, your data, about the project. */
function docsSection_() {
  const sec = CardService.newCardSection().setHeader(ui(t('set.docsHeader')));
  [['guide', 'help', 'set.docsGuide'], ['data', 'shield', 'set.docsData'], ['about', 'info', 'set.docsAbout']].forEach(([page, ic, key]) => {
    const url = docsUrl_(page);
    if (url) sec.addWidget(row_({ icon: ic, text: ui(t(key)), link: url, endIcon: 'open_in_new' }));
  });
  return sec;
}
/** "All saved to the group log" or "N records waiting": the only upload information on everyday cards. */
function statusLine_() {
  const n = outboxCount();
  return n ? row_({ icon: 'cloud_upload', text: ui(n === 1 ? t('status.waitingOne') : t('status.waiting', n)), bottom: ui(n === 1 ? t('status.waitingHintOne') : t('status.waitingHint')) })
           : row_({ icon: 'cloud_done', text: ui(t('status.saved')) });
}
const FAILING_BANNER_MS = 24 * 3600 * 1000;
const OUTBOX_WARN = 200;
/** A banner only when the member must act: an update is needed, uploads have failed for over a day, or the queue is nearly full. */
function problemSection_() {
  const lines = [];
  if (UP.getProperty('updateRequired')) lines.push(t('banner.update'));
  const st = getUploadStatus();
  const firstFail = parseInt(UP.getProperty('failingSince') || '0', 10);
  if (st && st.ok === false && firstFail && Date.now() - firstFail > FAILING_BANNER_MS) lines.push(t('banner.failing', esc(fmtDate(new Date(firstFail).toISOString()))));
  const n = outboxCount();
  if (n >= OUTBOX_WARN) lines.push(t('banner.full', n, OUTBOX_MAX));
  const refused = rejectedCount();
  if (refused) lines.push(t('banner.rejected', refused, REJECTED_KEEP_DAYS));
  if (storageUsed_() > STORAGE_WARN_CHARS) lines.push(t('banner.storage'));
  checkVersions().forEach(v => lines.push(v));   // our own text with a link: not escaped
  if (!lines.length) return null;
  const s = CardService.newCardSection();
  lines.forEach(l => s.addWidget(row_({ icon: 'warning', text: ui(l) })));
  return s;
}
/** "today 07:02" / "16 Nov 2026" for the home card's subtitle. */
function whenText_(iso) {
  const d = new Date(iso);
  const tz = Session.getScriptTimeZone();
  if (Utilities.formatDate(d, tz, 'yyyyMMdd') === Utilities.formatDate(new Date(), tz, 'yyyyMMdd')) return (isRtl_() ? 'היום ' : 'today ') + Utilities.formatDate(d, tz, 'HH:mm');
  return fmtDate(iso);
}
function daysSince_(iso) { return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000)); }

// ---- conversations the member switched off ("not an inquiry"): never offered again, counted as declined in the coverage heartbeat ----
function declinedIds_() { return getBlob('declined', []); }
function addDeclined_(ids) {
  const cur = declinedIds_();
  ids.forEach(id => { if (cur.indexOf(id) === -1) cur.push(id); });
  putBlob('declined', cur.slice(-2000));
}

/** Multi-value widgets (checkboxes) only deliver ALL their values via commonEventObject.formInputs; e.formInput is a first-value-only legacy view. */
function formValues(e, name) {
  const ci = e.commonEventObject && e.commonEventObject.formInputs;
  if (ci && ci[name] && ci[name].stringInputs) return ci[name].stringInputs.value || [];
  const v = e.formInput && e.formInput[name];
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}
function formValue(e, name) { const v = formValues(e, name); return v.length ? String(v[0]) : ''; }

// ======================= HOMEPAGE =======================
function uploadSummaryHtml(up) {
  const left = outboxCount();
  if (!up) return left ? t('up.waiting', left) : '';
  if (up.skipped === 'slow') return t('up.slow', left);
  if (up.skipped) return '<i>' + t('up.inProgress') + '</i>';
  if (up.error) return t('up.problem', esc(up.error), left);
  if (left) return t('up.stillWaiting', left);
  if (!(up.sent || up.duplicates)) return t('up.nothing');
  return up.duplicates ? t('up.doneDup', up.sent, up.duplicates) : t('up.done', up.sent);
}

/** Tries an upload when events are waiting and the last attempt was over a minute ago, so the home card self-heals without hammering a down gateway. */
function maybeAutoFlush() {
  if (!outboxCount() || !inlineUploadAllowed()) return;
  const last = parseInt(UP.getProperty('lastFlushAttempt') || '0', 10);
  if (Date.now() - last > 60000) flushOutbox({ maxMs: 6000, waitMs: 500 });
}

/**
 * HOME (redesign). Only about work: what needs the member (from the daily check), where their inquiries stand, one status line.
 * Settings, search and the inquiry list are in the ⋮ menu; a new install goes through the welcome first.
 */
function onHomepage(e) {
  noteLocale_(e);
  if (!welcomeDone_()) return buildWelcomeCard(1);
  try { maybeAutoFlush(); } catch (err) { /* never block the home card */ }
  try { maybeScan_(); } catch (err) { /* never block the home card */ }
  try { settleDrafts_(); } catch (err) { /* a draft sent from Gmail is picked up next time */ }
  const builder = CardService.newCardBuilder();
  const scan = getScanState();
  const lastCheck = lastCheckAt_(scan);
  builder.setHeader(header(t('app.name'), ui(lastCheck ? t('home.checked', whenText_(lastCheck)) : t('home.notChecked'))));
  addMenu_(builder);
  const problems = problemSection_();
  if (problems) builder.addSection(problems);

  const replies = scan ? (scan.newReplies !== undefined ? scan.newReplies : scan.newMessages) || 0 : 0;
  const threads = scan ? scan.newThreads || 0 : 0;
  const needs = CardService.newCardSection().setHeader(ui(t('home.needsHeader')));
  // No check for over a day (or never): say so, instead of scanning inside this click. Tapping the row is "Check now".
  // Rows that open something end in a forward arrow (as on the reply card); the action rows are bold (panel reality check, 20 Nov 2026).
  const fwd = forwardIcon_();
  if (checkIsStale_(scan)) needs.addWidget(row_({ icon: 'update', text: ui(lastCheck ? t('home.staleCheck', whenText_(lastCheck)) : t('home.notChecked')), bottom: ui(t('home.staleHint')), fn: 'onCheckNow', endIcon: fwd }));
  if (replies) needs.addWidget(row_({ icon: 'reply', text: ui('<b>' + (replies === 1 ? t('home.replyToRate') : t('home.repliesToRate', replies)) + '</b>'), bottom: ui(t('home.repliesHint')), fn: 'onReview', endIcon: fwd }));
  if (threads) needs.addWidget(row_({ icon: 'move_to_inbox', text: ui('<b>' + (threads === 1 ? t('home.newConv') : t('home.newConvs', threads)) + '</b>'), bottom: ui(t('home.newConvsHint')), fn: 'onReview', endIcon: fwd }));
  if (!replies && !threads) needs.addWidget(row_({ icon: 'check_circle', text: ui(t('home.nothingNeeds')) }));
  builder.addSection(needs);

  const inq = CardService.newCardSection().setHeader(ui(t('home.inqHeader')));
  const sum = inquirySummary_();
  if (!sum.total) inq.addWidget(para('<i>' + t('home.noInquiries') + '</i>'));
  if (sum.waitingIma) inq.addWidget(row_({ icon: 'schedule', text: ui(t('home.waitingIma', sum.waitingIma)),
    bottom: sum.longest ? ui(t('home.longest', daysWord(sum.longest.days), userText(esc(sum.longest.subject)))) : '', fn: 'onInquiries', endIcon: fwd }));
  // 'person' (it is the member's move), not 'reply' a second time: "replies to rate" above already uses the reply arrow.
  if (sum.waitingYou) inq.addWidget(row_({ icon: 'person', text: ui(t('home.waitingYou', sum.waitingYou)), bottom: ui(t('home.waitingYouHint')), fn: 'onInquiries', endIcon: fwd }));
  const drafts = pendingDraftCount_();
  if (drafts) inq.addWidget(row_({ icon: 'drafts', text: ui(drafts === 1 ? t('home.draftOne') : t('home.drafts', drafts)), bottom: ui(t('home.draftsHint')), link: 'https://mail.google.com/mail/#drafts', endIcon: 'open_in_new' }));
  if (scan && scan.unionThreadsFound) inq.addWidget(row_({ icon: 'radar', text: ui(t('home.coverage', scan.registered || 0, scan.unionThreadsFound)), bottom: ui(t('home.coverageHint')), fn: 'onInquiries', endIcon: fwd }));
  const n = replies + threads;
  // "New inquiry" sits in the footer when nothing needs review; only when the footer is "Review" does it appear here.
  inq.addWidget(n ? buttonPair(button(t('home.newInquiry'), 'onComposeNewStart'), button(t('home.allInquiries'), 'onInquiries')) : button(t('home.allInquiries'), 'onInquiries'));
  builder.addSection(inq);

  const st = CardService.newCardSection();
  st.addWidget(statusLine_());
  builder.addSection(st);

  if (n) footer_(builder, button(n === 1 ? t('home.reviewOne') : t('home.review', n), 'onReview'), button(t('home.checkNow'), 'onCheckNow'));
  else footer_(builder, button(t('home.newInquiry'), 'onComposeNewStart'), button(t('home.checkNow'), 'onCheckNow'));
  return builder.build();
}
/** "Check now": the daily check on demand (scan, inquiry states, automatic silence), then a fresh home card. */
function onCheckNow() {
  try {
    if (configRefreshQuick_()) { try { ensureConfig_({ refresh: true }); } catch (e) { /* the saved copy stays in use */ } }
    const s = runDailyScan_('home');
    const n = (s.newReplies || 0) + (s.newThreads || 0);
    return noteAndUpdate(n === 1 ? t('home.checkedOne') : n ? t('home.checkedFound', n) : t('home.checkedNothing'), onHomepage());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
/** Counts for the home card, from the cached inquiry states (no Gmail reads here: the home card must open fast). */
function inquirySummary_() {
  const map = getThreadMap();
  const st = (getBlob('inqState', null) || {}).states || {};
  const out = { total: Object.keys(map).length, waitingIma: 0, waitingYou: 0, longest: null };
  Object.keys(map).forEach(id => {
    const e = map[id], s = st[id];
    if (e.closed || !s) return;
    if (s.lastMine) {
      out.waitingIma++;
      const d = daysSince_(s.last);
      if (!out.longest || d > out.longest.days) out.longest = { days: d, subject: e.subject || s.subject || '' };
    } else if (s.unionReplied) out.waitingYou++;
  });
  return out;
}

function uploadResultText_(r) {
  const left = outboxCount();
  return r.skipped ? t('up.inProgress') : r.error ? t('up.problemShort', r.error) : left ? t('up.stillWaiting', left) : t('up.uploaded');
}
function onUploadNow() {
  const up = flushOutbox({ maxMs: 25000 });
  return noteAndUpdate(uploadResultText_(up), onHomepage());
}

// ======================= DAILY SCAN ("new to log" on the home card) =======================
// A Gmail add-on cannot badge its icon (one logo URL for everyone), so the cue is a section at the top of the home card. Once a
// day the check trigger (`lightCheckTrigger`, installed on the first home-card open; Settings turns it off) counts new union threads and new messages in tracked
// threads, records an observation heartbeat with coverage numbers, and uploads waiting events. If the trigger has not run for over
// 26 hours, the home card does the scan itself.
const SCAN_STALE_MS = 26 * 3600 * 1000;
function getScanState() { try { return JSON.parse(UP.getProperty('scanState') || 'null'); } catch (e) { return null; } }
function runDailyScan_(source) {
  try { settleDrafts_(); } catch (e) { /* next check */ }
  const map = getThreadMap();
  const s = cfgLib_().scanSummary(map, declinedIds_(), UP.getProperty('olderLeft') ? recentCutoff_() : null);   // { newThreads, olderThreads, newMessages, newReplies, unionThreadsFound, registered, declined, capped }
  s.at = new Date().toISOString();
  UP.setProperty('scanState', JSON.stringify(s));
  const open = Object.keys(map).filter(id => !map[id].closed).length;
  try { enqueueEvent(ReplyTrackingLib.buildCoverageHeartbeatEvent(myEmail(), { open: open, unionThreadsFound: s.unionThreadsFound, registered: s.registered, declined: s.declined, capped: s.capped, source: source })); } catch (e) { /* outbox full: the scan still counts */ }
  try { autoSilenceAll_(map); } catch (e) { /* recorded on the next check */ }
  try { refreshInquiryStates_(map, 12000); } catch (e) { /* the inquiry list falls back to what it has */ }
  try { evQueueNew_(); } catch (e) { /* next check */ }   // new messages of uploaded conversations
  return s;
}
/** Re-reads where each tracked inquiry stands (time-limited) and caches it for the home card and "My inquiries". */
/** `merge`: `map` is only some threads (e.g. those of one review); their states replace the old ones, the rest are kept. */
function refreshInquiryStates_(map, maxMs, merge) {
  const r = cfgLib_().inquiryStates(map || getThreadMap(), maxMs || 12000);
  const prev = getBlob('inqState', null) || {};
  const old = prev.states || {};
  putBlob('inqState', { at: merge && prev.at ? prev.at : new Date().toISOString(), states: Object.assign(r.partial || merge ? old : {}, r.states), partial: r.partial || (merge && !!prev.partial) });
}

// ---- automatic silence (decided 17 Nov 2026) ----
// When the member's own message is the last one and SILENCE_THRESHOLD_DAYS have passed, the add-on records the same status/no_response row
// a member's click would, marked finalTag=auto. The thread stays OPEN (a late reply still counts); `silentSince` remembers which silence
// was recorded, so it is recorded once, and a new message clears it. When the union replied last, nothing is recorded.
function autoSilence_(threadId, entry, d) {
  if (!entry || entry.closed) return null;
  d = d || cfgLib_().classifyThread(threadId, entry);
  if (!d || !d.due || d.kind === 'abandoned' || d.needsReview || entry.silentSince === d.lastDate) return null;
  enqueueEvent(ReplyTrackingLib.buildSilenceEvent(threadId, ReplyTrackingLib.silenceValueForKind(d.kind), myEmail(), entry, d.lastDate, true));
  entry.silentSince = d.lastDate;
  saveThread(threadId, entry);
  const rec = { threadId: threadId, subject: d.subject || entry.subject || '', lastDate: d.lastDate, daysSince: d.daysSince };
  const pending = getBlob('autoNew', []);           // shown once on the next "Review finished" card
  pending.push(rec);
  putBlob('autoNew', pending.slice(-30));
  return rec;
}
function autoSilenceAll_(map) {
  const r = cfgLib_().classifyOpenThreads(map);
  r.due.forEach(d => { try { autoSilence_(d.threadId, map[d.threadId], d); } catch (e) { /* next time */ } });
}
function dailyScanTrigger() {
  let scan = null;
  try { ensureConfig_({ refresh: true }); } catch (e) { /* the saved copy stays in use */ }
  try { scan = runDailyScan_('daily'); } catch (e) { /* try again tomorrow */ }
  try { if (scan) maybeSendReminder_(scan); } catch (e) { /* a reminder failure never breaks the daily check */ }
  try { flushOutbox({ maxMs: 60000 }); } catch (e) { /* events stay queued */ }
  try { purgeRejected_(); } catch (e) { /* next day */ }
  try { compactRegistry_(20000); } catch (e) { /* next day */ }
  try { evRun_(EV_RUN_MS); } catch (e) { /* the waiting list stays */ }
}

// ---- weekly reminder email (decided 18 Nov 2026) ----
// ONE email to the member themself when the "Needs you" items (replies to rate + new conversations) have waited a week; at most one
// per week. Counts only: no subjects, no email text. UserProperties: `needsSince` (ISO, when the count last went from 0 to more than 0),
// `reminderSentAt` (ISO), `remindOff` (set = turned off in Settings). Runs only from the daily trigger.
const GMAIL_URL = 'https://mail.google.com/';
/**
 * Pure: is a reminder due? True when `count` > 0, `needsSinceIso` is at least a week old and `lastSentIso` is missing or at least a week
 * old. "A week" allows 2 hours of slack: the daily scan comes every 22-24 hours (`DAILY_SCAN_DUE_MS` on a 2-hour trigger), so a
 * strict 7 x 24 h would often slip the reminder to day 8.
 */
function reminderDue_(nowMs, needsSinceIso, lastSentIso, count) {
  const WEEK_MS = 7 * 86400000 - 2 * 3600000;
  if (!(count > 0) || !needsSinceIso) return false;
  const since = Date.parse(needsSinceIso);
  if (isNaN(since) || nowMs - since < WEEK_MS) return false;
  if (!lastSentIso) return true;
  const last = Date.parse(lastSentIso);
  return isNaN(last) || nowMs - last >= WEEK_MS;
}
/** Keeps `needsSince` in step with the "Needs you" count and sends the reminder when it is due. */
function maybeSendReminder_(scan) {
  if (UP.getProperty('remindOff')) return false;
  const replies = (scan.newReplies !== undefined ? scan.newReplies : scan.newMessages) || 0;
  const threads = scan.newThreads || 0;
  const count = replies + threads;
  if (count <= 0) { UP.deleteProperty('needsSince'); return false; }
  const nowIso = new Date().toISOString();
  let since = UP.getProperty('needsSince');
  if (!since) { since = nowIso; UP.setProperty('needsSince', since); }
  if (!reminderDue_(Date.now(), since, UP.getProperty('reminderSentAt'), count)) return false;
  sendReminder_(replies, threads);
  UP.setProperty('reminderSentAt', nowIso);
  return true;
}
/** Sends the reminder to the member's own address (draft + send: covered by gmail.compose, no gmail.send scope). */
function sendReminder_(replies, threads) {
  const me = myEmail();
  if (!me) throw new Error('no email address');
  const lines = [t('remind.intro'), ''];
  if (replies) lines.push('- ' + (replies === 1 ? t('remind.reply') : t('remind.replies', replies)));
  if (threads) lines.push('- ' + (threads === 1 ? t('remind.conv') : t('remind.convs', threads)));
  lines.push('', t('remind.open'), GMAIL_URL, '', t('remind.footer'));
  const body = lines.join('\n');
  const opts = isRtl_() ? { htmlBody: rtlHtml_(body).replace(GMAIL_URL, '<a href="' + GMAIL_URL + '">' + GMAIL_URL + '</a>') } : {};
  GmailApp.createDraft(me, t('remind.subject'), body, opts).send();
}
/**
 * ONE time-based trigger per member (clicked in Gmail 23 Nov 2026): an add-on may hold only "one trigger of each type, per user, per
 * document" (Google's add-on trigger rules) and none more often than hourly; a second time-based trigger fails with "too many
 * time-based triggers". So `lightCheckTrigger` (every LIGHT_CHECK_HOURS) also runs the full daily scan when it is due. The 2-hour slots
 * start at each member's install time, which spreads the members' daily scans over the day (the gateway answers busy beyond about 30
 * parallel requests).
 */
function installScanTrigger() {
  removeScanTrigger();
  ScriptApp.newTrigger('lightCheckTrigger').timeBased().everyHours(LIGHT_CHECK_HOURS).create();
}
function removeScanTrigger() {   // dailyScanTrigger and flushOutboxTrigger: retired triggers of older versions, removed to free the slot
  ScriptApp.getProjectTriggers().filter(tr => ['dailyScanTrigger', 'lightCheckTrigger', 'flushOutboxTrigger'].includes(tr.getHandlerFunction()))
    .forEach(tr => ScriptApp.deleteTrigger(tr));
}

// ---- light check (decided 18 Nov 2026) ----
// Reply TIMES come from the messages' own dates, never from when a scan ran, so the cadence only decides how fresh the home card is.
// Silence uses a 14-day threshold (SILENCE_THRESHOLD_DAYS), so finding new conversations and recording silence once a day is enough (the full daily scan).
// What benefits from a shorter cadence is "a reply to rate", so a LIGHT check runs every LIGHT_CHECK_HOURS: one Gmail search for new
// messages in TRACKED threads, the inquiry states of the threads it touched, and the upload of waiting records. No coverage heartbeat,
// no new-conversation search (the daily scan keeps both). The home card never scans inline any more: a click must stay fast.
const LIGHT_CHECK_HOURS = 2;   // measured 18 Nov 2026 in the test account: about 1.5 s per run (16 tracked threads), so 2 hours, not 4
const DAILY_SCAN_DUE_MS = 22 * 3600 * 1000;   // with runs every 2 hours, the full scan comes every 22-24 hours
/** The member's only trigger: the full daily scan when the last one (trigger or "Check now") is due, otherwise the light check. */
function lightCheckTrigger() {
  const s = getScanState();
  if (!s || !s.at || !(Date.now() - Date.parse(s.at) < DAILY_SCAN_DUE_MS)) return dailyScanTrigger();
  try { ensureConfig_({ refresh: true }); } catch (e) { /* the saved copy stays in use */ }
  try { lightCheck_(); } catch (e) { /* next run */ }
  try { flushOutbox({ maxMs: 30000 }); } catch (e) { /* events stay queued */ }
  try { evRun_(EV_RUN_MS); } catch (e) { /* the waiting list stays; next run */ }   // the evidence upload's background pass
}
/** Refreshes only "replies to rate" (and the touched threads' states) in scanState; keeps the daily scan's other counts. */
function lightCheck_() {
  const t0 = Date.now();
  const s = getScanState();
  if (!s) return null;                                  // no daily scan yet: the first full scan comes from the trigger or "Check now"
  const map = getThreadMap();
  const r = cfgLib_().newReplySummary(map);
  s.newReplies = r.newReplies; s.newMessages = r.newMessages; s.lightAt = new Date().toISOString();
  UP.setProperty('scanState', JSON.stringify(s));
  if (r.threadIds.length) {
    const sub = {};
    r.threadIds.forEach(id => { if (map[id]) sub[id] = map[id]; });
    try { refreshInquiryStates_(sub, 8000, true); } catch (e) { /* the list refreshes on the next check */ }
  }
  UP.setProperty('lightMs', String(Date.now() - t0));
  return r;
}
/** When anything last checked Gmail (the daily scan or the light check), as an ISO string, or ''. */
function lastCheckAt_(s) {
  if (!s) return '';
  return [s.at, s.lightAt].filter(Boolean).sort().pop() || '';
}
/** Home card: installs the daily trigger once (unless turned off in Settings) and scans inline only if the last scan is stale. */
/**
 * Home card: installs the check trigger once, unless turned off in Settings. It NEVER scans inline any more (18 Nov 2026): a stale
 * check shows "last checked ..." on the home card, and "Check now" is in the footer. `checkTriggerSet` (23 Nov 2026, one trigger)
 * replaces the older `scanTriggerSet`/`lightTriggerSet`, so an older install is reinstalled once and loses its retired triggers.
 */
function maybeScan_() {
  if (UP.getProperty('scanOff') || UP.getProperty('checkTriggerSet')) return;
  try { installScanTrigger(); UP.setProperty('checkTriggerSet', new Date().toISOString()); } catch (e) { /* retried next open */ }
}
/** True when nothing has checked Gmail for a while (triggers off or failing): the home card says so. */
function checkIsStale_(s) {
  const last = lastCheckAt_(s);
  return !last || Date.now() - Date.parse(last) > SCAN_STALE_MS;
}
/** Once the member opens the matching action, its count no longer applies. */
function clearScanCount_(field) {
  const s = getScanState();
  if (s && s[field]) { s[field] = 0; UP.setProperty('scanState', JSON.stringify(s)); }
}

function onBackToHome() {
  clearSession();
  // popToRoot alone shows Gmail's cached copy of the home card (stale counts); rebuild it.
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().popToRoot().updateCard(onHomepage())).build();
}

/** Any handler error becomes a readable card instead of a blank "something went wrong". */
function buildErrorCard(err) {
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('err.title')));
  const section = CardService.newCardSection();
  section.addWidget(contentPara(esc(String((err && err.message) || err))));
  section.addWidget(button(t('btn.retry'), 'onRetryStep'));
  section.addWidget(button(t('btn.backHome'), 'onBackToHome'));
  builder.addSection(section);
  return builder.build();
}
function onRetryStep() { return updateTo(buildStepCard()); }

// ======================= REVIEW (redesign): new conversations -> replies -> anything due -> finished =======================
// After the first scan a member may have dozens of conversations: the triage card shows FIVE at a time, newest first, with a count
// ("1–5 of 23") and "Finish later" after every page (the rest stays under "Needs you", not declined).
const TRIAGE_MAX = 5;
// The count in the triage header covers only the last six months, so it is a goal a busy member can finish; older conversations come as
// one optional batch at the end ("sort them now, or leave them"). Leaving them declines nothing; they wait in "My inquiries".
const RECENT_DAYS = 183;
function recentCutoff_() { return new Date(Date.now() - RECENT_DAYS * 86400000).toISOString(); }
function candidatesIn_(scope, skipIds) {
  const cands = cfgLib_().searchAutoCandidates(Object.keys(getThreadMap()).concat(declinedIds_(), skipIds || []));
  const cut = recentCutoff_();
  return scope === 'older' ? cands.filter(c => c.date < cut) : scope === 'recent' ? cands.filter(c => c.date >= cut) : cands;
}
/** "Review N items": first the triage card for recent union conversations not tracked yet, then the walk-through of everything new. */
function onReview() {
  try {
    delBlob('triageAI');
    const recent = candidatesIn_('recent');
    clearScanCount_('newThreads');
    if (recent.length) {
      putBlob('triage', { scope: 'recent', list: recent.slice(0, TRIAGE_MAX), total: recent.length, start: 1, newIds: [] });
      return pushTo(buildTriageCard());
    }
    if (!UP.getProperty('olderLeft')) {
      const older = candidatesIn_('older').length;
      if (older) { putBlob('triage', { scope: 'older', list: [], total: older, start: 1, newIds: [] }); return pushTo(buildOlderChoiceCard_(older)); }
    }
    return startReview_([], 0, true);
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
/** "My inquiries" → older conversations the member left for later. */
function onReviewOlder() {
  try {
    UP.deleteProperty('olderLeft');
    const older = candidatesIn_('older');
    if (!older.length) return note(t('triage.none'));
    putBlob('triage', { scope: 'older', list: older.slice(0, TRIAGE_MAX), total: older.length, start: 1, newIds: [] });
    return pushTo(buildTriageCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
function buildOlderChoiceCard_(n) {
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('triage.olderTitle')));
  builder.addSection(CardService.newCardSection().addWidget(para(t('triage.olderText', n))));
  footer_(builder, button(t('triage.olderSort'), 'onTriageOlder'), button(t('triage.olderLeave'), 'onTriageLeaveOlder'));
  return builder.build();
}
function onTriageOlder() {
  const tr = getBlob('triage', { newIds: [] });
  const older = candidatesIn_('older');
  putBlob('triage', { scope: 'older', list: older.slice(0, TRIAGE_MAX), total: older.length, start: 1, newIds: tr.newIds || [] });
  return updateTo(buildTriageCard());
}
function onTriageLeaveOlder() {
  const tr = getBlob('triage', { newIds: [] });
  UP.setProperty('olderLeft', new Date().toISOString());
  const s = getScanState();
  if (s) { s.olderThreads = (s.olderThreads || 0) + (s.newThreads || 0); s.newThreads = 0; UP.setProperty('scanState', JSON.stringify(s)); }
  delBlob('triage');
  return startReview_(tr.newIds || [], (tr.newIds || []).length, false, (tr.later || []).length);
}
/** Starts the walk-through over threads with new messages (plus `newIds` just tracked). `push`: push the first card instead of replacing. */
function startReview_(newIds, added, push, later) {
  const map = getThreadMap();
  const ids = cfgLib_().findThreadsWithNewMessages(map);
  newIds.forEach(id => { if (ids.indexOf(id) === -1) ids.push(id); });
  clearScanCount_('newMessages'); clearScanCount_('newReplies');
  const steps = ids.length ? cfgLib_().buildSteps(ids, map, true) : [];
  startSession(steps);
  UP.setProperty('sessStats', JSON.stringify({ rated: 0, added: added || 0, skipped: 0, auto: [], later: later || 0 }));
  return push ? pushTo(buildStepCard()) : updateTo(buildStepCard());
}
/**
 * A review clears the home card's counts when it starts. When it ends (finished or stopped), what is still open goes back under
 * "Needs you": steps not reached, steps skipped, and conversations left as "Decide later". Otherwise home would say "nothing".
 */
function restoreLeftovers_() {
  const sess = loadSession(), st = sessStats_(), s = getScanState();
  if (!s) return;
  const open = (sess.queue || []).slice(sess.index || 0).filter(x => x.type === 'reply' || x.type === 'other').length;
  s.newReplies = (s.newReplies || 0) + open + (st.skipped || 0);
  s.newThreads = Math.max(s.newThreads || 0, st.later || 0);
  UP.setProperty('scanState', JSON.stringify(s));
}
function sessStats_() { try { return JSON.parse(UP.getProperty('sessStats') || 'null') || { rated: 0, added: 0, skipped: 0, auto: [] }; } catch (e) { return { rated: 0, added: 0, skipped: 0, auto: [] }; } }
function bumpStat_(field, value) {
  const s = sessStats_();
  if (field === 'auto') s.auto.push(value); else s[field] = (s[field] || 0) + 1;
  UP.setProperty('sessStats', JSON.stringify(s));
}

/** One card for every new union conversation: track it (switch) and under which topic. Switched-off ones are "not an inquiry". */
function buildTriageCard() {
  const tr = getBlob('triage', { list: [], total: 0, start: 1 });
  const builder = CardService.newCardBuilder();
  const end = tr.start + tr.list.length - 1;
  builder.setHeader(header(t(tr.scope === 'search' ? 'scan.resultsTitle' : 'triage.title'), ui(t(tr.scope === 'older' ? 'triage.subOlder' : tr.scope === 'search' ? 'triage.subSearch' : 'triage.subRecent', tr.start, end, tr.total))));
  if (!tr.list.length) {
    builder.addSection(CardService.newCardSection().addWidget(para(t('triage.none'))));
    return builder.build();
  }
  builder.addSection(CardService.newCardSection().addWidget(para('<i>' + t('triage.intro') + '</i>')));
  // Compact: ONE dropdown per conversation, all in one section. Its title is the conversation (plain text: subject · to · date); its options
  // are "Decide later" (default: the conversation stays for next time), the group's topics, and "Not an inquiry" (never offered again).
  // Each conversation leads with its SUBJECT in bold (the item), the topic dropdown below it (the answer). Under the subject: the first
  // words of the member's own message, past greetings (Gmail's subject + snippet pattern). Tapping the subject row opens the whole
  // conversation in Gmail in a new tab (an add-on cannot switch the Gmail view it sits in); the end icon says so.
  const ai = triageSuggestions_(tr.list.map(c => c.threadId));   // with a Gemini key: a topic and a one-line gist per conversation
  let snippets = {};
  const needSnip = tr.list.map(c => c.threadId).filter(id => !(ai[id] && ai[id].gist));
  if (needSnip.length) { try { snippets = cfgLib_().getSnippets(needSnip); } catch (e) { /* rows without snippets */ } }
  const me = myEmail();
  const topics = cfgLib_().getTopics();
  // Compact layout (chosen 18 Nov 2026 over one section per conversation with a "to · date" line): ONE section, per conversation a
  // two-line row (bold subject; "date · gist") and the dropdown, conversations split by a divider. Four fit on a screen instead of three.
  const s = CardService.newCardSection();
  tr.list.forEach((c, i) => {
    if (i) s.addWidget(CardService.newDivider());
    const sug = ai[c.threadId] || null;
    // Under the subject: the date, then Gemini's gist (marked ✦: written by the AI) or, without a key, the first full sentence.
    const gist = sug && sug.gist ? ui('✦ ') + userText(esc(sug.gist)) : snippets[c.threadId] ? userText(esc('“' + snippets[c.threadId] + '”')) : '';
    const d = row_({ text: '<b>' + userText(esc(c.subject || t('lbl.noSubject'))) + '</b>',
      bottom: ui(fmtDate(c.date)) + (gist ? ' · ' + gist : ''), endIcon: 'open_in_new' });
    d.setOpenLink(CardService.newOpenLink().setUrl('https://mail.google.com/mail/?authuser=' + encodeURIComponent(me) + '#all/' + c.threadId));
    s.addWidget(d);
    // Gemini's topic comes PRE-SELECTED (the member confirms or changes it); the field's title says it is a suggestion.
    const pick = sug ? (sug.notInquiry ? TRIAGE_NO : sug.topic) : '';
    const dd = CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN).setFieldName('topic_' + c.threadId)
      .setTitle(ui(pick ? t('triage.topicSuggested') : t('topic.field')));
    dd.addItem(t('triage.decideLater'), '', !pick);
    topics.forEach(x => dd.addItem(x, x, x === pick));
    dd.addItem(t('triage.notInquiry'), TRIAGE_NO, pick === TRIAGE_NO);
    s.addWidget(dd);
  });
  builder.addSection(s);
  if (ai.__error) builder.addSection(CardService.newCardSection().addWidget(para('<i>' + t(ai.__error === 'daily' ? 'triage.aiDaily' : 'triage.aiFailed') + '</i>')));
  const more = tr.total > end;
  footer_(builder, button(more ? t('triage.saveNext') : t('triage.save'), 'onTriageSave'), button(t('triage.later'), 'onTriageLater'));
  return builder.build();
}
/** Saves the current page: switched-on conversations are tracked under their topic, switched-off ones are "not an inquiry". */
const TRIAGE_NO = '__not_an_inquiry__';
/**
 * Gemini's topic + gist for the conversations on the current triage page: one request per page, cached for the review ('triageAI'), so
 * re-showing a page (Back, an error note) never asks again. A failure is remembered once and the card works without suggestions.
 */
function triageSuggestions_(ids) {
  const key = myApiKey();
  if (!key) return {};
  const cache = getBlob('triageAI', {});
  const missing = ids.filter(id => !cache[id]);
  if (missing.length && !cache.__error) {
    const r = cfgLib_().suggestTriage(missing, cfgLib_().getTopics(), key);
    Object.keys(r.byId).forEach(id => { cache[id] = r.byId[id]; });
    if (r.error) cache.__error = r.error.daily ? 'daily' : 'failed';
    missing.forEach(id => { if (!cache[id] && !r.error) cache[id] = { topic: '', notInquiry: false, gist: '' }; });
    putBlob('triageAI', cache);
  }
  return cache;
}
function saveTriagePage_(e) {
  const tr = getBlob('triage', { list: [], newIds: [], later: [] });
  const on = [], off = [], later = [];
  tr.list.forEach(c => {
    const v = formValue(e, 'topic_' + c.threadId);
    if (v === TRIAGE_NO) off.push(c.threadId);
    else if (v) on.push({ id: c.threadId, topic: v });
    else later.push(c.threadId);                       // "Decide later": not tracked, not declined; offered again next time
  });
  on.forEach(x => saveThread(x.id, cfgLib_().buildThreadRegistration(x.id, x.topic)));
  if (off.length) addDeclined_(off);
  if (tr.scope === 'search') {      // tracked or declined from search: they no longer wait as home's "new conversations" (IMA ones only)
    const decided = on.map(x => x.id).concat(off);
    const n = tr.list.filter(c => c.recipients && decided.indexOf(c.threadId) !== -1).length;
    const st = getScanState();
    if (n && st && st.newThreads) { st.newThreads = Math.max(0, st.newThreads - n); UP.setProperty('scanState', JSON.stringify(st)); }
  }
  tr.newIds = (tr.newIds || []).concat(on.map(x => x.id));
  tr.later = (tr.later || []).concat(later);            // kept out of the next pages of THIS review only
  tr.start = (tr.start || 1) + tr.list.length;
  return { tr: tr };
}
/** "Save and next 5": the next page while conversations remain, then the ratings for everything just tracked. */
function onTriageSave(e) {
  try {
    const r = saveTriagePage_(e);
    if (r.error) return note(r.error);
    const tr = r.tr;
    if (tr.scope === 'search') {                                       // search results: the next page of the same results, if any
      const rest = tr.rest || [];
      if (rest.length) {
        tr.list = rest.slice(0, TRIAGE_MAX); tr.rest = rest.slice(TRIAGE_MAX);
        putBlob('triage', tr);
        return updateTo(buildTriageCard());
      }
      delBlob('triage');
      return startReview_(tr.newIds, tr.newIds.length, false, 0);
    }
    const left = candidatesIn_(tr.scope || 'recent', tr.later);
    if (left.length) {
      tr.list = left.slice(0, TRIAGE_MAX);
      tr.total = tr.start - 1 + left.length;
      putBlob('triage', tr);
      return updateTo(buildTriageCard());
    }
    if (tr.scope !== 'older' && !UP.getProperty('olderLeft')) {          // recent ones done: offer the older ones as an optional batch
      const older = candidatesIn_('older').length;
      if (older) { putBlob('triage', { scope: 'older', list: [], total: older, start: 1, newIds: tr.newIds }); return updateTo(buildOlderChoiceCard_(older)); }
    }
    delBlob('triage');
    return startReview_(tr.newIds, tr.newIds.length, false, (tr.later || []).length);
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
/** "Finish later": saves this page and goes home; the rest stays under "Needs you" (not declined). */
function onTriageLater(e) {
  try {
    const r = saveTriagePage_(e);
    if (r.error) return note(r.error);
    delBlob('triage');
    if (r.tr.scope === 'search') return noteAndUpdate(t('saved'), onHomepage());   // search results: nothing to count for later
    const left = candidatesIn_(UP.getProperty('olderLeft') ? 'recent' : 'all').length;
    const s = getScanState();
    if (s) { s.newThreads = left; UP.setProperty('scanState', JSON.stringify(s)); }
    return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(ui(t('triage.laterDone', left))))
      .setNavigation(CardService.newNavigation().popToRoot().updateCard(onHomepage())).build();
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
/** "Item 2 of 5": position among the steps that need the member (sent / status steps are handled silently). */
function stepPosition_(queue, index) {
  const asks = s => s.type === 'reply' || s.type === 'other' || s.type === 'topic';
  const total = queue.filter(asks).length;
  const pos = queue.slice(0, index).filter(asks).length + 1;
  return { pos: Math.min(pos, total), total: total };
}
function onSkipStep(e) {
  const sess = loadSession();
  if (String(sess.index) !== e.parameters.si) return updateTo(buildStepCard());
  bumpStat_('skipped');
  setSessionIndex(sess.index + 1);
  return noteAndUpdate(t('step.skipped'), buildStepCard());
}
function onStopReview() {
  if (!UP.getProperty('sessReturn')) restoreLeftovers_();
  UP.deleteProperty('sessReturn'); UP.deleteProperty('sessStats');
  clearSession();
  return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(ui(t('step.stopped'))))
    .setNavigation(CardService.newNavigation().popToRoot().updateCard(onHomepage())).build();
}

/** The end of a review: what was done, what was recorded automatically (with "Resolved"), and the one-time profile question. */
function buildFinishedCard() {
  const f = getBlob('finData', { rated: 0, added: 0, skipped: 0, auto: [] });
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('fin.title')));
  const s1 = CardService.newCardSection();
  const parts = [];
  if (f.rated) parts.push(f.rated === 1 ? t('fin.ratedOne') : t('fin.rated', f.rated));
  if (f.added) parts.push(f.added === 1 ? t('fin.addedOne') : t('fin.added', f.added));
  if (!parts.length) parts.push(t('fin.nothing'));
  // One row per fact, each with its own check (was one joined line; panel reality check, 20 Nov 2026). Skips go under the last row.
  const skipped = f.skipped ? ui(f.skipped === 1 ? t('fin.skippedOne') : t('fin.skipped', f.skipped)) : '';
  parts.forEach((p, i) => s1.addWidget(row_({ icon: 'check_circle', text: ui(p), bottom: i === parts.length - 1 ? skipped : '' })));
  builder.addSection(s1);
  if (f.auto.length) {
    const s2 = CardService.newCardSection().setHeader(ui(t('fin.autoHeader')));
    f.auto.forEach(a => s2.addWidget(row_({
      icon: 'schedule', top: ui(t('fin.noReplyFor', daysWord(a.daysSince))), text: userText(esc(a.subject || t('lbl.noSubject'))),
      bottom: ui(t('fin.countedFrom', fmtDate(a.lastDate))), button: button(t('btn.resolved'), 'onResolveAuto', { threadId: a.threadId })
    })));
    s2.addWidget(para('<i>' + t('fin.autoHelp') + '</i>'));
    builder.addSection(s2);
  }
  if (!getProfile_() && !UP.getProperty('profileAsked')) {
    const s3 = CardService.newCardSection().setHeader(ui(t('fin.profileHeader')));
    s3.addWidget(para(t('fin.profileText')));
    s3.addWidget(buttonPair(button(t('btn.fillIn'), 'onProfileCard'), button(t('btn.noThanks'), 'onDismissProfileFin')));
    builder.addSection(s3);
  }
  const s4 = CardService.newCardSection();
  s4.addWidget(statusLine_());
  builder.addSection(s4);
  footer_(builder, button(t('btn.backHome'), 'onBackToHome'));
  return builder.build();
}
function onResolveAuto(e) {
  try {
    const id = e.parameters.threadId;
    const entry = getThreadMap()[id];
    if (entry && !entry.closed) {
      enqueueEvent(ReplyTrackingLib.buildResolvedEvent(id, myEmail(), entry));
      entry.closed = true;
      saveThread(id, entry);
    }
    const f = getBlob('finData', { auto: [] });
    f.auto = (f.auto || []).filter(a => a.threadId !== id);
    putBlob('finData', f);
    return noteAndUpdate(t('fin.markedResolved'), buildFinishedCard());
  } catch (err) { return note(String(err.message || err)); }
}
function onDismissProfileFin() { UP.setProperty('profileAsked', new Date().toISOString()); return noteAndUpdate(t('fin.profileLater'), buildFinishedCard()); }

// ======================= DISCOVERY =======================
function onScanAuto() {
  const candidates = cfgLib_().searchAutoCandidates(Object.keys(getThreadMap()));
  clearScanCount_('newThreads');
  return pushTo(buildCandidatesCard(candidates, t('scan.foundTitle'), true));
}

function onScanManualPrompt() {
  const builder = CardService.newCardBuilder();
  const section = CardService.newCardSection();
  section.addWidget(CardService.newTextInput().setFieldName('query').setTitle(ui(t('scan.queryTitle'))).setHint(ui(t('scan.queryHint'))));
  builder.setHeader(header(t('home.manual')));
  builder.addSection(section);
  footer_(builder, button(t('btn.search'), 'onScanManualSearch'));
  return pushTo(builder.build());
}

/**
 * Search results go to the SAME triage card as the daily check (redesign, 18 Nov 2026): a topic per conversation, "Not an inquiry",
 * "Decide later", the subject opens the email. Nothing is pre-selected (manual results may include personal mail): the default is
 * "Decide later". Pages of TRIAGE_MAX; the rest of the results wait in `tr.rest`.
 */
function onScanManualSearch(e) {
  const query = formValue(e, 'query').trim();
  if (!query) return note(t('scan.typeQuery'));
  const cands = cfgLib_().searchManualCandidates(query, Object.keys(getThreadMap()));
  if (!cands.length) return note(t('scan.none'));
  delBlob('triageAI');
  putBlob('triage', { scope: 'search', list: cands.slice(0, TRIAGE_MAX), rest: cands.slice(TRIAGE_MAX), total: cands.length, start: 1, newIds: [] });
  return pushTo(buildTriageCard());
}

function buildCandidatesCard(candidates, title, preChecked) {
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(title));
  const section = CardService.newCardSection();
  if (!candidates.length) {
    section.addWidget(para(t('scan.none')));
    builder.addSection(section);
    return builder.build();
  }
  const selection = CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('picked');
  candidates.forEach(c => {
    // Selection items are PLAIN TEXT — no escaping.
    const label = userText(c.subject) + (c.recipients ? ' — ' + c.recipients : '') + ' (' + ui(fmtDate(c.date)) + ')';
    selection.addItem(label, c.threadId, preChecked);
  });
  section.addWidget(selection);
  if (aiWaitHint_()) section.addWidget(para(aiWaitHint_()));
  section.addWidget(button(t('btn.processSelected'), 'onProcessSelected'));
  builder.addSection(section);
  return builder.build();
}

function onProcessSelected(e) {
  const picked = formValues(e, 'picked');
  if (!picked.length) return note(t('scan.nothingSelected'));
  try {
    const steps = cfgLib_().buildSteps(picked, getThreadMap(), true);
    if (!steps.length) return note(t('scan.nothingToProcess'));
    startSession(steps);
    return pushTo(buildStepCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}

// ======================= QUEUE WALK-THROUGH =======================
function buildStepCard() {
  try { return buildStepCardInner(); } catch (err) { return buildErrorCard(err); }
}

/**
 * Auto-processes consecutive 'sent' steps (logged silently), then renders the first step that needs the user.
 * Each logged message ID is saved to the registry right after its POST succeeds, so a crash/retry can never double-log.
 */
function buildStepCardInner() {
  const { queue, index: startIndex } = loadSession();
  let index = startIndex;
  const map = getThreadMap();

  // Auto-processes 'sent' steps (logged silently) and skips 'status' steps for threads that are not due yet; stops at the first step that needs the member.
  let statusDetail = null;
  while (index < queue.length) {
    const step = queue[index];
    if (step.type === 'sent') {
      const entry = map[step.threadId];
      if (entry && !isLogged(entry, step.msgId)) {
        enqueueEvent(ReplyTrackingLib.buildSentEvent(step.msgId, myEmail(), entry, step.threadId)); // local queue: fast, no network
        markLogged(entry, step.msgId);
        delete entry.silentSince;                    // a new message ends a recorded silence; a later one gets its own row
        saveThread(step.threadId, entry);
      }
      index++;
      setSessionIndex(index);
      continue;
    }
    if (step.type === 'status') {                    // redesign: silence is recorded automatically, never asked
      const entry = map[step.threadId];
      try { const rec = autoSilence_(step.threadId, entry); if (rec) { const p = getBlob('autoNew', []); putBlob('autoNew', p.filter(x => x.threadId !== rec.threadId)); bumpStat_('auto', rec); } } catch (e) { /* next check */ }
      index++;
      setSessionIndex(index);
      continue;
    }
    break;
  }

  if (index >= queue.length) {
    const back = UP.getProperty('sessReturn');       // a single correction from the thread card returns there
    if (!back) restoreLeftovers_();                  // skipped / "decide later" stay under "Needs you"
    clearSession();
    if (inlineUploadAllowed()) { try { flushOutbox({ maxMs: 15000 }); } catch (e) { /* stays queued */ } }   // best effort, only if uploads have been fast
    if (back) { UP.deleteProperty('sessReturn'); return buildThreadCard(back); }
    const st = sessStats_();
    st.auto = st.auto.concat(getBlob('autoNew', []).filter(a => !st.auto.some(x => x.threadId === a.threadId)));   // also what the daily check recorded
    delBlob('autoNew');
    putBlob('finData', st);
    UP.deleteProperty('sessStats');
    try {                                             // only the threads of this review can have changed: refresh those (fast), keep the rest
      const all = getThreadMap(), sub = {};
      queue.forEach(x => { if (all[x.threadId]) sub[x.threadId] = all[x.threadId]; });
      if (Object.keys(sub).length) refreshInquiryStates_(sub, 6000, true);
    } catch (e) { /* the list refreshes on the next check */ }
    return buildFinishedCard();
  }

  const step = queue[index];
  if (step.type === 'status') return buildStatusStepCard(step, index, statusDetail);
  if (step.type === 'topic') return buildTopicStepCard(step, index);
  if (step.type === 'other') return buildOtherStepCard(step, index);
  return buildReplyStepCard(step, index);
}

function buildTopicStepCard(step, si) {
  const info = cfgLib_().getThreadInfo(step.threadId);
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('topic.title'), info.subject));
  const section = CardService.newCardSection();
  if (info.recipients) section.addWidget(para(t('topic.recipients', esc(info.recipients))));
  section.addWidget(topicDropdown_());
  section.addWidget(button(t('btn.confirm'), 'onConfirmTopic', { threadId: step.threadId, si: String(si) }));
  builder.addSection(section);
  return builder.build();
}

/** Topics are the group's own list (Topics tab, usually Hebrew); only the field title and the placeholder are translated. */
function topicDropdown_(fieldName, current) {
  const dropdown = CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN).setFieldName(fieldName || 'topic').setTitle(ui(t('topic.field')));
  dropdown.addItem(t('topic.choose'), '', !current);
  cfgLib_().getTopics().forEach(x => dropdown.addItem(x, x, x === current));
  return dropdown;
}
function onConfirmTopic(e) {
  const p = e.parameters;
  const sess = loadSession();
  if (String(sess.index) !== p.si) return updateTo(buildStepCard()); // stale double-tap
  const topic = formValue(e, 'topic');
  if (!topic) return note(t('topic.pick'));
  try {
    saveThread(p.threadId, cfgLib_().buildThreadRegistration(p.threadId, topic));
    bumpStat_('added');
    setSessionIndex(sess.index + 1);
    return updateTo(buildStepCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}

// AI suggestions: on the free tier REQUESTS are scarce (20 per day per model), so the first reply card asks for every pending reply of the
// session in one request; each reply is judged against its whole thread. Results are cached for the session ('judgments').
function judgmentOf_(msgId) { const b = getBlob('judgments', {}); return b[msgId] || null; }
function prefetchJudgments_(fromIndex) {
  const key = myApiKey();
  if (!key) return;
  const b = getBlob('judgments', {});
  if (b.__error) return;                                   // already failed this session: show the failure and the retry button, do not hammer the API on every card
  if (b.__started && Date.now() - b.__started > 40000) {   // an earlier attempt never came back (Gmail cuts a click after 30 s)
    b.__error = 'timeout';
    delete b.__started;
    putBlob('judgments', b);
    return;
  }
  const queue = loadSession().queue;
  const byThread = {};
  for (let i = fromIndex; i < queue.length; i++) {
    const st = queue[i];
    if (st.type === 'reply' && !b[st.msgId]) (byThread[st.threadId] = byThread[st.threadId] || []).push(st.msgId);
  }
  const reqs = Object.keys(byThread).map(t => ({ threadId: t, msgIds: byThread[t] }));
  if (!reqs.length) return;
  b.__started = Date.now();
  putBlob('judgments', b);                                 // written BEFORE the call: if the click is killed, the next card knows
  const r = ReplyTrackingLib.judgeReplies(reqs, key, cfgLib_().getRubric());
  delete b.__started;
  Object.keys(r.byMsgId).forEach(id => { b[id] = r.byMsgId[id]; });
  if (r.error) {
    const status = ReplyTrackingLib.getAiStatus();
    b.__error = r.error.daily ? 'daily_limit' : (status && status.code === 'busy') ? 'busy' : 'error';
    b.__errorMsg = String(r.error.message || '').replace(/\s+/g, ' ').slice(0, 160);
  }
  putBlob('judgments', b);
}
/** Shown before an action that may wait for Gemini (only when a key is set): a bold "setting" line with its meaning below. */
function aiWaitHint_() {
  return myApiKey() ? t('ai.waitHint') : '';
}
/** Why there is no AI suggestion, in plain words. */
function aiNote_() {
  const b = getBlob('judgments', {});
  switch (b.__error) {
    case 'daily_limit': return t('ai.failDaily');
    case 'busy': return t('ai.failBusy');
    case 'timeout': return t('ai.failTimeout');
    case 'error': return t('ai.failError', esc(b.__errorMsg || t('ai.unknownError')));
    default: return '<i>' + t('ai.noneForReply') + '</i>';
  }
}
/** Re-submits the AI request for the rest of this session (may take up to 30 seconds). */
function onRetryAi(e) {
  try {
    const b = getBlob('judgments', {});
    delete b.__error; delete b.__errorMsg; delete b.__started;
    putBlob('judgments', b);
    return updateTo(buildStepCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
/**
 * REPLY CARD (redesign). The reply first; the member's own inquiry folded under it; then the four ratings as ONE choice list: each row is
 * the click target (label + one-line definition), in a fixed order. Gemini's pick is marked in place and its reason sits under the reply;
 * it never reorders or decides. Skip and Stop at the bottom.
 */
function buildReplyStepCard(step, si) {
  const d = cfgLib_().getReplyDisplay(step.msgId);
  let ai = step.correction ? null : judgmentOf_(step.msgId);
  if (!ai && myApiKey() && !step.correction) { prefetchJudgments_(si); ai = judgmentOf_(step.msgId); }
  const j = { tag: ai ? ai.tag : null, rationale: ai ? ai.rationale : null };
  const sess = loadSession();
  const pos = stepPosition_(sess.queue, si);
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('reply.title'), ui((pos.total > 1 ? t('step.itemOf', pos.pos, pos.total) + ' · ' : '') + userText(d.subject || ''))));   // headers are plain text: no esc()
  const section = CardService.newCardSection();
  section.addWidget(row_({ icon: 'reply', top: userText(esc(d.fromName || d.from)) + ' · ' + ui(fmtDate(d.date)),
    text: ui(d.afterDays !== null && d.afterDays !== undefined ? t('reply.after', daysWord(d.afterDays)) : t('reply.reviewing')) }));
  section.addWidget(contentPara(nl2br(esc(d.messageText || t('lbl.noText')))));
  if (j.tag && j.rationale) section.addWidget(para('<i><b>' + t('reply.geminiSays') + '</b> ' + esc(j.rationale) + '</i>'));
  else if (!j.tag && myApiKey() && !step.correction) {
    section.addWidget(para(aiNote_()));
    const failed = getBlob('judgments', {}).__error;
    if (failed && failed !== 'daily_limit') section.addWidget(button(t('ai.retry'), 'onRetryAi'));
  }
  builder.addSection(section);
  if (d.inquiryText) {
    const ask = CardService.newCardSection().setHeader(ui(t('reply.yourInquiry', fmtDate(d.inquiryDate)))).setCollapsible(true).setNumUncollapsibleWidgets(0);
    ask.addWidget(contentPara(nl2br(esc(d.inquiryText))));
    builder.addSection(ask);
  }
  // Four ACTION rows (not radio buttons: a circle promises "select, then confirm", but one tap here saves and moves on). Each row has
  // its own icon, the definition under the label, and a forward arrow; the header says what a tap does.
  const TAG_ICONS = { helpful: 'thumb_up', unhelpful: 'contrast', 'non-answer': 'chat_bubble_outline', refusal: 'block' };
  // Correcting: the current rating is marked (a check, not clickable) and the header says a tap CHANGES it (and returns to the thread).
  const current = step.correction ? ((getThreadMap()[step.threadId] || {}).tags || {})[step.msgId] || null : null;
  const tags = CardService.newCardSection().setHeader(ui(t(step.correction ? 'reply.howHelpfulFix' : UP.getProperty('sessReturn') ? 'reply.howHelpfulOne' : 'reply.howHelpful')));   // one reply from the thread card: no "next item"
  ReplyTrackingLib.getAllowedTags().forEach(tag => {
    const isAi = tag === j.tag;
    if (tag === current) {
      tags.addWidget(row_({ icon: TAG_ICONS[tag] || 'label', endIcon: 'check', top: ui(t('reply.currentRating')),
        text: ui('<b>' + esc(tagLabel_(tag)) + '</b>'), bottom: ui(t('tagdef.' + tag)) }));
      return;
    }
    tags.addWidget(row_({
      icon: TAG_ICONS[tag] || 'label', endIcon: forwardIcon_(), top: isAi ? ui('✦ ' + t('reply.geminiPick')) : '',
      text: ui('<b>' + esc(tagLabel_(tag)) + '</b>'), bottom: ui(t('tagdef.' + tag)),
      fn: 'onTagReply', params: { threadId: step.threadId, msgId: step.msgId, si: String(si), llmTag: j.tag || '', llmRationale: j.rationale || '', finalTag: tag }
    }));
  });
  builder.addSection(tags);
  // The group's full rubric (the same text Gemini receives), folded away; its hash is stored with every tag.
  try {
    const rubric = cfgLib_().getRubric();
    if (rubric) {
      const rs = CardService.newCardSection().setHeader(ui(t('reply.rubricHeader'))).setCollapsible(true).setNumUncollapsibleWidgets(0);
      rs.addWidget(CardService.newTextParagraph().setText(isolate_(nl2br(esc(rubric)), '⁧')));   // the rubric is Hebrew: always right-to-left
      builder.addSection(rs);
    }
  } catch (err) { /* the tag buttons still work without it */ }
  if (!step.correction) {
    const end = CardService.newCardSection();
    end.addWidget(buttonPair(button(t('btn.skip'), 'onSkipStep', { si: String(si) }), button(t('btn.stop'), 'onStopReview')));
    builder.addSection(end);
  }
  return builder.build();
}
/** The member-facing name of a stored tag (stored values stay English: helpful | unhelpful | non-answer | refusal). */
function tagLabel_(tag) { return t('tag.' + tag); }

function onTagReply(e) {
  const p = e.parameters;
  const sess = loadSession();
  if (String(sess.index) !== p.si) return updateTo(buildStepCard()); // stale double-tap: already handled
  try {
    const entry = getThreadMap()[p.threadId];
    if (!entry) return pushTo(buildErrorCard(new Error(t('err.notRegisteredLong'))));
    const step = sess.queue[sess.index] || {};
    if (step.correction && isLogged(entry, p.msgId)) {
      correctRating_(entry, p.threadId, p.msgId, p.finalTag);
      setSessionIndex(sess.index + 1);
      return noteAndUpdate(t('corr.saved', tagLabel_(p.finalTag)), buildStepCard());
    }
    if (!isLogged(entry, p.msgId)) {
      enqueueEvent(ReplyTrackingLib.buildReplyEvent(p.msgId, p.threadId, p.llmTag || null, p.llmRationale || null, p.finalTag, myEmail(), entry, cfgLib_().getRubric()));
      markLogged(entry, p.msgId);
      (entry.tags = entry.tags || {})[p.msgId] = p.finalTag;   // for the thread card and "Change"
      delete entry.silentSince;
      saveThread(p.threadId, entry);
      bumpStat_('rated');
    }
    setSessionIndex(sess.index + 1);
    return updateTo(buildStepCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}

/**
 * Rating corrections (decided 17 Nov 2026). Still waiting in the outbox -> the queued reply event is changed in place (the log never saw
 * the old value). Already uploaded -> a kind=correction row is queued. The check and the change happen under the same user lock that
 * flushOutbox holds, so an upload in progress can never send the old value and then delete the new one.
 */
function correctRating_(entry, threadId, msgId, newTag) {
  const key = outboxKey(myEmail() + '|reply:' + msgId);
  const lock = LockService.getUserLock();
  lock.waitLock(10000);
  try {
    const queued = UP.getProperty(key);
    if (queued) {
      const ev = JSON.parse(queued);
      ev.finalTag = newTag;
      UP.setProperty(key, JSON.stringify(ev));
    } else {
      enqueueEvent(ReplyTrackingLib.buildCorrectionEvent(msgId, threadId, newTag, myEmail(), entry, cfgLib_().getRubric()));
    }
  } finally { lock.releaseLock(); }
  (entry.tags = entry.tags || {})[msgId] = newTag;
  saveThread(threadId, entry);
}
/** "Change" on a rated reply in the thread card: the reply card again (no Gemini, no Skip), then back to the thread card. */
function onChangeRating(e) {
  try {
    const p = e.parameters;
    startSession([{ type: 'reply', threadId: p.threadId, msgId: p.msgId, correction: true }]);
    UP.setProperty('sessReturn', p.threadId);
    return pushTo(buildStepCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
/** "Rate the reply" for a reply that was never rated (from the thread card). */
function onRateOne(e) {
  try {
    const p = e.parameters;
    const steps = cfgLib_().buildSteps([p.threadId], getThreadMap(), false).filter(s => s.type === 'reply' || s.type === 'other' || s.type === 'sent');
    startSession(steps);
    UP.setProperty('sessReturn', p.threadId);
    return pushTo(buildStepCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}

// ---- final decision for a thread that is already due (scan/check pulled in old threads: tag them right in the flow) ----
/** "<b>12 days</b> since your last message (3 Nov 2026)" */
function sinceText_(days, mine, dateIso, bold) {
  const d = bold ? '<b>' + daysWord(days) + '</b>' : daysWord(days);
  return t(mine ? 'silence.sinceMine' : 'silence.sinceTheirs', d, esc(fmtDate(dateIso)));
}
function buildStatusStepCard(step, si, d) {
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('status.title'), d.subject));
  const section = CardService.newCardSection();
  section.addWidget(para(esc(d.recipients) + ' — ' + esc(d.topic)));
  section.addWidget(para(sinceText_(d.daysSince, d.lastMessage.mine, d.lastDate, true) + ' ' + t('statushelp.' + d.kind)));
  if (d.lastMessage.text) {
    section.addWidget(para('<b>' + t(d.lastMessage.mine ? 'lbl.yourLast' : 'lbl.theirLast') + ':</b>'));
    section.addWidget(contentPara(nl2br(esc(d.lastMessage.text))));
  }
  const base = { threadId: step.threadId, si: String(si), kind: ReplyTrackingLib.silenceValueForKind(d.kind), lastDate: d.lastDate };
  section.addWidget(button(t('btn.logIgnored'), 'onStatusDecision', Object.assign({ action: 'ignored' }, base)));
  section.addWidget(button(t('btn.markResolved'), 'onStatusDecision', Object.assign({ action: 'resolved' }, base)));
  section.addWidget(button(t('btn.decideLater'), 'onStatusDecision', Object.assign({ action: 'later' }, base)));
  builder.addSection(section);
  return builder.build();
}
function onStatusDecision(e) {
  const p = e.parameters;
  const sess = loadSession();
  if (String(sess.index) !== p.si) return updateTo(buildStepCard()); // stale double-tap
  try {
    const entry = getThreadMap()[p.threadId];
    if (entry && p.action !== 'later') {
      if (p.action === 'ignored') enqueueEvent(ReplyTrackingLib.buildSilenceEvent(p.threadId, p.kind, myEmail(), entry, p.lastDate));
      else enqueueEvent(ReplyTrackingLib.buildResolvedEvent(p.threadId, myEmail(), entry));
      entry.closed = true;
      saveThread(p.threadId, entry);
    }
    setSessionIndex(sess.index + 1);
    return updateTo(buildStepCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}

// ---- messages from someone who is neither me nor the IMA (ima.org.il or a Targets address): a CC'd colleague, a forward, an unlisted address ----
function buildOtherStepCard(step, si) {
  // Same pattern as the reply card: item counter in the header, the message, then two rows that act on one tap, then Skip / Stop.
  const m = cfgLib_().getMessageSummary(step.msgId);
  const pos = stepPosition_(loadSession().queue, si);
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('other.title'), ui((pos.total > 1 ? t('step.itemOf', pos.pos, pos.total) + ' · ' : '') + userText(m.subject || ''))));
  const section = CardService.newCardSection();
  section.addWidget(row_({ icon: 'mail', top: userText(esc(m.fromName || m.from)) + ' · ' + ui(fmtDate(m.date)), text: ui(t('other.who')) }));
  section.addWidget(contentPara(nl2br(esc(m.text || t('lbl.noText')))));
  builder.addSection(section);
  const params = { threadId: step.threadId, msgId: step.msgId, si: String(si) };
  const ask = CardService.newCardSection().setHeader(ui(t('other.ask')));
  ask.addWidget(row_({ icon: 'reply', endIcon: forwardIcon_(), text: ui('<b>' + t('btn.otherYes') + '</b>'), bottom: ui(t('other.yesHint')), fn: 'onOtherAsReply', params: params }));
  ask.addWidget(row_({ icon: 'person_off', endIcon: forwardIcon_(), text: ui('<b>' + t('btn.otherNo') + '</b>'), bottom: ui(t('other.noHint')), fn: 'onIgnoreOther', params: params }));
  builder.addSection(ask);
  const end = CardService.newCardSection();
  end.addWidget(buttonPair(button(t('btn.skip'), 'onSkipStep', { si: String(si) }), button(t('btn.stop'), 'onStopReview')));
  builder.addSection(end);
  return builder.build();
}
function onOtherAsReply(e) {
  const p = e.parameters;
  const sess = loadSession();
  if (String(sess.index) !== p.si) return updateTo(buildStepCard());
  sess.queue[sess.index].type = 'reply';
  putBlob('sessionQueue', sess.queue);
  return updateTo(buildStepCard());
}
function onIgnoreOther(e) {
  const p = e.parameters;
  const sess = loadSession();
  if (String(sess.index) !== p.si) return updateTo(buildStepCard());
  const entry = getThreadMap()[p.threadId];
  if (entry) { markLogged(entry, p.msgId); saveThread(p.threadId, entry); }
  setSessionIndex(sess.index + 1);
  return updateTo(buildStepCard());
}

// ======================= LIVE "CHECK FOR REPLIES" =======================
function onCheckRepliesLive() {
  try {
    const map = getThreadMap();
    const ids = cfgLib_().findThreadsWithNewMessages(map);
    clearScanCount_('newMessages');
    if (!ids.length) return note(t('replies.none'));
    const steps = cfgLib_().buildSteps(ids, map, true);
    if (!steps.length) return note(t('replies.none'));
    startSession(steps);
    return pushTo(buildStepCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}

// ======================= SILENCE CHECK + WAITING LIST =======================
// An open inquiry becomes "due" once its last message is SILENCE_THRESHOLD_DAYS old (14, set in the library). Due inquiries are sorted into
// three groups so the member sees what they are judging; everything younger goes to the waiting list with the days that are left.
const HE_MONTHS = ['בינו׳', 'בפבר׳', 'במרץ', 'באפר׳', 'במאי', 'ביוני', 'ביולי', 'באוג׳', 'בספט׳', 'באוק׳', 'בנוב׳', 'בדצמ׳'];
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isRtl_()) {
      const p = Utilities.formatDate(d, Session.getScriptTimeZone(), 'd|M|yyyy').split('|');
      return p[0] + ' ' + HE_MONTHS[parseInt(p[1], 10) - 1] + ' ' + p[2];
    }
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'd MMM yyyy');
  } catch (e) { return String(iso).slice(0, 10); }
}
function daysWord(n) { return t(n === 1 ? 'days.one' : 'days.many', n); }

function onCheckSilence() {
  try {
    const map = getThreadMap();
    const r = cfgLib_().classifyOpenThreads(map);
    const openCount = Object.keys(map).filter(id => !map[id].closed).length;
    // Observation marker: tells the analysis "as of now, all open inquiries were checked", so silence isn't mistaken for missing data.
    // It also carries the coverage numbers of the last scan (union threads found in the mailbox vs registered) when they are fresh.
    try {
      const s = getScanState();
      const fresh = s && Date.now() - Date.parse(s.at) < SCAN_STALE_MS;
      enqueueEvent(ReplyTrackingLib.buildCoverageHeartbeatEvent(myEmail(), fresh
        ? { open: openCount, unionThreadsFound: s.unionThreadsFound, registered: s.registered, capped: s.capped, source: 'silence' }
        : { open: openCount, source: 'silence' }));
    } catch (hbErr) { /* the check itself still works if the heartbeat can't be queued */ }
    putBlob('flagged', r.due);
    putBlob('waiting', r.waiting);
    if (!r.due.length && !r.waiting.length) return note(openCount ? t('silence.cantRead') : t('silence.noneOpen'));
    return pushTo(buildSilenceCard(r.due));
  } catch (err) { return pushTo(buildErrorCard(err)); }
}

const SILENCE_GROUPS = ['never_replied', 'no_response', 'abandoned'];   // titles and help texts: silencegroup.<kind>, silencehelp.<kind>

function buildSilenceCard(due) {
  due = due || getBlob('flagged', []);
  const waitingCount = getBlob('waiting', []).length;
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('silence.title'), t('silence.subtitle', daysWord(ReplyTrackingLib.getSilenceThresholdDays()))));

  SILENCE_GROUPS.forEach(kind => {
    const items = due.filter(f => f.kind === kind);
    if (!items.length) return;
    const batchable = items.filter(f => !f.needsReview).length;
    const section = CardService.newCardSection().setHeader(ui(t('silencegroup.' + kind) + ' (' + items.length + ')'));
    section.addWidget(para('<i>' + t('silencehelp.' + kind) + '</i>'));
    if (kind === 'never_replied' && batchable > 1) section.addWidget(button(t('btn.logAllIgnored', batchable), 'onLogAllNeverReplied'));
    items.forEach(f => {
      const mine = f.lastMessage ? f.lastMessage.mine : true;
      section.addWidget(CardService.newDecoratedText()
        .setTopLabel(userText(esc((f.subject ? f.subject + ' · ' : '') + f.recipients + ' — ' + f.topic)))
        .setText(ui(sinceText_(f.daysSince, mine, f.lastDate, false)))
        .setWrapText(true));
      if (kind !== 'never_replied' && f.lastMessage && f.lastMessage.text) {
        section.addWidget(para('<b>' + t(mine ? 'lbl.yourLast' : 'lbl.theirLast') + ', ' + esc(fmtDate(f.lastMessage.date)) + ':</b>'));
        section.addWidget(contentPara(nl2br(esc(f.lastMessage.text))));
      }
      if (f.needsReview) {
        section.addWidget(para('<i>' + t('silence.needsReview') + '</i>'));
        if (aiWaitHint_()) section.addWidget(para(aiWaitHint_()));
        section.addWidget(button(t('btn.reviewFirst'), 'onReviewThread', { threadId: f.threadId }));
      } else {
        const params = { threadId: f.threadId, kind: ReplyTrackingLib.silenceValueForKind(f.kind), lastDate: f.lastDate };
        section.addWidget(buttonPair(button(t('btn.logIgnored'), 'onLogSilence', params), button(t('btn.markResolved'), 'onMarkResolved', params)));
      }
    });
    builder.addSection(section);
  });

  const tail = CardService.newCardSection();
  if (!due.length) tail.addWidget(para(t('silence.nothingDue')));
  if (waitingCount) tail.addWidget(button(t('btn.notDueYet', waitingCount), 'onWaitingList'));
  builder.addSection(tail);
  return builder.build();
}

function onWaitingList() { return pushTo(buildWaitingCard(getBlob('waiting', []))); }

function buildWaitingCard(waiting) {
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('waiting.title'), t('waiting.subtitle')));
  const section = CardService.newCardSection();
  if (!waiting.length) section.addWidget(para(t('waiting.none')));
  waiting.slice(0, 60).forEach(w => {
    section.addWidget(CardService.newDecoratedText()
      .setTopLabel(ui(t('waiting.left', daysWord(w.daysLeft))))
      .setText(userText(esc(w.subject || t('lbl.noSubject'))))
      .setBottomLabel(userText(esc(w.recipients + ' — ' + w.topic)) + ' · ' + ui(t('waiting.lastMessage', esc(fmtDate(w.lastDate)))))
      .setWrapText(true));
  });
  if (waiting.length > 60) section.addWidget(para(t('waiting.more', waiting.length - 60)));
  builder.addSection(section);
  return builder.build();
}

function dropFlagged(threadId) {
  const left = getBlob('flagged', []).filter(f => f.threadId !== threadId);
  putBlob('flagged', left);
  return left;
}

/** One click for every "no reply at all" inquiry. Each still gets its own log event, with the date of ITS last message. */
function onLogAllNeverReplied() {
  try {
    const map = getThreadMap();
    const flagged = getBlob('flagged', []);
    let n = 0;
    flagged.filter(f => f.kind === 'never_replied' && !f.needsReview).forEach(f => {
      const entry = map[f.threadId];
      if (!entry || entry.closed) return;
      enqueueEvent(ReplyTrackingLib.buildSilenceEvent(f.threadId, 'no_response', myEmail(), entry, f.lastDate));
      entry.closed = true;
      saveThread(f.threadId, entry);
      n++;
    });
    const left = flagged.filter(f => !(f.kind === 'never_replied' && !f.needsReview));
    putBlob('flagged', left);
    return noteAndUpdate(t('silence.loggedN', n), buildSilenceCard(left));
  } catch (err) { return note(String(err.message || err)); }
}

/** Opens one flagged thread in the walk-through: classify its unreviewed replies first, then decide ignored / resolved. */
function onReviewThread(e) {
  try {
    const steps = cfgLib_().buildSteps([e.parameters.threadId], getThreadMap(), true);
    if (!steps.length) return note(t('silence.nothingToReview'));
    startSession(steps);
    return pushTo(buildStepCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}

function onLogSilence(e) {
  const p = e.parameters;
  try {
    const entry = getThreadMap()[p.threadId];
    if (!entry) return note(t('err.notRegistered'));
    enqueueEvent(ReplyTrackingLib.buildSilenceEvent(p.threadId, p.kind, myEmail(), entry, p.lastDate));
    entry.closed = true;
    saveThread(p.threadId, entry);
    return updateTo(buildSilenceCard(dropFlagged(p.threadId)));
  } catch (err) { return note(String(err.message || err)); }
}

/** For inquiries that actually got answered (or no longer matter) — stops them being flagged without recording them as ignored. */
function onMarkResolved(e) {
  const p = e.parameters;
  try {
    const entry = getThreadMap()[p.threadId];
    if (!entry) return note(t('err.notRegistered'));
    enqueueEvent(ReplyTrackingLib.buildResolvedEvent(p.threadId, myEmail(), entry));
    entry.closed = true;
    saveThread(p.threadId, entry);
    return updateTo(buildSilenceCard(dropFlagged(p.threadId)));
  } catch (err) { return note(String(err.message || err)); }
}

// ======================= MY INQUIRIES + THREAD CARD (redesign) =======================
const INQ_ROWS = 30;
/** Every tracked inquiry, grouped by whose move it is. Reads the cached states (daily check / "Check now"); computes them if missing. */
function onInquiries() {
  try {
    if (!getBlob('inqState', null)) refreshInquiryStates_(null, 15000);
    return pushTo(buildInquiriesCard());
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
function buildInquiriesCard() {
  const map = getThreadMap();
  const cache = getBlob('inqState', { states: {} });
  const st = cache.states || {};
  const scan = getScanState();
  const builder = CardService.newCardBuilder();
  const ids = Object.keys(map);
  builder.setHeader(header(t('inq.title'), ui(scan && scan.unionThreadsFound ? t('inq.sub', scan.registered || ids.length, scan.unionThreadsFound) : t('inq.subN', ids.length))));
  addMenu_(builder);
  const you = [], ima = [], closed = [];
  ids.forEach(id => {
    const e = map[id], s = st[id];
    if (e.closed) { closed.push(id); return; }
    if (!s) { ima.push(id); return; }
    if (!s.lastMine && s.unionReplied) you.push(id); else ima.push(id);
  });
  const lastOf = id => (st[id] && st[id].last) || '';
  ima.sort((a, b) => (lastOf(a) < lastOf(b) ? -1 : 1));       // longest wait first
  you.sort((a, b) => (lastOf(a) < lastOf(b) ? 1 : -1));
  const subjectOf = id => userText(esc(map[id].subject || (st[id] && st[id].subject) || t('lbl.noSubject')));
  const topLine = id => userText(esc(map[id].topic || '')) + (map[id].recipients ? ' · ' + userText(esc(String(map[id].recipients).split(',')[0])) : '');
  const evDone = evDone_(), evWait = evQueued_().map(q => q.id), evOn = evOptedIn_();
  if (!ids.length) builder.addSection(CardService.newCardSection().addWidget(para(t('inq.none'))));
  // Each row: an icon for whose move it is, and a forward arrow (it opens the conversation's card). Panel reality check, 20 Nov 2026.
  // An uploaded / uploading conversation shows its evidence cloud in the arrow's place (owner, 23 Nov 2026: visual, not text).
  const fwd = forwardIcon_();
  const endOf = id => EV_ICONS[evState_(id, evDone, st, evWait, evOn)] || fwd;

  if (you.length) {
    const s = CardService.newCardSection().setHeader(ui(t('inq.waitingYou', you.length)));
    you.slice(0, INQ_ROWS).forEach(id => {
      const x = st[id], tag = x.lastUnionMsgId && map[id].tags ? map[id].tags[x.lastUnionMsgId] : null;
      // A reply logged before ratings were kept locally (older versions) is rated, just not known here: say when they replied.
      const logged = x.lastUnionMsgId && (map[id].done || []).indexOf(x.lastUnionMsgId) !== -1;
      const bottom = tag ? t('inq.ratedAs', tagLabel_(tag)) : logged ? t('inq.repliedOn', fmtDate(x.last)) : t('inq.notRatedYet', fmtDate(x.last));
      s.addWidget(row_({ icon: 'person', top: topLine(id), text: '<b>' + subjectOf(id) + '</b>', bottom: ui(bottom), fn: 'onThread', params: { threadId: id }, endIcon: endOf(id) }));
    });
    builder.addSection(s);
  }
  if (ima.length) {
    const s = CardService.newCardSection().setHeader(ui(t('inq.waitingIma', ima.length)));
    ima.slice(0, INQ_ROWS).forEach(id => {
      const x = st[id];
      const bottom = !x ? '' : map[id].silentSince ? t('inq.unanswered', daysWord(daysSince_(x.last))) : t('inq.sentDays', fmtDate(x.last), daysWord(daysSince_(x.last)));
      s.addWidget(row_({ icon: 'schedule', top: topLine(id), text: subjectOf(id), bottom: ui(bottom), fn: 'onThread', params: { threadId: id }, endIcon: endOf(id) }));
    });
    builder.addSection(s);
  }
  if (scan && (scan.newThreads || scan.olderThreads)) {
    const s = CardService.newCardSection().setHeader(ui(t('inq.notTracked', (scan.newThreads || 0) + (scan.olderThreads || 0))));
    if (scan.newThreads) s.addWidget(row_({ icon: 'move_to_inbox', text: ui(t('inq.needDecision', scan.newThreads)), bottom: ui(t('inq.foundDaily')), fn: 'onReview', endIcon: fwd }));
    if (scan.olderThreads) s.addWidget(row_({ icon: 'history', text: ui(t('inq.older', scan.olderThreads)), bottom: ui(t('inq.olderHint')), fn: 'onReviewOlder', endIcon: fwd }));
    builder.addSection(s);
  }
  if (closed.length) {
    const s = CardService.newCardSection().setHeader(ui(t('inq.closed', closed.length))).setCollapsible(true).setNumUncollapsibleWidgets(0);
    closed.slice(0, INQ_ROWS).forEach(id => s.addWidget(row_({ icon: 'check_circle', top: topLine(id), text: subjectOf(id), bottom: ui(t('inq.closedItem')), fn: 'onThread', params: { threadId: id }, endIcon: endOf(id) })));
    builder.addSection(s);
  }
  if (cache.at) builder.addSection(CardService.newCardSection().addWidget(para('<i>' + t('inq.stale', esc(whenText_(cache.at))) + '</i>')));
  footer_(builder, button(t('home.newInquiry'), 'onComposeNewStart'), button(t('inq.find'), 'onScanManualPrompt'));
  return builder.build();
}

/** One inquiry: what happened (timeline with ratings), how long it took, and the next step. Also the card beside an open tracked email. */
function onThread(e) { try { return pushTo(buildThreadCard(e.parameters.threadId)); } catch (err) { return pushTo(buildErrorCard(err)); } }
function buildThreadCard(threadId) {
  const entry = hydrate_(threadId, getThreadMap()[threadId]);
  const tl = cfgLib_().getThreadTimeline(threadId);
  const builder = CardService.newCardBuilder();
  if (!tl) { builder.setHeader(header(t('err.title'))); builder.addSection(CardService.newCardSection().addWidget(para(t('err.notRegistered')))); return builder.build(); }
  builder.setHeader(headerUser_(tl.subject || t('lbl.noSubject'), entry ? ui(t('thr.tracked', userText(entry.topic || ''))) : ''));
  const s = CardService.newCardSection().setHeader(ui(t('thr.timeline')));
  let firstSent = true, lastReplyUnrated = null;
  tl.items.forEach(it => {
    const when = ui(fmtDate(it.date));
    if (it.kind === 'sent') {
      s.addWidget(row_({ icon: 'send', top: when + ' · ' + ui(t('thr.you')), text: ui(firstSent ? t('thr.sent') : t('thr.followup')), bottom: it.to ? ui(t('thr.toWhom', userText(esc(it.to)))) : '' }));
      firstSent = false;
    } else if (it.kind === 'reply') {
      const tag = entry && entry.tags ? entry.tags[it.msgId] : null;
      const logged = entry && ((entry.done || []).indexOf(it.msgId) !== -1 || (!!entry.lastReported && it.date <= entry.lastReported));
      s.addWidget(row_({
        icon: 'reply', top: when + ' · ' + userText(esc(it.fromName)) + (it.afterDays !== undefined ? ' · ' + ui(t('thr.after', daysWord(it.afterDays))) : ''),
        text: ui(tag ? t('thr.rated', '<b>' + esc(tagLabel_(tag)) + '</b>') : logged ? t('thr.ratedEarlier') : t('thr.notRated')),
        button: tag && logged ? button(t('btn.change'), 'onChangeRating', { threadId: threadId, msgId: it.msgId }) : null
      }));
      if (!logged) lastReplyUnrated = it.msgId;
    } else {
      s.addWidget(row_({ icon: 'mail', top: when + ' · ' + userText(esc(it.fromName)), text: ui(t('thr.otherMsg')) }));
    }
  });
  const last = tl.items[tl.items.length - 1];
  if (last) s.addWidget(row_({ icon: 'schedule', top: ui(t('thr.today')), text: ui(last.kind === 'sent' ? t('thr.sinceYours', daysWord(daysSince_(last.date))) : t('thr.sinceTheirs', daysWord(daysSince_(last.date)))) }));
  builder.addSection(s);

  const next = CardService.newCardSection().setHeader(ui(t('thr.next')));
  if (!entry) next.addWidget(para(t('err.notRegistered')));
  else if (entry.closed) next.addWidget(para('<i>' + t('thr.closedNote') + '</i>'));
  else if (lastReplyUnrated) next.addWidget(buttonPair(filledButton_(t('thr.rateNow'), 'onRateOne', { threadId: threadId }), button(t('btn.markResolved'), 'onResolveThread', { threadId: threadId })));
  else next.addWidget(buttonPair(filledButton_(t('thr.followUp'), 'onFollowupFor', { threadId: threadId }), button(t('btn.markResolved'), 'onResolveThread', { threadId: threadId })));
  builder.addSection(next);
  if (entry && (evOptedIn_() || evDone_()[threadId])) builder.addSection(evidenceThreadSection_(threadId));   // uploaded stays visible after opting out

  const det = CardService.newCardSection().setHeader(ui(t('thr.details'))).setCollapsible(true).setNumUncollapsibleWidgets(0);
  if (entry) det.addWidget(para(t('thr.detailsText', esc(entry.topic || ''), esc(entry.recipients || ''))));
  det.addWidget(CardService.newTextButton().setText(ui(t('thr.openGmail'))).setOpenLink(CardService.newOpenLink().setUrl('https://mail.google.com/mail/#all/' + threadId)));
  builder.addSection(det);
  return builder.build();
}
function onResolveThread(e) {
  try {
    const id = e.parameters.threadId;
    const entry = getThreadMap()[id];
    if (entry && !entry.closed) {
      enqueueEvent(ReplyTrackingLib.buildResolvedEvent(id, myEmail(), entry));
      entry.closed = true;
      saveThread(id, entry);
    }
    return noteAndUpdate(t('fin.markedResolved'), buildThreadCard(id));
  } catch (err) { return note(String(err.message || err)); }
}
/** "Send a follow-up" from the thread card: the follow-up draft for this inquiry directly (no picker). */
function onFollowupFor(e) {
  const threadId = e.parameters.threadId;
  const entry = getThreadMap()[threadId];
  if (!entry) return note(t('compose.pickInquiry'));
  const session = { mode: 'followup', threadId, recipients: entry.recipients, ownStyle: !!myApiKey() && styleOn_() };
  saveComposeSession(session);
  const d = styleDraft_(session, cfgLib_().getTemplateDraft({ mode: 'followup', recipients: entry.recipients, threadId: threadId }, mySenderName()));
  return pushTo(buildDraftCard(d.subject, d.body, d.note));
}

// ======================= BESIDE AN OPEN EMAIL (contextual trigger) =======================
// Gmail calls this when the member opens an email while the side panel is open. A tracked conversation shows its thread card (rate a new
// reply right there); an untracked conversation with the IMA offers "Track this conversation"; anything else shows the home card.
// Needs gmail.addons.current.message.metadata in the manifest (added before launch, so no member has to re-approve later).
function onGmailMessage(e) {
  noteLocale_(e);
  try {
    const g = (e && e.gmail) || {};
    // The IDs in the event are not always in the form the registry uses (keys come from GmailApp's getId()), so ask GmailApp for its own.
    let threadId = null;
    if (g.messageId) { try { threadId = GmailApp.getMessageById(g.messageId).getThread().getId(); } catch (err) { /* fall back to threadId */ } }
    if (!threadId && g.threadId) { try { threadId = GmailApp.getThreadById(g.threadId).getId(); } catch (err) { threadId = g.threadId; } }
    if (!threadId) return onHomepage();
    if (getThreadMap()[threadId]) return buildThreadCard(threadId);
    const info = cfgLib_().getConversationInfo(threadId);
    if (info && info.isUnion) return buildTrackCard_(threadId, info);
    return onHomepage();
  } catch (err) { return buildErrorCard(err); }
}
function buildTrackCard_(threadId, info, declinedNote) {
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('ctx.notTracked'), userText(info.subject || t('lbl.noSubject'))));
  const s = CardService.newCardSection();
  s.addWidget(row_({ icon: 'mail', top: ui(t('ctx.convWith', fmtDate(info.first))), text: ui(t('ctx.ask')) }));
  s.addWidget(para('<i>' + t(declinedNote ? 'ctx.declined' : 'ctx.explain') + '</i>'));
  s.addWidget(topicDropdown_('topic'));
  builder.addSection(s);
  footer_(builder, button(t('ctx.track'), 'onCtxTrack', { threadId: threadId }), declinedNote ? null : button(t('ctx.notInquiry'), 'onCtxDecline', { threadId: threadId }));
  return builder.build();
}
function onCtxTrack(e) {
  try {
    const id = e.parameters.threadId;
    const topic = formValue(e, 'topic');
    if (!topic) return note(t('topic.pick'));
    const wasDeclined = declinedIds_().indexOf(id) !== -1;
    saveThread(id, cfgLib_().buildThreadRegistration(id, topic));
    putBlob('declined', declinedIds_().filter(x => x !== id));
    const st = getScanState();                         // it was one of home's "new conversations" (unless it had been declined)
    if (st && st.newThreads && !wasDeclined) { st.newThreads--; UP.setProperty('scanState', JSON.stringify(st)); }
    return noteAndUpdate(t('ctx.tracked'), buildThreadCard(id));
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
function onCtxDecline(e) {
  try {
    const id = e.parameters.threadId;
    addDeclined_([id]);
    return updateTo(buildTrackCard_(id, cfgLib_().getConversationInfo(id), true));
  } catch (err) { return pushTo(buildErrorCard(err)); }
}

// ======================= COMPOSE WIZARD =======================
function saveComposeSession(obj) { putBlob('composeSession', obj); }
function loadComposeSession() { return getBlob('composeSession', {}); }
function clearComposeSession() { delBlob('composeSession'); }

// ---- "In my own style": Gemini rewrites the group's template the way this member writes ----
// Stored here (personal state): 'styleOn' = the toggle's last position, 'styleIds' = Gmail message IDs of the emails the member chose as
// examples of their writing. Only IDs are stored; the library reads the texts at rewrite time and sends them to Gemini with the member's key.
function styleOn_() { return UP.getProperty('styleOn') === '1'; }
function savedStyleIds_() { try { const a = JSON.parse(UP.getProperty('styleIds') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
/** The member's chosen style emails, or (until they choose) their own newest messages in tracked threads. */
function styleIdsForUse_() {
  const saved = savedStyleIds_();
  if (saved.length) return saved;
  try { return ReplyTrackingLib.suggestStyleIds(Object.keys(getThreadMap())); } catch (e) { return []; }
}
/** The toggle on the first compose card (only when a Gemini key is set). A one-item checkbox: checkboxes are verified in Gmail, switches are not yet. */
function addStyleToggle_(section, on) {
  if (!myApiKey()) return;
  const n = savedStyleIds_().length;
  section.addWidget(CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('ownStyle')
    .addItem(ui(t('style.toggle')), '1', on === undefined ? styleOn_() : on));
  section.addWidget(para('<i>' + (n ? t('style.hintChosen', n) : t('style.hintAuto')) + '</i>'));
}
/**
 * Fills the draft "in my own style" when the member ticked the toggle. Returns { subject, body, note }: the template unchanged (with a
 * note saying why) whenever the rewrite cannot be done, so the member always gets a draft.
 */
function styleDraft_(session, draft) {
  const key = myApiKey();
  if (!session.ownStyle || !key) return { subject: draft.subject, body: draft.body, note: '' };
  const ids = styleIdsForUse_();
  if (!ids.length) return { subject: draft.subject, body: draft.body, note: t('style.needEmails') };
  try {
    const r = ReplyTrackingLib.refineWithGemini(Object.assign({}, session, { subject: draft.subject, body: draft.body, instr: '', styleMsgIds: ids }), key);
    if (!r.styleUsed) return { subject: draft.subject, body: draft.body, note: t('style.unreadable') };
    const warn = refineWarningText_(r);
    return {
      subject: session.mode === 'new' ? (r.subject || draft.subject) : draft.subject,
      body: r.body || draft.body,
      note: t('style.done', r.styleUsed) + (warn ? ' ' + t('compose.checkRewrite') + warn : '')
    };
  } catch (err) {
    const daily = ReplyTrackingLib.getAiStatus() && ReplyTrackingLib.getAiStatus().code === 'daily_limit';
    return { subject: draft.subject, body: draft.body, note: t(daily ? 'style.failDaily' : 'style.failError') };
  }
}
/** The rewrite's warnings as interface text (leading space each), or '' when there are none. */
function refineWarningText_(draft) {
  const w = draft.warnings || [];
  return (w.indexOf('placeholder') !== -1 ? ' ' + t('compose.warnPlaceholder') : '') + (w.indexOf('over_150_words') !== -1 ? ' ' + t('compose.warnLong') : '');
}

function onComposeHome() {
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('home.compose')));
  const section = CardService.newCardSection();
  section.addWidget(button(t('compose.new'), 'onComposeNewStart'));
  const open = Object.values(getThreadMap()).filter(v => !v.closed);
  if (open.length) section.addWidget(button(t('compose.followup'), 'onComposeFollowupStart'));
  else section.addWidget(para('<i>' + t('compose.noOpen') + '</i>'));
  builder.addSection(section);
  return pushTo(builder.build());
}

function onComposeNewStart() { return pushTo(buildNewInquiryCard_(null)); }
/** Picking another template rebuilds the card (keeping what was ticked and chosen) so its text shows underneath. */
function onTemplatePick(e) { return updateTo(buildNewInquiryCard_(newInquiryState_(e))); }
/** Step 1 of a new inquiry. `state`: null for a fresh card, or what the form held when the member picked another template. */
function buildNewInquiryCard_(state) {
  const st = state || {};
  const picked = st.targets || [];
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('compose.newTitle')));
  const section = CardService.newCardSection();
  recipientsField_(picked).forEach(w => section.addWidget(w));
  section.addWidget(topicDropdown_('topic', st.topic));
  const tpl = templateDropdown_(st.template);
  section.addWidget(tpl.widget.setOnChangeAction(CardService.newAction().setFunctionName('onTemplatePick')));
  addStyleToggle_(section, state ? !!st.ownStyle : undefined);
  builder.addSection(section);
  builder.addSection(templatePreview_(tpl.selected));
  footer_(builder, button(t('btn.next'), 'onComposeNewNext'));
  return builder.build();
}
/**
 * "Send to" (field `targets`, values = email addresses, looked up again on submit). The Targets tab will grow past 15 people:
 * - up to RECIPIENT_CHECKBOX_MAX people: plain checkboxes (one tap each);
 * - more: a MULTI_SELECT (a field that opens a scrollable list; picked people show as chips with an x). Verified in Gmail 18 Nov 2026:
 *   picking and the chips work and the values arrive, but TYPING in the field filters nothing (static items) and search answered by the
 *   add-on (external data source) exists only for Chat apps. So the list is ordered for picking: people the member already wrote to
 *   first, then alphabetical; each shows the role in the text and the address underneath; a hint says to pick from the list.
 */
const RECIPIENT_CHECKBOX_MAX = 6;
const PERSON_ICON = 'https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/person/default/24px.svg';
function recipientsField_(picked) {
  const targets = cfgLib_().getTargets();
  const label = tg => ReplyTrackingLib.honorificName(tg) + (tg.position ? ' — ' + tg.position : '');
  const isPicked = tg => picked.indexOf(String(tg.email).toLowerCase()) !== -1;
  if (targets.length <= RECIPIENT_CHECKBOX_MAX) {
    const cb = CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('targets').setTitle(ui(t('compose.recipients')));
    targets.forEach(tg => cb.addItem(label(tg), tg.email, isPicked(tg)));
    return [cb];
  }
  const used = {};
  const map = getThreadMap();
  Object.keys(map).forEach(id => String(map[id].recipients || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
    .forEach(a => { used[a] = (used[a] || 0) + 1; }));
  const n = tg => used[String(tg.email).toLowerCase()] || 0;
  const sorted = targets.slice().sort((a, b) => (n(b) - n(a)) || String(a.name).localeCompare(String(b.name), 'he'));
  // Search box (verified 18 Nov 2026): a TextInput's own suggestions DO filter as you type in Gmail (by any part: name or role, Hebrew
  // included), and picking one fires its onChange; onRecipientSearch adds that person as a chip and rebuilds the card.
  const search = CardService.newTextInput().setFieldName('targetSearch').setTitle(ui(t('compose.recipientSearch')))
    .setSuggestions(CardService.newSuggestions().addSuggestions(sorted.map(label)))
    .setOnChangeAction(CardService.newAction().setFunctionName('onRecipientSearch'));
  const ms = CardService.newSelectionInput().setType(CardService.SelectionInputType.MULTI_SELECT).setFieldName('targets').setTitle(ui(t('compose.recipients')));
  sorted.forEach(tg => ms.addMultiSelectItem(label(tg), tg.email, isPicked(tg), PERSON_ICON, tg.email));
  return [search, ms, para('<i>' + t('compose.recipientsHint') + '</i>')];
}
/** What the new-inquiry form holds, so a rebuild keeps it. */
function newInquiryState_(e) {
  return {
    targets: formValues(e, 'targets').map(x => x.toLowerCase()), topic: formValue(e, 'topic'), template: formValue(e, 'template'),
    ownStyle: formValue(e, 'ownStyle') === '1'
  };
}
/** A suggestion picked in the recipient search: that person joins the chips (matched by the exact suggestion text), card rebuilt. */
function onRecipientSearch(e) {
  const st = newInquiryState_(e);
  const typed = String(formValue(e, 'targetSearch') || '').trim();
  const tg = typed && cfgLib_().getTargets().find(x => ReplyTrackingLib.honorificName(x) + (x.position ? ' — ' + x.position : '') === typed);
  if (tg) {                                  // free text that is not a suggestion adds no one (the card is redrawn as it was)
    const email = String(tg.email).toLowerCase();
    if (st.targets.indexOf(email) === -1) st.targets.push(email);
  }
  return updateTo(buildNewInquiryCard_(st));
}
/** The chosen template's subject and text as the group wrote it ({{name}} shown as a marker, {{sender}} as the member's name). */
function templatePreview_(value) {
  const s = CardService.newCardSection().setHeader(ui(t('compose.previewHeader')));
  if (value === TEMPLATE_BLANK) { s.addWidget(para('<i>' + t('compose.previewBlank') + '</i>')); return s; }
  let p = null;
  try { p = cfgLib_().getNewTemplateText(String(value || 't:').replace(/^t:/, '')); } catch (err) { p = null; }
  if (!p) { s.addWidget(para('<i>' + t('compose.previewNone') + '</i>')); return s; }
  const fill = x => String(x || '').replace(/{{name}}/g, () => t('compose.namePh')).replace(/{{sender}}/g, () => mySenderName() || t('compose.senderPh'));
  if (p.subject) s.addWidget(para('<b>' + userText(esc(fill(p.subject))) + '</b>'));
  s.addWidget(contentPara(nl2br(esc(fill(p.body)))));
  if (p.hasMulti) s.addWidget(para('<i>' + t('compose.previewMulti') + '</i>'));
  return s;
}

function onComposeNewNext(e) {
  const emails = formValues(e, 'targets').map(s => s.toLowerCase());
  if (!emails.length) return note(t('compose.pickRecipient'));
  const topic = formValue(e, 'topic');
  if (!topic) return note(t('topic.pick'));
  const targets = cfgLib_().getTargets().filter(t => emails.indexOf(String(t.email).toLowerCase()) !== -1);
  if (!targets.length) return note(t('compose.noMatch'));
  const tplValue = formValue(e, 'template');
  const blank = tplValue === TEMPLATE_BLANK;
  const tplName = blank || tplValue === '' ? '' : tplValue.replace(/^t:/, '');
  const session = { mode: 'new', targets, topic, ownStyle: readStyleToggle_(e), template: blank ? null : tplName };
  saveComposeSession(session);
  if (blank) {   // nothing to rewrite: a greeting and a sign-off, and the member writes the rest
    const body = t('compose.blankGreeting', ReplyTrackingLib.buildSalutation(targets)) + '\n\n\n\n' + t('compose.blankSignoff') + '\n' + mySenderName();
    return pushTo(buildDraftCard('', body, ''));
  }
  const d = styleDraft_(session, cfgLib_().getTemplateDraft({ mode: 'new', targets, templateName: tplName }, mySenderName()));
  return pushTo(buildDraftCard(d.subject, d.body, d.note));
}
// ---- the group's templates (Templates tab: stage | subject | body | name) ----
const TEMPLATE_BLANK = '__blank';
/** "Template" dropdown: the group's new-inquiry templates in sheet order (the first is pre-selected), then "No template". Values are
 *  "t:<name>" so an unnamed template ('' name) is still a non-empty value. */
function templateDropdown_(current) {
  const dd = CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN).setFieldName('template').setTitle(ui(t('compose.template')));
  let list = [];
  try { list = cfgLib_().getNewTemplates(); } catch (err) { list = []; }
  const values = list.map(tp => 't:' + tp.name).concat([TEMPLATE_BLANK]);
  const selected = current && values.indexOf(current) !== -1 ? current : values[0];
  list.forEach(tp => dd.addItem(tp.name || t('compose.templateDefault'), 't:' + tp.name, 't:' + tp.name === selected));
  dd.addItem(t('compose.templateBlank'), TEMPLATE_BLANK, selected === TEMPLATE_BLANK);
  return { widget: dd, selected: selected };
}
/** Reads the "my own style" checkbox and remembers it as the default for next time (only when the toggle was shown, i.e. a key is set). */
function readStyleToggle_(e) {
  if (!myApiKey()) return false;
  const on = formValue(e, 'ownStyle') === '1';
  UP.setProperty('styleOn', on ? '1' : '0');
  return on;
}

function onComposeFollowupStart() {
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('compose.followTitle')));
  const section = CardService.newCardSection();
  const dropdown = CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN).setFieldName('threadId').setTitle(ui(t('compose.openInquiry')));
  const map = getThreadMap();
  // Plain-text items (no escaping). Subject first, so similar threads can be told apart; older registry entries have no subject.
  Object.keys(map).filter(id => !map[id].closed).forEach(id => {
    const e = map[id];
    dropdown.addItem((e.subject ? e.subject + ' · ' : '') + (e.recipients || t('compose.noUnionRecipients')) + ' — ' + e.topic, id, false);
  });
  section.addWidget(dropdown);
  addStyleToggle_(section);
  builder.addSection(section);
  footer_(builder, button(t('btn.next'), 'onComposeFollowupNext'));
  return pushTo(builder.build());
}

function onComposeFollowupNext(e) {
  const threadId = formValue(e, 'threadId');
  const entry = threadId && getThreadMap()[threadId];
  if (!entry) return note(t('compose.pickInquiry'));
  const session = { mode: 'followup', threadId, recipients: entry.recipients, ownStyle: readStyleToggle_(e) };
  saveComposeSession(session);
  const d = styleDraft_(session, cfgLib_().getTemplateDraft({ mode: 'followup', recipients: entry.recipients, threadId: threadId }, mySenderName()));
  return pushTo(buildDraftCard(d.subject, d.body, d.note));
}

function buildDraftCard(subject, body, statusNote) {
  const s = loadComposeSession();
  const builder = CardService.newCardBuilder();
  // Title says WHAT is being written; a follow-up names its conversation. The one forward step is in the footer.
  const followSubject = s.mode === 'followup' ? ((getThreadMap()[s.threadId] || {}).subject || '') : '';
  builder.setHeader(header(s.mode === 'new' ? t('compose.new') : t('compose.draftFollow'), followSubject ? userText(followSubject) : ''));
  const section = CardService.newCardSection();
  if (statusNote) section.addWidget(para(esc(statusNote)));
  if (s.mode === 'new') {   // which of the group's templates this started from (or none), so a member who picked wrong can go back
    const tplLabel = s.template === null || s.template === undefined ? ui(t('compose.noTemplate')) : s.template ? userText(esc(s.template)) : ui(t('compose.templateDefault'));
    section.addWidget(row_({ icon: 'description', top: ui(t('compose.fromTemplate')), text: tplLabel }));
  }
  const toLine = s.mode === 'new' ? (s.targets || []).map(tg => tg.email).join(', ') : (s.recipients || '');
  section.addWidget(para('<b>' + t('lbl.to') + '</b> ' + userText(esc(toLine))));
  if (s.mode === 'new') {
    section.addWidget(CardService.newTextInput().setFieldName('subject').setTitle(ui(t('lbl.subjectField'))).setValue(subject || ''));
  } else {
    section.addWidget(para('<i>' + t('compose.inThread') + '</i>'));
  }
  section.addWidget(CardService.newTextInput().setFieldName('body').setTitle(ui(t('compose.body'))).setMultiline(true).setValue(body || ''));
  section.addWidget(CardService.newTextInput().setFieldName('instr').setTitle(ui(t('compose.instr'))).setMultiline(true));
  section.addWidget(button(!myApiKey() ? t('compose.refineOff') : s.ownStyle ? t('style.rewriteBtn') : t('compose.refine'), 'onRefineDraft'));
  if (s.mode === 'new') section.addWidget(para('<i>' + t('compose.gmailHint') + '</i>'));
  builder.addSection(section);
  if (s.mode === 'new') {
    // A new inquiry is finished and sent in Gmail's own composer (formatting, attachments, the member's signature); sending from the
    // panel stays as the second choice. The draft is remembered, and once it is sent it is tracked and logged (settleDrafts_).
    const gmail = CardService.newTextButton().setText(ui(t('compose.openGmail')))
      .setComposeAction(CardService.newAction().setFunctionName('onOpenInGmail'), CardService.ComposedEmailType.STANDALONE_DRAFT);
    footer_(builder, gmail, button(t('compose.sendHere'), 'onSendComposed'));
  } else {
    footer_(builder, button(t('compose.reviewSend'), 'onSendComposed'));
  }
  return builder.build();
}

/** "Open in Gmail": the draft as a real Gmail draft (right-to-left when the text is Hebrew), opened in Gmail's composer. */
function onOpenInGmail(e) {
  const s = loadComposeSession();
  const subject = formValue(e, 'subject').trim();
  const body = formValue(e, 'body').trim();
  const to = (s.targets || []).map(tg => tg.email).join(',');
  const opts = /[א-ת]/.test(body) ? { htmlBody: rtlHtml_(body) } : {};
  const draft = GmailApp.createDraft(to, subject, body, opts);
  const pend = getBlob('pendDrafts', []);
  pend.push({ draftId: draft.getId(), msgId: draft.getMessage().getId(), threadId: draft.getMessage().getThread().getId(), topic: s.topic || '', subject: subject, at: new Date().toISOString() });
  putBlob('pendDrafts', pend.slice(-20));
  return CardService.newComposeActionResponseBuilder().setGmailDraft(draft).build();
}
/** Plain text as right-to-left HTML for Gmail's composer (escaped, line breaks kept). */
function rtlHtml_(text) {
  return '<div dir="rtl" style="text-align:right">' + esc(text).split('\n').join('<br>') + '</div>';
}

/**
 * Drafts opened in Gmail from the panel: once one is SENT, its conversation is tracked under the topic chosen in the panel and the
 * sent message is logged, as if it had been sent from the panel. Still a draft: kept (30 days at most). Gone (discarded): forgotten.
 * Returns how many were sent and are now tracked. Runs on the home card, "Check now" and the daily check.
 */
function settleDrafts_() {
  const pend = getBlob('pendDrafts', []);
  if (!pend.length) return 0;
  const keep = [];
  let tracked = 0;
  const young = p => Date.now() - new Date(p.at).getTime() < 30 * 86400000;
  pend.forEach(p => {
    let m = null;
    // Verified 18 Nov 2026: sending a draft gives the message a NEW ID but keeps the THREAD ID. So look in the draft's thread first:
    // a real (non-draft) message there is the sent inquiry, even if the member changed the subject or recipients in Gmail.
    if (p.threadId) {
      let th = null;
      try { th = GmailApp.getThreadById(p.threadId); } catch (err) { th = null; }
      if (th) {
        const all = th.getMessages(), sent = all.filter(x => !x.isDraft());
        if (sent.length) m = sent[0];
        else if (all.length) { if (young(p)) keep.push(p); return; }   // still a draft
      }
    }
    if (!m) { try { m = GmailApp.getMessageById(p.msgId); } catch (err) { m = null; } }
    if (m && m.isDraft()) { if (young(p)) keep.push(p); return; }
    if (!m || m.isInTrash()) m = sentLike_(p);                  // last resort: a sent message with the same subject
    if (!m) return;                                            // discarded
    try {
      const threadId = m.getThread().getId();
      const entry = getThreadMap()[threadId] || cfgLib_().buildThreadRegistration(threadId, p.topic);
      if (!isLogged(entry, m.getId())) {
        enqueueEvent(ReplyTrackingLib.buildSentEvent(m.getId(), myEmail(), entry, threadId));
        markLogged(entry, m.getId());
      }
      saveThread(threadId, entry);
      tracked++;
    } catch (err) { keep.push(p); }                            // try again next time
  });
  putBlob('pendDrafts', keep);
  return tracked;
}
/** A sent message with the draft's subject, sent after the draft was made (null if none). */
function sentLike_(p) {
  if (!p.subject) return null;
  const day = Utilities.formatDate(new Date(p.at), Session.getScriptTimeZone(), 'yyyy/MM/dd');
  const q = 'in:sent after:' + day + ' subject:"' + p.subject.replace(/"/g, '') + '"';
  try {
    const hits = GmailApp.search(q, 0, 5);
    for (const th of hits) {
      const ms = th.getMessages().filter(x => !x.isDraft() && x.getDate() >= new Date(p.at) && x.getSubject() === p.subject);
      if (ms.length) return ms[ms.length - 1];
    }
  } catch (err) { /* nothing found */ }
  return null;
}
function pendingDraftCount_() { return getBlob('pendDrafts', []).length; }

function onRefineDraft(e) {
  const subject = formValue(e, 'subject');
  const body = formValue(e, 'body');
  const apiKey = myApiKey();
  if (!apiKey) return updateTo(buildDraftCard(subject, body, t('compose.aiOff')));
  const s = loadComposeSession();
  try {
    const styleIds = s.ownStyle ? styleIdsForUse_() : [];
    const draft = ReplyTrackingLib.refineWithGemini(Object.assign({}, s, { subject, body, instr: formValue(e, 'instr'), styleMsgIds: styleIds }), apiKey);
    const warn = refineWarningText_(draft) ? t('compose.checkRewrite') + refineWarningText_(draft) : '';
    const styleNote = s.ownStyle ? (draft.styleUsed ? t('style.rewritten', draft.styleUsed) + ' ' : t('style.plainFallback') + ' ') : '';
    return updateTo(buildDraftCard(s.mode === 'new' ? draft.subject : subject, draft.body, (styleNote + warn).trim()));
  } catch (err) {
    return updateTo(buildDraftCard(subject, body, ReplyTrackingLib.getAiStatus() && ReplyTrackingLib.getAiStatus().code === 'daily_limit' ? t('compose.aiDaily') : t('compose.aiError')));
  }
}

/** Step 1 of 2: validates, stores the draft, and shows a confirmation card (nothing is sent yet). */
function onSendComposed(e) {
  const s = loadComposeSession();
  if (!s.mode) return note(t('compose.expired'));
  const subject = s.mode === 'new' ? formValue(e, 'subject').trim() : '';
  const body = formValue(e, 'body').trim();
  if (!body) return note(t('compose.bodyEmpty'));
  if (s.mode === 'new' && !subject) return note(t('compose.subjectEmpty'));
  s.subject = subject; s.body = body;
  saveComposeSession(s);

  const toLine = s.mode === 'new' ? s.targets.map(tg => tg.email).join(', ') : s.recipients;
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('compose.sendTitle')));
  const section = CardService.newCardSection();
  section.addWidget(para('<b>' + t('lbl.to') + '</b> ' + userText(esc(toLine))));
  if (s.mode === 'new') section.addWidget(para('<b>' + t('lbl.subject') + '</b> ' + esc(subject)));
  else section.addWidget(para('<b>' + t('compose.followInThread') + '</b>'));
  section.addWidget(contentPara(nl2br(esc(body.length > 600 ? body.slice(0, 600) + '…' : body))));
  builder.addSection(section);
  footer_(builder, button(t('compose.yesSend'), 'onSendFinal'), button(t('compose.backEdit'), 'onBackToDraft'));
  return pushTo(builder.build());
}
/** Back to the draft card underneath (it keeps what was typed), instead of stacking a second copy of it. */
function onBackToDraft() {
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().popCard()).build();
}

/** Step 2 of 2. Guarded against double-clicks; the email is logged right after it's sent. */
function onSendFinal() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(3000)) return note(t('compose.sendBusy'));
  try {
    const s = loadComposeSession();
    if (!s.mode || s.sending) return note(t('compose.alreadySent'));
    s.sending = true;
    saveComposeSession(s);

    const map = getThreadMap();
    const followEntry = s.mode === 'followup' ? map[s.threadId] : null;
    if (s.mode === 'followup' && !followEntry) { s.sending = false; saveComposeSession(s); return note(t('compose.noLongerRegistered')); }

    let result;
    try {
      result = ReplyTrackingLib.sendComposedEmail({
        mode: s.mode, targets: s.targets, threadId: s.threadId, subject: s.subject, body: s.body,
        expectedRecipients: followEntry && followEntry.recipients ? followEntry.recipients.split(', ') : []
      });
    } catch (err) {
      s.sending = false; saveComposeSession(s);
      return note(t('compose.notSent', String(err.message || err)));
    }

    // From here on the email IS sent — never leave the session in a state that allows a second send.
    clearComposeSession();
    let status = t('send.ok');
    try {
      if (result.unconfirmed) {
        status = t('send.unconfirmed');
      } else {
        let entry;
        if (s.mode === 'new') {
          entry = cfgLib_().buildThreadRegistration(result.threadId, s.topic);
          saveThread(result.threadId, entry);
        } else {
          entry = followEntry;
        }
        enqueueEvent(ReplyTrackingLib.buildSentEvent(result.msgId, myEmail(), entry, result.threadId));
        markLogged(entry, result.msgId);
        saveThread(result.threadId, entry);
        if (!result.recipientsOk) status = t('send.checkRecipients');
        else if (result.threaded === false) status = t('send.notThreaded');
      }
    } catch (logErr) {
      status = t('send.logFailed');
    }
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText(ui(status)))
      .setNavigation(CardService.newNavigation().popToRoot())
      .build();
  } finally {
    lock.releaseLock();
  }
}

// ======================= RESTORE HISTORY (after a reinstall) =======================
// The thread registry lives only in this person's own UserProperties, so a reinstall (or a new device) starts empty and every reply would be
// offered again. The gateway's log already holds what the registry needs, so "Restore" rebuilds it from there: topic, recipients, which Gmail
// messages were already logged, and which threads were closed. Not restored (never in the log): the Gemini key, the sign-off name, and events
// that were still waiting to upload when the add-on was removed.
function hasRegistry_() { return UP.getKeys().some(k => k.indexOf('t_') === 0); }
function restoreErrorText_(r) {
  const e = r && r.error;
  if (e === 'unauthorized' || e === 'not_a_member') return t('restore.errMember');
  if (e === 'rate_limited') return t('restore.errRate');
  if (e === 'update_required') return t('restore.errUpdate');
  if (e === 'bad_request') return t('restore.errGateway');
  return t('restore.errOther', e ? ' (' + e + ')' : '');
}
function onRestoreHistory() {
  try {
    const x = restoreHistory_();
    if (x.error) return note(x.error);
    return pushTo(buildRestoreCard(x));
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
/** Rebuilds the registry from the log. Returns { added, updated, gone, messages, total, truncated } or { error }. */
function restoreHistory_() {
  {
    const r = ReplyTrackingLib.fetchHistory(identityToken(), CODE_VERSION);
    if (!r || !r.ok) return { error: restoreErrorText_(r) };
    const started = Date.now();
    const map = getThreadMap();
    const props = {};
    let added = 0, updated = 0, gone = 0, messages = 0;
    (r.threads || []).forEach(t => {
      const have = map[t.threadId];
      if (have) {                                                  // keep what is here, add what only the log knows
        const done = (have.done || []).slice();
        (t.done || []).forEach(id => { if (done.indexOf(id) === -1) done.push(id); });
        const closed = !!have.closed || !!t.closed;
        const tags = Object.assign({}, t.tags || {}, have.tags || {});
        if (done.length !== (have.done || []).length || closed !== !!have.closed || Object.keys(tags).length !== Object.keys(have.tags || {}).length) {
          have.done = done; have.closed = closed; have.tags = tags; props['t_' + t.threadId] = JSON.stringify(have); updated++;
        }
        return;
      }
      let subject = '';
      if (Date.now() - started < 15000) {                          // subjects only while there is time; a thread that is not in this mailbox is skipped
        const sub = ReplyTrackingLib.getThreadSubject(t.threadId);
        if (sub === null) { gone++; return; }
        subject = sub;
      }
      const entry = { recipients: t.recipients || '', topic: t.topic || '', closed: !!t.closed, done: t.done || [], subject: subject, tags: t.tags || {} };
      if (t.silentSince) entry.silentSince = t.silentSince;      // gateway v4: an automatic silence keeps the thread open
      props['t_' + t.threadId] = JSON.stringify(entry);
      added++;
      messages += (t.done || []).length;
    });
    if (Object.keys(props).length) UP.setProperties(props);
    UP.setProperty('restoreDone', new Date().toISOString());
    return { added: added, updated: updated, gone: gone, messages: messages, total: r.total || 0, truncated: !!r.truncated };
  }
}
function onDismissRestore() { UP.setProperty('restoreDone', new Date().toISOString()); return updateTo(onHomepage()); }
function buildRestoreCard(x) {
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('restore.title')));
  const section = CardService.newCardSection();
  if (!x.total) {
    section.addWidget(para(t('restore.nothing')));
  } else {
    section.addWidget(para(t('restore.done', x.added, x.messages)
      + (x.updated ? '<br>' + t('restore.updated', x.updated) : '')
      + (x.gone ? '<br>' + t('restore.gone', x.gone) : '')
      + (x.truncated ? '<br><i>' + t('restore.truncated') + '</i>' : '')));
  }
  section.addWidget(para('<i>' + t('restore.notRestored') + '</i>'));
  builder.addSection(section);
  return builder.build();
}

// ======================= EVIDENCE UPLOAD (docs/features/EVIDENCE_UPLOAD.md) =======================
// Everything here is invisible unless the GROUP switch is on: the gateway's config answer carries features.evidenceUpload (saved by
// refreshConfig_ in UserProperty cfgFeatures; a missing field = off). The member then opts in on the evidence card (consent recorded by
// the gateway; our copy in UserProperty evConsent) and picks conversations. The pick uploads for a few seconds at once; the rest goes in
// the BACKGROUND inside the existing light check (every 2 h) and daily check. No trigger of its own: VERIFIED 23 Nov 2026 in Gmail, the
// add-on may hold only one time-based trigger per user ("too many time-based triggers"), and add-on triggers run at most hourly.
// State kept here, never message content:
//   ev_<threadId> = index of the next message to upload ('0' at first): one UserProperty per waiting conversation. Clicks only ADD
//                   keys and an upload pass only advances or removes them, so a pick made while a pass runs is never lost.
//   blob evStats  = { done, accepted, duplicate, tooLarge, rejected, error } for the progress card (reset when a new batch starts)
//   blob evDone   = { threadId: { at: ISO date of its last complete upload, n: messages in the thread then } }
const EV_RUN_MS = 180000;          // inside the light/daily check (a trigger run stops at 6 min; the checks use up to ~2 min themselves)
// shortcut: a click may run 30 s and a request is started until the budget ends; a slow 4 MB request can overrun and fail the click.
// Nothing is lost (the stored messages answer 'duplicate' next time). Lower EV_CLICK_MS if members see timeouts.
const EV_CLICK_MS = 15000;
const EV_LIST_MAX = 100;           // conversations listed on the picker
const EV_NO_STATS = { done: 0, accepted: 0, duplicate: 0, tooLarge: 0, rejected: 0, error: '' };
function evFeatures_() { try { return JSON.parse(UP.getProperty('cfgFeatures') || '{}') || {}; } catch (e) { return {}; } }
function evidenceOn_() { return evFeatures_().evidenceUpload === true; }
function evConsent_() { try { return JSON.parse(UP.getProperty('evConsent') || 'null'); } catch (e) { return null; } }
/** Opted in under the consent version the group currently requires. */
function evOptedIn_() {
  const c = evConsent_(), f = evFeatures_();
  return f.evidenceUpload === true && !!c && c.state === 'given' && c.version === (f.evidenceConsentVersion || ReplyTrackingLib.getEvidenceConsentVersion());
}
function evDone_() { return getBlob('evDone', {}); }
function evStates_() { return (getBlob('inqState', null) || {}).states || {}; }
/** A conversation has more messages than at its last complete upload (by the saved conversation states: daily scan, light check). By count,
 *  not date: a message's Date header can be older than its arrival, so a date test misses mail delivered late. */
function evNewer_(id, done, st) { return !!done[id] && !!st[id] && (st[id].count || 0) > done[id].n; }
/** 'done' = every message so far is uploaded, 'up' = waiting or uploading (new messages go by themselves), '' = not uploaded. */
const EV_ICONS = { done: 'cloud_done', up: 'cloud_upload' };
function evState_(id, done, st, waiting, on) {
  if (on && (waiting.indexOf(id) !== -1 || evNewer_(id, done, st))) return 'up';
  return done[id] ? 'done' : '';
}
function evQueued_() {
  const all = UP.getProperties();
  return Object.keys(all).filter(k => k.indexOf('ev_') === 0).map(k => ({ id: k.slice(3), next: parseInt(all[k], 10) || 0 }));
}
function evStats_() { return Object.assign({}, EV_NO_STATS, getBlob('evStats', {})); }
function evAddStats_(add, error) {
  const s = evStats_();
  Object.keys(add).forEach(k => { s[k] += add[k]; });
  s.error = error;
  putBlob('evStats', s);
}
/** Queues the new messages of uploaded conversations (no member approval: owner, 23 Nov 2026). Called by every upload pass and Check now. */
function evQueueNew_() {
  if (!evOptedIn_()) return;
  const done = evDone_(), st = evStates_(), waiting = evQueued_().map(q => q.id), add = {};
  // shortcut: resumes at the message count of the last upload; an earlier message deleted from the thread shifts that by one and the
  // first new message is skipped. Store uploaded message ids instead if members delete mail from tracked conversations.
  Object.keys(done).forEach(id => { if (waiting.indexOf(id) === -1 && evNewer_(id, done, st)) add['ev_' + id] = String(done[id].n); });
  if (!Object.keys(add).length) return;
  if (!waiting.length) putBlob('evStats', EV_NO_STATS);
  UP.setProperties(add);
}
/**
 * One upload pass: from a click (EV_CLICK_MS) or the light/daily check (EV_RUN_MS). One pass at a time: each member runs a personal copy,
 * so the SCRIPT lock is per member (flushOutbox uses the user lock, so the two never wait for each other).
 */
function evRun_(budgetMs, firstId) {
  if (!evOptedIn_()) return;
  evQueueNew_();
  if (!evQueued_().length) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;                     // another pass is working
  try { runEvidence_(budgetMs, firstId); } finally { lock.releaseLock(); }
}
/** Stop and turn-off: forget the waiting conversations. */
function evClear_() {
  evQueued_().forEach(q => UP.deleteProperty('ev_' + q.id));
  delBlob('evStats');
}
function evErrorText_(code, consent) {
  if (code === 'not_enabled') return t('ev.errNotEnabled');
  if (consent) return t('ev.consentFailed', esc(code || 'unknown'));
  if (code === 'consent_required' || code === 'consent_outdated') return t('ev.errConsent');
  if (code === 'not_logged') return t('ev.errNotLogged');
  return t('ev.error', esc(code || 'unknown'));
}

/** Settings: one row, only while the group switch is on. */
function evidenceSettingsSection_() {
  const s = CardService.newCardSection().setHeader(ui(t('ev.section')));
  const c = evConsent_(), n = evQueued_().length;
  const state = evOptedIn_() ? t('ev.stateOn', fmtDate(c.at), Object.keys(evDone_()).length) : t('ev.stateOff');
  s.addWidget(row_({ icon: 'gavel', text: ui(t('ev.row')), bottom: ui(state + (n ? ' · ' + t('ev.stateQueued', n) : '')),
    fn: 'onEvidenceCard', endIcon: forwardIcon_() }));
  return s;
}
/** Thread card: uploaded, waiting, or not yet (with an Upload button); opted-in members only. */
function evidenceThreadSection_(threadId) {
  const done = evDone_(), on = evOptedIn_(), state = evState_(threadId, done, evStates_(), evQueued_().map(q => q.id), on);
  const s = CardService.newCardSection().setHeader(ui(t('ev.thrHeader')));
  s.addWidget(row_({ icon: EV_ICONS[state], text: ui(state === 'up' ? t('ev.thrQueued') : state ? t('ev.thrDone', fmtDate(done[threadId].at)) : t('ev.thrNot')),
    button: !state && on ? button(t('ev.thrBtn'), 'onEvidenceThread', { threadId: threadId }) : null }));
  return s;
}

function onEvidenceCard() { if (!evidenceOn_()) return note(t('ev.errNotEnabled')); return pushTo(buildEvidenceCard()); }
function buildEvidenceCard() {
  const builder = CardService.newCardBuilder();
  if (!evOptedIn_()) {
    builder.setHeader(header(t('ev.section'), ui(t('ev.stateOff'))));
    const s = CardService.newCardSection();
    s.addWidget(para('<b>' + t('ev.consentTitle') + '</b>'));
    s.addWidget(para(t('ev.consentText')));
    s.addWidget(row_({ icon: 'warning', text: ui(t('ev.patientWarn')) }));
    s.addWidget(para('<i>' + t('ev.consentWithdraw') + '</i>'));
    s.addWidget(CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('evAgree').addItem(ui(t('ev.agree')), 'yes', false));
    builder.addSection(s);
    footer_(builder, button(t('ev.turnOn'), 'onEvidenceTurnOn'), button(t('ev.notNow'), 'onEvidenceBack'));
    return builder.build();
  }
  // Listed: tracked conversations never uploaded and not waiting (owner, 23 Nov 2026: what is uploaded or waits is not offered again;
  // new messages of an uploaded conversation go by themselves, evQueueNew_).
  const done = evDone_(), map = getThreadMap(), waiting = evQueued_().map(q => q.id);
  const ids = Object.keys(map).filter(id => waiting.indexOf(id) === -1 && !done[id]).slice(0, EV_LIST_MAX);
  builder.setHeader(header(t('ev.section'), ui(t('ev.stateOn', fmtDate(evConsent_().at), Object.keys(done).length))));
  const pick = CardService.newCardSection();
  pick.addWidget(para('<i>' + t('ev.pickHint') + '</i>'));
  if (!ids.length) pick.addWidget(para(t(Object.keys(map).length ? 'ev.allDone' : 'ev.noThreads')));
  else {
    const sel = CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('evThreads').setTitle(ui(t('ev.listTitle')));
    // Selection items are PLAIN TEXT (no esc); the subject is user text with its own direction.
    // Owner decision 23 Nov 2026: everything listed is ticked; the member unticks what should not go.
    ids.forEach(id => sel.addItem(userText(map[id].subject || t('lbl.noSubject')), id, true));
    pick.addWidget(sel);
  }
  builder.addSection(pick);
  const off = CardService.newCardSection().setHeader(ui(t('ev.offHeader'))).setCollapsible(true).setNumUncollapsibleWidgets(0);
  off.addWidget(para('<i>' + t('ev.offText') + '</i>'));
  off.addWidget(button(t('ev.turnOff'), 'onEvidenceTurnOff'));
  builder.addSection(off);
  if (ids.length) footer_(builder, button(t('ev.uploadSelected'), 'onEvidenceUpload'), button(t('ev.back'), 'onEvidenceBack'));
  return builder.build();
}
function onEvidenceBack() { return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().popCard().updateCard(buildSettingsCard())).build(); }

function onEvidenceTurnOn(e) {
  if (formValues(e, 'evAgree').indexOf('yes') === -1) return note(t('ev.mustAgree'));
  try {
    const r = ReplyTrackingLib.postEvidenceConsent(identityToken(), CODE_VERSION, true, lang_());
    if (!r || !r.ok) return note(evErrorText_(r && r.error, true));
    UP.setProperty('evConsent', JSON.stringify({ state: 'given', version: r.consentVersion || ReplyTrackingLib.getEvidenceConsentVersion(), at: r.at || new Date().toISOString() }));
    return noteAndUpdate(t('ev.turnedOn'), buildEvidenceCard());
  } catch (err) { return note(String(err.message || err)); }
}
function onEvidenceTurnOff() {
  try {
    const r = ReplyTrackingLib.postEvidenceConsent(identityToken(), CODE_VERSION, false, lang_());
    if (!r || !r.ok) return note(evErrorText_(r && r.error, true));
    UP.setProperty('evConsent', JSON.stringify({ state: 'withdrawn', at: r.at || new Date().toISOString() }));
    evClear_();
    return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(ui(t('ev.turnedOff'))))
      .setNavigation(CardService.newNavigation().popCard().updateCard(buildSettingsCard())).build();
  } catch (err) { return note(String(err.message || err)); }
}

/** Adds conversations to the waiting list (fresh counters when nothing was waiting). */
function evEnqueue_(ids) {
  const waiting = evQueued_().map(q => q.id), add = {};
  ids.forEach(id => { if (waiting.indexOf(id) === -1) add['ev_' + id] = '0'; });
  putBlob('evStats', waiting.length ? Object.assign(evStats_(), { error: '' }) : EV_NO_STATS);
  UP.setProperties(add);
}
function onEvidenceUpload(e) {
  const ids = formValues(e, 'evThreads');
  if (!ids.length) return note(t('ev.noneSelected'));
  evEnqueue_(ids);
  evRun_(EV_CLICK_MS);
  return pushTo(buildEvidenceProgressCard());
}
/** Thread card "Upload": this conversation goes first and the card is redrawn in place with its new state (cloud icon). */
function onEvidenceThread(e) {
  const id = e.parameters.threadId;
  if (!evOptedIn_()) return pushTo(buildEvidenceCard());
  // Gmail's Back shows a cached thread card that may still offer Upload: an uploaded or waiting conversation is not queued again.
  if (!evState_(id, evDone_(), evStates_(), evQueued_().map(q => q.id), true)) { evEnqueue_([id]); evRun_(EV_CLICK_MS, id); }
  return updateTo(buildThreadCard(id));
}
function evBackToPicker_(text) {
  const r = CardService.newActionResponseBuilder();
  if (text) r.setNotification(CardService.newNotification().setText(ui(text)));
  return r.setNavigation(CardService.newNavigation().popCard().updateCard(buildEvidenceCard())).build();
}
function onEvidenceRefresh() { evRun_(EV_CLICK_MS); return updateTo(buildEvidenceProgressCard()); }
function onEvidenceDone() { return evBackToPicker_(''); }
function onEvidenceStop() {
  const n = evQueued_().length;
  evClear_();
  return evBackToPicker_(t('ev.stopped', n));
}

/**
 * Works through the waiting conversations for up to `budgetMs`. Counters and the last problem go to evStats. A conversation not in the
 * log yet stays waiting for a later pass. Never throws on a gateway or network problem.
 */
function runEvidence_(budgetMs, firstId) {
  if (!evOptedIn_()) { evAddStats_({}, evidenceOn_() ? 'consent_required' : 'not_enabled'); return; }
  const deadline = Date.now() + budgetMs, token = identityToken(), done = evDone_();
  const add = { done: 0, accepted: 0, duplicate: 0, tooLarge: 0, rejected: 0 };
  let error = '';
  for (const item of evQueued_().sort((a, b) => (b.id === firstId) - (a.id === firstId))) {
    const key = 'ev_' + item.id;
    if (Date.now() >= deadline) break;
    if (UP.getProperty(key) == null) continue;      // stopped meanwhile
    const startedAt = new Date().toISOString();
    let r;
    try { r = cfgLib_().uploadEvidenceThread(token, CODE_VERSION, item.id, item.next, deadline); }
    catch (err) { error = String((err && err.message) || err); break; }
    ['accepted', 'duplicate', 'tooLarge', 'rejected'].forEach(k => { add[k] += r[k] || 0; });
    if (r.error === 'not_logged') { error = r.error; continue; }
    if (r.done) {
      if (r.error !== 'gone') done[item.id] = { at: startedAt, n: r.total };
      UP.deleteProperty(key); add.done++;
      continue;
    }
    // shortcut: a Stop in the milliseconds between these two calls is undone for this one conversation; rare, Stop can be pressed again
    if (UP.getProperty(key) != null) UP.setProperty(key, String(r.next));
    error = r.error || '';
    break;                                          // not done = refused, or the deadline passed inside this conversation
  }
  if (error === 'consent_required' || error === 'consent_outdated') UP.deleteProperty('evConsent');   // the server says the consent no longer counts
  putBlob('evDone', done);
  evAddStats_(add, error);
}

function buildEvidenceProgressCard() {
  const q = evStats_(), left = evQueued_().length, total = q.done + left;
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('ev.progTitle'), ui(t('ev.progSub', q.done, total))));
  const s = CardService.newCardSection();
  s.addWidget(row_({ icon: left ? 'cloud_upload' : 'cloud_done', text: ui(t('ev.progDone', q.done, total)), bottom: ui(t('ev.progCounts', q.accepted, q.duplicate)) }));
  if (q.tooLarge) s.addWidget(row_({ icon: 'warning', text: ui(t('ev.tooLarge', q.tooLarge)), bottom: ui(t('ev.tooLargeHint')) }));
  if (q.rejected) s.addWidget(row_({ icon: 'warning', text: ui(t('ev.refused', q.rejected)) }));
  if (q.error) s.addWidget(para('<b>' + evErrorText_(q.error) + '</b>'));
  s.addWidget(para('<i>' + (left ? t('ev.progHint') : t('ev.finished')) + '</i>'));
  builder.addSection(s);
  if (left) footer_(builder, button(t('ev.refresh'), 'onEvidenceRefresh'), button(t('ev.stop'), 'onEvidenceStop'));
  else footer_(builder, button(t('ev.back'), 'onEvidenceDone'));
  return builder.build();
}

// ======================= SETTINGS (redesign: five short groups) =======================
function buildSettingsCard() {
  const senderName = getProp('SENDER_NAME') || '';
  const hasKey = !!getProp('GEMINI_API_KEY');
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('home.settings')));

  const ls = CardService.newCardSection().setHeader(ui(t('settings.langHeader')));
  ls.addWidget(langRadio_().setOnChangeAction(CardService.newAction().setFunctionName('onSaveLanguage')));   // applies on selection: no Save button
  rtlHint_(ls);
  builder.addSection(ls);

  const me = CardService.newCardSection().setHeader(ui(t('set.personal')));
  me.addWidget(CardService.newTextInput().setFieldName('senderName').setTitle(ui(t('settings.nameField'))).setValue(senderName));
  me.addWidget(button(t('btn.save'), 'onSaveSettings'));
  const prof = getProfile_();
  me.addWidget(row_({ icon: 'person', text: ui(t('set.about')), bottom: ui(prof ? t('profile.savedOn', fmtDate(prof.at)) : t('profile.notSet')), fn: 'onProfileCard', params: { from: 'settings' } }));
  builder.addSection(me);

  const gm = CardService.newCardSection().setHeader('Gemini');
  gm.addWidget(row_({ icon: 'auto_awesome', text: ui(t(hasKey ? 'set.keyOn' : 'set.keyOff')), button: button(t('set.keyBtn'), 'onKeyCard') }));
  const nStyle = savedStyleIds_().length;
  gm.addWidget(row_({ icon: 'edit', text: ui(t('set.style')), bottom: ui(nStyle ? t('set.styleN', nStyle) : t('set.styleAuto')), fn: 'onStyleChooser' }));
  builder.addSection(gm);

  const dc = CardService.newCardSection().setHeader(ui(t('set.daily')));
  const scanOn = !UP.getProperty('scanOff');
  const scan = getScanState();
  dc.addWidget(row_({ icon: 'radar', text: ui(t('set.dailyText', LIGHT_CHECK_HOURS)), bottom: lastCheckAt_(scan) ? ui(t('set.lastRun', whenText_(lastCheckAt_(scan)))) : '', button: button(t(scanOn ? 'btn.turnOff' : 'btn.turnOn'), 'onToggleDailyScan') }));
  const remindOn = !UP.getProperty('remindOff');
  dc.addWidget(row_({ icon: 'mail', text: ui(t('set.remindText')), bottom: ui(t(scanOn ? 'set.remindHint' : 'set.remindNeedsDaily')), button: button(t(remindOn ? 'btn.turnOff' : 'btn.turnOn'), 'onToggleReminder') }));
  builder.addSection(dc);

  if (evidenceOn_()) builder.addSection(evidenceSettingsSection_());   // only while the group switch is on
  if (docsUrl_('guide')) builder.addSection(docsSection_());

  const adv = CardService.newCardSection().setHeader(ui(t('set.advanced'))).setCollapsible(true).setNumUncollapsibleWidgets(0);
  const st = getUploadStatus();
  adv.addWidget(para(
    '<b>' + t('settings.waiting') + '</b> ' + outboxCount() + '<br><b>' + t('settings.rejected') + '</b> ' + rejectedCount() +
    '<br><b>' + t('settings.lastUpload') + '</b> ' + (st ? esc(fmtDate(st.at)) + (st.ok ? ' — ' + t('settings.ok') : ' — ' + esc(st.error || t('up.failed'))) : t('settings.never')) +
    '<br>' + t('set.version', esc(CODE_VERSION), esc(ReplyTrackingLib.getLibraryVersion()))));
  adv.addWidget(buttonPair(button(t('btn.uploadNow'), 'onUploadNowFromSettings'), button(t('settings.restore'), 'onRestoreHistory')));
  builder.addSection(adv);
  return builder.build();
}
function onSettingsHome() { return pushTo(buildSettingsCard()); }
function langRadio_() {
  const sel = CardService.newSelectionInput().setType(CardService.SelectionInputType.RADIO_BUTTON).setFieldName('lang');
  const chosen = lang_();
  sel.addItem('עברית', 'he', chosen === 'he');
  sel.addItem('English', 'en', chosen === 'en');
  return sel;
}

/** The Gemini key and its privacy note, on their own card (not shown on every visit to Settings). */
function onKeyCard() { return pushTo(buildKeyCard()); }
function buildKeyCard() {
  const hasKey = !!getProp('GEMINI_API_KEY');
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('set.keyCard')));
  const s = CardService.newCardSection();
  s.addWidget(para(t('wel.aiText')));
  s.addWidget(para(t('settings.privacy')));
  s.addWidget(CardService.newTextInput().setFieldName('geminiKey').setTitle(ui(t('settings.keyField'))).setHint(ui(hasKey ? t('settings.keyHintSet') : t('settings.keyHintEmpty'))));
  s.addWidget(CardService.newTextButton().setText(ui(t('settings.getKey'))).setOpenLink(CardService.newOpenLink().setUrl('https://aistudio.google.com/apikey')));
  if (hasKey && DEV_TOOLS) s.addWidget(button('Test Gemini on sample cases', 'onAiSelfTest'));   // development only, not translated
  if (hasKey) s.addWidget(button(t('settings.removeKey'), 'onRemoveGeminiKey'));
  builder.addSection(s);
  footer_(builder, button(t('btn.save'), 'onSaveKey'));
  return builder.build();
}
function onSaveKey(e) {
  const key = formValue(e, 'geminiKey').trim();
  if (key) PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(ui(t('saved'))))
    .setNavigation(CardService.newNavigation().popCard().updateCard(buildSettingsCard())).build();
}

// ======================= WELCOME (first install: 4 steps) =======================
// 1 what is recorded + language + name · 2 about you (optional) · 3 Gemini (optional) · 4 restore history or start fresh.
// Existing members (anything already tracked) never see it. debugShowWelcome() shows it again in a test account.
function welcomeDone_() { return !UP.getProperty('forceWelcome') && (!!UP.getProperty('welcomeDone') || hasRegistry_()); }
function buildWelcomeCard(step) {
  const builder = CardService.newCardBuilder();
  const s = CardService.newCardSection();
  if (step === 1) {
    builder.setHeader(header(t('wel.title'), ui(t('wel.step', 1))));
    s.addWidget(para(t('wel.intro')));
    s.addWidget(row_({ icon: 'shield', text: ui(t('wel.uploaded')), bottom: ui(t('wel.uploadedText')) }));
    const dataUrl = docsUrl_('data');
    if (dataUrl) s.addWidget(CardService.newTextButton().setText(ui(t('wel.dataLink'))).setOpenLink(CardService.newOpenLink().setUrl(dataUrl)));
    builder.addSection(s);
    const s2 = CardService.newCardSection();
    s2.addWidget(langRadio_().setTitle(ui(t('wel.lang'))));
    if (gmailLocale_() && !gmailIsHebrew_()) s2.addWidget(para('<i>' + t('wel.rtlNote') + '</i>'));
    s2.addWidget(CardService.newTextInput().setFieldName('senderName').setTitle(ui(t('wel.name'))).setValue(getProp('SENDER_NAME') || ''));
    builder.addSection(s2);
    footer_(builder, button(t('btn.continue'), 'onWelcomeNext', { step: '1' }));
  } else if (step === 2) {
    builder.setHeader(header(t('profile.header'), ui(t('wel.step', 2))));
    addProfileFields_(builder, s);
    footer_(builder, button(t('triage.save'), 'onWelcomeNext', { step: '2' }), button(t('btn.skip2'), 'onWelcomeSkip', { step: '2' }));
  } else if (step === 3) {
    builder.setHeader(header(t('wel.aiTitle'), ui(t('wel.step', 3))));
    s.addWidget(para(t('wel.aiText')));
    s.addWidget(para(t('settings.privacy')));
    s.addWidget(CardService.newTextInput().setFieldName('geminiKey').setTitle(ui(t('settings.keyField'))).setHint(ui(t('wel.keyHint'))));
    s.addWidget(CardService.newTextButton().setText(ui(t('settings.getKey'))).setOpenLink(CardService.newOpenLink().setUrl('https://aistudio.google.com/apikey')));
    builder.addSection(s);
    footer_(builder, button(t('btn.continue'), 'onWelcomeNext', { step: '3' }), button(t('btn.skip2'), 'onWelcomeSkip', { step: '3' }));
  } else {
    builder.setHeader(header(t('wel.histTitle'), ui(t('wel.step', 4))));
    s.addWidget(para(t('wel.histText')));
    builder.addSection(s);
    footer_(builder, button(t('wel.fresh'), 'onWelcomeFresh'), button(t('wel.restore'), 'onWelcomeRestore'));
  }
  return builder.build();
}
function onWelcomeNext(e) {
  const step = parseInt(e.parameters.step, 10);
  try {
    if (step === 1) {
      const l = formValue(e, 'lang');
      if (l === 'he' || l === 'en') { UP.setProperty('lang', l); _str = null; }
      const name = formValue(e, 'senderName').trim();
      if (name) PropertiesService.getScriptProperties().setProperty('SENDER_NAME', name);
    } else if (step === 2) {
      saveProfileFromForm_(e);
    } else if (step === 3) {
      const key = formValue(e, 'geminiKey').trim();
      if (key) PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
    }
    return updateTo(buildWelcomeCard(step + 1));
  } catch (err) { return note(String(err.message || err)); }
}
function onWelcomeSkip(e) { return updateTo(buildWelcomeCard(parseInt(e.parameters.step, 10) + 1)); }
function finishWelcome_() { UP.setProperty('welcomeDone', new Date().toISOString()); UP.setProperty('restoreDone', new Date().toISOString()); UP.deleteProperty('forceWelcome'); }
function onWelcomeFresh() {
  finishWelcome_();
  try { runDailyScan_('home'); } catch (err) { /* the home card scans again */ }
  return updateTo(onHomepage());
}
function onWelcomeRestore() {
  finishWelcome_();
  const r = restoreHistory_();
  return noteAndUpdate(r.error ? r.error : t('restore.done', r.added, r.messages).replace(/<\/?b>/g, ''), onHomepage());
}
/** Test accounts only: show the welcome again on the next home card. */
function debugShowWelcome() { UP.setProperty('forceWelcome', '1'); Logger.log('The welcome shows on the next home card.'); }

// ---- "Your writing style": the member picks up to 5 emails THEY wrote; only their message IDs are stored ----
const STYLE_DEFAULT_QUERY = 'in:sent newer_than:1y';
/** ticked: IDs to show ticked (the saved choice, or what was ticked before a new search); query: the Gmail search shown below them. */
function buildStyleCard(ticked, query) {
  const max = ReplyTrackingLib.getStyleMaxSamples();
  const c = ReplyTrackingLib.getStyleChoices(query || STYLE_DEFAULT_QUERY, ticked);
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('style.cardTitle'), ui(t('style.cardSub', max))));
  const intro = CardService.newCardSection();
  intro.addWidget(para(t('style.intro')));
  intro.addWidget(para(t('style.privacy')));
  builder.addSection(intro);

  const pick = CardService.newCardSection();
  if (!c.chosen.length && !c.found.length) pick.addWidget(para('<i>' + t('style.none') + '</i>'));
  if (c.chosen.length || c.found.length) {
    const sel = CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('styleIds').setTitle(ui(t('style.listTitle')));
    // Selection items are PLAIN TEXT: no escaping. Email text gets its own direction (FSI isolate), like other user text.
    c.chosen.forEach(x => sel.addItem(userText(x.label), x.msgId, true));
    c.found.forEach(x => sel.addItem(userText(x.label), x.msgId, false));
    pick.addWidget(sel);
  }
  pick.addWidget(button(t('style.saveBtn'), 'onStyleSave'));
  builder.addSection(pick);

  const search = CardService.newCardSection().setHeader(ui(t('style.findHeader')));
  search.addWidget(CardService.newTextInput().setFieldName('styleQuery').setTitle(ui(t('style.searchField'))).setValue(query || STYLE_DEFAULT_QUERY)
    .setHint(ui(t('style.searchHint'))));
  search.addWidget(button(t('style.searchBtn'), 'onStyleSearch'));
  builder.addSection(search);
  return builder.build();
}
function onStyleChooser() {
  try {
    const saved = savedStyleIds_();
    return pushTo(buildStyleCard(saved.length ? saved : styleIdsForUse_(), STYLE_DEFAULT_QUERY));   // first visit: the suggestions come pre-ticked
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
function onStyleSearch(e) {
  try { return updateTo(buildStyleCard(formValues(e, 'styleIds'), formValue(e, 'styleQuery').trim())); }
  catch (err) { return note(String(err.message || err)); }
}
function onStyleSave(e) {
  const ids = formValues(e, 'styleIds');
  const max = ReplyTrackingLib.getStyleMaxSamples();
  if (ids.length > max) return note(t('style.tooMany', max, ids.length));
  UP.setProperty('styleIds', JSON.stringify(ids));
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(ui(ids.length ? t('style.saved', ids.length) : t('style.cleared'))))
    .setNavigation(CardService.newNavigation().popCard().updateCard(buildSettingsCard()))
    .build();
}
function onSaveLanguage(e) {
  const l = formValue(e, 'lang');
  if (l === 'he' || l === 'en') UP.setProperty('lang', l);
  _str = null;   // reload the texts in the new language for this response
  return noteAndUpdate(t('saved'), buildSettingsCard());
}

function onUploadNowFromSettings() {
  const r = flushOutbox({ maxMs: 25000 });
  return noteAndUpdate(uploadResultText_(r), buildSettingsCard());
}
function onToggleDailyScan() {
  let msg;
  try {
    if (UP.getProperty('scanOff')) { UP.deleteProperty('scanOff'); installScanTrigger(); UP.setProperty('checkTriggerSet', new Date().toISOString()); msg = t('settings.scanTurnedOn'); }
    else { UP.setProperty('scanOff', '1'); removeScanTrigger(); msg = t('settings.scanTurnedOff'); }
  } catch (err) { msg = t('settings.bgError', String(err.message || err)); }
  return noteAndUpdate(msg, buildSettingsCard());
}
/** Weekly reminder email on/off. Turning it off forgets `needsSince`, so turning it back on starts a fresh week. */
function onToggleReminder() {
  let msg;
  try {
    if (UP.getProperty('remindOff')) { UP.deleteProperty('remindOff'); msg = t('settings.remindTurnedOn'); }
    else { UP.setProperty('remindOff', '1'); UP.deleteProperty('needsSince'); msg = t('settings.remindTurnedOff'); }
  } catch (err) { msg = t('settings.bgError', String(err.message || err)); }
  return noteAndUpdate(msg, buildSettingsCard());
}

function onSaveSettings(e) {
  const props = PropertiesService.getScriptProperties();
  const name = formValue(e, 'senderName').trim();
  if (name) props.setProperty('SENDER_NAME', name); else props.deleteProperty('SENDER_NAME');
  return noteAndUpdate(t('saved'), buildSettingsCard());
}

// ======================= OPTIONAL PROFILE =======================
// Lets the analysis compare groups (e.g. residents vs seniors). Every field is a pick-list with "prefer not to say"; nothing is required.
// Saved as a dated kind=profile event (latest one per member wins), plus a local copy so the form can show what was chosen.
function getProfile_() { try { return JSON.parse(UP.getProperty('profile') || 'null'); } catch (e) { return null; } }
function onDismissProfile() { UP.setProperty('profileAsked', new Date().toISOString()); return updateTo(onHomepage()); }
/**
 * The profile questions (redesign): career stage FIRST, as a one-tap radio list (the answer the junior/senior comparison needs), then the
 * other three as dropdowns under "More, if you like". Used by the welcome (step 2) and by the profile card.
 */
function addProfileFields_(builder, section) {
  const opts = ReplyTrackingLib.getProfileOptions();   // { stage: [...], specialty: [...], hospitalType: [...], imaRole: [...] }
  const prof = getProfile_() || {};
  section.addWidget(para('<i>' + t('profile.why') + '</i>'));
  const stage = CardService.newSelectionInput().setType(CardService.SelectionInputType.RADIO_BUTTON).setFieldName('stage').setTitle(ui(t('profile.f.stage')));
  const order = opts.stage.filter(v => v !== 'na').concat(['na']);   // "I'd rather not say" last
  order.forEach(v => stage.addItem(t('profile.stage.' + v), v, v === (prof.stage || 'na')));
  section.addWidget(stage);
  builder.addSection(section);
  const more = CardService.newCardSection().setHeader(ui(t('about.more')));
  Object.keys(opts).filter(f => f !== 'stage').forEach(field => {
    const dd = CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN).setFieldName(field).setTitle(ui(t('profile.f.' + field)));
    const cur = prof[field] || 'na';
    opts[field].forEach(v => dd.addItem(t('profile.' + field + '.' + v), v, v === cur));
    more.addWidget(dd);
  });
  builder.addSection(more);
}
/** Saves the profile form as a dated kind=profile event (plus a local copy). Nothing is sent when every answer is "na" and none was saved before. */
function saveProfileFromForm_(e) {
  const opts = ReplyTrackingLib.getProfileOptions();
  const prof = {};
  Object.keys(opts).forEach(field => { const v = formValue(e, field); prof[field] = opts[field].indexOf(v) !== -1 ? v : 'na'; });
  UP.setProperty('profileAsked', new Date().toISOString());
  if (!getProfile_() && Object.keys(prof).every(k => prof[k] === 'na')) return false;
  enqueueEvent(ReplyTrackingLib.buildProfileEvent(myEmail(), prof));
  UP.setProperty('profile', JSON.stringify(Object.assign({ at: new Date().toISOString() }, prof)));
  return true;
}
function onProfileCard(e) {
  const from = (e && e.parameters && e.parameters.from) || 'fin';
  const builder = CardService.newCardBuilder();
  builder.setHeader(header(t('profile.header')));
  addProfileFields_(builder, CardService.newCardSection());
  footer_(builder, button(t('btn.save'), 'onSaveProfile', { from: from }));
  return pushTo(builder.build());
}
function onSaveProfile(e) {
  try {
    saveProfileFromForm_(e);
    const back = e.parameters && e.parameters.from === 'settings' ? buildSettingsCard() : buildFinishedCard();
    return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(ui(t('profile.saved'))))
      .setNavigation(CardService.newNavigation().popCard().updateCard(back)).build();
  } catch (err) { return note(String(err.message || err)); }
}
// ---- "Test Gemini": runs the real prompts on synthetic cases and shows what the model answered ----
const AI_TEST_UPLOADS_RESULTS = DEV_TOOLS;   // development only: also queue the results as kind=test rows so the maintainers can read them in the log
function onAiSelfTest(e) {
  if (!DEV_TOOLS) return note('Not available.');
  try {
    const key = myApiKey();
    if (!key) return note('Add a Gemini key in Settings first.');
    const round = (e && e.parameters && e.parameters.round) ? parseInt(e.parameters.round, 10) : 1;
    const r = cfgLib_().selfTestAI(key, cfgLib_().getRubric(), round);
    r.round = round;
    if (AI_TEST_UPLOADS_RESULTS) {
      const me = myEmail();
      enqueueEvent(ReplyTrackingLib.buildAiTestEvent(me, 'r' + round + '_summary', JSON.stringify({ model: r.model, tier: r.tier, trace: r.trace, candidates: r.candidates, tokens: r.tokens, calls: r.calls, ms: r.ms, format: r.format, rubricChars: r.rubricChars, rubricStart: r.rubricStart, error: r.error, aiStatus: r.aiStatus })));
      r.items.forEach(c => enqueueEvent(ReplyTrackingLib.buildAiTestEvent(me, 'r' + round + '_' + c.ref, JSON.stringify(c))));
      r.refine.forEach(c => enqueueEvent(ReplyTrackingLib.buildAiTestEvent(me, 'r' + round + '_' + c.id, JSON.stringify(c))));
    }
    return round === 1 ? pushTo(buildAiTestCard(r)) : updateTo(buildAiTestCard(r));
  } catch (err) { return pushTo(buildErrorCard(err)); }
}
function buildAiTestCard(r) {
  const builder = CardService.newCardBuilder();
  builder.setHeader(CardService.newCardHeader().setTitle('Gemini check, round ' + r.round).setSubtitle(String(r.model || 'no model answered') + (r.tier ? ' (' + r.tier + ' tier)' : '')));
  const section = CardService.newCardSection();
  const firm = r.items.filter(c => !c.borderline), soft = r.items.filter(c => c.borderline);
  if (r.error) section.addWidget(para('<b>Error:</b> ' + esc(r.error.message)));
  if ((r.trace || []).length) section.addWidget(para('<b>Attempts:</b> ' + esc(r.trace.join('; '))));
  section.addWidget(para('<b>As expected:</b> ' + firm.filter(c => c.ok).length + ' of ' + firm.length + ' clear cases, ' + soft.filter(c => c.ok).length + ' of ' + soft.length + ' borderline<br><b>Requests used:</b> ' + r.calls + '<br><b>Prompt tokens:</b> ' + (r.tokens === null ? '?' : r.tokens) + '<br><b>Time:</b> ' + Math.round(r.ms / 100) / 10 + ' s<br><b>Rubric:</b> ' + r.rubricChars + ' characters'));
  section.addWidget(para(r.items.map(c => (c.ok ? '✓ ' : '✗ ') + esc(c.id) + ': expected ' + esc(c.expected) + (c.ok ? '' : ', got ' + esc(String(c.got)))).join('<br>')));
  section.addWidget(para(Object.keys(r.format).map(k => esc(k) + ': lost lines ' + r.format[k].lostLines + ', chars ' + esc(r.format[k].chars) + (r.format[k].keptReplyBelowQuote !== undefined ? ', kept reply below quote ' + r.format[k].keptReplyBelowQuote + ', dropped quoted copy ' + r.format[k].droppedQuotedCopy : '')).join('<br>')));
  if (r.refine.length) section.addWidget(para(r.refine.map(c => c.error ? esc(c.id) + ': ERROR ' + esc(c.error) : esc(c.id) + ': ' + c.words + ' words' + (c.keeps ? '' : ', lost a required detail') + (c.mentionsRole ? ', MENTIONS ROLE' : '') + (c.addedSignoff ? ', ADDED A SIGN-OFF' : '') + ((c.warnings || []).length ? ', warnings: ' + esc(c.warnings.join(',')) : '')).join('<br>')));
  if (AI_TEST_UPLOADS_RESULTS) section.addWidget(para('<i>Results were also queued for upload (development build). Press Upload now.</i>'));
  if (r.round === 1) section.addWidget(button('Run again (consistency, 1 request)', 'onAiSelfTest', { round: '2' }));
  if (r.round !== 3) section.addWidget(button('Test the rewrite (2 requests)', 'onAiSelfTest', { round: '3' }));
  if (r.round === 1 || r.round === 2) section.addWidget(button('Judge with the everyday model instead (comparison, 1 request)', 'onAiSelfTest', { round: '4' }));
  section.addWidget(button('Upload now', 'onUploadNowFromSettings'));
  builder.addSection(section);
  return builder.build();
}
function onRemoveGeminiKey() {
  PropertiesService.getScriptProperties().deleteProperty('GEMINI_API_KEY');
  return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(ui(t('settings.keyRemoved'))))
    .setNavigation(CardService.newNavigation().popCard().updateCard(buildSettingsCard())).build();
}

// ======================= TEST / DEBUG HELPERS =======================
// Not wired to any card — run from the Apps Script editor (function dropdown → Run).

/** RUN THIS FIRST. Verifies scopes, address detection, aliases, and that the group settings arrive from the gateway. */
function debugCheckSetup() {
  ensureConfig_({ refresh: true });
  const saved = getBlob('cfg', null);
  Logger.log(JSON.stringify(Object.assign(ReplyTrackingLib.selfCheck(), {
    settingsSource: 'gateway (config action); saved copy used when it is down',
    savedVersion: saved ? saved.version : null,
    lastConfirmed: UP.getProperty('cfgCheckedAt') ? new Date(parseInt(UP.getProperty('cfgCheckedAt'), 10)).toISOString() : null,
    lastRefresh: getConfigStatus()
  }), null, 2));
}

/** Queues one 'test' event and uploads the outbox. Logs what the gateway answered. Check the gateway's Log tab for the row. */
function debugTestGateway() {
  enqueueEvent(ReplyTrackingLib.buildTestEvent(myEmail()));
  const r = flushOutbox({ maxMs: 30000 });
  Logger.log('Upload result: ' + JSON.stringify(r) + '\nStill waiting: ' + outboxCount() + '   Rejected: ' + rejectedCount() +
    '\nIf sent is 1 the gateway accepted it: open the gateway\'s Log tab and look for the kind=test row.');
}
/** Uploads whatever is queued, right now. */
function debugFlushOutbox() { Logger.log(JSON.stringify(flushOutbox({ maxMs: 60000 }))); }
/** Prints the queued events (outbox) and the ones the gateway rejected. */
function debugShowOutbox() {
  const all = UP.getProperties();
  Logger.log('QUEUED (' + outboxCount() + '):\n' + outboxKeys().map(k => all[k]).join('\n') +
    '\nREJECTED (' + rejectedCount() + '):\n' + Object.keys(all).filter(k => k.indexOf('x_') === 0).map(k => all[k]).join('\n') +
    '\nLAST STATUS: ' + JSON.stringify(getUploadStatus()));
}
/** Throws away every queued/rejected event. Test account only. */
function debugClearOutbox() {
  Object.keys(UP.getProperties()).forEach(k => { if (k.indexOf('o_') === 0 || k.indexOf('x_') === 0) UP.deleteProperty(k); });
  UP.deleteProperty('updateRequired'); UP.deleteProperty('uploadStatus'); UP.deleteProperty('outboxN');
  Logger.log('Outbox cleared.');
}

function debugListThreadMap() { Logger.log(JSON.stringify(getThreadMap(), null, 2)); }

/** Forgets ONE thread so scan/search offers it again. NOTE: it will be re-logged (new events, same eventIds are dropped by the gateway only within ~6 h) — analysis reads the Clean tab, which dedupes on eventId. */
function debugForgetThread() {
  const threadId = 'PASTE_THREAD_ID_HERE';
  UP.deleteProperty('t_' + threadId);
  Logger.log('Forgot thread ' + threadId + '. Remaining: ' + Object.keys(getThreadMap()).length);
}

/** Wipes your ENTIRE private thread registry. Only for a test account. */
function debugResetAllThreads() {
  Object.keys(UP.getProperties()).forEach(k => { if (k.indexOf('t_') === 0) UP.deleteProperty(k); });
  UP.deleteProperty('threadMap');
  Logger.log('Thread registry cleared.');
}

/** Clears the "already logged" list on one thread so all its messages are offered again by "Check for replies". */
function debugRerunLatestReply() {
  const threadId = 'PASTE_THREAD_ID_HERE';
  const entry = getThreadMap()[threadId];
  if (!entry) { Logger.log('Thread not registered.'); return; }
  entry.done = [];
  delete entry.lastReported;
  saveThread(threadId, entry);
  Logger.log('Cleared logged-message list for ' + threadId + '. Duplicate events are possible; the Clean tab dedupes on eventId.');
}

function debugPrintSession() { Logger.log(JSON.stringify(loadSession(), null, 2)); }
function debugClearSession() { clearSession(); delBlob('flagged'); clearComposeSession(); Logger.log('Session cleared.'); }
