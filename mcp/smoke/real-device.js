#!/usr/bin/env node

import { runMovicom } from "../src/runner.js";

if (process.env.MOVICOM_REAL_DEVICE !== "1") {
  process.stderr.write("Set MOVICOM_REAL_DEVICE=1 to run this manual smoke test.\n");
  process.exit(2);
}

const device = process.env.MOVICOM_DEVICE;
const run = (args) => runMovicom(args, { device });

const status = await run(["doctor"]);
const initial = await run(["ui", "frame"]);
const settings = await run(["app", "fresh", "settings"]);
const frame = settings.frame || await run(["ui", "frame"]);
const firstOpen = (frame.do || []).map((item) => String(item).match(/^(\d+) open:/)).find(Boolean);
const navigated = firstOpen
  ? await run(["ui", "do", JSON.stringify({ n: Number(firstOpen[1]) })])
  : { skipped: "No safe open action found on Settings screen" };
const back = await run(["ui", "back"]);

process.stdout.write(`${JSON.stringify({ status, initial, settings, navigated, back }, null, 2)}\n`);
