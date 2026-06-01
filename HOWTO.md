# HOWTO — set up movicom (give your agent a phone)

This guide takes you from nothing to **your AI agent driving a real Android phone**
through `movicom`. Three parts:

1. [Install the bridge (`adb`) + movicom](#1-install) — Mac & Windows
2. [Prepare the Android phone](#2-prepare-the-phone) — dev mode, USB or wireless
3. [Connect & verify](#3-connect--verify) — confirm your agent can see the phone

> No emulator? You can do everything below with the Android Studio emulator
> instead of a real phone — see [Option C](#option-c-emulator-no-hardware).

---

## 1. Install

movicom talks to the phone through **adb** (Android Debug Bridge), part of Android
Platform Tools. You need `adb` on your PATH, plus Node.js 14+.

### macOS
```bash
# adb (Android platform-tools) — via Homebrew
brew install --cask android-platform-tools
# Node (if you don't have it)
brew install node
# movicom
npm install -g movicom
```

### Windows
```powershell
# adb (platform-tools) — via winget, or download from developer.android.com/tools/releases/platform-tools
winget install Google.PlatformTools
# Node from https://nodejs.org (LTS), then:
npm install -g movicom
```
> If `adb` isn't found after install, add the platform-tools folder to your PATH
> (e.g. `%LOCALAPPDATA%\Android\platform-tools` or wherever it unzipped).

### Verify the install
```bash
adb version        # should print "Android Debug Bridge version 1.0.4x"
movicom doctor     # prints adb version, device (null for now), foreground app
```
`movicom doctor` with no device yet is expected — we connect one next.

---

## 2. Prepare the phone

A few one-time settings make the phone reachable and reliable. **Recommended, not
all mandatory** — the device-debugging toggle is the only hard requirement.

### a) Turn on Developer Options (required)
1. **Settings → About phone** → tap **Build number** **7 times**.
2. You'll see "You are now a developer." Developer options now appear in Settings
   (often under **System**).

### b) Turn on USB debugging (required for cable) / Wireless debugging
- **Settings → System → Developer options → USB debugging: ON**
- **(Android 11+) Wireless debugging: ON** — lets you connect with no cable.

### c) Recommended settings for smooth automation
- **Stay awake while charging** (Developer options) — screen won't sleep mid-task.
- **Lock with a numeric PIN**, not only biometrics — a PIN can be entered via adb
  (`input text`), a fingerprint cannot. Pre-unlock the phone for your agent.
- **Sign into the apps** your agent will use (Gmail, WhatsApp, etc.) **yourself,
  beforehand.** movicom drives apps as the logged-in user — it does not (and
  should not) create accounts. This is the gray-hat line: your agent acts on
  *your* accounts, never fakes new ones.
- **Pre-install the apps** the agent needs. movicom uses what's on the phone; it
  doesn't sideload.

> **Accuracy tip (movicom-specific):** the on-screen keyboard shifts the layout and
> can break multi-field typing. movicom can disable it for you while it works —
> `movicom kbd off` before a form, `movicom kbd on` after. (`input text` still
> types with the soft keyboard off.) Optional but makes forms rock-solid.

---

## 3. Connect & verify

Pick the way that fits your hardware.

### Option A — USB cable (simplest, any Android)
1. Use a **data** USB cable (charge-only cables won't work) — plug straight into
   the computer, not through a hub.
2. On the phone, set USB mode to **File Transfer (MTP)** if prompted.
3. The phone shows **"Allow USB debugging?"** → check *Always allow from this
   computer* → **Allow**.
4. Confirm:
   ```bash
   adb devices          # your phone's serial should be listed as "device"
   movicom doctor       # device + current foreground app
   ```

### Option B — Wireless (no cable, Android 11+)
1. Phone and computer on the **same Wi-Fi**.
2. **Developer options → Wireless debugging → Pair device with pairing code.**
   The phone shows an **IP:port** and a **6-digit code**.
3. On the computer:
   ```bash
   adb pair <IP>:<PAIR_PORT>      # enter the 6-digit code when asked
   adb connect <IP>:<CONNECT_PORT> # the port shown on the main Wireless debugging screen
   adb devices                    # should list <IP>:<port>  device
   movicom doctor
   ```
> Android 10 and older have no `adb pair`. You can still go wireless with one
> initial USB handshake: `adb tcpip 5555` (with cable plugged), unplug, then
> `adb connect <phone-ip>:5555`.

### Option C — Emulator (no hardware)
1. Install [Android Studio](https://developer.android.com/studio).
2. **Device Manager → Create Virtual Device** → pick a phone + a system image
   (choose one **with Play Store** if you need real apps) → Finish.
3. Launch it (Device Manager ▶, or
   `~/Library/Android/sdk/emulator/emulator -avd <name>` on Mac).
4. `adb devices` lists `emulator-5554` automatically (loopback, no cable).
   ```bash
   movicom doctor   # device: emulator-5554
   ```
> Note: Play-Integrity/SafetyNet-gated apps (e.g. WhatsApp) may refuse to run on a
> stock emulator. Use a real device for those.

---

## You're connected — now what

```bash
movicom doctor                 # where am I? device + foreground app
movicom app open settings      # launch an app by name
movicom ui see                 # read the screen as a MENU (where/actions/fields/hint)
movicom ui tap "Wi-Fi"         # act by NAME — movicom holds the coordinates
```

Every action returns the **new screen as a menu** — your agent reads `where`,
`actions`, `fields`, and a `hint` of what to do next, and picks. No screenshots
for normal use; movicom reads the UI as text (cheap). See **[AGENTS.md](AGENTS.md)**
for the agent operating manual and **[README.md](README.md)** for the full verb
reference.

### Quick troubleshooting
| Symptom | Fix |
|---|---|
| `adb: command not found` | Platform-tools not on PATH — see [Install](#1-install). |
| `adb devices` empty over USB | Bad/charge-only cable, or the "Allow USB debugging?" prompt wasn't accepted. Replug, watch the phone. |
| Phone never shows the debug prompt | Try another cable/port; some cables are charge-only. Or use wireless (Option B). |
| `movicom doctor` shows `device: null` | No device reachable — `adb devices` first; reconnect. |
| Typing lands in the wrong field | `movicom kbd off` before filling forms, `movicom kbd on` after. |
| `null root node` / dump fails | The screen had no focused window — movicom retries; if it persists, wake/unlock the phone. |
