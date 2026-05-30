# movicom

**Give an AI agent a body on a phone.** A tiny, dependency-free Node.js driver that
lets an LLM *see* and *use* a real Android device over `adb` — reading the screen as
structured text (cheap) instead of screenshots (expensive), and acting by **name**
instead of pixel coordinates.

```js
const phone = require('./movicom');
phone.open('Settings').tap('Network & internet').see();
// → {"app":"settings","tap":["Wi-Fi","Mobile network",...],"scroll":true}
```

Named after [Movicom](https://en.wikipedia.org/wiki/Movicom), the pioneering
Argentine cellular company — a local telecom ghost reborn as an agent's hands.

---

## Why

Most "let an agent use a phone" setups send a **screenshot** to a vision model on
every step. That's slow and burns tokens — a single screen is ~150–500 KB of image.

movicom takes a different path: it reads Android's own UI tree (`uiautomator dump`)
and hands the agent only the **meaning** — the labels you can tap, the fields you can
type into, whether the screen scrolls. A whole home screen is ~230 bytes of JSON.

| Approach | Cost per screen | Agent reasons about |
|---|---|---|
| Screenshot → vision | ~150–500 KB | pixels |
| **movicom `see()`** | **~0.2–0.5 KB** | **labels & structure** |

The agent thinks in names (`tap("Settings")`); movicom keeps the coordinates to
itself and resolves the name to a tap. Screenshots remain available as an explicit
fallback (`shot()`) for the rare screen with no text (captchas, canvases, images).

## Design

```
  AGENT  (the LLM)            decides WHAT and WHY — by name, never coordinates
    │  intentions
  movicom  (this file)        the "optic nerve": dump XML → minified meaning;
    │  adb commands            resolve names → coords; owns the see→act loop
  DEVICE  (Android over adb)  emulator or a real phone — swappable, same code
```

Everything is `adb`. No app to install on the phone, no agent process running on the
device, no root required for the core. The device is swappable: an emulator and a
real phone are the same to the agent.

## Install

Requires [`adb`](https://developer.android.com/tools/adb) (Android Platform Tools)
and Node.js 14+. No npm dependencies.

```bash
git clone git@github.com:andycufari/movicom.git
cd movicom
# connect a device (see "Configuring the phone" below), then:
node movicom.js see
```

## Usage

**CLI** — chain verbs with `:` :

```bash
node movicom.js see
node movicom.js open Settings : tap "Apps" : see
node movicom.js notifications
node movicom.js home
```

**As a module** — fluent and chainable:

```js
const phone = require('./movicom');

phone.open('Settings')
     .tap('Network & internet')
     .see();

// type into a form robustly (handles the soft-keyboard layout shift)
phone.fill({ 'First name': 'Ada', 'Last name': 'Lovelace' });

// prefer intents / providers over UI mazes when an app exposes them
phone.intent('android.intent.action.INSERT', '-t vnd.android.cursor.dir/contact');
phone.addContact({ first: 'Ada', last: 'Lovelace', phone: '+5491100000000' });
```

### Verbs

| Verb | What it does |
|---|---|
| `see({coords, raw})` | Print the screen as minified JSON: `{app, tap[], type[], read[], scroll}`. `coords:true` includes tap points; `raw:true` dumps the source XML (debugging). |
| `tap(name)` | Tap the element whose label exactly/loosely matches `name`. |
| `type(text)` | Type into the focused field. |
| `key(name)` / `back()` / `home()` | Send a key event (`BACK`, `HOME`, `ENTER`, `TAB`, `ESCAPE`, …). |
| `scroll(dir)` / `nextPage()` | Swipe `down`/`up`/`left`/`right`. |
| `open(app)` | Launch an app by its launcher name. |
| `intent(action, extra)` | Fire an Android intent (often more reliable than tapping through menus). |
| `fill({label: value})` | Fill a multi-field form, hardened against keyboard layout shift. |
| `addContact({first, last, phone})` | Write a contact straight to the content provider (no typing). |
| `notifications()` | Read the notification shade as text — let the phone *summon* the agent. |
| `shot(file)` | Low-res screenshot — explicit fallback for text-less screens. |

## Configuring the phone

You need a device `adb` can reach. Easiest is the Android Studio emulator; a real
phone works too.

### Option A — Emulator (no hardware)

1. Install [Android Studio](https://developer.android.com/studio).
2. **Device Manager → Create Virtual Device** → pick a phone + a system image → Finish.
3. Launch it (from Device Manager, or `~/Library/Android/sdk/emulator/emulator -avd <name>`).
4. `adb devices` should list `emulator-5554`. Done — `adb` talks to it over loopback,
   no cable.

> Note: Google-Play-protected apps (e.g. WhatsApp) may refuse to run on a stock
> emulator. Use a real device for those.

### Option B — Real phone over USB

1. **Enable Developer Options:** Settings → About phone → tap **Build number** 7×.
2. **Settings → System → Developer options → USB debugging: ON.**
3. Connect via a **data** USB cable (charge-only cables won't work) — ideally
   straight into the computer, not through a hub.
4. Set the USB mode to **File Transfer (MTP)** if prompted.
5. On the phone, accept **"Allow USB debugging?"** for this computer (check *always
   allow*).
6. `adb devices` should now list your phone.

For automation, also consider: **Stay awake while charging** (Developer options),
and a numeric **PIN** lock rather than biometrics (a PIN can be entered via
`input text`, a fingerprint cannot).

## Status

Early but real. Proven on an Android 16 emulator: navigating apps, reading screens,
filling forms, and writing a contact end-to-end — all verified against ground truth
(the content provider), not just the screen. Built in the open.

Contributions welcome. Found a screen movicom mis-reads? Run `node movicom.js see raw`
on it and open an issue with the XML — the parser learns from real screens.

## License

MIT © Andy Cufari. See [LICENSE](LICENSE).
