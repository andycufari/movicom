---
name: android-control
description: Operate a real Android device through semantic MCP tools backed by Movicom. Use for reading screens, navigating apps, contacts, notifications, web actions, or camera work; prefer structured UI over screenshots.
---

# Android control

Use available `android_*` MCP tools. Movicom owns Android details, UIAutomator parsing, coordinates, intents, and the act-to-next-frame loop. Do not reproduce that logic or start with shell commands.

## Operating strategy

1. Start with `android_status`. If device choice is ambiguous, call `android_devices`, then pass one `device` serial consistently.
2. Prefer deterministic system tools and intents: app, contacts, notifications, and web tools before driving UI.
3. For UI work, call `android_screen`, read `read`, then choose a numbered semantic action from `do` with `android_action`.
4. Treat the frame returned by `android_action` as the next observation. Do not add a redundant screen read unless state looks stale or unexpected.
5. When an action disappeared or UI changed unexpectedly, refresh with `android_screen`; never guess an old action number.
6. Prefer `android_fresh_app` when task needs a deterministic app start or navigation became confused.
7. Use `android_screenshot` only when structured UI lacks enough meaning, such as canvas, map, image-only, or broken accessibility screens.

Avoid manual coordinates. `android_tap` by label remains fallback when numbered frame action does not expose needed element.

## Safety

Reading screen, apps, contacts, status, and notifications normally has no external side effect. Taps, typing, intents, camera capture, and app navigation change device state.

Before any action that could send, publish, purchase, delete, confirm, install, disclose data, or create another irreversible effect, show intended action and get user confirmation. Confirmation applies only to that action, not later steps.

Camera may reveal private surroundings. Get confirmation immediately before capture.

If accessibility/UIAutomator cannot expose an app correctly, use one screenshot for understanding, then return to semantic tools where possible. Stop after repeated state mismatch; report screen and failed action instead of looping visually.

Shell `movicom` commands are debugging fallback only when MCP tools fail and user task permits diagnostics.
