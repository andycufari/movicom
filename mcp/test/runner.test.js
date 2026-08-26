import assert from "node:assert/strict";
import test from "node:test";
import { MovicomError, runMovicom } from "../src/runner.js";

function fakeExec({ error = null, stdout = "", stderr = "" }) {
  return (_file, _args, _options, callback) => callback(error, stdout, stderr);
}

test("parses one JSON value from Movicom", async () => {
  const result = await runMovicom(["doctor"], {
    execFile: fakeExec({ stdout: '{"device":"emulator-5554"}' }),
  });
  assert.deepEqual(result, { device: "emulator-5554" });
});

test("rejects stdout contaminated by logs", async () => {
  await assert.rejects(
    runMovicom(["doctor"], {
      execFile: fakeExec({ stdout: 'debug log\n{"device":"emulator-5554"}' }),
    }),
    (error) => error instanceof MovicomError && error.code === "INVALID_OUTPUT",
  );
});

test("maps missing device to an agent-readable error", async () => {
  const processError = Object.assign(new Error("Command failed"), { code: 1 });
  await assert.rejects(
    runMovicom(["ui", "frame"], {
      execFile: fakeExec({ error: processError, stderr: "adb: no devices/emulators found" }),
    }),
    (error) => error.code === "NO_DEVICE" && /No Android device/.test(error.message),
  );
});

test("maps invalid action returned as JSON", async () => {
  await assert.rejects(
    runMovicom(["ui", "do", "99"], {
      execFile: fakeExec({ stdout: '{"error":"no action #99"}' }),
    }),
    (error) => error.code === "INVALID_ACTION" && /refresh android_screen/.test(error.message),
  );
});

test("adds selected device through ADB without changing command arguments", async () => {
  let captured;
  const result = await runMovicom(["doctor"], {
    device: "emulator-5554",
    execFile: (file, args, options, callback) => {
      captured = { file, args, adb: options.env.ADB };
      callback(null, '{"device":"emulator-5554"}', "");
    },
  });
  assert.deepEqual(result, { device: "emulator-5554" });
  assert.deepEqual(captured.args, ["doctor"]);
  assert.equal(captured.adb, "adb -s emulator-5554");
});

test("rejects unsafe device serials", async () => {
  await assert.rejects(
    runMovicom(["doctor"], { device: "serial; rm -rf nope" }),
    (error) => error.code === "INVALID_DEVICE",
  );
});
