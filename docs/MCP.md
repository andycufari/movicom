# Movicom MCP

`movicom-mcp` is an optional [Model Context Protocol](https://modelcontextprotocol.io)
stdio server that exposes Movicom as **semantic Android tools**. Any MCP-compatible
client — Codex, Claude Code, OpenCode, APX, or your own — can then read the screen and
act on the phone as native tools, with no shell glue.

It is a **thin layer**. Movicom stays the driver:

```
Agent → MCP (movicom-mcp) → Movicom → adb → Android
```

The server never re-implements UIAutomator parsing, coordinate resolution, intents, or
the see→act→frame loop. Each tool is a small translation to an existing Movicom command,
so the CLI and the MCP behave identically.

## Install

The server lives in [`mcp/`](../mcp) and depends on the MCP SDK, so it ships as its own
package (keeping `movicom` itself dependency-free):

```bash
npm install -g movicom          # the driver (dependency-free)
npm install -g movicom-mcp      # the MCP adapter
```

`movicom-mcp` finds `movicom` on your `PATH`. To point at a specific build, set
`MOVICOM_BIN` (see [Environment](#environment)).

Running from a clone instead of a global install:

```bash
cd mcp
npm install
node src/server.js              # this is the stdio server
```

## Verify it talks to Android

```bash
adb devices        # your phone should be listed
movicom doctor     # adb version, device serial, foreground app
```

Then confirm the server starts and a client can reach the phone. Any of your MCP clients
can call `android_status` — it returns the same data as `movicom doctor`. If that comes
back with your device serial, the full chain (MCP → Movicom → adb → phone) is live.

## Tools

Names are stable; schemas are discoverable by the client. Read-only tools are marked
with a `readOnlyHint`; the rest change device state.

| Tool | Backed by | Notes |
| --- | --- | --- |
| `android_status` | `movicom doctor` | **Start here.** adb, device, foreground app, keyboard. |
| `android_devices` | `movicom devices` | List adb serials. Pass one as `device` to any tool. |
| `android_screen` | `movicom ui frame` | **The frame:** `{app, read[], do[]}`, actions numbered. Prefer this over screenshots. |
| `android_action` | `movicom ui do <n\|verb>` | Run a numbered action or a verb (`type`,`send`,`up`,`down`,`back`,`home`,`more`). Returns the next frame. |
| `android_tap` | `movicom ui tap` | Tap an element by visible label. Fallback to `android_action`. |
| `android_fill` | `movicom ui fill` | Fill one or more labeled fields (multi-field forms). |
| `android_open_app` | `movicom app open` | Launch an app by friendly name or package id. |
| `android_fresh_app` | `movicom app fresh` | Force-stop + home + launch = deterministic clean start. |
| `android_list_apps` | `movicom app list` | Installed launchable apps with package ids. |
| `android_back` | `movicom ui back` | Press Back. |
| `android_home` | `movicom ui home` | Press Home. |
| `android_notifications` | `movicom notif list` | Read the shade; filter by `since` epoch ms or `apps` substrings. |
| `android_contacts_list` | `movicom contacts list` | List contacts, optional filter. |
| `android_contacts_find` | `movicom contacts find` | Find contacts by name or phone. |
| `android_web_open` | `movicom web open` | Open a URL/domain via a VIEW intent; returns page structure. |
| `android_web_search` | `movicom web search` | Open browser search results. |
| `android_screenshot` | `movicom ui shot` | Returns an image. **Fallback** when the frame lacks meaning. |
| `android_camera_shot` | `movicom camera shot` | Take a real photo; may expose surroundings — confirm first. |

### The core loop

`android_screen` returns a frame; `android_action` runs one of its numbered actions and
returns the *next* frame. You rarely need a separate read between actions:

```
android_screen                        → { app, read[], do:["1 type <text>","2 send", …] }
android_action { action: 7 }          → opens a chat, returns its frame
android_action { action: 1, text: "hola" }   → types, returns the frame
android_action { action: "send" }     → sends, returns the frame
```

Use **numbers** interactively (you just read the frame) and **verbs**
(`send`, `back`, `type`) when you want a step that re-resolves against the live screen.

## Device selection

With one device connected, omit `device`. With several, call `android_devices` and pass
one serial consistently on each call. The server sets `adb -s <serial>` for that call
without changing any other argument; the serial is validated before use.

You can also pin a default globally with the `MOVICOM_DEVICE` environment variable.

## Environment

| Variable | Purpose |
| --- | --- |
| `MOVICOM_BIN` | Path to the `movicom` executable, if not on `PATH`. |
| `MOVICOM_DEVICE` | Default adb serial when a call omits `device`. |
| `MOVICOM_ADB` / `ADB` | Path to `adb`, if not on `PATH`. |

## Configuration examples

The server speaks MCP over **stdio**. Once `movicom-mcp` is on your `PATH`, every client
uses the same one-line command. Replace it with `node /absolute/path/to/movicom/mcp/src/server.js`
to run from a clone.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.android]
command = "movicom-mcp"
```

### Claude Code

```bash
claude mcp add android movicom-mcp
```

or in `.mcp.json` / settings:

```json
{ "mcpServers": { "android": { "command": "movicom-mcp" } } }
```

### OpenCode

`opencode.json`:

```json
{
  "mcp": {
    "android": { "type": "local", "command": ["movicom-mcp"], "enabled": true }
  }
}
```

### APX

APX hot-loads MCP servers, so no restart is needed:

```bash
apx mcp add android --command movicom-mcp
apx mcp tools android                     # prove it connected
apx mcp run android android_status '{}'   # call a tool through the daemon
```

Running from a clone, pass the source path and any environment:

```bash
apx mcp add android --command node \
  --env MOVICOM_BIN=/absolute/path/to/movicom/movicom.js \
  -- /absolute/path/to/movicom/mcp/src/server.js
```

## Agent skill

[`skills/android-control`](../skills/android-control/SKILL.md) is a reusable skill that
teaches an agent *how* to operate Android through these tools — start with
`android_status`, prefer `android_screen` over screenshots, act with semantic actions,
re-inspect when the UI changes, and confirm before anything irreversible. It teaches
strategy, not a copy of each tool's schema, and assumes the MCP tools are available.

The `SKILL.md` is the source of truth. If you use APX Skill Sync (or a similar mechanism),
point it at that file to distribute the skill to your agents.

## Safety

Classify tools by side effect:

- **Read** — `android_status`, `android_screen`, `android_notifications`,
  `android_contacts_*`, `android_list_apps`, `android_screenshot`: no external effect.
- **Act** — `android_action`, `android_tap`, `android_fill`, `android_open_app`,
  `android_fresh_app`, `android_back`, `android_home`, `android_web_*`: change device
  state.
- **Sensitive / irreversible** — sending a message, purchasing, deleting, posting,
  confirming, installing, or `android_camera_shot`: **get user confirmation first.**

The server does not implement a permission system; it surfaces enough structure for the
agent (and its host) to decide. The skill documents the confirmation rule.

## Errors

Failures come back as structured, agent-readable messages with a `code`, not a raw stack
trace, while keeping technical detail for debugging:

```
NO_DEVICE         No Android device connected
MULTIPLE_DEVICES  Multiple devices connected; specify device
ADB_NOT_FOUND     ADB is not installed or not available on PATH
INVALID_ACTION    UI action no longer exists; refresh android_screen
APP_NOT_FOUND     App not found
MOVICOM_FAILED    Movicom command failed
```

The server also guards its stdout: only MCP protocol traffic is written there, never logs.

## Tests

```bash
cd mcp
npm install
npm test              # unit + mocked integration (no phone required)
```

Coverage:

- **Unit** — MCP input → Movicom command translation; JSON parsing; process errors;
  no-device / invalid-action mapping; schema validation; device injection.
- **Mocked integration** — a stdio client lists and calls tools against the real server
  wired to a fixture `movicom`, asserting stdout stays clean.

A real-device smoke test is manual (it needs a phone):

```bash
cd mcp
MOVICOM_REAL_DEVICE=1 npm run test:smoke
```

It runs `android_status` → `android_screen` → open Settings → navigate → back, and prints
each frame. It never sends messages, buys, or changes sensitive data.
