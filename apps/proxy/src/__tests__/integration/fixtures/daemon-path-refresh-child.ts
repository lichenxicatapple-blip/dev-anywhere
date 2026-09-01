import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectAutoUpdateInvocation } from "#src/common/auto-update-invocation.js";
import { prepareDaemonSpawnEnvironment } from "#src/common/daemon-spawn-env.js";
import { AUTO_UPDATE_LOCK_PATH, PROFILE_NAME } from "#src/common/paths.js";

const PROBE_TIMEOUT_MS = 5_000;

function readFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

async function runDaemonLikeChild(
  env: NodeJS.ProcessEnv,
  expectedPath: string,
): Promise<{ pathMatchesExpected: boolean; sentinelPreserved: boolean }> {
  const source = [
    "const result = {",
    "  pathMatchesExpected: process.env.PATH === process.argv[1],",
    '  sentinelPreserved: process.env.DAEMON_PATH_FIXTURE_SENTINEL === "preserved",',
    "};",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", source, expectedPath], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 4 * 1024) child.kill("SIGKILL");
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Daemon-like fixture child timed out"));
    }, PROBE_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  if (code !== 0) throw new Error(`Daemon-like fixture child exited ${code}`);
  return JSON.parse(stdout) as { pathMatchesExpected: boolean; sentinelPreserved: boolean };
}

const mode = readFlag("--mode");
if (mode !== "auto" && mode !== "manual") throw new Error("Invalid --mode");
const callerPath = readFlag("--caller-path");
const loginPath = readFlag("--login-path");
const expectedPath = mode === "auto" ? loginPath : callerPath;
const expectedProfile = readFlag("--profile");
const isolatedHome = process.env.HOME;
if (!isolatedHome) throw new Error("Fixture HOME is missing");

const directInvocation = isDirectAutoUpdateInvocation();
const lockOwnerMatchesParent = existsSync(AUTO_UPDATE_LOCK_PATH)
  ? (JSON.parse(readFileSync(AUTO_UPDATE_LOCK_PATH, "utf8")) as { pid?: unknown }).pid ===
    process.ppid
  : false;
const prepared = await prepareDaemonSpawnEnvironment();
const daemonProbe = await runDaemonLikeChild(prepared.env, expectedPath);

process.stdout.write(
  JSON.stringify({
    mode,
    directInvocation,
    pathSource: prepared.pathSource,
    failureReason: prepared.failureReason ?? null,
    helperPathMatchesExpected: prepared.env.PATH === expectedPath,
    helperSentinelPreserved: prepared.env.DAEMON_PATH_FIXTURE_SENTINEL === "preserved",
    daemonPathMatchesExpected: daemonProbe.pathMatchesExpected,
    daemonSentinelPreserved: daemonProbe.sentinelPreserved,
    lockOwnerMatchesParent,
    profileIsIsolated: PROFILE_NAME === expectedProfile,
    lockPathIsIsolated:
      AUTO_UPDATE_LOCK_PATH === join(isolatedHome, ".dev-anywhere", "run", "auto-update.lock"),
  }),
);
