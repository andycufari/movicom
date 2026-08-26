import { execFile as nodeExecFile } from "node:child_process";

const DEVICE_RE = /^[A-Za-z0-9._:-]+$/;

export class MovicomError extends Error {
  constructor(code, message, technical = {}) {
    super(message);
    this.name = "MovicomError";
    this.code = code;
    this.technical = technical;
  }
}

function classifyFailure(message) {
  const value = String(message || "");
  if (/more than one device|multiple devices/i.test(value)) {
    return ["MULTIPLE_DEVICES", "Multiple devices connected; specify device"];
  }
  if (/no devices?\/emulators? found|device ['\"]?[^'\"]+['\"]? not found|no android device/i.test(value)) {
    return ["NO_DEVICE", "No Android device connected"];
  }
  if (/adb.*(?:not found|is not recognized|ENOENT)|spawn adb ENOENT/i.test(value)) {
    return ["ADB_NOT_FOUND", "ADB is not installed or not available on PATH"];
  }
  if (/no action #|no ".*" action on this screen/i.test(value)) {
    return ["INVALID_ACTION", "UI action no longer exists; refresh android_screen"];
  }
  if (/don't know the package|app not found|package.*not found/i.test(value)) {
    return ["APP_NOT_FOUND", "App not found"];
  }
  return ["MOVICOM_FAILED", "Movicom command failed"];
}

function parseOutput(stdout, stderr, args) {
  const raw = String(stdout || "").trim();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new MovicomError("INVALID_OUTPUT", "Movicom returned invalid JSON", {
      command: args,
      stdout: raw.slice(0, 2000),
      stderr: String(stderr || "").trim().slice(0, 2000),
      cause: error.message,
    });
  }

  if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
    const [code, message] = classifyFailure(data.error);
    throw new MovicomError(code, message, {
      command: args,
      movicomError: data.error,
      result: data,
      stderr: String(stderr || "").trim().slice(0, 2000),
    });
  }
  return data;
}

export function runMovicom(args, options = {}) {
  const execFile = options.execFile || nodeExecFile;
  const executable = options.executable || process.env.MOVICOM_BIN || "movicom";
  const device = options.device || process.env.MOVICOM_DEVICE;
  const env = { ...process.env, ...options.env };

  if (device) {
    if (!DEVICE_RE.test(device)) {
      return Promise.reject(new MovicomError(
        "INVALID_DEVICE",
        "Invalid Android device serial",
        { device },
      ));
    }
    const adb = process.env.MOVICOM_ADB || "adb";
    env.ADB = `${adb} -s ${device}`;
  }

  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      env,
      encoding: "utf8",
      timeout: options.timeout || 45_000,
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout = "", stderr = "") => {
      if (error) {
        try {
          if (String(stdout).trim()) return resolve(parseOutput(stdout, stderr, args));
        } catch (parsedError) {
          return reject(parsedError);
        }
        const combined = `${error.message}\n${stderr}`;
        const [code, message] = error.code === "ENOENT"
          ? ["MOVICOM_NOT_FOUND", "Movicom is not installed or MOVICOM_BIN is invalid"]
          : classifyFailure(combined);
        return reject(new MovicomError(code, message, {
          command: args,
          exitCode: error.code,
          signal: error.signal,
          stderr: String(stderr).trim().slice(0, 2000),
        }));
      }

      try {
        resolve(parseOutput(stdout, stderr, args));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}
