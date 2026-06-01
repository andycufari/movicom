# movicom

**Give an AI agent a body on a phone.** A tiny, dependency-free Node.js driver that
lets *any* LLM *see* and *use* a real Android device over `adb` — reading the screen
as a **menu designed for the model** (cheap) instead of screenshots (expensive), and
acting by **name** instead of pixel coordinates. Light enough that a small **9B
local model** can drive it.

```bash
movicom web search "world cup 2026 first match"
movicom ui see
# → {"where":"chrome",
#    "text":["The 2026 World Cup opens Thu June 11, 2026 — Mexico vs South Africa,
#             Estadio Azteca, Mexico City"],
#    "actions":["Images","Maps","News"], "fields":["Search"],
#    "can_scroll":true, "page":"1/8",
#    "hint":"tap an action: ui tap \"Images\"  |  more actions: ui more"}
```

No screenshot. No API. No browser extension. movicom read the answer off the phone
as text — the way a person would.

**Building an agent on movicom? Read [AGENTS.md](AGENTS.md)** (the operating manual
for LLMs) and **[HOWTO.md](HOWTO.md)** (set up adb + a phone in minutes).

Named after [Movicom](https://en.wikipedia.org/wiki/Movicom), the pioneering
Argentine cellular company — a local telecom ghost reborn as an agent's hands.

---

## Why

Most "let an agent use a phone" setups send a **screenshot** to a vision model on
every step — slow, and it burns real tokens (and dollars) per image.

movicom reads Android's own UI tree (`uiautomator dump`) and hands the agent a
**menu** — `where` it is, the `actions` it can tap, the `fields` it can fill, the
visible `text`, and a `hint` of what to do next. The model *picks from a menu* like a
human browses a UI; it never reasons about pixels.

| Approach | Cost per screen | Agent reasons about |
|---|---|---|
| Screenshot → vision | ~1,000–1,500 tok + $ per image | pixels |
| **movicom menu** | **~200–400 tok, no image $** | **labels & structure** |

This is the **AI Interface / AI Experience (AII/AIX)**: the output isn't a raw dump,
it's an interface *designed for an AI to use*. Cluttered pages are paginated
(`page:"1/8"`, `ui more`) so a noisy screen stays cheap — a Google results page went
from ~1,350 tokens to ~270 with no loss of reach. Screenshots remain an explicit
fallback (`shot()`, plus `camera shot` to take a real photo) for the rare screen
with no text.

### Why a phone, not an API?

Because **most of what a person does on a phone has no API** — your Instagram feed,
a Rappi order, a logged-in dashboard, an app whose API got killed or gated. The
*screen* is always there; it's the one surface that can't be walled off without
walling off the user. movicom drives it as **you**, on **your** device, with **your**
accounts — for your own work. (When a clean API exists — e.g. weather — use it;
movicom is for the 99% that doesn't.)

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
npm install -g movicom
adb version && movicom doctor
```

**New here? Read [HOWTO.md](HOWTO.md)** — a step-by-step setup guide: install adb +
movicom (Mac & Windows), prepare the Android phone (developer mode, USB or wireless
debugging), recommended phone settings, and connect/verify. Covers real devices and
the emulator.

## Usage

Grammar: `movicom <noun> <verb> [arg|json]`. Every command prints **one JSON value**.

```bash
movicom doctor                       # where am I? device + foreground app
movicom web search "best ramen near me"   # reach the web (don't fumble the omnibox)
movicom app open gmail               # launch an app by name
movicom ui see                       # read the screen as a menu
movicom ui tap "Compose"             # act by NAME (movicom holds the coords)
movicom ui fill '{"Subject":"Hi","Compose email":"the body"}'
movicom ui more                      # next page of actions on a busy screen
movicom camera shot '{"pull":true}'  # take a real photo, copy it to the computer
```

### Verbs

| Verb | What it does |
|---|---|
| `doctor` / `devices` | Device + foreground app / list adb devices. Start here. |
| `web open <url>` · `web go <domain>` · `web search <query>` | Reach the internet deterministically via an intent — no address-bar fumbling. |
| `app list` · `app open <name>` · `app intent '{...}'` | List / launch apps; fire a raw intent. |
| `ui see [page#]` | Read the screen as a menu: `{where, actions[], fields[], text[], can_scroll, page, hint}`. |
| `ui more` | Next page of actions (busy screens are paginated to stay cheap). |
| `ui tap "<label>"` | Tap the element matching `label` (resolves across all pages). |
| `ui type "<text>"` · `ui fill '{field: value}'` | Type into the focused field / fill a multi-field form (focuses each field first). |
| `ui key <BACK\|HOME\|ENTER\|…>` · `ui scroll <dir>` · `ui back` · `ui home` | Keys, swipes, navigation. |
| `kbd off` / `kbd on` | Disable/enable the soft keyboard — stops layout shift so forms fill reliably. |
| `contacts list\|find\|add` · `notif list` | System lane: talk to the OS, not the glass. |
| `camera shot '{"pull":true}'` | Take a real photo; `pull` copies it back so a multimodal model can SEE it. |
| `ui shot [file]` | Low-res screenshot — explicit fallback for text-less screens. |
| `workflow add\|run\|list\|del` | Save & replay named command sequences (shareable macros). |

Every **action** (`ui tap/type/key/scroll/fill`) returns `{<result>, screen:{...}}` —
the fresh menu after the action — so the model doesn't need a separate `ui see`.

## Configuring the phone

See **[HOWTO.md](HOWTO.md)** for the full setup: install `adb` + movicom (Mac &
Windows), enable developer mode, and connect a phone over **USB**, **wireless**
(Android 11+, no cable), or the **emulator**. Quick check:

```bash
adb devices      # your device should be listed
movicom doctor   # device + current foreground app
```

## Status

Early but real, and dogfooded hard. Proven on an Android emulator + real Android:
reading screens as a menu, filling multi-field forms, sending an email through the
Gmail app, taking a photo, reading live web answers, writing a contact — all
verified against ground truth (the MediaStore / content provider / a received
email), not just the screen. It's UI-driven, so it can break when an app redesigns —
that's the trade for reaching apps that have no API. Built in the open.

Contributions welcome. Found a screen movicom mis-reads? Run `movicom ui see --raw`
on it and open an issue with the XML — the parser learns from real screens.

## License

MIT © Andy Cufari. See [LICENSE](LICENSE).
