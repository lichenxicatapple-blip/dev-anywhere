import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { decodeBinaryFrame, RELAY_CONTROL_PROTOCOL_VERSION } from "@dev-anywhere/shared";
import { spawnCommand } from "../src/common/command-launch.js";
import { buildProxyProfilePaths } from "../src/common/paths.js";
import { requestServiceControl } from "../src/common/service-control.js";
import { requestServiceHost } from "../src/common/service-host-control.js";
import { installAcceptanceService } from "./auto-update-service.js";

// Full native acceptance: packaged entrypoints, the real Relay, real npm installs, an OS
// service (or detached daemon), and an interactive shell. No updater mocks or shorter timers.
// Versions 0.0.1-3 belong only to this loopback registry; these artifacts are never published.
if (process.env.CI !== "true") throw new Error("Run on a disposable native CI host");
const mode = process.argv.includes("--daemon") ? "daemon" : "system";
const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(
  join(process.platform === "win32" ? (process.env.PUBLIC ?? tmpdir()) : "/tmp", "da-update-"),
);
const runtimeHome =
  process.platform === "win32" && mode === "system" ? join(root, "account") : homedir();
const profile = `update-${randomUUID().slice(0, 8)}`;
const paths = buildProxyProfilePaths(runtimeHome, profile);
const prefix = join(root, "npm");
const packageRoot = join(
  prefix,
  ...(process.platform === "win32" ? [] : ["lib"]),
  "node_modules",
  "@dev-anywhere",
  "proxy",
);
const entry = join(packageRoot, "dist", "index.js");
const npm = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
const originalConfig = existsSync(paths.configPath) ? await readFile(paths.configPath) : null;
const token = randomUUID();
const artifacts = new Map<
  string,
  { manifest: Record<string, unknown>; tar: Buffer; integrity: string }
>();
let blockTarball = false;
let blockedRequests = 0;
let relay: ChildProcess | undefined;
let client: WebSocket | undefined;
let service: Awaited<ReturnType<typeof installAcceptanceService>> | undefined;
let sessionId: string | undefined;
let originalWorkerPid: number | undefined;
let proxyId: string | undefined;
let shellOutput = "";
let requestNumber = 0;
const messages: Array<Record<string, unknown>> = [];
const startedAt = Date.now();
const log = (event: string, details: unknown = {}) =>
  console.log(
    JSON.stringify({
      event,
      platform: process.platform,
      mode,
      elapsedMs: Date.now() - startedAt,
      ...(details as object),
    }),
  );
const registry = createServer((req, res) => {
  const url = new URL(req.url!, "http://localhost");
  const name = decodeURIComponent(url.pathname);
  if (name === "/@dev-anywhere/proxy") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        name: "@dev-anywhere/proxy",
        "dist-tags": { latest: "0.0.3" },
        versions: Object.fromEntries(
          [...artifacts].map(([version, item]) => [
            version,
            {
              ...item.manifest,
              dist: { tarball: `${registryUrl}/proxy-${version}.tgz`, integrity: item.integrity },
            },
          ]),
        ),
      }),
    );
  } else if (/^\/proxy-[\d.]+\.tgz$/.test(name)) {
    const version = name.slice("/proxy-".length, -".tgz".length);
    const artifact = artifacts.get(version);
    if (!artifact) {
      res.writeHead(404).end();
      return;
    }
    if (blockTarball && version === "0.0.3") {
      blockedRequests++;
      log("tarball_download_stalled", { request: blockedRequests });
      // Send a partial body and leave it open. npm must enforce its actual fetch timeout.
      res.writeHead(200, {
        "Content-Length": artifact.tar.length,
        "Content-Type": "application/octet-stream",
      });
      res.write(artifact.tar.subarray(0, 256));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(artifact.tar);
  } else {
    // Dependency metadata and tarballs remain the real public npm artifacts.
    res.writeHead(307, { Location: `https://registry.npmjs.org${req.url}` }).end();
  }
});
await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
const registryAddress = registry.address();
assert(registryAddress && typeof registryAddress === "object");
const registryUrl = `http://127.0.0.1:${registryAddress.port}`;
const env = {
  ...process.env,
  npm_config_prefix: prefix,
  npm_config_cache: join(root, "npm-cache"),
  npm_config_registry: registryUrl,
};
const environmentModule = join(root, "environment.mjs");
await writeFile(
  environmentModule,
  `Object.assign(process.env, ${JSON.stringify({ npm_config_prefix: prefix, npm_config_cache: env.npm_config_cache, npm_config_registry: registryUrl })});`,
);

async function command(command: string, args: string[], cwd = root) {
  return new Promise<string>((done, reject) => {
    const child = spawnCommand(command, args, {
      env,
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data;
    });
    child.stderr?.on("data", (data) => {
      output += data;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? done(output)
        : reject(new Error(`${command} ${args.join(" ")} (${code}):\n${output}`)),
    );
  });
}
async function waitFor<T>(
  description: string,
  probe: () => Promise<T> | T,
  timeout = 60000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result as NonNullable<T>;
    await delay(300);
  }
  throw new Error(`Timed out: ${description}`);
}
async function logs(prefix: string) {
  if (!existsSync(paths.logDir)) return [];
  const files = (await readdir(paths.logDir)).filter(
    (name) => name.startsWith(prefix + "-") && name.endsWith(".log"),
  );
  const records: Array<Record<string, unknown>> = [];
  for (const name of files)
    for (const line of (await readFile(join(paths.logDir, name), "utf8")).trim().split("\n")) {
      try {
        records.push(JSON.parse(line));
      } catch {
        /* An active writer can have an incomplete last line. */
      }
    }
  return records.sort((a, b) => Number(a.time) - Number(b.time));
}
async function status() {
  return requestServiceControl(paths.serviceControlPath, "status", 2000).catch(() => null);
}
async function pack(version: string) {
  const directory = join(root, `package-${version}`);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  await mkdir(directory, { recursive: true });
  for (const name of manifest.files)
    await cp(join(source, name), join(directory, name), { recursive: true });
  manifest.version = version;
  manifest.dependencies["@dev-anywhere/relay"] = JSON.parse(
    await readFile(join(source, "../relay/package.json"), "utf8"),
  ).version;
  delete manifest.devDependencies;
  delete manifest.scripts.prepack;
  delete manifest.scripts.prepublishOnly;
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  const output = JSON.parse(await command(npm, ["pack", "--ignore-scripts", "--json"], directory));
  const tar = await readFile(join(directory, output[0].filename));
  artifacts.set(version, {
    manifest,
    tar,
    integrity: `sha512-${createHash("sha512").update(tar).digest("base64")}`,
  });
  log("candidate_packed", { version, sha256: createHash("sha256").update(tar).digest("hex") });
}
async function stopRelay() {
  client?.terminate();
  client = undefined;
  if (!relay || relay.exitCode !== null) return;
  const stopped = new Promise<void>((done) => relay!.once("close", () => done()));
  relay.kill();
  await stopped;
  relay = undefined;
}
let relayRoot: string;
let relayPort: number;
async function startRelay(version: string) {
  await stopRelay();
  const manifestPath = join(relayRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version }));
  const script = join(root, "relay.mjs");
  await writeFile(
    script,
    `
import { createRelayServer } from ${JSON.stringify(pathToFileURL(join(relayRoot, "dist/server.js")).href)};
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(relayRoot, "package.json"))});
const server = createRelayServer({ logger: require('pino')({level:'error'}), proxyToken:${JSON.stringify(token)},clientToken:${JSON.stringify(token)},dataDir:${JSON.stringify(join(root, "relay-data"))},webAssetDir:false });
server.httpServer.listen(${relayPort},'127.0.0.1',()=>console.log('RELAY_READY'));
`,
  );
  relay = spawn(process.execPath, [script], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  relay.stdout!.on("data", (data) => {
    output += data;
  });
  relay.stderr!.on("data", (data) => {
    output += data;
  });
  await waitFor("Relay ready", () => {
    if (relay?.exitCode !== null) throw new Error(`Relay exited: ${output}`);
    return output.includes("RELAY_READY");
  });
  log("relay_started", { version, pid: relay.pid });
}
function send(message: Record<string, unknown>) {
  assert(client?.readyState === WebSocket.OPEN);
  client.send(JSON.stringify(message));
}
async function response(type: string, requestId?: string) {
  return waitFor(type, () =>
    messages.find(
      (item) => item.type === type && (requestId === undefined || item.requestId === requestId),
    ),
  );
}
async function connectBrowser() {
  messages.length = 0;
  client = new WebSocket(`ws://127.0.0.1:${relayPort}/client?token=${encodeURIComponent(token)}`);
  client.on("error", (error) => log("client_socket_error", { error: String(error) }));
  client.on("message", (data, binary) => {
    if (binary) {
      const frame = decodeBinaryFrame(Buffer.from(data as Buffer));
      if (frame?.sessionId === sessionId) shellOutput += Buffer.from(frame.data).toString("utf8");
    } else messages.push(JSON.parse(data.toString()));
  });
  await waitFor("browser connection", () => client?.readyState === WebSocket.OPEN);
  send({
    type: "client_register",
    protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
    clientId: profile,
    browserName: "Acceptance",
    osName: process.platform,
    deviceKind: "desktop",
  });
  await response("client_register_response");
  const requestId = `select-${++requestNumber}`;
  send({ type: "proxy_select", requestId, proxyId });
  assert.equal((await response("proxy_select_response", requestId)).success, true);
}
async function checkShell(label: string) {
  const requestId = `snapshot-${++requestNumber}`;
  send({ type: "session_subscribe", sessionId, requestId });
  await response("session_snapshot", requestId);
  const marker = `DA_OK_${randomUUID().replaceAll("-", "")}`;
  shellOutput = "";
  // Construct the marker in the shell so the echoed input cannot satisfy the assertion.
  send({
    type: "remote_input_raw",
    sessionId,
    data:
      process.platform === "win32"
        ? `Write-Output ('DA_OK_' + '${marker.slice(6)}')\r`
        : `printf 'DA_%s\\n' 'OK_${marker.slice(6)}'\r`,
  });
  await waitFor("shell command output", () => shellOutput.includes(marker));
  const sessions = JSON.parse(await readFile(paths.sessionsPath, "utf8"));
  const session = sessions.find((item: { id: string }) => item.id === sessionId);
  assert(session, "Original terminal session is missing");
  originalWorkerPid ??= session.pid;
  assert.equal(session.pid, originalWorkerPid, "Terminal worker was replaced");
  log("original_shell_responded", { label, sessionId, workerPid: originalWorkerPid });
}
try {
  log("acceptance_started", { node: process.version, root });
  for (const version of ["0.0.1", "0.0.2", "0.0.3"]) await pack(version);
  // Install the baseline once. From this point target versions are installed only by Proxy.
  log("baseline_install", {
    output: await command(npm, [
      "install",
      "--global",
      "@dev-anywhere/proxy@0.0.1",
      "--no-audit",
      "--no-fund",
    ]),
  });
  const baselineRequire = createRequire(join(packageRoot, "package.json"));
  const installedRelay = dirname(dirname(baselineRequire.resolve("@dev-anywhere/relay/server")));
  const relayCopy = join(root, "relay-runtime");
  await cp(packageRoot, relayCopy, { recursive: true, verbatimSymlinks: true });
  relayRoot = installedRelay.replace(packageRoot, relayCopy);
  const portServer = createServer();
  await new Promise<void>((done) => portServer.listen(0, "127.0.0.1", done));
  const address = portServer.address();
  assert(address && typeof address === "object");
  relayPort = address.port;
  await new Promise<void>((done, reject) =>
    portServer.close((error) => (error ? reject(error) : done())),
  );
  const config = originalConfig
    ? JSON.parse(originalConfig.toString())
    : { profiles: {}, relays: {} };
  config.autoUpdate = true;
  config.profiles[profile] = { relay: profile };
  config.relays[profile] = { url: `ws://127.0.0.1:${relayPort}`, proxyToken: token };
  await mkdir(dirname(paths.configPath), { recursive: true });
  await writeFile(paths.configPath, JSON.stringify(config), { mode: 0o600 });
  await startRelay("0.0.1");
  if (mode === "system")
    service = await installAcceptanceService({
      home: runtimeHome,
      profile,
      entry,
      environmentModule: pathToFileURL(environmentModule).href,
      root,
    });
  else
    log("daemon_start", {
      output: await command(process.execPath, [
        entry,
        "--profile",
        profile,
        "serve",
        "start",
        "--json",
      ]),
    });
  const baseline = await waitFor("baseline connected", async () => {
    const current = await status();
    return current?.state === "ready" &&
      current.info?.relay?.connected &&
      current.version === "0.0.1"
      ? current
      : null;
  });
  proxyId = baseline.info!.relay!.proxyId;
  const host =
    mode === "system"
      ? await requestServiceHost(paths.serviceHostPath, profile, { action: "probe" })
      : undefined;
  if (mode === "system") assert.equal(host?.status, "host");
  log("baseline_connected", { daemonPid: baseline.pid, host, service: service?.label });
  await connectBrowser();
  send({
    type: "session_create",
    requestId: "create",
    kind: "terminal",
    mode: "pty",
    ...(process.platform === "win32" ? { shell: "powershell" } : {}),
    cols: 100,
    rows: 30,
  });
  const created = await response("session_create_response", "create");
  assert.equal(created.success, true, JSON.stringify(created));
  sessionId = String(created.sessionId);
  await checkShell("before-upgrade");
  await startRelay("0.0.2");
  const updated = await waitFor(
    "first automatic upgrade",
    async () => {
      const current = await status();
      return current?.version === "0.0.2" && current.info?.relay?.connected ? current : null;
    },
    6 * 60000,
  );
  assert.notEqual(updated.pid, baseline.pid);
  assert.equal((await command(process.execPath, [entry, "--version"])).trim(), "0.0.2");
  await connectBrowser();
  await checkShell("after-first-upgrade");
  log("automatic_upgrade_passed", { from: "0.0.1", to: "0.0.2", daemonPid: updated.pid });
  blockTarball = true;
  await startRelay("0.0.3");
  const retry = await waitFor(
    "download failure and automatic retry scheduled",
    async () => (await logs("service")).find((item) => item.msg === "Proxy auto-update will retry"),
    7 * 60000,
  );
  assert.equal(retry.retryInMs, 900000, "The production retry timer must remain 15 minutes");
  assert(blockedRequests > 0, "The updater did not attempt the real tarball download");
  const stillRunning = await status();
  assert.equal(stillRunning?.pid, updated.pid, "Download failure stopped the old daemon");
  assert.equal(stillRunning?.version, "0.0.2");
  assert.equal(
    (await command(process.execPath, [entry, "--version"])).trim(),
    "0.0.2",
    "The npm installation was not restored",
  );
  await connectBrowser();
  await checkShell("after-download-failure");
  blockTarball = false;
  log("failure_recovered_waiting_for_real_retry", { retry, blockedRequests });
  const recovered = await waitFor(
    "default automatic retry succeeds",
    async () => {
      const current = await status();
      return current?.version === "0.0.3" && current.info?.relay?.connected ? current : null;
    },
    20 * 60000,
  );
  assert.notEqual(recovered.pid, updated.pid);
  assert.equal((await command(process.execPath, [entry, "--version"])).trim(), "0.0.3");
  client?.terminate();
  await connectBrowser();
  await checkShell("after-automatic-retry");
  if (mode === "system")
    assert.deepEqual(
      await requestServiceHost(paths.serviceHostPath, profile, { action: "probe" }),
      host,
      "System service host was replaced",
    );
  log("ACCEPTANCE_PASSED", {
    from: "0.0.1",
    to: "0.0.3",
    daemonPid: recovered.pid,
    originalWorkerPid,
    retryInMs: retry.retryInMs,
  });
} catch (error) {
  for (const kind of ["service", "auto-update", "terminal"])
    for (const record of await logs(kind)) log(`diagnostic_${kind}`, record);
  throw error;
} finally {
  if (sessionId && client?.readyState === WebSocket.OPEN) {
    send({ type: "session_terminate", sessionId });
    await delay(1000);
  }
  if (service) await service.dispose();
  else if (existsSync(entry))
    await command(process.execPath, [entry, "--profile", profile, "serve", "stop", "--json"]).catch(
      (error) => log("cleanup_error", { error: String(error) }),
    );
  await stopRelay();
  registry.closeAllConnections();
  await new Promise<void>((done) => registry.close(() => done()));
  if (originalConfig) await writeFile(paths.configPath, originalConfig);
  else await rm(paths.configPath, { force: true });
  // Keep the diagnostics on the disposable runner for the workflow artifact upload.
  await mkdir(join(source, "../../artifacts/auto-update"), { recursive: true });
  if (existsSync(paths.logDir))
    await cp(
      paths.logDir,
      join(source, "../../artifacts/auto-update", `${process.platform}-${mode}`),
      { recursive: true, dereference: true },
    );
  await delay(6000);
  await rm(paths.profileDir, { recursive: true, force: true, maxRetries: 5 }).catch(
    () => undefined,
  );
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch((error) =>
    log("retained_runner_files", { error: String(error) }),
  );
}
