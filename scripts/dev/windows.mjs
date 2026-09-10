import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { cp, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);
const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
const vite = join(root, "apps/web/node_modules/vite/bin/vite.js");
const configPath = join(homedir(), ".dev-anywhere/config.json");
const stateDir = join(root, ".tmp/dev-services");
const checkoutId = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 24);
const valueOptions = {
  restart: ["profile", "relay", "relay-port", "web-port", "log-dir", "log-retention"],
  health: ["profile", "relay-port", "web-port", "log-dir", "proxy-log-dir"],
  web: ["relay", "target", "port", "host"],
};

function invalid(message) {
  throw Object.assign(new Error(message), { exitCode: 2 });
}

export function parseArgs(command, args) {
  const options = {
    "relay-port": "3100",
    "web-port": "5173",
    "log-dir": join(homedir(), ".dev-anywhere/logs"),
    "log-retention": "50",
    host: "127.0.0.1",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { help: true };
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match || !valueOptions[command]?.includes(match[1])) invalid(`unknown argument: ${arg}`);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith("--")) invalid(`missing value for --${match[1]}`);
    options[match[1]] = value;
  }
  for (const name of ["port", "relay-port", "web-port"]) {
    const value = options[name];
    if (
      value !== undefined &&
      (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    ) {
      invalid(`--${name} must be a port between 1 and 65535`);
    }
  }
  if (!/^\d+$/.test(options["log-retention"]))
    invalid("--log-retention must be a non-negative integer");
  if (command === "restart" && Number(options["relay-port"]) === Number(options["web-port"])) {
    invalid("--relay-port and --web-port must differ");
  }
  if (command === "web") {
    if (options.relay && options.target) invalid("use either --relay or --target, not both");
    if (!options.relay && !options.target)
      invalid("missing --relay <name> or --target <relay-url>");
    if (!options.port) invalid("missing --port");
  }
  return options;
}

export function normalizeTarget(value) {
  const target = value.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    invalid(`invalid relay URL: ${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    invalid("relay URL must use http, https, ws or wss");
  return target;
}

function runNode(args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`Command failed (${code ?? signal}): node ${args.join(" ")}`));
    });
  });
}

async function resolveProfile(options) {
  if (options.profile) return;
  const { stdout, stderr } = await exec(
    process.execPath,
    [
      join(root, "scripts/lib/resolve-dev-profile.mjs"),
      "--relay-url",
      `ws://localhost:${options["relay-port"]}`,
      "--json",
    ],
    { windowsHide: true },
  );
  if (stderr) process.stderr.write(stderr);
  const resolved = JSON.parse(stdout);
  options.profile = resolved.profile;
  options.relay ??= resolved.relay;
}

function webScheme() {
  return process.env.DEV_ANYWHERE_WEB_HTTPS_CERT || process.env.DEV_ANYWHERE_WEB_HTTPS_KEY
    ? "https"
    : "http";
}

export function portAvailable(port, host = "0.0.0.0") {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolvePort(false);
      else reject(error);
    });
    server.listen({ port: Number(port), host, exclusive: true }, () =>
      server.close(() => resolvePort(true)),
    );
  });
}

function request(url) {
  return new Promise((resolveRequest, reject) => {
    const cert = process.env.DEV_ANYWHERE_WEB_HTTPS_CERT;
    const tls =
      url.startsWith("https:") && cert ? { ca: readFileSync(resolve(root, "apps/web", cert)) } : {};
    const req = (url.startsWith("https:") ? https : http).get(
      url,
      { ...tls, timeout: 1500 },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 400) resolveRequest(body);
          else reject(new Error(`HTTP ${response.statusCode}: ${url}`));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`request timed out: ${url}`)));
    req.on("error", reject);
  });
}

async function waitReady(label, url, logFile) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await request(url);
      console.log(`${label} ready: ${url} (log: ${logFile})`);
      return;
    } catch {
      await delay(200);
    }
  }
  const log = await readFile(logFile, "utf8").catch(() => "");
  throw new Error(
    `${label} failed its HTTP readiness check: ${url}\nLog: ${logFile}\n${log.split(/\r?\n/).slice(-80).join("\n")}`,
  );
}

export function ownsProcess(record, commandLine) {
  return (
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    /^dev-anywhere-[\da-f-]{36}$/.test(record.token) &&
    commandLine?.includes(`--title=${record.token}`)
  );
}

async function stopManaged(name) {
  const file = join(stateDir, `${name}.json`);
  let record;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!Number.isSafeInteger(record.pid) || record.pid < 1)
    throw new Error(`Invalid process state: ${file}`);
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${record.pid}').CommandLine`,
    ],
    { windowsHide: true },
  );
  if (stdout.trim()) {
    if (!ownsProcess(record, stdout))
      throw new Error(
        `PID ${record.pid} no longer belongs to this checkout; refusing to stop it. State: ${file}`,
      );
    console.log(`Stopping managed ${name} (PID: ${record.pid})`);
    await exec("taskkill.exe", ["/PID", String(record.pid), "/T", "/F"], { windowsHide: true });
  }
  await rm(file, { force: true });
}

async function prepareLog(name, options, runId) {
  const dir = resolve(options["log-dir"]);
  const stem = `${name}-dev`;
  const prefix = `${stem}-${checkoutId}`;
  const file = join(dir, `${prefix}-${runId}.log`);
  const stable = join(dir, `${prefix}.log`);
  await mkdir(dir, { recursive: true });
  // NTFS hard links need no administrator/developer-mode permission.
  try {
    if ((await stat(stable)).nlink > 1) await rm(stable);
    else await rename(stable, join(dir, `${prefix}-${runId}-legacy.log`));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(file, "");
  await link(file, stable);
  const keep = Number(options["log-retention"]);
  if (keep > 0) {
    const previous = (await readdir(dir))
      .filter(
        (name) =>
          name.startsWith(`${prefix}-`) &&
          name.endsWith(".log") &&
          name !== `${prefix}-${runId}.log`,
      )
      .sort()
      .reverse();
    await Promise.all(previous.slice(keep - 1).map((name) => rm(join(dir, name), { force: true })));
  }
  return file;
}

async function startManaged(name, args, cwd, env, logFile) {
  await mkdir(stateDir, { recursive: true });
  const token = `dev-anywhere-${randomUUID()}`;
  const fd = openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [`--title=${token}`, ...args], {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    await new Promise((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });
  } finally {
    closeSync(fd);
  }
  try {
    await writeFile(
      join(stateDir, `${name}.json`),
      JSON.stringify({ pid: child.pid, token, logFile }) + "\n",
    );
  } catch (error) {
    await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    throw error;
  }
  child.unref();
}

function proxyArgs(options, action) {
  return [
    tsx,
    join(root, "apps/proxy/src/index.ts"),
    "--profile",
    options.profile,
    "serve",
    action,
    ...(action === "restart" && options.relay ? ["--relay", options.relay] : []),
  ];
}

async function restart(options) {
  await resolveProfile(options);
  console.log("Building shared protocol package...");
  const shared = join(root, "packages/shared");
  await runNode([join(root, "node_modules/tsup/dist/cli-default.js")], { cwd: shared });
  await rm(join(shared, "dist/.tsbuildinfo"), { force: true });
  await runNode(
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.build.json",
      "--outDir",
      "dist",
    ],
    { cwd: shared },
  );
  await runNode([
    tsx,
    join(root, "scripts/dev/validate-profile.mjs"),
    "--profile",
    options.profile,
    ...(options.relay ? ["--relay", options.relay] : []),
  ]);
  const fonts = join(homedir(), ".dev-anywhere/relay-data/fonts/sarasa-fixed-sc");
  const bundled = join(root, "apps/proxy/assets/fonts/sarasa-fixed-sc");
  if (
    !(await stat(fonts).then(
      () => true,
      () => false,
    )) &&
    (await stat(bundled).then(
      () => true,
      () => false,
    ))
  ) {
    await cp(bundled, fonts, { recursive: true, force: false, errorOnExist: false });
  }
  await stopManaged("web");
  await stopManaged("relay");
  for (const [name, port] of [
    ["Relay", options["relay-port"]],
    ["Web", options["web-port"]],
  ]) {
    if (!(await portAvailable(port)))
      throw new Error(
        `${name} port ${port} is already in use by an unmanaged process. Stop it or choose another port.`,
      );
  }
  const runId = `${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-")}-${process.pid}`;
  const relayLog = await prepareLog("relay", options, runId);
  const webLog = await prepareLog("web", options, runId);
  const relayEnv = { ...process.env, PORT: options["relay-port"] };
  for (const key of ["RELAY_PROXY_TOKEN", "RELAY_CLIENT_TOKEN", "ALLOWED_ORIGINS"])
    delete relayEnv[key];
  try {
    await startManaged(
      "relay",
      [tsx, "src/index.ts"],
      join(root, "apps/relay"),
      relayEnv,
      relayLog,
    );
    await waitReady("Relay", `http://127.0.0.1:${options["relay-port"]}/api/status`, relayLog);
    await startManaged(
      "web",
      [vite, "--host", "0.0.0.0", "--port", options["web-port"], "--strictPort"],
      join(root, "apps/web"),
      {
        ...process.env,
        DEV_ANYWHERE_WEB_RELAY_TARGET: `http://127.0.0.1:${options["relay-port"]}`,
      },
      webLog,
    );
    await waitReady("Web", `${webScheme()}://127.0.0.1:${options["web-port"]}/`, webLog);
    await runNode(proxyArgs(options, "restart"), {
      cwd: join(root, "apps/proxy"),
      env: { ...process.env, INIT_CWD: root },
    });
  } catch (error) {
    await stopManaged("web");
    await stopManaged("relay");
    throw error;
  }
  console.log(
    `\nAll services restarted.\n  Relay: http://localhost:${options["relay-port"]}\n  Web:   ${webScheme()}://localhost:${options["web-port"]}\n  Proxy profile: ${options.profile}\n  Proxy relay: ${options.relay ?? process.env.RELAY_URL ?? "profile config"}\n  Logs: ${resolve(options["log-dir"])}`,
  );
  console.log(
    `\nCheck health: pnpm dev:health -- --profile ${options.profile} --relay-port ${options["relay-port"]} --web-port ${options["web-port"]}`,
  );
}

async function web(options) {
  if (!options.target) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    options.target = config.relays?.[options.relay]?.url;
    if (!options.target) invalid(`Missing relays.${options.relay}.url in ${configPath}`);
  }
  const target = normalizeTarget(options.target);
  let port = Number(options.port);
  while (!(await portAvailable(port, options.host))) {
    if (++port > 65535) throw new Error("No available port at or above the requested port");
  }
  console.log(`Web: ${webScheme()}://${options.host}:${port}\nRelay target: ${target}`);
  await runNode([vite, "--host", options.host, "--port", String(port)], {
    cwd: join(root, "apps/web"),
    env: { ...process.env, DEV_ANYWHERE_WEB_RELAY_TARGET: target },
  });
}

export async function findServiceLog(logDir, servicePid) {
  const stable = join(logDir, "service.log");
  if (
    await stat(stable).then(
      (entry) => entry.isFile(),
      () => false,
    )
  )
    return stable;
  const names = await readdir(logDir).catch(() => []);
  const candidates = await Promise.all(
    names
      .filter((name) => /^service-.+\.log$/.test(name))
      .map(async (name) => {
        const file = join(logDir, name);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) return null;
        const lease = await readFile(`${file}.active`, "utf8").then(
          (raw) => {
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          },
          () => null,
        );
        const active =
          lease?.version === 1 &&
          lease.fileName === name &&
          Number.isSafeInteger(lease.pid) &&
          lease.pid > 0 &&
          (servicePid === undefined || lease.pid === servicePid);
        return { file, active, modified: info.mtimeMs };
      }),
  );
  return (
    candidates
      .filter(Boolean)
      .sort((a, b) => Number(b.active) - Number(a.active) || b.modified - a.modified)[0]?.file ??
    stable
  );
}

async function health(options) {
  await resolveProfile(options);
  let failed = false;
  let servicePid;
  for (const [label, url] of [
    ["Relay health", `http://localhost:${options["relay-port"]}/health`],
    ["Relay status", `http://localhost:${options["relay-port"]}/api/status`],
    ["Web", `${webScheme()}://localhost:${options["web-port"]}/`],
  ]) {
    try {
      await request(url);
      console.log(`OK   ${label}: ${url}`);
    } catch (error) {
      console.error(`FAIL ${label}: ${error.message}`);
      failed = true;
    }
  }
  try {
    const { stdout, stderr } = await exec(process.execPath, proxyArgs(options, "status"), {
      cwd: join(root, "apps/proxy"),
      env: { ...process.env, INIT_CWD: root },
      windowsHide: true,
    });
    process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const pidMatch = /Service: ready \(PID (\d+)\)/.exec(stdout);
    if (pidMatch) servicePid = Number(pidMatch[1]);
    if (!/Service: ready/.test(stdout) || !/Relay:\s+connected/.test(stdout)) failed = true;
  } catch (error) {
    console.error(`FAIL Proxy: ${error.message}`);
    failed = true;
  }
  const proxyLogDir =
    options["proxy-log-dir"] ??
    join(
      homedir(),
      ".dev-anywhere",
      ...(options.profile === "default" ? [] : ["profiles", options.profile]),
      "logs",
    );
  for (const file of [
    join(options["log-dir"], `relay-dev-${checkoutId}.log`),
    join(options["log-dir"], `web-dev-${checkoutId}.log`),
    await findServiceLog(proxyLogDir, servicePid),
  ]) {
    const content = await readFile(file, "utf8").catch(() => null);
    if (content === null) console.log(`WARN Log missing: ${file}`);
    else {
      console.log(`Log: ${file}`);
      const suspicious = content
        .split(/\r?\n/)
        .slice(-300)
        .filter(
          (line) =>
            /error|fatal|panic|uncaught|eaddrinuse/i.test(line) &&
            !/NO_COLOR|ECONNRESET|EPIPE|ws proxy socket error/i.test(line),
        );
      if (suspicious.length) console.log(suspicious.slice(-20).join("\n"));
    }
  }
  if (failed) throw new Error("Local development health checks failed");
}

export async function main(command, args) {
  const options = parseArgs(command, args);
  if (options.help) {
    console.log(
      `Usage: pnpm dev:${command} -- ${valueOptions[command].map((name) => `[--${name} <value>]`).join(" ")}\nRestart/health default ports: relay 3100, web 5173. Profile is resolved from local relay URL in config.\nEnvironment: RELAY_URL, DEV_ANYWHERE_HOOK_PORT, DEV_ANYWHERE_WEB_HTTPS_CERT, DEV_ANYWHERE_WEB_HTTPS_KEY.`,
    );
    return;
  }
  if (command !== "restart") return { web, health }[command](options);
  // The OS releases this checkout's restart lock even if the launcher crashes.
  const lock = net.createServer();
  await new Promise((resolveLock, reject) => {
    lock.once("error", () =>
      reject(new Error("Another dev:restart is already running for this checkout")),
    );
    lock.listen(`\\\\.\\pipe\\dev-anywhere-restart-${checkoutId}`, resolveLock);
  });
  try {
    await restart(options);
  } finally {
    await new Promise((resolveClose) => lock.close(resolveClose));
  }
}
