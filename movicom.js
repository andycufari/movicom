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
    this._page = 1;        // current action page (for the paged AIX menu)
    this._pageSig = '';    // screen signature — resets paging when the screen changes
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

  // ---- the optic nerve: build the MEANING view (dump → parse → minify).
  // _view() RETURNS the object (no printing) so every ACTION can fold a fresh
  // screen read into its own result — act→see in one round-trip, the #1 token win
  // (Andy's idea, 2026-05-31): the model never needs a separate `see` to learn
  // what its tap did. `readCap` lets content-heavy screens (a news article) widen
  // the text beyond the default 12-item noise cap.
  // The text IS the UI. We don't dump the raw screen — we present a MENU for the
  // model (Andy's framing, 2026-05-31): like an IVR phone menu, name WHERE it is,
  // list the ACTIONS it can tap and the FIELDS it can fill, say whether it can
  // scroll, surface visible TEXT, and give a one-line HINT of how to act. The
  // model PICKS from a menu instead of analyzing pixels/arrays — the real win for
  // small LLMs. Neutral: we present faithfully, we don't guess intent.
  // The AII/AItext IS the interface (Andy's framing 2026-06-01: AII = AI Interface,
  // AIX = AI Experience). We don't dump the raw screen — we design the experience
  // for a model: name WHERE it is, present the ACTIONS it can tap as a PAGED menu
  // (cheap by default, more on demand), the FIELDS it can fill, the visible TEXT,
  // and a one-line HINT of how to act. The model browses a menu like a human
  // browses a UI — it doesn't analyze pixels. Neutral: we present, we don't guess.
  //
  // Pagination (scar 2026-06-01: a Google results page had 115 actions = ~1200
  // tok of mostly junk). We filter NOISE, then show one PAGE of ~12 actions and
  // report page N/M + how to get the next page (`ui more`). The FULL action list
  // is cached so `ui tap "<label>"` still resolves an item on ANY page, not just
  // the visible one. `page` arg jumps to a specific page; null = current.
  _view({ coords = false, readCap = 12, pageSize = 12, page = null } = {}) {
    const xml = this._dump();
    this._els = parseScreen(xml);
    this._app = foregroundApp();

    const rawActions = [], fields = [], text = [];
    let scroll = false;
    for (const e of this._els) {
      if (e.scrollable) scroll = true;
      if (e.editable) {
        if (e.label) fields.push(coordize(e, coords));
        continue;
      }
      if (e.clickable && e.label) { rawActions.push(coordize(e, coords)); continue; }
      if (e.label) text.push(e.label);
    }

    const allActions = dedupe(rawActions).filter(a => !isNoise(labelOf(a)));
    const F = dedupe(fields);
    const T = dedupe(text).filter(t => !isNoise(t)).slice(0, readCap);

    // page math. `page` resets when the screen identity changes (so `ui more` on a
    // new screen starts at page 1, not wherever we left off elsewhere).
    const sig = this._app.pkg + ':' + allActions.length + ':' + (allActions[0] ? labelOf(allActions[0]) : '');
    if (sig !== this._pageSig) { this._page = 1; this._pageSig = sig; }
    const totalPages = Math.max(1, Math.ceil(allActions.length / pageSize));
    if (page != null) this._page = Math.min(Math.max(1, page), totalPages);
    const p = Math.min(this._page, totalPages);
    const A = allActions.slice((p - 1) * pageSize, p * pageSize);

    const parts = [];
    if (F.length) parts.push(`fill a field: ui fill '{"${labelOf(F[0])}":"..."}'`);
    if (A.length) parts.push(`tap an action: ui tap "${labelOf(A[0])}"`);
    if (totalPages > 1 && p < totalPages) parts.push('more actions: ui more');
    if (scroll) parts.push('more content below: ui scroll down');
    const hint = parts.join('  |  ') || 'nothing actionable — try ui scroll down, or ui back';

    const view = {
      where: shortApp(this._app.pkg),
      actions: A,
      fields: F,
      text: T,
      can_scroll: scroll,
      hint,
    };
    if (totalPages > 1) view.page = `${p}/${totalPages}`; // only when there's >1 page
    return view;
  }

  see({ coords = false, raw = false, readCap = 12, page = null } = {}) {
    if (raw) { const xml = this._dump(); console.log(xml); return this; }
    console.log(JSON.stringify(this._view({ coords, readCap, page })));
    return this;
  }

  // advance to the next page of actions on the CURRENT screen (the AIX "show more"
  // — lazy-load the rest of the menu only when the model needs it). No re-tap, no
  // scroll; same screen, next slice. Wraps to page 1 after the last page.
  more() {
    this._page = (this._page || 1) + 1;
    console.log(JSON.stringify(this._view({ page: this._page })));
    return this;
  }

  // ---- act by NAME; tool resolves to coords --------------------------------
  // ALWAYS resolve against a FRESH dump. Coordinates move out from under us when
  // the soft keyboard opens/closes (Gmail's Subject shifted ~436px between dumps,
  // 2026-05-31) — resolving against cached `_els` taps where the element USED to
  // be (scar: "tap Subject" opened the camera). Fresh dump every time is the fix.
  _find(name) {
    this._silentSee();
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

  // Every action returns {<what it did>, screen:<fresh view>} — act→see folded
  // into ONE call so the model sees the result of its action without a separate
  // `see` (halves the round-trips; the biggest token + reasoning win).
  _act(result) {
    sleep(300);                 // small settle so the new screen has rendered
    this._els = [];
    console.log(JSON.stringify({ ...result, screen: this._view() }));
    return this;
  }

  tap(name) {
    const e = this._find(name); // fresh dump inside _find
    if (!e) { console.log(JSON.stringify({ error: `no element matching "${name}"`, screen: this._view() })); return this; }
    adbShell(`input tap ${e.bounds.cx} ${e.bounds.cy}`);
    sleep(900);
    return this._act({ tapped: name });
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
    return this._act({ typed: text });
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
    return this._act({ key: name });
  }

  back() { return this.key('BACK'); }
  home() { return this.key('HOME'); }

  // scroll folds the post-scroll screen into its result with a WIDER read cap —
  // reading long content (a news article) is scroll→see→scroll→see, and the model
  // wants the freshly-revealed TEXT each time, not just the chrome.
  scroll(dir = 'down') {
    const d = { down: '540 1600 540 600', up: '540 600 540 1600',
                left: '900 1200 200 1200', right: '200 1200 900 1200' }[dir];
    adbShell(`input swipe ${d} 300`);
    sleep(700);
    this._els = [];
    console.log(JSON.stringify({ scrolled: dir, screen: this._view({ readCap: 40 }) }));
    return this;
  }
  nextPage() { return this.scroll('down'); }

  // Open an app by PACKAGE via `monkey` — deterministic, no fragile gestures, never
  // depends on an icon being on a visible page. Also the reliable way to RESET
  // position when lost. (scar 2026-05-30: gesture+icon-tap got lost in the shade.)
  open(app) {
    // "home" has no launchable activity — it's the HOME key.
    if (/^home$/i.test(String(app).trim())) {
      this.home(); sleep(800);
      console.log(JSON.stringify({ opened: 'home' }));
      return this;
    }
    const pkg = this._resolvePackage(app);
    if (!pkg) {
      console.log(JSON.stringify({ error: `no installed app matches "${app}"`, hint: 'try `movicom app list`' }));
      return this;
    }
    try {
      const r = adbShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
      sleep(1600); this._els = [];
      if (/No activities found|aborted/i.test(r)) {
        console.log(JSON.stringify({ error: `"${app}" (${pkg}) has no launchable activity` }));
      } else {
        console.log(JSON.stringify({ opened: app, pkg }));
      }
    } catch (e) {
      console.log(JSON.stringify({ error: `failed to open "${app}": ${e.message || e}` }));
    }
    return this;
  }

  // friendly name -> package: alias table first, then search installed packages.
  _resolvePackage(app) {
    const n = String(app).toLowerCase().trim();
    const alias = {
      settings: 'com.android.settings',
      chrome: 'com.android.chrome', browser: 'com.android.chrome',
      gmail: 'com.google.android.gm', mail: 'com.google.android.gm',
      whatsapp: 'com.whatsapp',
      messages: 'com.google.android.apps.messaging', sms: 'com.google.android.apps.messaging',
      phone: 'com.google.android.dialer', dialer: 'com.google.android.dialer',
      contacts: 'com.google.android.contacts',
      photos: 'com.google.android.apps.photos',
      youtube: 'com.google.android.youtube',
      maps: 'com.google.android.apps.maps',
      calendar: 'com.google.android.calendar',
      clock: 'com.google.android.deskclock', alarm: 'com.google.android.deskclock',
      camera: 'com.android.camera2',
      'play store': 'com.android.vending', play: 'com.android.vending', store: 'com.android.vending',
    };
    if (alias[n]) return alias[n];
    try {
      const pkgs = adbShell('pm list packages').split('\n')
        .map((l) => l.replace('package:', '').trim()).filter(Boolean);
      const tok = n.replace(/\s+/g, '');
      return pkgs.find((p) => p.split('.').pop().toLowerCase() === tok)
        || pkgs.find((p) => p.toLowerCase().includes(tok))
        || null;
    } catch (_) { return null; }
  }

  // list launchable apps (name + package), parsed from the launcher resolver.
  appList() {
    let out = '';
    try {
      out = adbShell('cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER');
    } catch (_) {}
    const pkgs = [...new Set(
      (out.match(/^[\s]*([a-z][a-z0-9_.]+)\/[A-Za-z0-9_.$]+/gm) || [])
        .map((l) => l.trim().split('/')[0])
        .filter((p) => p.split('.').length >= 2)
    )];
    const apps = pkgs.map((p) => ({ name: shortApp(p), pkg: p }))
                     .sort((a, b) => a.name.localeCompare(b.name));
    console.log(JSON.stringify(apps));
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

  // robust multi-field form fill (scars 2026-05-31, Gmail compose). Pass
  // {labelOrHint: value}. Per field: resolve from a FRESH dump (keyboard shifts
  // the layout ~436px), tap to FOCUS it (type() types into whatever is focused —
  // skip the focus and every field piles into the previous one, e.g. recipient+
  // subject+body all landing in "To"), then type. We do NOT send ESCAPE between
  // fields: in some apps (Gmail) it dismisses the whole compose.
  fill(fields) {
    const filled = [];
    for (const [name, value] of Object.entries(fields)) {
      const e = this._findField(name); // fresh dump inside
      if (!e) { filled.push({ field: name, error: 'not found' }); continue; }
      adbShell(`input tap ${e.bounds.cx} ${e.bounds.cy}`); // FOCUS the field
      sleep(500);
      adbShell(`input text "${String(value).replace(/(["'\\ ])/g, '\\$1').replace(/ /g, '%s')}"`);
      this._settle();
      this._els = [];                                       // layout shifted
      filled.push({ field: name, value });
    }
    console.log(JSON.stringify({ filled, screen: this._view() }));
    return this;
  }

  // like _find but prefers EditText fields — a form field's "label" is often its
  // hint text living IN the EditText (e.g. text="Subject"). Fresh dump each call.
  _findField(name) {
    this._silentSee();
    const n = name.toLowerCase();
    return (
      this._els.find((e) => e.editable && e.label.toLowerCase() === n) ||
      this._els.find((e) => e.editable && e.label.toLowerCase().includes(n)) ||
      this._els.find((e) => e.label.toLowerCase() === n) ||
      this._els.find((e) => e.label.toLowerCase().includes(n))
    );
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

  // dial a number. GATED: dialing is an outbound action — it must pass the
  // approval brake before it can actually place a call. For now it only composes
  // the dialer (ACTION_DIAL, does NOT call) and returns gated:true so the CLI
  // surfaces that the real CALL path is not wired yet. ("handle later with a hack
  // in between" — Andy, 2026-05-30.)
  call(number) {
    if (!number) { console.log(JSON.stringify({ error: 'call: no number' })); return this; }
    // ACTION_DIAL only fills the dialer; it never auto-places the call.
    adbShell(`am start -a android.intent.action.DIAL -d tel:${String(number).replace(/[^\d+]/g, '')}`);
    sleep(1200);
    this._els = [];
    console.log(JSON.stringify({ gated: true, action: 'composed-dialer', number,
      note: 'real CALL is gated behind the approval brake — not placed' }));
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

  // take a real PHOTO with the camera — one call instead of the open→permission→
  // shutter→find-file dance. Opens the camera, taps the Shutter, then reads the
  // newest image from the MediaStore (source of truth — the file may land in
  // DCIM/ OR Pictures/ depending on the device, so we don't guess a folder).
  // opts.pull: also copy the photo to the computer so a multimodal brain can SEE
  // it. Returns { photo: <device path>, pulled?: <local path> }.
  photo({ pull = false, dir = '/tmp' } = {}) {
    // Track the newest image by the MAX _id (monotonic, indexed instantly) rather
    // than date_added (second-granularity + lags the file write). We do NOT use a
    // `--sort` flag: its quotes get mangled when the command is passed as one
    // string through adbShell→execSync (scar 2026-06-01: `content` printed its
    // usage banner). Instead we scan all rows and take the highest _id ourselves.
    const newest = () => {
      try {
        const out = adbShell("content query --uri content://media/external/images/media " +
          "--projection _id:_data");
        let best = null;
        for (const ln of out.split('\n')) {
          const m = ln.match(/_id=(\d+),\s*_data=(\S+)/);
          if (m) { const id = parseInt(m[1], 10); if (!best || id > best.id) best = { id, path: m[2].trim() }; }
        }
        return best;
      } catch (_) { return null; }
    };
    const before = newest();
    const beforeId = before ? before.id : -1;
    this.open('camera'); sleep(1500);
    // clear any first-run / permission dialogs by granting the obvious choice
    for (let i = 0; i < 3; i++) {
      this._silentSee();
      const allow = this._els.find((e) => e.clickable &&
        /^(while using the app|allow|next|ok|got it)$/i.test((e.label || '').trim()));
      const shutter = this._els.find((e) => /shutter|capture|take photo/i.test(e.label || ''));
      if (shutter) break;
      if (allow) { adbShell(`input tap ${allow.bounds.cx} ${allow.bounds.cy}`); sleep(1200); }
      else break;
    }
    // press the shutter
    this._silentSee();
    const sh = this._els.find((e) => /shutter|capture|take photo/i.test(e.label || ''));
    if (!sh) { console.log(JSON.stringify({ error: 'no shutter button found', screen: this._view() })); return this; }
    adbShell(`input tap ${sh.bounds.cx} ${sh.bounds.cy}`);
    sleep(2000); // let the capture write to storage

    // poll until a NEW image (higher _id than before) shows up — up to ~10s.
    let after = newest(), tries = 0;
    while (tries++ < 12 && (!after || after.id <= beforeId)) {
      sleep(800); after = newest();
    }
    if (!after || after.id <= beforeId) {
      console.log(JSON.stringify({ error: 'photo not found in MediaStore after capture', lastSeen: after }));
      return this;
    }

    const result = { photo: after.path };
    if (pull) {
      const base = after.path.split('/').pop();
      const local = `${dir}/${base}`;
      try { adb(`pull "${after.path}" "${local}"`); result.pulled = local; }
      catch (e) { result.pullError = String(e.message || e); }
    }
    console.log(JSON.stringify(result));
    return this;
  }
}

// ---- helpers -------------------------------------------------------------
function coordize(e, withCoords) {
  return withCoords ? { l: e.label || `(${e.cls})`, xy: [e.bounds.cx, e.bounds.cy] }
                    : (e.label || `(${e.cls})`);
}
// the label string out of either shape (plain string, or {l, xy} when coords on)
function labelOf(a) { return typeof a === 'string' ? a : (a && a.l) || ''; }

// Is this label noise an agent never needs? Raw URLs / tracking params / encoded
// query strings, and universal nav/footer boilerplate. Conservative on purpose —
// we only drop things that are clearly not a meaningful choice. (scar 2026-06-01)
const NOISE_RE = /^(https?:\/\/|www\.)|[?&](sa|ved|ei|oq|gs_|sei|ec|client|sourceid)=|%[0-9A-Fa-f]{2}.*%[0-9A-Fa-f]{2}/;
const NOISE_EXACT = new Set([
  'privacidad', 'condiciones', 'privacy', 'terms', 'ayuda', 'help', 'comentario',
  'comentarios', 'feedback', 'acerca de este resultado', 'about this result',
  'menú principal', 'main menu', 'configuración de búsqueda', 'search settings',
  'cómo se utiliza la ubicación', 'connection is secure',
]);
function isNoise(label) {
  const s = String(label || '').trim();
  if (!s) return true;
  if (s.length > 120) return true;                 // a paragraph isn't a tap target
  if (NOISE_RE.test(s)) return true;
  if (NOISE_EXACT.has(s.toLowerCase())) return true;
  return false;
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

const phone = new Phone();
module.exports = phone;

// ---- CLI grammar: `movicom <noun> <verb> [json-or-plain-args]` ------------
// Convention (locked with Andy 2026-05-30):
//   * writes take a JSON object:   contacts add '{"first":"Ada","phone":"+54..."}'
//   * reads / single args stay plain:  contacts find Andy   |   call dial 54911...
//   * EVERY command prints exactly one JSON value to stdout (agent-first).
// The router maps nouns to the engine methods that already exist + are tested.
function out(v) { console.log(JSON.stringify(v)); }
function parseArg(a) { // JSON object if it looks like one, else the raw string
  if (a == null) return undefined;
  const s = String(a).trim();
  if (s.startsWith('{') || s.startsWith('[')) { try { return JSON.parse(s); } catch (_) {} }
  return s;
}

const ROUTER = {
  // ---- system lane: talk to the OS, not the glass ----
  contacts: {
    list: (a) => phone.contacts(typeof a === 'string' ? a : ''),
    find: (a) => phone.contacts(typeof a === 'string' ? a : (a && a.q) || ''),
    add:  (a) => phone.addContact(a || {}),
    // del intentionally omitted from v0.1 router until guarded (see brakes)
  },
  sms: {
    list: (a) => phone.smsList ? phone.smsList(a) : out({ error: 'sms list: not yet implemented' }),
    send: (a) => out({ error: 'sms send is gated — wire the approval brake first', got: a }),
    read: (a) => phone.smsRead ? phone.smsRead(a) : out({ error: 'sms read: not yet implemented' }),
  },
  call: {
    dial: (a) => phone.call(typeof a === 'string' ? a : (a && a.number)), // gated stub
    log:  () => phone.callLog ? phone.callLog() : out({ error: 'call log: not yet implemented' }),
  },
  notif: {
    list: () => phone.notifications(),
  },
  // camera: take a real photo in one call. `camera shot` (or `camera photo`).
  // pass {"pull":true} to also copy it to the computer for a multimodal brain.
  camera: {
    shot:  (a) => phone.photo(typeof a === 'object' ? a : {}),
    photo: (a) => phone.photo(typeof a === 'object' ? a : {}),
  },
  app: {
    list: () => phone.appList(),
    open: (a) => phone.open(typeof a === 'string' ? a : (a && a.name)),
    intent: (a) => phone.intent((a && a.action) || a, (a && a.extra) || ''),
  },
  // ---- UI lane: drive the glass (third-party apps with no back door) ----
  ui: {
    see:    (a) => phone.see(typeof a === 'object' ? a : (typeof a === 'string' && /^\d+$/.test(a) ? { page: parseInt(a, 10) } : {})),
    more:   () => phone.more(),
    tap:    (a) => phone.tap(typeof a === 'string' ? a : (a && a.label)),
    type:   (a) => phone.type(typeof a === 'string' ? a : (a && a.text)),
    key:    (a) => phone.key(typeof a === 'string' ? a : (a && a.key)),
    scroll: (a) => phone.scroll(typeof a === 'string' ? a : (a && a.dir) || 'down'),
    fill:   (a) => phone.fill(a || {}),
    shot:   (a) => phone.shot(typeof a === 'string' ? a : undefined),
    back:   () => phone.back(),
    home:   () => phone.home(),
  },
  // ---- workflows: named, saved, replayable command sequences ----
  // A workflow is an array of command strings stored in ~/.movicom/workflows.json,
  // shareable across agents. Turns movicom from a remote control into a programmable body.
  workflow: {
    list: () => out(Object.entries(loadWorkflows()).map(([name, steps]) => ({ name, steps: steps.length }))),
    show: (a) => { const w = loadWorkflows(); const n = typeof a === 'string' ? a : a && a.name; out(w[n] ? { name: n, steps: w[n] } : { error: `no workflow "${n}"` }); },
    add: (a) => {
      let name, steps;
      if (a && typeof a === 'object' && !Array.isArray(a)) { name = a.name; steps = a.steps; }
      else if (typeof a === 'string') {
        const sp = a.indexOf(' ');
        name = sp === -1 ? a : a.slice(0, sp);
        const rest = sp === -1 ? '' : a.slice(sp + 1).trim();
        try { steps = JSON.parse(rest); } catch (_) { steps = rest ? rest.split(';').map((s) => s.trim()).filter(Boolean) : []; }
      }
      if (!name || !Array.isArray(steps) || !steps.length) {
        return out({ error: 'usage: workflow add <name> \'["cmd","cmd"]\'  (or json {name,steps})' });
      }
      const w = loadWorkflows(); w[name] = steps; saveWorkflows(w);
      out({ saved: name, steps });
    },
    del: (a) => { const n = typeof a === 'string' ? a : a && a.name; const w = loadWorkflows(); if (!w[n]) return out({ error: `no workflow "${n}"` }); delete w[n]; saveWorkflows(w); out({ deleted: n }); },
    run: (a) => {
      const n = typeof a === 'string' ? a : a && a.name;
      const w = loadWorkflows();
      if (!w[n]) return out({ error: `no workflow "${n}"`, available: Object.keys(w) });
      const results = [];
      for (const step of w[n]) {
        const captured = capture(() => dispatch(tokenize(step)));
        results.push({ step, result: tryParse(captured) });
      }
      out({ workflow: n, results });
    },
  },
  // ---- meta ----
  devices: () => { try { out({ devices: sh(`${ADB} devices`).split('\n').slice(1).map((l) => l.split('\t')[0]).filter(Boolean) }); } catch (e) { out({ error: String(e.message || e) }); } },
  doctor:  () => {
    const r = {};
    try { r.adb = (sh(`${ADB} version`).match(/version\s+([\d.]+)/i) || [])[1]; } catch (_) { r.adb = null; }
    r.adbValidated = ADB_VALIDATED;
    try { r.device = sh(`${ADB} devices`).split('\n')[1]?.split('\t')[0] || null; } catch (_) { r.device = null; }
    try { r.focus = (adbShell('dumpsys window').match(/mCurrentFocus=Window\{[^ ]+ \w+ ([^}]+)\}/) || [])[1] || null; } catch (_) { r.focus = null; }
    try { r.softKeyboard = adbShell('ime list -s').trim() ? 'on' : 'off'; } catch (_) {}
    out(r);
  },
  // kbd off|on — RECOMMENDED (not required) accuracy setting. The soft keyboard is
  // movicom's #1 enemy: opening it shifts the layout ~436px (stale-coord taps),
  // collapses fields out of the view tree, and triggers autocomplete dropdowns
  // that eat the layout. `input text` injects BELOW the IME, so typing still works
  // with the soft keyboard DISABLED — but the layout stays rock-still, so multi-
  // field forms (email, etc.) fill reliably even on a small model. Turn it back on
  // when a human needs the phone. (scar+fix 2026-05-31, Andy's idea.)
  kbd: (a) => {
    const want = (typeof a === 'string' ? a : (a && a.state) || '').toLowerCase();
    try {
      const imes = adbShell('ime list -s').split('\n').map(s => s.trim()).filter(Boolean);
      if (want === 'off') {
        for (const id of imes) { try { adbShell(`ime disable ${id}`); } catch (_) {} }
        out({ softKeyboard: 'off', note: 'layout will stay stable; `input text` still types. Re-enable with `movicom kbd on`.' });
      } else if (want === 'on') {
        // re-enable the standard Latin/Gboard IME and make it active
        const latin = 'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME';
        try { adbShell(`ime enable ${latin}`); adbShell(`ime set ${latin}`); } catch (_) {}
        out({ softKeyboard: 'on', restored: latin });
      } else {
        out({ error: 'usage: movicom kbd off | movicom kbd on', current: imes.length ? 'on' : 'off' });
      }
    } catch (e) { out({ error: String(e.message || e) }); }
  },
};

// ---- workflow storage + helpers ------------------------------------------
const _os = require('os');
const _path = require('path');
const _fs = require('fs');
const WF_DIR = _path.join(_os.homedir(), '.movicom');
const WF_FILE = _path.join(WF_DIR, 'workflows.json');
function loadWorkflows() {
  try { return JSON.parse(_fs.readFileSync(WF_FILE, 'utf8')); } catch (_) { return {}; }
}
function saveWorkflows(w) {
  try { _fs.mkdirSync(WF_DIR, { recursive: true }); _fs.writeFileSync(WF_FILE, JSON.stringify(w, null, 2)); } catch (_) {}
}
// split a command string into argv, respecting quotes and JSON braces so
// `app open Play Store`, `ui tap "No thanks"`, `contacts add {"x":1}` all work.
function tokenize(str) {
  const toks = []; let i = 0; const s = String(str).trim();
  while (i < s.length) {
    while (s[i] === ' ') i++;
    if (i >= s.length) break;
    let tok = '';
    if (s[i] === '"' || s[i] === "'") { const q = s[i++]; while (i < s.length && s[i] !== q) tok += s[i++]; i++; }
    else if (s[i] === '{' || s[i] === '[') { tok = s.slice(i); i = s.length; }
    else { while (i < s.length && s[i] !== ' ') tok += s[i++]; }
    toks.push(tok);
  }
  return toks;
}
function capture(fn) {
  const orig = console.log; let buf = '';
  console.log = (...a) => { buf += a.join(' ') + '\n'; };
  try { fn(); } finally { console.log = orig; }
  return buf.trim();
}
function tryParse(s) { try { return JSON.parse(s); } catch (_) { return s; } }

function dispatch(argv) {
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help') {
    return out({
      usage: 'movicom <noun> <verb> [json-or-args]',
      system: ['contacts list|find|add', 'sms list|send|read', 'call dial|log', 'notif list', 'app list|open|intent'],
      ui: ['ui see|tap|type|key|scroll|fill|shot|back|home'],
      workflow: ['workflow list|show|add|run|del — saved replayable command sequences'],
      meta: ['devices', 'doctor'],
      notes: 'writes take JSON; reads take plain args; output is always JSON. See AGENTS.md.',
      examples: [
        'movicom app open gmail',
        'movicom ui see',
        'movicom contacts add \'{"first":"Ada","phone":"+5491100000000"}\'',
        'movicom workflow add morning \'["app open gmail","ui see","notif list"]\'',
        'movicom workflow run morning',
      ],
    });
  }
  const [noun, verb, ...rest] = argv;
  const node = ROUTER[noun];
  if (!node) return out({ error: `unknown noun "${noun}"`, hint: 'try: movicom help' });
  if (typeof node === 'function') return node(parseArg(verb)); // meta nouns: devices/doctor
  const fn = node[verb];
  if (!fn) return out({ error: `unknown verb "${verb}" for "${noun}"`, available: Object.keys(node) });
  return fn(parseArg(rest.join(' ')));
}

if (require.main === module) {
  try { dispatch(process.argv.slice(2)); }
  catch (e) { out({ error: String(e && e.message || e) }); process.exit(1); }
}
