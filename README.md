# movicom

**Give an AI agent a body on a phone.** A tiny, dependency-free Node.js driver that
lets *any* LLM *see* and *use* a real Android device over `adb` — reading the screen
as a **menu designed for the model** (cheap) instead of screenshots (expensive), and
acting by **name** instead of pixel coordinates. Light enough that a small **9B
local model** can drive it.

```bash
movicom app fresh whatsapp
movicom ui frame
# → {"app":"whatsapp",
#    "read":["Andres: Buen día ☀️","you: Quinto test (Delivered)","Andres: HOP"],
#    "do":["1 type <text>","2 send","3 up","4 down","5 back","6 home",
#          "7 open: Andres","8 open: Video call","9 more (12 more, page 1/2)"],
#    "pick":"act with: ui do <n>   (e.g. ui do 1 \"your text\")"}
movicom ui do 7            # open the chat (by number)
movicom ui do 1 "hola"    # type
movicom ui do send        # send
```

No screenshot. No API. No browser extension. movicom reads the screen as a **frame**
— what to READ, what to DO (numbered) — and acts by number or verb, the way a person
uses a phone. Same gestures drive WhatsApp, Instagram, Gmail, Settings — *any* app.

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
movicom app fresh whatsapp           # open an app at a clean start point
movicom ui frame                     # read the screen as {app, read[], do[]} (numbered)
movicom ui do 7                      # run action #7 (e.g. open a chat)
movicom ui do 1 "the message"        # type into the input
movicom ui do send                   # send (verb mode — self-healing)
movicom app store instagram          # open an app's Play Store page (then ui do Install)
movicom web search "best ramen near me"   # reach the web (don't fumble the omnibox)
movicom camera shot '{"pull":true}'  # take a real photo, copy it to the computer
```

### Verbs

| Verb | What it does |
|---|---|
| `doctor` / `devices` | Device + foreground app / list adb devices. Start here. |
| **`ui frame`** (alias `ui f`) | **Read the screen as `{app, read[], do[]}` — content + NUMBERED actions. The front door.** |
| **`ui do <n> [text]`** | **Run action #n (optionally with text); returns the next frame. `ui do more` pages.** |
| **`ui do <verb> [text]`** | **Verb mode (self-healing, for macros): `type` `type2` `send` `up` `down` `back` `home` `more`.** |
| `app fresh <name>` | Secure start: force-stop + home + launch (deterministic reset). |
| `app store <name>` | Open an app's Play Store page directly by package (skip search + ad trap). |
| `app list` · `app open <name>` · `app intent '{...}'` | List / launch apps; fire a raw intent. |
| `web open <url>` · `web go <domain>` · `web search <query>` | Reach the internet deterministically via an intent. |
| `contacts list\|find\|add` | System lane: talk to the OS, not the glass. |
| `notif list [--since ms\|--apps a,b\|--all]` | Notifications as `{pkg,app,title,text,when,key,category}`; system noise dropped by default. The heartbeat primitive. |
| `camera shot '{"pull":true}'` | Take a real photo; `pull` copies it back so a multimodal model can SEE it. |
| `workflow add\|run\|list\|del` | App-specific macros over the agnostic frame (parameterized `$1 $2`, self-healing). |
| `ui see` · `ui tap "<label>"` · `ui fill '{...}'` · `ui shot` | Low-level lane: act on a specific element by name; screenshot fallback. |
| `kbd off` / `kbd on` | (Mostly automatic now — every action dismisses the keyboard.) |

Every `ui do` returns the next **frame**, so the model never needs a separate read
between actions — read, pick a number, see what changed.

## MCP

Use Movicom as **native tools** from Codex, Claude Code, OpenCode, APX, and any other
MCP client. An optional [`movicom-mcp`](mcp/) stdio server exposes semantic Android
tools (`android_status`, `android_screen`, `android_action`, …) as a thin layer over the
CLI — the driver stays `movicom`, dependency-free.

```bash
npm install -g movicom-mcp
```

See **[docs/MCP.md](docs/MCP.md)** for the tools, client configuration, safety, and
tests, and the [`android-control`](skills/android-control/SKILL.md) skill that teaches an
agent to drive Android through them.

## Configuring the phone

See **[HOWTO.md](HOWTO.md)** for the full setup: install `adb` + movicom (Mac &
Windows), enable developer mode, and connect a phone over **USB**, **wireless**
(Android 11+, no cable), or the **emulator**. Quick check:

```bash
adb devices      # your device should be listed
movicom doctor   # device + current foreground app
```

## Status

Early but real, and dogfooded hard. Proven on a real Android phone: reading any
screen as a frame, sending WhatsApp messages, **installing Instagram from the Play
Store, logging in, and reading the profile + DM inbox** — plus filling multi-field
forms, sending email through Gmail, taking a photo, reading live web answers. All
verified against ground truth (the package list / MediaStore / a received message),
not just the screen. It's UI-driven, so it can break when an app redesigns — that's
the trade for reaching apps that have no API. Built in the open.

**Your phone. Your accounts. Your work.** movicom drives apps you're already logged
into; it never creates accounts or impersonates anyone.

Contributions welcome. Found a screen movicom mis-reads? Run `movicom ui see --raw`
on it and open an issue with the XML — the parser learns from real screens.

## License

MIT © Andy Cufari. See [LICENSE](LICENSE).
