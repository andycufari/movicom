#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.join(" ") === "devices") {
  process.stdout.write(JSON.stringify({ devices: ["emulator-5554"] }));
} else if (args.join(" ") === "doctor") {
  process.stdout.write(JSON.stringify({ adb: "1.0.41", device: "emulator-5554" }));
} else {
  process.stdout.write(JSON.stringify({ args }));
}
