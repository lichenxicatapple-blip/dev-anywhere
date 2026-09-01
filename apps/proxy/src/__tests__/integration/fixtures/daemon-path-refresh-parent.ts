import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireUpdateLock } from "#src/update-runner.js";
import { AUTO_UPDATE_LOCK_PATH } from "#src/common/paths.js";

const OUTPUT_LIMIT_BYTES = 16 * 1024;
const CHILD_TIMEOUT_MS = 10_000;

function readFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

async function runDirectChild(): Promise<{ code: number | null; stdout: string }> {
  const childPath = fileURLToPath(new URL("./daemon-path-refresh-child.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      childPath,
      "--profile",
      readFlag("--profile"),
      "--mode",
      readFlag("--mode"),
      "--caller-path",
      readFlag("--caller-path"),
      "--login-path",
      readFlag("--login-path"),
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > OUTPUT_LIMIT_BYTES) child.kill("SIGKILL");
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Path refresh fixture child timed out"));
    }, CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

const mode = readFlag("--mode");
if (mode !== "auto" && mode !== "manual") throw new Error("Invalid --mode");

// This process is the updater analogue. acquireUpdateLock writes its real PID, and the service CLI
// analogue below is its direct child, so production parent/lock detection runs without overrides.
const lock = mode === "auto" ? acquireUpdateLock(AUTO_UPDATE_LOCK_PATH) : null;
if (mode === "auto" && !lock) throw new Error("Unable to acquire isolated fixture lock");

try {
  const result = await runDirectChild();
  if (result.code !== 0) throw new Error(`Path refresh fixture child exited ${result.code}`);
  process.stdout.write(result.stdout);
} finally {
  lock?.release();
}
