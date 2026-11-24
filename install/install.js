#!/usr/bin/env node
/*
 * IMA Reply Tracking installer (runs on the doctor's computer; Node.js 18+ is provided by install.ps1 / install.sh).
 *
 *  1. installs `clasp` (Google's Apps Script command-line tool) into ~/.ima-reply-tracking/tools   (no admin rights, nothing global)
 *  2. signs the doctor in to Google ONCE, in their browser (clasp's own sign-in; the token is kept in a private temp folder)
 *  3. joins the doctor to IMA Reply Tracking: sends the doctor's Google ID token (proves who they are; grants no access), plus an invite
 *     code if the group uses them, to the log gateway, which adds them to the member list (the library is shared by link).
 *     Since 21 Nov 2026 the GCP gateway runs in OPEN join mode (no code needed; the owner's decision).
 *  4. downloads the add-on files from the project's public GitHub release, creates the doctor's OWN Apps Script project and pushes them
 *  5. REVOKES the clasp sign-in and deletes the token (the doctor does not need it afterwards)
 *  6. opens the project so the doctor can do the two clicks nobody can automate: Deploy -> Test deployments -> Install, then Gmail's permission prompt
 *
 * Re-running it updates the same project to the release this installer was built for (its files are pinned by hash: a newer
 * release comes with a new command).
 * Nothing is sent anywhere except: Google (sign-in, project creation), GitHub (download), npm (clasp), and the log gateway (join).
 *
 * Options:  --code XXXX-XXXX-XXXX-XXXX   invite code (only if the group's server is set to require invites)
 *           --gateway URL  --release-base URL   override the built-in addresses (testing)
 *           --source DIR   take Code.gs and appsscript.json from a folder instead of GitHub (testing)
 *           --no-open      do not open the browser at the end        --yes   do not wait for Enter keys
 *           --dry-run      show what would happen, change nothing
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const readline = require('readline');

// ---- addresses (filled in when the installer is published; the gateway URL is not a secret) ----
const CONFIG = {
  gatewayUrl: 'https://gateway-umq64hvc6a-zf.a.run.app/',
  releaseBase: 'https://github.com/amits-ds/ima-reply-tracking-addon/releases/latest/download',
  projectTitle: 'IMA Reply Tracking',
  claspVersion: '3.4.1',
  settingsUrl: 'https://script.google.com/home/usersettings',
};

// ---- arguments ----
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const FLAG = { code: opt('code'), gateway: opt('gateway') || CONFIG.gatewayUrl, base: opt('release-base') || CONFIG.releaseBase, source: opt('source'),
  noOpen: !!opt('no-open'), yes: !!opt('yes'), dry: !!opt('dry-run') };

const HOME = path.join(os.homedir(), '.ima-reply-tracking');
const TOOLS = path.join(HOME, 'tools');
const AUTH = path.join(HOME, 'auth');          // temporary: holds clasp's token only during the install
let PROJ = path.join(HOME, 'project');         // the doctor's project files + .clasp.json (a per-account subfolder is chosen once the account is known)
const STATE = path.join(HOME, 'state.json');
const LOG = path.join(HOME, 'install.log');
fs.mkdirSync(HOME, { recursive: true });

function say(msg) { console.log(msg); try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { /* ignore */ } }
function logOnly(msg) { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { /* ignore */ } }
const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';
let stepNo = 0;
const TOTAL = 6;
function step(msg) { stepNo++; say('\n[' + stepNo + '/' + TOTAL + '] ' + msg); }
class Fatal extends Error { constructor(msg, hint) { super(msg); this.hint = hint; } }

function ask(prompt) {
  if (FLAG.yes) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(prompt, a => { rl.close(); res(a); }));
}
function openUrl(url) {
  if (FLAG.noOpen) return;
  try {
    if (process.platform === 'win32') cp.spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else cp.spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { /* the URL is printed anyway */ }
}
function run(cmd, a, o) {
  const r = cp.spawnSync(cmd, a, Object.assign({ encoding: 'utf8', shell: false }, o || {}));
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

// ---- 1. clasp ----
function claspJs() {
  const pkg = path.join(TOOLS, 'node_modules', '@google', 'clasp');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    const bin = typeof j.bin === 'string' ? j.bin : (j.bin && j.bin.clasp);
    const p = path.join(pkg, bin);
    return fs.existsSync(p) ? p : null;
  } catch (e) { return null; }
}
function ensureClasp() {
  step('Installing the Google Apps Script tool (clasp)');
  if (claspJs()) { say('  already installed'); return; }
  if (FLAG.dry) { say('  [dry run] would run: npm install @google/clasp@' + CONFIG.claspVersion); return; }
  fs.mkdirSync(TOOLS, { recursive: true });
  if (!fs.existsSync(path.join(TOOLS, 'package.json'))) fs.writeFileSync(path.join(TOOLS, 'package.json'), '{"name":"reply-tracking-tools","private":true}');
  const npmArgs = ['install', '--no-audit', '--no-fund', '--loglevel', 'error', '--cache', path.join(HOME, 'npm-cache'), '@google/clasp@' + CONFIG.claspVersion];   // cache kept inside our own folder too
  const nodeDir = path.dirname(process.execPath);
  const npmCli = [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(p => fs.existsSync(p));
  let r = npmCli
    ? run(process.execPath, [npmCli].concat(npmArgs), { cwd: TOOLS })          // run npm with the same node, no shell involved
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, { cwd: TOOLS, shell: process.platform === 'win32' });
  logOnly(r.out);
  if (r.status !== 0 || !claspJs()) throw new Fatal('Could not install clasp.', 'Check your internet connection and run the installer again. Details: ' + LOG);
  say('  done');
}
function clasp(a, o) {
  const js = claspJs();
  return run(process.execPath, [js, '-A', authFile()].concat(a), o);
}

// ---- 2. Google sign-in (clasp's own) ----
function authFile() { return path.join(AUTH, '.clasprc.json'); }
function readTokens() {
  try { const j = JSON.parse(fs.readFileSync(authFile(), 'utf8')); return (j.tokens && j.tokens.default) || null; } catch (e) { return null; }
}
async function signIn() {
  step('Signing in to Google');
  fs.mkdirSync(AUTH, { recursive: true });
  if (readTokens()) { say('  already signed in'); return; }
  if (FLAG.dry) { say('  [dry run] would open the Google sign-in'); return; }
  say('  A browser window will open. Choose the Google account you use for your Gmail (the one you correspond from),');
  say('  then press Allow. If the window does not open, copy the address that appears below into your browser.');
  const js = claspJs();
  const r = cp.spawnSync(process.execPath, [js, '-A', authFile(), 'login'], { stdio: 'inherit' });
  if (r.status !== 0 || !readTokens()) throw new Fatal('Google sign-in did not finish.', 'Run the installer again and complete the sign-in in the browser window.');
}
function jwtExp(jwt) { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')).exp * 1000; } catch (e) { return 0; } }
/** A Google ID token for the signed-in account. It only PROVES who the doctor is (it grants no access to anything), so that is all we ever send to the IMA Reply Tracking server. */
async function idToken() {
  const t = readTokens();
  if (!t) throw new Fatal('No Google sign-in found.');
  if (t.id_token && jwtExp(t.id_token) - Date.now() > 120000) return t.id_token;
  const body = new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await res.json();
  if (!j.id_token) throw new Fatal('Could not refresh the Google sign-in.', 'Run the installer again.');
  return j.id_token;
}
async function whoAmI(token) {
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
  if (!res.ok) return null;
  const j = await res.json();
  return j.email && String(j.email_verified) === 'true' ? String(j.email).toLowerCase() : null;
}

// ---- 3. join IMA Reply Tracking ----
async function postGateway(payload) {
  const res = await fetch(FLAG.gateway, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { throw new Fatal('The IMA Reply Tracking server gave an unreadable answer (HTTP ' + res.status + ').', 'Try again in a few minutes.'); }
}
async function join(state, email, token) {
  step('Joining IMA Reply Tracking');
  if (state.joinedAs === email) { say('  already joined as ' + email); return; }
  if (/PASTE_/.test(FLAG.gateway)) throw new Fatal('This installer has no server address configured.', 'Ask the person who sent it to you for a newer version.');
  if (FLAG.dry) { say('  [dry run] would send the sign-in' + (FLAG.code ? ' and the invite code' : '') + ' to the IMA Reply Tracking server'); return; }
  let r = null;
  for (let i = 0; i < 4; i++) {
    r = await postGateway(FLAG.code ? { action: 'join', code: FLAG.code, idToken: token } : { action: 'join', idToken: token });
    if (!(r && r.error === 'busy')) break;
    say('  server busy, retrying...');
    await new Promise(s => setTimeout(s, 4000 * (i + 1)));
  }
  logOnly('join answer: ' + JSON.stringify(Object.assign({}, r, { detail: undefined })));
  if (!r || !r.ok) {
    if (r && r.error === 'paused') throw new Fatal('The account ' + email + ' is paused for a review by the group admins.', 'Nothing is lost. Ask the group admins; once they lift the pause, run the installer again.');
    if (r && r.error === 'join_refused' && !FLAG.code) throw new Fatal('The server did not accept ' + email + ' as a member.',
      'If that is the wrong Google account, run the installer again and pick the right one in the account chooser (use "Use another account" if it is not listed). ' +
      'If the group sent you an invite code, run it with:  --code XXXX-XXXX-XXXX-XXXX');
    if (r && r.error === 'join_refused') throw new Fatal('The invite code was not accepted.', 'It may already be used, expired, or typed wrongly. Ask for a new code. (Signed in as ' + email + '.)');
    throw new Fatal('Joining failed: ' + ((r && (r.error || r.message)) || 'no answer') + '.', 'Try again in a few minutes.');
  }
  state.joinedAs = email;
  saveState(state);
  say('  joined as ' + email);
}

// ---- 4. project ----
async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Fatal('Could not download ' + url + ' (HTTP ' + res.status + ').', 'Try again later.');
  return Buffer.from(await res.arrayBuffer());
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
/** The release publishes SHA256SUMS.txt ("<hash>  <file>" lines). A downloaded file that does not match is never written anywhere. */
function checkSum(sums, name, buf) {
  const line = sums.split(/\r?\n/).map(l => l.trim().split(/\s+/)).find(p => p.length === 2 && p[1] === name);
  if (!line) throw new Fatal('The release has no checksum for ' + name + '.', 'Tell the organizer.');
  if (line[0].toLowerCase() !== sha256(buf)) throw new Fatal(name + ' does not match its published checksum, so it was not installed.', 'Try again later; if it repeats, tell the organizer.');
}
async function getFiles() {
  let code, manifest;
  if (FLAG.source) {
    code = fs.readFileSync(path.join(FLAG.source, 'Code.gs'));
    manifest = fs.readFileSync(path.join(FLAG.source, 'appsscript.json'));
  } else {
    [code, manifest] = await Promise.all([fetchBytes(FLAG.base + '/Code.gs'), fetchBytes(FLAG.base + '/appsscript.json')]);
    // Always the latest release (owner, 24 Nov 2026). SHA256SUMS.txt comes from the same release, so it catches a broken or partial
    // download, not a changed release: that rests on who can publish to the public repo.
    const sums = (await fetchBytes(FLAG.base + '/SHA256SUMS.txt')).toString('utf8');
    checkSum(sums, 'Code.gs', code);
    checkSum(sums, 'appsscript.json', manifest);
    say('  downloaded files match the release checksums (SHA256SUMS.txt)');
  }
  return { code: code.toString('utf8'), manifest: manifest.toString('utf8'), codeBuf: code, manifestBuf: manifest };
}
function sanity(files) {
  let m;
  try { m = JSON.parse(files.manifest); } catch (e) { throw new Fatal('The downloaded manifest is not valid.', 'Tell the organizer.'); }
  const lib = m.dependencies && m.dependencies.libraries && m.dependencies.libraries[0];
  if (!lib || lib.userSymbol !== 'ReplyTrackingLib' || /PASTE_/.test(lib.libraryId || '')) throw new Fatal('The downloaded add-on is not configured yet.', 'Tell the organizer.');
  if (!/ReplyTrackingLib\./.test(files.code) || files.code.length < 20000) throw new Fatal('The downloaded add-on file looks wrong.', 'Tell the organizer.');
}
async function ensureProject(state) {
  step(state.scriptId ? 'Updating your add-on project' : 'Creating your add-on project');
  const files = await getFiles();
  sanity(files);
  if (FLAG.dry) { say('  [dry run] would ' + (state.scriptId ? 'push to project ' + state.scriptId : 'create the project and push the files')); return; }
  fs.mkdirSync(PROJ, { recursive: true });
  const sleep = (ms) => new Promise(s => setTimeout(s, ms));
  let apiPrompted = false;
  // Google needs a few minutes to notice the "Apps Script API" switch, so keep trying (every 10 s, up to ~6 min) instead of giving up.
  const waitForApiSwitch = async () => {
    if (!apiPrompted) {
      apiPrompted = true;
      say('\n  One switch is needed once: Google must allow scripts to be created from this account.');
      say('  A page will open. Turn ON "Google Apps Script API". Then wait here: it can take a few minutes for Google to notice,');
      say('  and the installer keeps trying by itself.');
      openUrl(CONFIG.settingsUrl);
      say('  ' + CONFIG.settingsUrl);
    } else { process.stdout.write('  still waiting for Google...\n'); }
    await sleep(FLAG.api_wait_ms || 10000);
  };
  for (let attempt = 0; attempt < 36; attempt++) {
    if (!state.scriptId) {
      const r = clasp(['create', '--type', 'standalone', '--title', CONFIG.projectTitle], { cwd: PROJ });
      logOnly(r.out);
      if (r.status !== 0) {
        if (/Apps Script API|not enabled|has not been used|disabled|accessNotConfigured/i.test(r.out)) { await waitForApiSwitch(); continue; }
        throw new Fatal('Could not create the project.', 'Details: ' + LOG);
      }
      const j = JSON.parse(fs.readFileSync(path.join(PROJ, '.clasp.json'), 'utf8'));
      state.scriptId = j.scriptId;
      saveState(state);
    }
    fs.writeFileSync(path.join(PROJ, 'appsscript.json'), files.manifestBuf);
    fs.writeFileSync(path.join(PROJ, 'Code.gs'), files.codeBuf);
    fs.writeFileSync(path.join(PROJ, '.clasp.json'), JSON.stringify({ scriptId: state.scriptId, rootDir: '' }));
    const p = clasp(['push', '-f'], { cwd: PROJ });
    logOnly(p.out);
    if (p.status === 0) { say('  done'); return; }
    if (/Apps Script API|not enabled|has not been used|disabled/i.test(p.out)) { await waitForApiSwitch(); continue; }
    if (/library|Library|not found|permission/i.test(p.out)) throw new Fatal('Your account cannot see the shared library.', 'Tell the organizer (the library must be shared "Anyone with the link: Viewer"). Details: ' + LOG);
    throw new Fatal('Could not upload the add-on files.', 'Details: ' + LOG);
  }
  throw new Fatal('Could not finish creating the project.', 'Run the installer again.');
}

// ---- 5. forget the Google sign-in ----
async function signOut() {
  step('Removing the temporary Google sign-in from this computer');
  const t = readTokens();
  if (t && !FLAG.dry) {
    try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.refresh_token || t.access_token), { method: 'POST' }); } catch (e) { /* best effort */ }
  }
  if (!FLAG.dry) fs.rmSync(AUTH, { recursive: true, force: true });
  say('  done (you will sign in again only if you run the installer again)');
}

// State is kept PER GOOGLE ACCOUNT (two people on one computer must not share a project): { accounts: { "<email>": { joinedAs, scriptId } } }
let ALL_STATE = { accounts: {} };
function loadState() { try { const j = JSON.parse(fs.readFileSync(STATE, 'utf8')); return j && j.accounts ? j : { accounts: {} }; } catch (e) { return { accounts: {} }; } }
function saveState() { fs.writeFileSync(STATE, JSON.stringify(ALL_STATE, null, 2)); }

async function main() {
  if (opt('forget')) {   // remove a leftover temporary Google sign-in (e.g. after a failed install) and stop
    const t = readTokens();
    if (t) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.refresh_token || t.access_token), { method: 'POST' }); } catch (e) { /* best effort */ } }
    fs.rmSync(AUTH, { recursive: true, force: true });
    say('The temporary Google sign-in was removed.');
    return;
  }
  say('IMA Reply Tracking installer' + (FLAG.dry ? '  [DRY RUN]' : ''));
  if (parseInt(process.versions.node, 10) < 18) throw new Fatal('Node.js 18 or newer is required.');
  ALL_STATE = loadState();
  ensureClasp();
  await signIn();
  const token = FLAG.dry ? null : await idToken();
  const email = FLAG.dry ? 'dry-run' : await whoAmI(token);
  if (!FLAG.dry && !email) throw new Fatal('Could not read your Google account from the sign-in.', 'Run the installer again.');
  if (!FLAG.dry) say('  signed in as ' + email);
  const state = ALL_STATE.accounts[email] = ALL_STATE.accounts[email] || {};
  PROJ = path.join(HOME, 'project', email.replace(/[^a-z0-9._@-]/gi, '_'));
  await join(state, email, token);
  await ensureProject(state);
  await signOut();

  step('Last two clicks (Google requires you to do these yourself)');
  const url = state.scriptId ? 'https://script.google.com/home/projects/' + state.scriptId + '/edit' : '(project address)';
  say('\n  Your add-on project: ' + url);
  say('  1. In the page that opens: click the blue "Deploy" button, then "Test deployments", then "Install".');
  say('     (If a small window appears, wait a few seconds; then press "Install".)');
  say('  2. Open Gmail, press F5, open any email and click the new add-on icon on the right.');
  say('     Press "Authorize access", pick your account, then Advanced > Go to ... > Allow.');
  say('     Google shows a warning because this is your own personal copy; that is expected.');
  if (!FLAG.dry) openUrl(url);

  say('\nOptional: AI tag suggestions with Gemini');
  say('  The add-on works fully without it; you then pick each reply\'s tag yourself. With it, Google\'s Gemini model suggests a tag and a one-line');
  say('  reason for each reply (you always make the final choice). It needs YOUR OWN Gemini key from Google:');
  say('    1. Open ' + GEMINI_KEY_URL + ' and sign in, then press "Create API key" and copy the key.');
  say('    2. In Gmail open the add-on, open Settings (menu), press "Key" next to Gemini, paste the key into "Gemini API key" and press Save.');
  say('  Privacy: with a Gemini key, the text of the replies (and your own messages in that thread) is sent to Google. On Google\'s FREE tier its terms');
  say('  allow it to use what you send to improve its products; paid (billing-enabled) keys are treated differently. Replies can contain personal or');
  say('  medical details, so check Google\'s current terms for your tier, or leave the key empty if you are unsure.');
  if (!FLAG.dry && !FLAG.yes) {
    const a = String(await ask('\n  Open the Gemini key page in your browser now? (y/N) ')).trim().toLowerCase();
    if (a === 'y' || a === 'yes') openUrl(GEMINI_KEY_URL);
  }

  say('\nIf you used the add-on before (a reinstall or a new computer): on the add-on\'s last welcome step press "Restore my history" (later: Settings,');
  say('Advanced, "Restore history from the log"), so nothing is asked twice.');
  say('\nDone. You can close this window.');
}

main().catch(err => {
  const msg = err instanceof Fatal ? err.message : 'Unexpected problem: ' + (err && err.message || err);
  console.error('\nERROR: ' + msg);
  if (err instanceof Fatal && err.hint) console.error('  ' + err.hint);
  logOnly('FATAL ' + (err && err.stack || err));
  console.error('  Log file: ' + LOG);
  process.exit(1);
});
