# movicom for agents

You are an AI agent. `movicom` is your **body on an Android phone** — it runs over
`adb` and lets you *see* the screen as cheap structured text and *act* on it by name.
This is your operating manual.

## The one rule

**Talk to the OS, not the glass, whenever you can.** Android system apps (contacts,
sms, calendar, settings) have direct commands — use them. Drive the screen
(`ui ...`) only for third-party apps with no back door.

## Command shape

```
movicom <noun> <verb> [arg]
```

- **Writes take JSON:** `movicom contacts add '{"first":"Ada","phone":"+54..."}'`
- **Reads / simple args are plain:** `movicom contacts find Ada`, `movicom app open gmail`
- **Output is ALWAYS one JSON value** — parse it. Reads return data; writes return
  `{opened:...}`/`{saved:...}`/`{added:...}`; failures return `{error:"..."}`.

## Reading the screen — `ui frame` (THE interface)

`ui frame` (and every `ui do`) returns a **FRAME**: the screen split into what to
READ and what to DO, with every action NUMBERED. This is the front door — use it.

```json
{"app":"whatsapp",
 "read":["Andres: Buen día ☀️","you: Quinto test (Delivered)","Andres: HOP"],
 "do":["1 type <text>  (empty)","2 send","3 up","4 down","5 back","6 home",
       "7 open: Andres","8 open: Video call","9 more  (12 more, page 1/2)"],
 "pick":"act with: ui do <n>   (e.g. ui do 1 \"your text\")"}
```

- `read` — the **content** on screen (messages, captions, list items). Read this.
- `do` — the **actions**, each NUMBERED. Pick one with `ui do <n>`.
- `app` — what app you're in.

**Act with `ui do <n|verb> [text]`:**
- `ui do 1 "hola"` — run action #1 with text (here: type "hola")
- `ui do 2` — run action #2 (here: send)
- `ui do more` — page to the next batch of actions (inline, cheap)

**Numbers vs verbs:**
- A **number** (`ui do 1`) is position-specific — perfect interactively, because the
  frame you just read shows the current numbering. Always read before you pick.
- A **verb** (`ui do send`, `ui do type "x"`, `ui do back`) re-resolves against the
  live screen every time. **Use verbs in workflows/macros** so they self-heal when
  the UI shifts. Core verbs: `type` (and `type2`, `type3` for extra fields), `send`,
  `up`, `down`, `back`, `home`, `more`. Everything else is opened by number.

You browse the frame the way a human uses a phone: read, pick a number, see what
changed. **Never reason about pixels.** movicom holds the coordinates.

## Core loop

```
movicom doctor                 # where am I? (device + foreground app)
movicom app fresh whatsapp     # open at a clean start point (force-stop + home + launch)
movicom ui frame               # read the screen: {app, read[], do[]}
movicom ui do 7                # act by number (opens a chat, etc.)
movicom ui do 1 "hola"         # type into the input
movicom ui do send             # send
```

Every `ui do` returns the next frame, so you don't need a separate read between
actions. **If you get lost, `movicom app fresh <name>`** resets to that app's main
screen — deterministic, always lands. Never rely on swipe gestures to navigate.

### Installing an app
`movicom app store <name>` opens its Play Store page DIRECTLY by package (skips
search and the sponsored-ad trap), then `ui do <Install>`. Logging in is the human's
job — movicom drives your accounts, it never creates them.

## Verbs

### System lane (preferred — no UI race)
- `contacts list [filter]` · `contacts find <q>` · `contacts add '{first,last,phone}'`
- `notif list` — read the notification shade (your "what needs me?" sense). Each is
  `{pkg, app, title, text, when, key, category}`. System/OEM noise is dropped by
  default. `notif list --since <epochMs>` = only new since a watermark (heartbeat);
  `notif list --apps whatsapp,gmail` = allow-list; `notif list --all` = include noise
- `camera shot '{"pull":true}'` — take a real PHOTO in one call (opens camera,
  clears permission dialogs, presses the shutter, returns the saved file path;
  `pull:true` also copies it to the computer so a multimodal brain can SEE it)
- `app list` — installed launchable apps (`[{name,pkg}]`)
- `app open <name> [--fresh]` — launch by package
- `app fresh <name>` — SECURE START: force-stop + home + launch (deterministic reset;
  the canonical first step of a macro so replay never starts mid-app)
- `app store <name>` — open the app's Play Store page directly by package
- `app intent '{"action":"...","extra":"-n pkg/activity"}'` — fire any intent

### UI lane — THE FRAME (drive any app)
- `ui frame` (alias `ui f`) — read the screen as `{app, read[], do[]}` (numbered)
- `ui do <n>` — run action #n · `ui do <n> "text"` — with text · `ui do more` — page
- `ui do <verb> [text]` — verb mode (self-healing, for macros): `type` `type2` `send`
  `up` `down` `back` `home` `more`

### UI lane — low-level (when you need a specific element by name)
- `ui see [<page#>]` · `ui more` · `ui tap "<label>"` · `ui type "<text>"`
- `ui key <BACK|HOME|ENTER|TAB|...>` · `ui scroll <down|up|left|right>`
- `ui fill '{"First name":"Ada"}'` — multi-field form fill
- `ui shot [file]` — low-res screenshot. **Fallback only**, for text-less screens.

### Workflows — app-specific macros (layer 2 over the agnostic frame)
The frame drives any app; a **workflow** crystallizes a known task into a replayable,
parameterized macro. Build app-specific ergonomics as DATA, not code.
- `workflow add <name> '[...steps...]'` — steps are movicom commands; use `$1 $2 $*`
  for parameters and **verb-mode `ui do`** so the macro self-heals:
  ```
  workflow add wa-send '["app fresh whatsapp","ui tap $1","ui do type \"$2\"","ui do send"]'
  workflow run wa-send Andres "hola que tal"   # multi-word args preserved
  ```
- **Start from a SECURE POINT** (`app fresh <app>`) as step 1 so replay is deterministic.
- **Self-improving loop:** do a task once via the frame, then `workflow add` the steps
  you ran (with `$`-params). Next time it's one call. The agent gets faster at what
  it has done before.
- `workflow run <name> [args...]` · `workflow list` · `workflow show <name>` · `workflow del <name>`
- Stored in `~/.movicom/workflows.json` — shareable across agents and runs.

### Gated (outbound — do not assume they fire)
- `sms send` → returns a gate error. `call dial <num>` → only COMPOSES the dialer,
  never places the call (returns `gated:true`). Check before trusting.

### Meta
- `doctor` — adb version, device, foreground app (start here)
- `devices` — what adb can see

## Patterns

- **Frame first:** `ui frame` → `ui do <n>`. Read `read`, pick a number, repeat.
  Every `ui do` returns the next frame, so you rarely need a separate read.
- **Structured data → skip the UI:** a contact is `contacts add '{...}'`, not typing.
- **Start clean:** `app fresh <name>` before a task so you begin at the app's main
  screen, not wherever it was left.
- **Multi-step jobs → a workflow:** do it once via the frame, then `workflow add` the
  steps (verb-mode `ui do` + `$`-params) so it self-heals and runs in one call.
- **Reading content:** the conversation/page text is in `read`. To read more, `ui do
  down` (or `up`) — each returns a fresh frame with the newly revealed `read`.

## Gotchas (learned the hard way)
- `ui type` is async on-device; movicom settles between actions — but prefer
  intents/providers over typing for anything structured.
- Android auto-formats phone numbers; the stored value is clean, the display isn't.
- `ui scroll up` can open the notification shade on some launchers — to switch apps,
  use `app open <name>`, not gestures.
