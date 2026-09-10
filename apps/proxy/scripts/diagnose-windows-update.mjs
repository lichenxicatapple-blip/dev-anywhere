import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") throw new Error("Run this diagnostic on Windows");
const root = mkdtempSync(join(tmpdir(), "dev-anywhere-windows-update-"));
const prefix = join(root, "npm");
const packageRoot = join(prefix, "node_modules", "@dev-anywhere", "proxy");
const recoveryRoot = join(root, "recovery");
const configPath = join(homedir(), ".dev-anywhere", "config.json");
const profile = "windows-update-" + process.pid;
const originalConfig = existsSync(configPath) ? readFileSync(configPath) : null;
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const env = {
  ...process.env,
  npm_config_prefix: prefix,
  npm_config_audit: "false",
  npm_config_fund: "false",
};
let servicePid;
function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    env,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return {
    code: result.status,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
function cli(base, args) {
  return run([join(base, "dist", "index.js"), "--profile", profile, "serve", ...args], {
    timeout: 90000,
  });
}
function install(version) {
  return run([
    npmCli,
    "install",
    "--global",
    "@dev-anywhere/proxy@" + version,
    "--no-audit",
    "--no-fund",
    "--fetch-timeout=30000",
    "--fetch-retries=2",
  ]);
}
function log(label, value) {
  console.log(label + " " + JSON.stringify(value));
}
function nativeModules(pid) {
  const source =
    "(Get-Process -Id " +
    pid +
    ').Modules | Where-Object { $_.FileName -like "*dev-anywhere*" } | Select-Object ModuleName,FileName | ConvertTo-Json -Compress';
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  return result.stdout.trim() || result.stderr.trim();
}
try {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      autoUpdate: false,
      profiles: {},
      relays: { diagnostic: { url: "ws://127.0.0.1:49387" } },
    }),
  );
  const initial = install("0.9.8");
  log("BASELINE_INSTALL", initial);
  if (initial.code !== 0) throw new Error("Could not install the published baseline");
  cpSync(packageRoot, recoveryRoot, { recursive: true, verbatimSymlinks: true });
  const started = cli(packageRoot, ["start", "--relay", "diagnostic", "--json"]);
  log("SERVICE_START", started);
  if (started.code !== 0) throw new Error("Could not start the real baseline daemon");
  servicePid = JSON.parse(started.stdout).pid;
  log("LOADED_NATIVE_MODULES", nativeModules(servicePid));
  const liveUpdate = install("0.9.9");
  log("LIVE_NPM_UPDATE", liveUpdate);
  log("STATUS_AFTER_LIVE_UPDATE", cli(recoveryRoot, ["status"]));
  log("LOADED_NATIVE_MODULES_AFTER_UPDATE", nativeModules(servicePid));
  try {
    cpSync(packageRoot, join(root, "live-copy"), { recursive: true, verbatimSymlinks: true });
    log("COPY_RUNNING_PACKAGE", "succeeded");
  } catch (error) {
    log("COPY_RUNNING_PACKAGE", { code: error.code, message: error.message });
  }
  try {
    const moved = join(dirname(packageRoot), ".diagnostic-retired-package");
    renameSync(packageRoot, moved);
    renameSync(moved, packageRoot);
    log("RENAME_RUNNING_PACKAGE", "succeeded");
  } catch (error) {
    log("RENAME_RUNNING_PACKAGE", { code: error.code, message: error.message });
  }
  log("SERVICE_STOP", cli(recoveryRoot, ["stop"]));
  await delay(6000);
  log("NPM_UPDATE_AFTER_STOP", install("0.9.9"));
} finally {
  if (existsSync(join(recoveryRoot, "dist", "index.js")))
    log("CLEANUP_STOP", cli(recoveryRoot, ["stop"]));
  await delay(6000);
  if (originalConfig) writeFileSync(configPath, originalConfig);
  else rmSync(configPath, { force: true });
  rmSync(join(homedir(), ".dev-anywhere", "profiles", profile), { recursive: true, force: true });
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    log("CLEANUP_FILES", { code: error.code });
  }
}
