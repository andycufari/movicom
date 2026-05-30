#!/usr/bin/env node
/**
 * phone.js — Claudia's body. A fluent driver for an Android device over adb.
 *
 * Design (agreed with Andy, 2026-05-30, projects/movicom/BUILDME.md):
 *  - The tool is Claudia's OPTIC NERVE: it throws away the raw XML photons and
 *    hands the brain only MEANING (labels + structure), minified. Coordinates
 *    live INSIDE the tool, never in Claudia's context. She acts by NAME; the
 *    tool resolves the name to numbers.
 *  - Fluent + chainable: open("Settings").tap("Apps").see()
 *  - XML-first, screenshot only as explicit fallback (shot()).
 *
 * Usage (inline, from Bash):
 *   node bin/phone.js see
 *   node bin/phone.js open Settings : tap "Network & internet" : see
 *   node -e 'require("./bin/phone").open("Settings").tap("Apps").see()'
 */

const { execSync } = require('child_process');

const ADB = process.env.ADB || 'adb';
const DUMP_PATH = '/sdcard/window_dump.xml';

// movicom is validated against this adb (Android Debug Bridge) version. adb's
// `uiautomator dump` / `dumpsys` output format is stable across point releases
// but COULD change; if the live adb differs we warn once so a future format
// shift surfaces loudly instead of silently mis-parsing. Override the check with
// MOVICOM_SKIP_VERSION_CHECK=1. Bump this when re-validating on a newer adb.
const ADB_VALIDATED = '1.0.41'; // Platform-Tools 36.x line (see README)

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
function adb(args) {
  return sh(`${ADB} ${args}`);
}
function adbShell(args) {
  // single-quote the inner command so spaces/specials survive
  return sh(`${ADB} shell ${args}`);
}
const sleep = (ms) => { const e = Date.now() + ms; while (Date.now() < e) {} };

let _versionChecked = false;
function checkAdbVersion() {
  if (_versionChecked || process.env.MOVICOM_SKIP_VERSION_CHECK) return;
  _versionChecked = true;
  try {
    const v = (sh(`${ADB} version`).match(/version\s+([\d.]+)/i) || [])[1];
    if (v && v !== ADB_VALIDATED) {
      process.stderr.write(
        `[movicom] warning: adb ${v} differs from validated ${ADB_VALIDATED}. ` +
        `If screens mis-parse, re-validate and bump ADB_VALIDATED. ` +
        `(silence: MOVICOM_SKIP_VERSION_CHECK=1)\n`);
    }
  } catch (_) { /* adb missing — the first real command will surface it */ }
}

// ---- bounds helpers ------------------------------------------------------
function parseBounds(b) {
  // "[x1,y1][x2,y2]" -> {x1,y1,x2,y2,cx,cy}
  const m = b && b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x1, y1, x2, y2, cx: (x1 + x2) >> 1, cy: (y1 + y2) >> 1 };
}

// ---- the retina: raw XML -> structured elements --------------------------
// We keep coords HERE; we never ship them to the brain unless asked.
// We WALK THE TREE (not flat regex) so a labeled leaf can inherit "clickable"
// + bounds from an ancestor container — Android marks the click on the parent,
// the label on a child TextView. (scar found 2026-05-30 by diffing real XML.)
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function attrsOf(tag) {
  const a = {};
  let m; const re = /([\w-]+)="([^"]*)"/g;
  while ((m = re.exec(tag))) a[m[1]] = m[2];
  return a;
}
function parseScreen(xml) {
  const els = [];
  // tokenize into open / selfclose / close so we can track ancestor stack
  const tokRe = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  const stack = []; // ancestors: {clickable, bounds}
  let m;
  while ((m = tokRe.exec(xml))) {
    if (m[0] === '</node>') { stack.pop(); continue; }
    const a = attrsOf(m[1]);
    const selfClose = m[2] === '/';
    const bounds = parseBounds(a['bounds']);
    const node = {
      clickable: a['clickable'] === 'true' || a['long-clickable'] === 'true',
      bounds,
    };

    const label = decodeEntities((a['text'] || '').trim() || (a['content-desc'] || '').trim());
    const cls = (a['class'] || '').split('.').pop();
    const scrollable = a['scrollable'] === 'true';
    const editable = cls === 'EditText' || a['password'] === 'true';

    // is this node OR any ancestor clickable? if ancestor, tap THERE.
    let tapTarget = node.clickable ? bounds : null;
    if (!tapTarget) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].clickable) { tapTarget = stack[i].bounds; break; }
      }
    }
    const isTappable = !!tapTarget;

    if (bounds) {
      const fullScreen = bounds.x1 === 0 && bounds.y1 === 0;
      const keep = label || isTappable || editable || (scrollable && !fullScreen);
      if (keep && (label || editable || (scrollable && !fullScreen))) {
        els.push({
          label, cls,
          clickable: isTappable,
          scrollable, editable,
          bounds: tapTarget || bounds, // tap the clickable ancestor, not the dead label
        });
      }
    }
    if (!selfClose) stack.push(node);
  }
  return els;
}

function foregroundApp() {
  try {
    const w = adbShell('dumpsys window');
    const m = w.match(/mCurrentFocus=Window\{[^ ]+ \w+ ([^/]+)\/([^}]+)\}/);
    if (m) return { pkg: m[1], activity: m[2] };
  } catch (_) {}
  return { pkg: '?', activity: '?' };
}

// ---- the Phone object ----------------------------------------------------
class Phone {
  constructor() {
    this._els = [];        // last-seen elements (with coords — internal only)
    this._app = null;
  }

  // ensure a window actually has focus, else uiautomator returns null-root
  _ensureFocus() {
    adbShell('input keyevent KEYCODE_WAKEUP') ;
    try { adbShell('wm dismiss-keyguard'); } catch (_) {}
  }

  _dump(retries = 4) {
    checkAdbVersion();
    for (let i = 0; i < retries; i++) {
      try {
        const out = adbShell('uiautomator dump');
        if (/dumped to/.test(out)) {
          const xml = adbShell(`cat ${DUMP_PATH}`);
          if (xml.includes('<hierarchy')) return xml;
        }
      } catch (_) {}
      // null-root: force a focus event and retry
      this._ensureFocus();
      adbShell('input keyevent KEYCODE_MENU');
      sleep(600);
    }
    throw new Error('phone.see: could not get a UI dump (no focused window?)');
  }

  // ---- the optic nerve: returns MEANING, prints minified, stays chainable
  see({ coords = false, raw = false } = {}) {
    const xml = this._dump();
    this._els = parseScreen(xml);
    this._app = foregroundApp();

    if (raw) { console.log(xml); return this; }

    const tap = [], type = [], read = [];
    let scroll = false;
    for (const e of this._els) {
      if (e.scrollable) scroll = true;
      if (e.editable) { if (e.label || true) type.push(coordize(e, coords)); continue; }
      if (e.clickable && e.label) { tap.push(coordize(e, coords)); continue; }
      if (e.label) read.push(e.label);
    }
    const view = {
      app: shortApp(this._app.pkg),
      tap: dedupe(tap),
      type: dedupe(type),
      read: dedupe(read).slice(0, 12), // cap the non-interactive text noise
      scroll,
    };
    console.log(JSON.stringify(view));
    return this;
  }

  // ---- act by NAME; tool resolves to coords --------------------------------
  _find(name) {
    if (!this._els.length) this._silentSee();
    const n = name.toLowerCase();
    // exact label, then contains
    return (
      this._els.find((e) => e.label.toLowerCase() === n) ||
      this._els.find((e) => e.label.toLowerCase().includes(n))
    );
  }
  _silentSee() {
    const xml = this._dump();
    this._els = parseScreen(xml);
    this._app = foregroundApp();
  }

  tap(name) {
    const e = this._find(name);
    if (!e) { console.log(JSON.stringify({ error: `no element matching "${name}"` })); return this; }
    adbShell(`input tap ${e.bounds.cx} ${e.bounds.cy}`);
    sleep(900);
    this._els = []; // screen likely changed; force re-see on next find
    return this;
  }

  // `input text` is ASYNC on the device — adb returns before the keystrokes land.
  // Firing tap→type→type back-to-back races: chars interleave into the wrong/old
  // field (scar 2026-05-30: "Andy"→"riCuf"). So we type, then SETTLE by polling
  // until the device stops changing, rather than guessing a fixed sleep. For
  // structured data (contacts, etc.) prefer intent()/addContact() over typing.
  type(text) {
    const esc = String(text).replace(/(["'\\ ])/g, '\\$1').replace(/ /g, '%s');
    adbShell(`input text "${esc}"`);
    this._settle();
    return this;
  }

  // wait until the device's IME/input has quiesced: poll a cheap signal until it
  // stops moving (or a cap). Beats a blind sleep — fast when idle, patient when busy.
  _settle(maxMs = 2500) {
    let last = '', stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      sleep(120);
      let now = '';
      try { now = adbShell('dumpsys input_method | grep -E "mServedView|mInputShown" || true'); } catch (_) {}
      if (now === last) { if (++stable >= 2) break; } else { stable = 0; last = now; }
    }
    return this;
  }

  key(name) {
    const code = name.startsWith('KEYCODE_') ? name : 'KEYCODE_' + name.toUpperCase();
    adbShell(`input keyevent ${code}`);
    sleep(500);
    this._els = [];
    return this;
  }

  back() { return this.key('BACK'); }
  home() { return this.key('HOME'); }

  scroll(dir = 'down') {
    const d = { down: '540 1600 540 600', up: '540 600 540 1600',
                left: '900 1200 200 1200', right: '200 1200 900 1200' }[dir];
    adbShell(`input swipe ${d} 300`);
    sleep(700);
    this._els = [];
    return this;
  }
  nextPage() { return this.scroll('down'); }

  open(app) {
    // try launcher by name from home; fall back to monkey by guessed pkg
    this.home(); sleep(600); this._silentSee();
    const e = this._find(app);
    if (e) { adbShell(`input tap ${e.bounds.cx} ${e.bounds.cy}`); sleep(1500); this._els = []; return this; }
    // not on first home page — try app drawer swipe up then search
    this.scroll('up'); sleep(600); this._silentSee();
    const e2 = this._find(app);
    if (e2) { adbShell(`input tap ${e2.bounds.cx} ${e2.bounds.cy}`); sleep(1500); this._els = []; return this; }
    console.log(JSON.stringify({ error: `couldn't find app "${app}" on home/drawer` }));
    return this;
  }

  // notifications: the phone's nervous signals (cheap, no screenshot)
  notifications() {
    const out = adbShell('dumpsys notification --noredact');
    const lines = out.split('\n');
    const notes = [];
    let cur = null;
    for (const ln of lines) {
      let m;
      if ((m = ln.match(/pkg=([^\s]+)/))) { if (cur) notes.push(cur); cur = { pkg: shortApp(m[1]) }; }
      if (cur && (m = ln.match(/android\.title=String \(([^)]*)\)/))) cur.title = m[1];
      if (cur && (m = ln.match(/android\.text=String \(([^)]*)\)/))) cur.text = (m[1] || '').slice(0, 80);
    }
    if (cur) notes.push(cur);
    const slim = notes.filter((n) => n.title || n.text);
    console.log(JSON.stringify(slim));
    return this;
  }

  // fire an intent — prefer this over UI mazes when an app exposes one.
  // e.g. intent('android.intent.action.INSERT', '-t vnd.android.cursor.dir/contact')
  intent(action, extra = '') {
    adbShell(`am start -a ${action} ${extra}`);
    sleep(1500);
    this._els = [];
    return this;
  }

  // robust multi-field form fill: tap → type → hide-IME → re-settle per field.
  // pass {labelOrHint: value}. matches an EditText by its hint/text, taps its
  // SETTLED center (keyboard hidden), types, hides keyboard, moves on. This is
  // the scar-hardened path; the soft keyboard shifts layout, so we re-see between
  // fields instead of trusting stale coordinates.
  fill(fields) {
    for (const [name, value] of Object.entries(fields)) {
      this.key('ESCAPE');            // ensure keyboard down before reading layout
      this._silentSee();
      const e = this._els.find(
        (x) => x.editable &&
          ((x.label || '').toLowerCase().includes(name.toLowerCase())));
      if (!e) { console.log(JSON.stringify({ error: `no field matching "${name}"` })); continue; }
      adbShell(`input tap ${e.bounds.cx} ${e.bounds.cy}`);
      sleep(700);
      this.type(value);
      this.key('ESCAPE');
      sleep(400);
    }
    return this;
  }

  // write a contact straight to the provider — NO typing, NO drift. The lesson
  // of 2026-05-30: when an app fights the glass, go through the OS.
  addContact({ first = '', last = '', phone = '' }) {
    const full = [first, last].filter(Boolean).join(' ');
    adbShell('content insert --uri content://com.android.contacts/raw_contacts ' +
      '--bind account_name:s:null --bind account_type:s:null');
    const ids = adbShell('content query --uri content://com.android.contacts/raw_contacts --projection _id')
      .match(/_id=(\d+)/g) || [];
    const rid = ids.map((s) => +s.split('=')[1]).sort((a, b) => a - b).pop();
    if (full) adbShell('content insert --uri content://com.android.contacts/data ' +
      `--bind raw_contact_id:i:${rid} ` +
      '--bind "mimetype:s:vnd.android.cursor.item/name" ' +
      `--bind "data1:s:${full}" --bind "data2:s:${first}" --bind "data3:s:${last}"`);
    if (phone) adbShell('content insert --uri content://com.android.contacts/data ' +
      `--bind raw_contact_id:i:${rid} ` +
      '--bind "mimetype:s:vnd.android.cursor.item/phone_v2" ' +
      `--bind "data1:s:${phone}" --bind "data2:i:2"`);
    console.log(JSON.stringify({ added: { name: full, phone }, raw_contact_id: rid }));
    return this;
  }

  // read contacts straight from the provider — no UI, no scrolling, no screenshot.
  contacts(filter = '') {
    const out = adbShell('content query --uri content://com.android.contacts/data/phones ' +
      '--projection display_name:data1');
    const rows = [];
    for (const ln of out.split('\n')) {
      const n = (ln.match(/display_name=([^,]*)/) || [])[1];
      const p = (ln.match(/data1=(.*)$/) || [])[1];
      if (n && p) rows.push({ name: n.trim(), phone: p.trim() });
    }
    const f = filter.toLowerCase();
    const slim = f ? rows.filter((r) => r.name.toLowerCase().includes(f) || r.phone.includes(filter)) : rows;
    console.log(JSON.stringify(slim));
    return this;
  }

  // explicit fallback only — low-res screenshot when XML is blind
  shot(file = '/tmp/phone.png') {
    adb(`exec-out screencap -p > ${file}`);
    console.log(JSON.stringify({ shot: file }));
    return this;
  }
}

// ---- helpers -------------------------------------------------------------
function coordize(e, withCoords) {
  return withCoords ? { l: e.label || `(${e.cls})`, xy: [e.bounds.cx, e.bounds.cy] }
                    : (e.label || `(${e.cls})`);
}
function dedupe(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = JSON.stringify(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
function shortApp(pkg) {
  if (!pkg) return '?';
  const map = {
    'com.google.android.apps.nexuslauncher': 'home',
    'com.android.settings': 'settings',
    'com.android.chrome': 'chrome',
    'com.google.android.gm': 'gmail',
    'com.whatsapp': 'whatsapp',
    'com.google.android.apps.messaging': 'messages',
    'com.android.dialer': 'phone-dialer',
  };
  return map[pkg] || pkg.split('.').pop();
}

// ---- CLI: `node phone.js see` or chained: `open Settings : tap Apps : see`
const phone = new Phone();
module.exports = phone;

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (!argv.length) { phone.see(); process.exit(0); }
  // split on ":" into chained calls
  const groups = [];
  let g = [];
  for (const a of argv) { if (a === ':') { groups.push(g); g = []; } else g.push(a); }
  if (g.length) groups.push(g);
  for (const [verb, ...args] of groups) {
    if (typeof phone[verb] === 'function') phone[verb](...args);
    else console.log(JSON.stringify({ error: `unknown verb "${verb}"` }));
  }
}
