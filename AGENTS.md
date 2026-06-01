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

## Reading the screen — `ui see` (your interface, as a menu)

`ui see` (and every action) returns a **menu designed for you** — not a raw screen
dump. Read it like an IVR/phone menu and pick:

```json
{"where":"chrome","actions":["Search","Images","Maps"],"fields":["Search or type URL"],
 "text":["Buenos Aires","mar, Nublado, máx 14° mín 11°"],"can_scroll":true,
 "page":"1/8","hint":"fill a field: ui fill '{\"Search\":\"...\"}'  |  more actions: ui more"}
```

- `where` — what screen/app you're on.
- `actions` — labels you can **tap**: `movicom ui tap "Maps"`. Shown one **page** at
  a time (~12) to stay cheap. `page:"1/8"` = there are 8 pages.
- `fields` — inputs you can **fill** (by name): `movicom ui fill '{"<name>":"..."}'`.
  Unnamed inputs are `field 1`, `field 2`…
- `text` — the visible content (what a news page or weather card SAYS).
- `can_scroll` — true → `ui scroll down` reveals more content.
- `page` + `ui more` — flip to the next page of actions WITHOUT re-reading the
  whole screen. You can still `ui tap "<label>"` an action that's on a later page —
  movicom finds it regardless of which page is shown. Only page when what you want
  isn't on the current one.
- `hint` — the exact next command(s) to try. When in doubt, do what the hint says.

You browse this menu the way a human browses a UI. **Don't reason about pixels.**

You think in **names**; movicom holds the coordinates. Never reason about pixels.
If a label isn't there, it may be off-screen — `ui scroll down` and look again.

## Core loop

```
movicom doctor          # where am I? (device + foreground app)
movicom app open gmail  # go somewhere (deterministic, by package)
movicom ui see          # what's here?
movicom ui tap "Compose"
movicom ui see          # confirm it changed
```

**If you get lost, reset with `movicom app open home`** (or open any known app).
Opening is by package — it always lands. Never rely on swipe gestures to navigate.

## Verbs

### System lane (preferred — no UI race)
- `contacts list [filter]` · `contacts find <q>` · `contacts add '{first,last,phone}'`
- `notif list` — read the notification shade (your "what needs me?" sense)
- `camera shot '{"pull":true}'` — take a real PHOTO in one call (opens camera,
  clears permission dialogs, presses the shutter, returns the saved file path;
  `pull:true` also copies it to the computer so a multimodal brain can SEE it)
- `app list` — installed launchable apps (`[{name,pkg}]`)
- `app open <name>` — launch by package; also the reliable position reset
- `app intent '{"action":"...","extra":"-n pkg/activity"}'` — fire any intent

### UI lane (third-party apps with no back door)
- `ui see [<page#>]` · `ui more` (next page of actions) · `ui tap "<label>"` · `ui type "<text>"`
- `ui key <BACK|HOME|ENTER|TAB|ESCAPE|...>` · `ui scroll <down|up|left|right>`
- `ui fill '{"First name":"Ada"}'` — multi-field form fill (handles keyboard shift)
- `ui shot [file]` — low-res screenshot. **Fallback only**, for text-less screens.

### Workflows — save & replay sequences (your macros)
- `workflow add <name> '["app open gmail","ui see","notif list"]'`
- `workflow run <name>` → runs each step, returns `{workflow, results:[{step,result}]}`
- `workflow list` · `workflow show <name>` · `workflow del <name>`
- Stored in `~/.movicom/workflows.json` — shareable across agents and runs.
  Compose a behavior once; any agent can replay it.

### Gated (outbound — do not assume they fire)
- `sms send` → returns a gate error. `call dial <num>` → only COMPOSES the dialer,
  never places the call (returns `gated:true`). Check before trusting.

### Meta
- `doctor` — adb version, device, foreground app (start here)
- `devices` — what adb can see

## Patterns

- **Structured data → skip the UI:** a contact is `contacts add '{...}'`, not typing.
- **Find then act:** `ui see` to learn exact labels, THEN `ui tap "<label>"`. Don't guess.
- **Verify by re-reading:** after a tap, `ui see` again and confirm `app`/`tap` changed.
- **Multi-step jobs → a workflow:** save the recipe, run it, share it.

## Gotchas (learned the hard way)
- `ui type` is async on-device; movicom settles between actions — but prefer
  intents/providers over typing for anything structured.
- Android auto-formats phone numbers; the stored value is clean, the display isn't.
- `ui scroll up` can open the notification shade on some launchers — to switch apps,
  use `app open <name>`, not gestures.
