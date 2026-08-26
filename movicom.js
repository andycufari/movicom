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

// Type text via `adb shell input text` SAFELY. The text crosses two shells (local
// execSync → device sh), so unescaped metacharacters (> < & | ; $ ( ) ` ") break
// it — scar 2026-06-01: a "->" in a WhatsApp message made the device sh try to
// REDIRECT to a file ("Read-only file system"). Also: `input text` uses %s for a
// space, and chokes on non-ASCII (emoji throw a NullPointerException), so we strip
// what it can't send rather than crash the whole message. Returns false if the
// text became empty after stripping (caller can skip the send).
// Type text via `adb shell input text`. HARD TRUTH (verified on Moto G06 /
// Android 15, 2026-06-01): the device's `input text` is effectively ASCII-only —
// ANY non-ASCII char (emoji AND Latin-1 accents like é ñ ü) throws a
// NullPointerException and drops the WHOLE message. So we: (1) transliterate
// common accents to their base letter (qué→que, ñ→n) to stay readable on a LATAM
// phone instead of losing chars; (2) drop anything still non-ASCII (emoji); then
// (3) escape device-shell specials (> < & | ( ) … — scar: a "->" tried to
// REDIRECT to a Read-only file) and map spaces to %s. A true Unicode path
// (base64→clipboard paste, or an ADBKeyboard IME) is a future upgrade.
// Returns false if nothing typeable remained (caller can skip the send).
const ACCENTS = { 'á':'a','à':'a','ä':'a','â':'a','ã':'a','é':'e','è':'e','ë':'e','ê':'e','í':'i','ì':'i','ï':'i','î':'i','ó':'o','ò':'o','ö':'o','ô':'o','õ':'o','ú':'u','ù':'u','ü':'u','û':'u','ñ':'n','ç':'c','¿':'','¡':'','«':'"','»':'"','‘':"'",'’':"'",'“':'"','”':'"','–':'-','—':'-','…':'...' };
function typeText(text) {
  let s = String(text);
  s = s.replace(/[À-ÿ¿¡«»''""–—…]/g, (ch) => {
    const lower = ch.toLowerCase();
    const t = ACCENTS[lower];
    if (t === undefined) return ch;
    return ch === lower ? t : t.toUpperCase();   // preserve case (Ñ→N, ñ→n)
  });
  s = s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ''); // drop anything still non-ASCII (emoji)
  if (!s.trim()) return false;
  const esc = s
    .replace(/(["'\\`$&|;<>()!*?\[\]{}~#])/g, '\\$1')
    .replace(/ /g, '%s');
  adbShell(`input text "${esc}"`);
  return true;
}

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

    const txt = (a['text'] || '').trim();
    const desc = (a['content-desc'] || '').trim();
    const label = decodeEntities(txt || desc);
    const cls = (a['class'] || '').split('.').pop();
    const scrollable = a['scrollable'] === 'true';
    const isPassword = a['password'] === 'true';
    const editable = cls === 'EditText' || isPassword;
    // a field's "hint" — its content-desc when it has no typed text — tells inputs
    // apart in a form (e.g. "Username", "Password"). Used to label `type` actions.
    const hint = desc && !txt ? decodeEntities(desc) : '';
    // a control = a button/icon whose meaning is its content-desc (Send, Attach,
    // Back…), not a text blob. These are the things a user ACTS with; rank them
    // above content that merely happens to be clickable (chat bubbles, list rows).
    const isControl = (!txt && !!desc) || cls === 'ImageButton' || cls === 'Button' || cls === 'ImageView';

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
          scrollable, editable, isControl,
          password: isPassword, hint,
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

    const controls = [], rowActions = [], fields = [], text = [];
    let scroll = false;
    for (const e of this._els) {
      if (e.scrollable) scroll = true;
      if (e.editable) {
        if (e.label) fields.push(coordize(e, coords));
        continue;
      }
      if (e.clickable && e.label) {
        // A long clickable text blob is CONTENT (a chat bubble, a list row preview),
        // not a control — surface it as text AND keep it tappable, but rank it after
        // the real controls so Send/Attach/etc. never get paginated off page 1.
        const longBlob = !e.isControl && e.label.length > 40;
        if (longBlob) text.push(e.label);
        (e.isControl ? controls : rowActions).push(coordize(e, coords));
        continue;
      }
      if (e.label) text.push(e.label);
    }

    // controls first (Send, Attach, Back…), then row/content actions. So the bottom
    // input-bar buttons land on page 1 where a model expects to find "how do I send?"
    const allActions = dedupe([...controls, ...rowActions]).filter(a => !isNoise(labelOf(a)));
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

  // ============================================================================
  // THE FRAME — the app-agnostic AIX (my interface, designed 2026-06-01).
  //
  // Every action returns ONE frame. A frame separates what to READ from what to
  // DO, and every DO is NUMBERED. The model reads `read`, picks `do N`, and gets
  // the next frame back. It never needs to know an app's labels ("Send" vs
  // "content-desc=Send") — movicom CLASSIFIES the raw tree into a small fixed
  // vocabulary so the SAME gestures drive WhatsApp, Gmail, Settings, anything:
  //
  //   { app, screen, read: [...content...],
  //     do: ["1 type <text>", "2 send", "3 down", "4 back", "5 more (N)", "6 open: …"] }
  //
  // Stable core verbs get low, predictable slots; variable items (list rows,
  // links) get the higher numbers. `do more` expands overflow into a new frame —
  // drilling in is the same gesture as everything else, no special pagination.
  //
  // KIND vocabulary a node is classified into:
  //   input  — an EditText (→ `type`)
  //   submit — a send/submit/post control (→ `send`)
  //   nav    — up/down/back (scroll + system back)
  //   more   — overflow (⋮ / "More options") (→ expands)
  //   open   — anything else actionable (a chat row, a link, a button) (→ tap)
  // Content (non-actionable text, long clickable blobs) goes to `read`.
  // ============================================================================

  // classify last-parsed els into {inputs, submits, opens, overflow, content, scroll}
  _classify() {
    const inputs = [], submits = [], opens = [], overflow = [], content = [];
    let scroll = false;
    // Submit/action controls. Also match the common ES/PT labels (Enviar, Mandar,
    // Publicar…) — WhatsApp's send button is "Enviar" on a Spanish phone, so an
    // English-only list left `do send` blind on non-English devices (it fell back
    // to Enter, which just inserts a newline). Same intents, more locales.
    const SUBMIT_RE = /^(send|enviar|mandar|submit|post|publicar|reply|responder|publish|share|compartir|compartilhar|search|buscar|pesquisar|go|ir|done|listo|hecho|concluir|feito|next|siguiente|proximo|próximo|confirm|confirmar|ok)\b/i;
    const MORE_RE = /^(more options|more|overflow|⋮|options menu|see more)$/i;
    // these are NAV/status/content masquerading as tappable rows — already covered
    // by a core verb (back/home) or they're really read-only chrome (a timestamp,
    // a delivery receipt). Keep them OUT of the numbered `open` list so it stays the
    // things worth opening (chats, links, buttons), not every clickable pixel.
    const NAV_DUP_RE = /^(back|navigate up|home|up)$/i;
    const STATUS_RE = /^(\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?|\d{1,2}:\d{2} ?[ap]m|delivered|read|sent|sending|seen|online|typing\.{0,3}|yesterday|today|\w+ \d{1,2}, \d{4})$/i;
    for (const e of this._els) {
      if (e.scrollable) scroll = true;
      if (e.editable) { inputs.push(e); continue; }
      if (!e.clickable || !e.label) { if (e.label) content.push(e.label); continue; }
      const lab = e.label.trim();
      if (NAV_DUP_RE.test(lab)) continue;                 // duplicate of the back/home verbs
      if (STATUS_RE.test(lab)) { content.push(lab); continue; } // timestamp / receipt = read, not an action
      if (SUBMIT_RE.test(lab)) { submits.push(e); continue; }
      if (MORE_RE.test(lab)) { overflow.push(e); continue; }
      // A clickable TEXTVIEW is almost always CONTENT that merely happens to be
      // tappable — a chat-message bubble, a list-row title, a caption (scar
      // 2026-06-02: IG DM messages like "our best video so far btw" landed in the
      // `do` list, never in `read`). Surface as content; keep tappable too (it's
      // still reachable as an open if the model wants to act on that message). A
      // long blob is content regardless of class. Real controls (buttons/icons)
      // and short non-text widgets stay actions.
      const isTextual = e.cls === 'TextView' || e.cls === 'EditText';
      if ((isTextual && !e.isControl) || (!e.isControl && lab.length > 40)) {
        content.push(lab); opens.push(e); continue;
      }
      opens.push(e);
    }
    return { inputs, submits, opens, overflow, content, scroll };
  }

  // build the frame object (no printing). `expand` = page deeper into the opens.
  _frame({ readCap = 10, openCap = 8, expand = false } = {}) {
    const xml = this._dump();
    this._els = parseScreen(xml);
    this._app = foregroundApp();
    const c = this._classify();

    // reset the opens page when the SCREEN changes, so `more` on a new screen starts
    // at page 1 (a fresh `frame`/non-expand read also resets it, below).
    const fsig = this._app.pkg + ':' + this._els.length;
    if (fsig !== this._frameSig) { this._openPage = 1; this._frameSig = fsig; }

    // Assemble the DO list in STABLE order. Each entry: {n, verb, label, kind, el}.
    // _do is the resolver `do N` uses; the strings in frame.do are what the model sees.
    const doList = [];
    let n = 0;
    const add = (verb, label, kind, el) => { n++; doList.push({ n, verb, label, kind, el }); };

    // ONE type action PER input field — so a multi-field form (login: username +
    // password) is fully driveable by frame alone (scar 2026-06-02: `do type` only
    // ever hit input #1, so the password needed a raw adb fallback). Each carries
    // its hint/value so the model can tell the fields apart. First input keeps the
    // bare verb `type`; the rest get `type2`, `type3`, … (and their own numbers).
    const inputs = c.inputs;
    inputs.forEach((inp, i) => {
      const cur = (inp.label && inp.label !== inp.cls) ? inp.label : '';
      const hint = inp.password ? 'password' : (cur ? `now: "${cur.slice(0, 24)}"` : (inp.hint || 'empty'));
      const verb = i === 0 ? 'type' : `type${i + 1}`;
      add(verb, `${verb} <text>  (${hint})`, 'input', inp);
    });
    // a submit verb only makes sense when there's an input to submit. A "Search
    // settings" row with no text box is just a normal `open`, not a send (scar
    // 2026-06-02: Settings showed a phantom "1 send"). If a submit control exists
    // but there's no input, demote it to a regular open.
    if (c.submits[0] && inputs.length) {
      const hasDraft = inputs.some((inp) => (inp.label || '') && inp.label !== inp.cls);
      add('send', hasDraft ? 'send' : 'send  (type something first)', 'submit', c.submits[0]);
    } else if (c.submits[0]) {
      c.opens.unshift(c.submits[0]); // no input → it's an ordinary tappable row
    }
    if (c.scroll) { add('up', 'up', 'nav'); add('down', 'down', 'nav'); }
    add('back', 'back', 'nav');
    add('home', 'home', 'nav');

    // openable items (chat rows, links, buttons, top-bar icons). Dedupe by label.
    const seen = new Set();
    let opens = c.opens.filter((e) => { const k = e.label.toLowerCase(); if (seen.has(k) || isNoise(e.label)) return false; seen.add(k); return true; });
    // RANK: top-bar nav ICONS first (Direct/DM, notifications, search, camera) so
    // they never get paginated off page 1 (scar 2026-06-02: IG's Direct icon was
    // buried behind stories → unreachable by frame). An icon = a control (no text,
    // content-desc only) sitting in the top or bottom bar. Content rows come after.
    const NAV_ICON_RE = /(direct|message|inbox|notif|activity|search|camera|new post|create|home|reels|profile|settings)/i;
    opens = opens.map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const ai = a.e.isControl && NAV_ICON_RE.test(a.e.label) ? 0 : 1;
        const bi = b.e.isControl && NAV_ICON_RE.test(b.e.label) ? 0 : 1;
        return ai - bi || a.i - b.i; // stable otherwise
      })
      .map((x) => x.e);

    // PAGING for `more` is CUMULATIVE — `more` REVEALS the next batch on top of the
    // ones already shown, in ONE continuous numbering. This is the fix for the worst
    // AIX bug (Haiku, 2026-06-02): page-replace paging desynced the displayed labels
    // from `ui do <n>` (page-2 label, page-1 target → wrong contact). With cumulative
    // paging a number ALWAYS means the same action, on any page; nothing shifts.
    const page = expand ? (this._openPage || 1) : 1;
    if (!expand) this._openPage = 1;
    const total = opens.length;
    const shownCount = Math.min(total, page * openCap);
    const shownOpens = opens.slice(0, shownCount);          // 0..N cumulative, not a window
    for (const e of shownOpens) add('open', `open: ${e.label.slice(0, 48)}`, 'open', e);
    // surface an overflow ⋮ as a normal open (explicit), if present
    for (const ov of c.overflow.slice(0, 1)) add('open', `open: ${(ov.label || 'menu').slice(0, 40)}`, 'open', ov);

    const hidden = total - shownCount;
    if (hidden > 0) add('more', `more  (${hidden} more)`, 'more', null);

    this._do = doList; // resolver for do N

    const read = dedupe(c.content).filter((t) => !isNoise(t)).slice(0, readCap);
    return {
      app: shortApp(this._app.pkg),
      do: doList.map((d) => `${d.n} ${d.label}`),
      read,
      pick: 'act with: ui do <n>   (e.g. ui do 1 "your text")',
    };
  }

  // print a fresh frame (the new front door). `ui frame` or `ui f`.
  frame(opts = {}) { console.log(JSON.stringify(this._frame(opts))); return this; }

  // do <n|verb> [arg] — execute an action of the CURRENT frame, then return the
  // NEXT frame so the model sees what changed. The whole loop is: read → do → read.
  //
  // TWO addressing modes (scar 2026-06-02):
  //   NUMBER  (`do 1`)      — for INTERACTIVE use. Cheap, but position is screen-
  //                           specific, so it's the wrong thing to bake into a macro.
  //   VERB    (`do send`,   — for MACROS / replay. Re-resolves against the LIVE frame
  //   `do type "hola"`)       every time, so a saved workflow SELF-HEALS when the UI
  //                           shifts. `type`/`send`/`up`/`down`/`back`/`home`/`more`.
  // ALWAYS rebuild the frame first so we act on what's on screen NOW, never a stale
  // cached numbering (the macro bug: `do 1` hit "back" because the frame had changed).
  do(n, arg) {
    // Rebuild the frame PRESERVING the current page (expand:true honors _openPage),
    // so the numbers we resolve match the page the model just saw. Rebuilding at
    // page 1 was a correctness bug: after `ui do more` showed page 2, the next
    // `ui do 12` silently fired page-1's #12 — a DIFFERENT target (Haiku nearly
    // messaged the wrong contact, 2026-06-02). Numbers must mean what was displayed.
    this._frame({ expand: true });
    let a;
    const asVerb = String(n).trim().toLowerCase();
    if (/^\d+$/.test(String(n).trim())) {
      const idx = parseInt(n, 10);
      a = this._do.find((d) => d.n === idx);
      if (!a) { console.log(JSON.stringify({ error: `no action #${idx}`, frame: this._frame() })); return this; }
    } else {
      // verb mode: find the first action whose stable verb matches
      a = this._do.find((d) => d.verb === asVerb);
      // `send` fallback: some inputs have NO visible submit button (Play Store
      // search, search bars) — they submit via the keyboard's action key. If a
      // `send` was asked for but there's no submit control and an input exists,
      // press ENTER instead of failing (scar 2026-06-02: Play Store search needed
      // a raw KEYCODE_ENTER). Same for `search`/`go` aliases.
      if (!a && /^(send|submit|search|go|enter)$/.test(asVerb) && this._do.some((d) => d.kind === 'input')) {
        adbShell('input keyevent KEYCODE_ENTER'); sleep(900); this._dismissKb();
        console.log(JSON.stringify({ did: 'submitted (enter)', frame: this._frame() })); return this;
      }
      if (!a) { console.log(JSON.stringify({ error: `no "${asVerb}" action on this screen`, available: this._do.map((d) => d.verb), frame: this._frame() })); return this; }
    }

    switch (a.kind) {
      case 'input': {
        if (arg == null || arg === '') { console.log(JSON.stringify({ error: 'do <n> needs text for an input, e.g. ui do 1 "hola"', frame: this._frame() })); return this; }
        adbShell(`input tap ${a.el.bounds.cx} ${a.el.bounds.cy}`); sleep(350);
        this._clearInput();                                       // wipe any existing draft first
        if (!typeText(arg)) { console.log(JSON.stringify({ error: 'nothing typeable after stripping', frame: this._frame() })); return this; }
        this._settle(); this._dismissKb();
        console.log(JSON.stringify({ did: `typed "${arg}"`, frame: this._frame() })); return this;
      }
      case 'submit': {
        adbShell(`input tap ${a.el.bounds.cx} ${a.el.bounds.cy}`); sleep(900); this._dismissKb();
        console.log(JSON.stringify({ did: 'sent', frame: this._frame() })); return this;
      }
      case 'open': {
        adbShell(`input tap ${a.el.bounds.cx} ${a.el.bounds.cy}`); sleep(900); this._dismissKb();
        console.log(JSON.stringify({ did: `opened ${a.label.replace(/^open: /, '')}`, frame: this._frame() })); return this;
      }
      case 'more': {
        // `more` ALWAYS pages the opens list INLINE — it never taps a control
        // (scar 2026-06-02: tapping an overflow as "more" navigated to the profile
        // instead of revealing hidden actions). An ⋮ menu is a normal `open` now.
        this._openPage = (this._openPage || 1) + 1;
        console.log(JSON.stringify({ did: `more (page ${this._openPage})`, frame: this._frame({ expand: true }) })); return this;
      }
      case 'nav': {
        if (a.verb === 'up') this.scrollSilent('up');
        else if (a.verb === 'down') this.scrollSilent('down');
        else if (a.verb === 'back') { adbShell('input keyevent KEYCODE_BACK'); sleep(500); }
        else if (a.verb === 'home') { adbShell('input keyevent KEYCODE_HOME'); sleep(500); }
        console.log(JSON.stringify({ did: a.verb, frame: this._frame() })); return this;
      }
      default:
        console.log(JSON.stringify({ error: `unknown kind ${a.kind}`, frame: this._frame() })); return this;
    }
  }

  // clear the currently-focused input. Typing into a non-empty field APPENDS
  // (scar 2026-06-01: a leftover draft + new text = "test\> here oNoveno…"), so
  // wipe first. Select-all then delete is the reliable cross-app way (works when
  // the cursor position is unknown). Assumes the field is already focused.
  _clearInput() {
    adbShell('input keycombination 113 29'); // CTRL_LEFT + A → select all
    sleep(150);
    adbShell('input keyevent KEYCODE_DEL');   // delete selection
    sleep(150);
    return this;
  }

  // scroll without printing (used inside do())
  scrollSilent(dir = 'down') {
    const d = { down: '540 1600 540 600', up: '540 600 540 1600',
                left: '900 1200 200 1200', right: '200 1200 900 1200' }[dir] || '540 1600 540 600';
    adbShell(`input swipe ${d} 300`); sleep(700); this._els = [];
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
  // Close the soft keyboard if one is up, so every screen settles to a stable,
  // keyboard-free layout before we read it. BACK is what reliably dismisses BOTH
  // the system IME and in-app panels (WhatsApp's emoji tray) — `ime disable`
  // (kbd off) does neither on real OEM phones (scar 2026-06-01: claimed "off"
  // while Andy watched the emoji keyboard stay open). Idempotent: only fires
  // when a keyboard is actually shown, so it never eats a real BACK navigation.
  // Bonus: dismissing the IME is exactly what makes icon-only buttons that live
  // behind it (e.g. WhatsApp Send) render and become tappable by name.
  _dismissKb() {
    let shown = false;
    try { shown = /mInputShown=true/.test(adbShell('dumpsys input_method | grep mInputShown || true')); } catch (_) {}
    if (shown) { adbShell('input keyevent KEYCODE_BACK'); sleep(350); }
    return this;
  }

  // keepKb=true skips the keyboard dismiss — used when the action's whole point is
  // to FOCUS an input (tapping a field), where you want the IME to stay up so the
  // next type() lands. Every other action closes the keyboard (Andy's rule
  // 2026-06-01: "every time an instruction executes, it should close keyboard").
  _act(result, keepKb = false) {
    sleep(300);                 // small settle so the new screen has rendered
    if (!keepKb) this._dismissKb();   // keyboard off after every action → stable, readable screen
    this._els = [];
    console.log(JSON.stringify({ ...result, screen: this._view() }));
    return this;
  }

  tap(name) {
    const e = this._find(name); // fresh dump inside _find
    if (!e) { console.log(JSON.stringify({ error: `no element matching "${name}"`, screen: this._view() })); return this; }
    adbShell(`input tap ${e.bounds.cx} ${e.bounds.cy}`);
    sleep(900);
    return this._act({ tapped: name }, !!e.editable); // tapping a field → keep keyboard for the next type()
  }

  // `input text` is ASYNC on the device — adb returns before the keystrokes land.
  // Firing tap→type→type back-to-back races: chars interleave into the wrong/old
  // field (scar 2026-05-30: "Andy"→"riCuf"). So we type, then SETTLE by polling
  // until the device stops changing, rather than guessing a fixed sleep. For
  // structured data (contacts, etc.) prefer intent()/addContact() over typing.
  type(text) {
    if (!typeText(text)) { console.log(JSON.stringify({ error: 'nothing typeable (emoji/non-Latin stripped to empty)', input: String(text) })); return this; }
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
  // open an app. `fresh:true` = SECURE START POINT (Andy 2026-06-02: "workflows
  // should start from some secure point — reset to main menu, then open the app").
  // A macro can't assume where the phone is; replaying from a random screen is how
  // `ui tap Andres` opened ContactInfo instead of the chat. `fresh` force-stops the
  // app + goes home first, so it ALWAYS launches at its main screen — a determin-
  // istic anchor every macro can rely on as step 1.
  open(app, { fresh = false } = {}) {
    // "home" has no launchable activity — it's the HOME key. Use a SILENT home
    // keyevent (not this.home(), which prints its own frame) so open() emits
    // exactly ONE JSON value — a 9B parses one line, two lines breaks it (scar
    // 2026-06-02: `app fresh` printed the launcher frame THEN {opened}, so Michi
    // read the launcher and thought WhatsApp never opened).
    if (/^home$/i.test(String(app).trim())) {
      adbShell('input keyevent KEYCODE_HOME'); sleep(800);
      console.log(JSON.stringify({ opened: 'home' }));
      return this;
    }
    const pkg = this._resolvePackage(app);
    if (!pkg) {
      console.log(JSON.stringify({ error: `no installed app matches "${app}"`, hint: 'try `movicom app list`' }));
      return this;
    }
    try {
      if (fresh) {
        try { adbShell(`am force-stop ${pkg}`); } catch (_) {}
        adbShell('input keyevent KEYCODE_HOME'); sleep(500);   // silent — see above
      }
      const r = adbShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
      sleep(fresh ? 2200 : 1600); this._els = [];
      if (/No activities found|aborted/i.test(r)) {
        console.log(JSON.stringify({ error: `"${app}" (${pkg}) has no launchable activity` }));
      } else {
        console.log(JSON.stringify({ opened: app, pkg, fresh }));
      }
    } catch (e) {
      console.log(JSON.stringify({ error: `failed to open "${app}": ${e.message || e}` }));
    }
    return this;
  }

  // Open an app's Play Store page DETERMINISTICALLY by package, via the
  // market://details?id= intent — skips searching the store and the SPONSORED-AD
  // trap entirely (scar 2026-06-02: a Play Store search for "instagram" put a
  // sponsored TikTok "Install" as the first result; a blind tap installs the wrong
  // app). Lands the model straight on the right app's page, where `ui do` Install
  // is unambiguous. `pkg` may be a known store package id, or a friendly name we
  // map to one. Does NOT auto-tap Install — installing is a deliberate act the
  // model/human confirms by reading the page first. Returns the frame.
  store(app) {
    const KNOWN = {
      instagram: 'com.instagram.android', tiktok: 'com.zhiliaoapp.musically',
      whatsapp: 'com.whatsapp', telegram: 'org.telegram.messenger',
      'x': 'com.twitter.android', twitter: 'com.twitter.android',
      facebook: 'com.facebook.katana', messenger: 'com.facebook.orca',
      'pedidos ya': 'com.pedidosya', pedidosya: 'com.pedidosya',
      rappi: 'com.grability.rappi', spotify: 'com.spotify.music',
    };
    const n = String(app).toLowerCase().trim();
    const pkg = KNOWN[n] || (/^[\w.]+\.[\w.]+$/.test(n) ? n : null); // known, or looks like a package id
    if (!pkg) { console.log(JSON.stringify({ error: `don't know the package for "${app}" — pass a package id (e.g. com.instagram.android) or add it to KNOWN`, })); return this; }
    adbShell(`am start -a android.intent.action.VIEW -d 'market://details?id=${pkg}'`);
    sleep(2500); this._els = [];
    console.log(JSON.stringify({ store: app, pkg, frame: this._frame() }));
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

  // notifications: the phone's nervous signals (cheap, no screenshot). This is the
  // HEARTBEAT primitive — a cron polls it, recognises the sender, loads the contact,
  // acts. So each note carries what a heartbeat needs to ROUTE and DEDUPE:
  //   pkg   full package (com.whatsapp) — route to the right handler. Truncating it
  //         (old bug) made whatsapp indistinguishable from any "…whatsapp…" pkg.
  //   app   short alias (whatsapp) for humans/logs.
  //   title sender name / app — feed to matchBySender() to find the contact.
  //   text  the message preview.
  //   when  epoch ms — drop ones older than the last beat (--since).
  //   key   the notification's stable key — dedupe across beats; dismiss after acting.
  // `since` (ms) filters to notes newer than a watermark so a heartbeat only ever
  // sees what's NEW since its last run (no reprocessing the same message every beat).
  // `apps` (array of pkg substrings, e.g. ['whatsapp','gmail']) keeps ONLY those.
  // By default OS/OEM boilerplate (setup wizard, USB debug, OTA, system) is dropped
  // — a heartbeat never acts on "USB debugging connected", and paying ~850 tok/beat
  // to read 15 system notices is the opposite of token-efficient.
  notifications(since = 0, apps = null) {
    const out = adbShell('dumpsys notification --noredact');
    const lines = out.split('\n');
    const notes = [];
    let cur = null;
    const decode = (s) => String(s || '')
      .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch (_) { return ''; } })
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    for (const ln of lines) {
      let m;
      // A NotificationRecord(...) header line carries pkg + key. when/category live
      // on their OWN lines further down inside the record, so pick those up below.
      if ((m = ln.match(/NotificationRecord\(.*?pkg=(\S+)/))) {
        if (cur) notes.push(cur);
        const pkg = m[1];
        cur = { pkg, app: shortApp(pkg) };
        let k; if ((k = ln.match(/\bkey=(\S+?):? /))) cur.key = k[1]; // strip trailing ":"
        continue;
      }
      if (!cur) continue;
      // when=<ms>/<ms> on its own line — take the first (the post time).
      if ((m = ln.match(/^\s*when=(\d+)/))) { if (!cur.when) cur.when = +m[1]; continue; }
      if ((m = ln.match(/^\s*category=([a-z]+)/))) { cur.category = m[1]; continue; }
      // title/text can be String(...) OR SpannableString(...) — match both.
      if ((m = ln.match(/android\.title=(?:Spannable)?String \(([\s\S]*?)\)\s*$/))) cur.title = decode(m[1]);
      else if ((m = ln.match(/android\.text=(?:Spannable)?String \(([\s\S]*?)\)\s*$/))) cur.text = decode(m[1]).slice(0, 120);
    }
    if (cur) notes.push(cur);
    let slim = notes.filter((n) => n.title || n.text);
    if (since) slim = slim.filter((n) => (n.when || 0) >= since);
    if (apps && apps.length) {
      // explicit allow-list: keep only the apps the caller named
      slim = slim.filter((n) => apps.some((p) => n.pkg.includes(p)));
    } else {
      // default: drop OS/OEM/system noise a heartbeat would never act on
      slim = slim.filter((n) => !NOTIF_NOISE_PKG.test(n.pkg));
    }
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

  // Open a URL (or run a web search) in the browser via a VIEW intent — the
  // DETERMINISTIC way to reach the web. Don't fumble the address bar: if you know
  // the URL, go straight there; if you have a query, we build the search URL.
  // (scar 2026-06-01: tapping Chrome's omnibox + typing missed twice; the intent
  // worked first try.) Returns the screen after the page loads. `wait` ms to let
  // the page render before reading (default 3500).
  web(target, { search = false, wait = 5000 } = {}) {
    let url = String(target || '').trim();
    if (search || !/^https?:\/\//i.test(url)) {
      // treat it as a search query (or bare domain → search is safer than guessing https)
      if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url) && !search) {
        url = 'https://' + url;                       // looks like a domain → go there
      } else {
        url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
      }
    }
    // single-quote the URL so &, ?, = survive the shell
    adbShell(`am start -a android.intent.action.VIEW -d '${url.replace(/'/g, "%27")}'`);
    sleep(wait);
    this._els = [];
    console.log(JSON.stringify({ opened: url, screen: this._view() }));
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
      const ok = typeText(value);                           // safe escape + emoji strip
      this._settle();
      this._els = [];                                       // layout shifted
      filled.push(ok ? { field: name, value } : { field: name, value, note: 'emoji/non-Latin chars stripped' });
    }
    this._dismissKb();          // keyboard off so the post-fill screen is stable + Send/icon buttons render
    this._els = [];
    console.log(JSON.stringify({ filled, screen: this._view() }));
    return this;
  }

  // send: type a message into the composer and fire Send — ATOMICALLY. Sending a
  // message is ONE intent; making the model fill-then-hunt-for-a-button is the AIX
  // failure (scar 2026-06-01: fill + immediate `tap Send` raced and the draft
  // vanished; only worked with a manual settle in between). So we bake the settle
  // in: focus the composer → type → settle → dismiss keyboard → tap the send
  // control. `field` is the composer's name (default "Message" — WhatsApp; pass
  // e.g. "Compose email" or "Type a message" for other apps). `send` is the send
  // button's label/desc (default "Send"). Verifies the field cleared = it fired.
  send(text, { field = 'Message', send = 'Send' } = {}) {
    const f = this._findField(field);
    if (!f) { console.log(JSON.stringify({ error: `no composer field matching "${field}"`, screen: this._view() })); return this; }
    adbShell(`input tap ${f.bounds.cx} ${f.bounds.cy}`);  // focus composer
    sleep(400);
    if (!typeText(text)) { console.log(JSON.stringify({ error: 'nothing typeable (emoji/non-Latin stripped to empty)', input: String(text) })); return this; }
    this._settle();                                       // wait for keystrokes to land
    this._dismissKb();                                    // close kbd → Send control renders + stable layout
    const s = this._find(send);                           // _find does a fresh dump; Send now surfaced on page 1
    if (!s) { console.log(JSON.stringify({ error: `typed but no send button matching "${send}"`, typed: text, screen: this._view() })); return this; }
    adbShell(`input tap ${s.bounds.cx} ${s.bounds.cy}`);
    sleep(900);
    return this._act({ sent: text });
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
// packages whose notifications a heartbeat never acts on — OS, OEM bloat, install
// chatter, system services. Dropped from `notif list` by default (override with
// `notif list --apps ...`). Keep this conservative: only obvious system noise.
const NOTIF_NOISE_PKG = /(?:^android$|setupwizard|\.gms|googlequicksearchbox|packageinstaller|com\.android\.vending|\.wellbeing|com\.dti\.motorola|motorola\.ccc|\.systemui|inputmethod|com\.android\.systemui|\.providers\.|com\.google\.android\.apps\.wellbeing)/i;

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
    // notif list                      → new+real notifications (system noise dropped)
    // notif list --since <epochMs>     → only notifications newer than the watermark
    // notif list <epochMs>             → same (bare number = since)
    // notif list --apps whatsapp,gmail → ONLY those apps (heartbeat allow-list)
    // notif list --all                 → include system/OEM noise too
    list: (a) => {
      let since = 0, apps = null;
      if (typeof a === 'number') since = a;
      else if (a && typeof a === 'object' && !Array.isArray(a)) {
        if (a.since) since = +a.since;
        if (a.apps) apps = Array.isArray(a.apps) ? a.apps : String(a.apps).split(',');
      } else if (typeof a === 'string') {
        const sm = a.match(/(?:--since\s+)?(\d{10,})/); if (sm) since = +sm[1];
        const am = a.match(/--apps\s+(\S+)/);           if (am) apps = am[1].split(',').filter(Boolean);
        if (/--all\b/.test(a)) apps = [''];             // [''] = keep every pkg (defeats noise filter)
      }
      return phone.notifications(since, apps);
    },
  },
  // web: reach the internet DETERMINISTICALLY — don't fumble the address bar.
  //   web open <url>        → load a URL
  //   web go <url-or-domain>→ same (domain gets https://)
  //   web search <query>    → load the Google results for the query
  // Returns the loaded page as the usual screen menu. If you know the URL, GO
  // straight there; only `ui` your way through a page when you must.
  web: {
    open:   (a) => phone.web(typeof a === 'string' ? a : (a && a.url)),
    go:     (a) => phone.web(typeof a === 'string' ? a : (a && a.url)),
    search: (a) => phone.web(typeof a === 'string' ? a : (a && a.q), { search: true }),
  },
  // camera: take a real photo in one call. `camera shot` (or `camera photo`).
  // pass {"pull":true} to also copy it to the computer for a multimodal brain.
  camera: {
    shot:  (a) => phone.photo(typeof a === 'object' ? a : {}),
    photo: (a) => phone.photo(typeof a === 'object' ? a : {}),
  },
  app: {
    list: () => phone.appList(),
    // app open <name> [--fresh]   — launch (optionally from a clean start point)
    open: (a) => {
      if (a && typeof a === 'object') return phone.open(a.name, { fresh: !!a.fresh });
      const s = String(a || '');
      const fresh = /--fresh\b/.test(s);
      return phone.open(s.replace(/--fresh\b/, '').trim(), { fresh });
    },
    // app fresh <name>   — SECURE START POINT: force-stop + home + launch. The
    // canonical first step of a macro so replay is deterministic, never mid-app.
    fresh: (a) => phone.open(typeof a === 'string' ? a : (a && a.name), { fresh: true }),
    // app store <name|pkg>  — open the app's Play Store page DIRECTLY (skips search
    // + the sponsored-ad trap). Then `ui do <Install>`. Doesn't auto-install.
    store: (a) => phone.store(typeof a === 'string' ? a : (a && a.name)),
    intent: (a) => phone.intent((a && a.action) || a, (a && a.extra) || ''),
  },
  // ---- UI lane: drive the glass (third-party apps with no back door) ----
  ui: {
    // THE FRAME (app-agnostic AIX): `ui frame` reads the screen as {app, read[], do[]}
    // with NUMBERED actions; `ui do <n> ["text"]` runs the nth and returns the next
    // frame. Same gestures drive every app — the model never needs app-specific labels.
    frame:  () => phone.frame(),
    f:      () => phone.frame(),
    do:     (a) => {
      // accept a NUMBER (interactive) or a VERB (macro, self-healing):
      //   `1` | `1 "text"` | `send` | `type "hola"` | `back` | {n,text}
      if (a && typeof a === 'object') return phone.do(a.n, a.text);
      const s = String(a == null ? '' : a).trim();
      const m = s.match(/^(\d+|[a-z]+\d*)\s*(?:"([\s\S]*)"|'([\s\S]*)'|([\s\S]*))?$/i);
      if (!m) return out({ error: 'usage: ui do <n|verb> ["text"]   (verbs: type type2 send up down back home more)' });
      const n = m[1];
      const arg = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] || '')).trim();
      return phone.do(n, arg);
    },
    see:    (a) => phone.see(typeof a === 'object' ? a : (typeof a === 'string' && /^\d+$/.test(a) ? { page: parseInt(a, 10) } : {})),
    more:   () => phone.more(),
    tap:    (a) => phone.tap(typeof a === 'string' ? a : (a && a.label)),
    type:   (a) => phone.type(typeof a === 'string' ? a : (a && a.text)),
    key:    (a) => phone.key(typeof a === 'string' ? a : (a && a.key)),
    scroll: (a) => phone.scroll(typeof a === 'string' ? a : (a && a.dir) || 'down'),
    fill:   (a) => phone.fill(a || {}),
    // ui send "<text>"  → type into the composer + Send, atomically (default
    //   field "Message", button "Send"). For other apps:
    //   ui send '{"text":"hi","field":"Compose email","send":"Send"}'
    send:   (a) => typeof a === 'string'
                   ? phone.send(a)
                   : phone.send((a && a.text) || '', a || {}),
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
    // workflow run <name> [arg1] [arg2] …  — replay a saved macro, substituting
    // $1,$2,… (and $* = all args joined) in each step. THIS is how app-specific
    // ergonomics live OUTSIDE the agnostic core (Andy 2026-06-02: "the navigation
    // is app-agnostic, that's why we have workflows — macros for specific apps").
    // e.g.  workflow add wa-send '["app open whatsapp","ui tap $1","ui do 1 \"$2\"","ui do 2"]'
    //       workflow run wa-send Andres "hola que tal"
    run: (a) => {
      let n, args = [];
      if (a && typeof a === 'object' && !Array.isArray(a)) { n = a.name; args = a.args || []; }
      else if (typeof a === 'string') { const t = tokenize(a); n = t[0]; args = t.slice(1); }
      const w = loadWorkflows();
      if (!w[n]) return out({ error: `no workflow "${n}"`, available: Object.keys(w) });
      const subst = (s) => String(s)
        .replace(/\$\*/g, args.join(' '))
        .replace(/\$(\d+)/g, (_, i) => args[(+i) - 1] != null ? args[(+i) - 1] : '');
      const results = [];
      for (const raw of w[n]) {
        const step = subst(raw);
        const captured = capture(() => dispatch(tokenize(step)));
        results.push({ step, result: tryParse(captured) });
      }
      out({ workflow: n, args, results });
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
  // `workflow run <name> <arg> <arg…>` needs args kept SEPARATE — a quoted
  // multi-word message must stay one arg ($2), not get re-flattened+re-split
  // (scar 2026-06-02: "long msg" shattered into $2,$3,$4…). Pass {name,args} so
  // the shell's argv grouping survives intact.
  if (noun === 'workflow' && verb === 'run' && rest.length) {
    return fn({ name: rest[0], args: rest.slice(1) });
  }
  return fn(parseArg(rest.join(' ')));
}

if (require.main === module) {
  try { dispatch(process.argv.slice(2)); }
  catch (e) { out({ error: String(e && e.message || e) }); process.exit(1); }
}
