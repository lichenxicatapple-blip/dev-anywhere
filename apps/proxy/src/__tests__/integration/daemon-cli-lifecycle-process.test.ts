import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty, type IPty } from "node-pty";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer } from "@dev-anywhere/relay/server";
import { createLogger } from "@dev-anywhere/shared/logger";
import {
  decodeBinaryFrame,
  RELAY_CONTROL_PROTOCOL_VERSION,
  type ControlMessage,
  type RelayControlMessage,
  type RelayControlType,
} from "@dev-anywhere/shared";
import { tryAcquireFileLock } from "#src/common/file-lock.js";
import {
  processArgvMatchesManagedSession,
  readProcessArgv,
} from "#src/common/managed-session-process.js";
import { buildProxyProfilePaths } from "#src/common/paths.js";
import { requestServiceControl, type ServiceStatus } from "#src/common/service-control.js";

const PROCESS_TIMEOUT_MS = 45_000;
const OUTPUT_LIMIT_BYTES = 128 * 1024;
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../../index.ts", import.meta.url));
const AUTO_START_PATH = fileURLToPath(
  new URL("./fixtures/daemon-auto-start-client.ts", import.meta.url),
);
const FAKE_AGENT_SOURCE = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));

interface Fixture {
  root: string;
  profile: string;
  env: NodeJS.ProcessEnv;
  paths: ReturnType<typeof buildProxyProfilePaths>;
  observedInstances: Map<string, number>;
}
interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
const fixtures = new Set<Fixture>();
const commandChildren = new Map<ChildProcess, Promise<void>>();
const terminalPtys = new Set<IPty>();

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve fixture port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function createFixture(profile = "default", sharedRoot?: string): Promise<Fixture> {
  // Keep real Unix socket paths below macOS's length limit, including non-default profiles.
  const root =
    sharedRoot ?? mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "da-"));
  const paths = buildProxyProfilePaths(root, profile);
  mkdirSync(paths.appDir, { recursive: true });
  const config = sharedRoot
    ? JSON.parse(readFileSync(paths.configPath, "utf8"))
    : {
        defaultProfile: profile,
        autoUpdate: false,
        profiles: {},
        relays: { fixture: { url: "ws://127.0.0.1:1" } },
      };
  config.profiles[profile] = { relay: "fixture" };
  writeFileSync(paths.configPath, JSON.stringify(config), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("DEV_ANYWHERE_") ||
      key.startsWith("RELAY_") ||
      ["CLAUDE_BIN", "CODEX_BIN", "KIMI_BIN", "LOG_LEVEL"].includes(key)
    )
      delete env[key];
  }
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    NODE_ENV: "test",
    VITEST: "1",
    DEV_ANYWHERE_HOOK_PORT: String(await reservePort()),
  });
  const fixture = { root, profile, env, paths, observedInstances: new Map<string, number>() };
  fixtures.add(fixture);
  return fixture;
}

function startNode(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  commandChildren.set(child, new Promise<void>((resolve) => child.once("close", () => resolve())));
  return child;
}

async function collectProcess(child: ChildProcess): Promise<ProcessResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`;
    if (Buffer.byteLength(stdout) > OUTPUT_LIMIT_BYTES) child.kill("SIGKILL");
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`;
    if (Buffer.byteLength(stderr) > OUTPUT_LIMIT_BYTES) child.kill("SIGKILL");
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Daemon CLI fixture timed out: ${stdout}\n${stderr}`));
      }, PROCESS_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    },
  );
  return { ...result, stdout, stderr };
}

async function observeService(fixture: Fixture): Promise<ServiceStatus | null> {
  const service = await requestServiceControl(fixture.paths.serviceControlPath, "status", 1_000);
  if (service) {
    expect(service.profile).toBe(fixture.profile);
    fixture.observedInstances.set(service.instanceId, service.pid);
  }
  return service;
}
async function readyService(fixture: Fixture): Promise<ServiceStatus> {
  const service = await observeService(fixture);
  if (!service || service.state !== "ready") throw new Error("Fixture service is not ready");
  return service;
}
async function waitForReady(fixture: Fixture): Promise<ServiceStatus> {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const service = await observeService(fixture);
    if (service?.state === "ready") return service;
    await sleep(25);
  }
  throw new Error("Fixture service did not become ready");
}
async function runCli(
  fixture: Fixture,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  const result = await collectProcess(
    startNode([CLI_PATH, "--profile", fixture.profile, ...args], {
      ...fixture.env,
      ...envOverrides,
    }),
  );
  await observeService(fixture);
  return result;
}
async function runAutoStart(
  fixture: Fixture,
  intent: "initial" | "reconnect" = "initial",
): Promise<ProcessResult> {
  const result = await collectProcess(
    startNode([AUTO_START_PATH, "--profile", fixture.profile, "--intent", intent], fixture.env),
  );
  await observeService(fixture);
  return result;
}
function expectSuccess(result: ProcessResult): void {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.signal).toBeNull();
}
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
async function waitForProcessToExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (performance.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}
function runtimeIsFree(fixture: Fixture): boolean {
  const lock = tryAcquireFileLock(fixture.paths.serviceRuntimeLockPath);
  if (!lock) return false;
  lock.release();
  return true;
}
function fixtureFailureLogs(fixture: Fixture, sessionId?: string): string {
  try {
    const files = readdirSync(fixture.paths.logDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(service|terminal)-.*\.log$/.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: join(fixture.paths.logDir, entry.name),
        modified: statSync(join(fixture.paths.logDir, entry.name)).mtimeMs,
      }))
      .sort((a, b) => b.modified - a.modified);
    // A failed worker can exit before newer CLI/service logs are created. Keep its
    // own log even when several management commands follow the failure.
    return ["terminal", "service"]
      .flatMap((kind) => files.filter((file) => file.name.startsWith(`${kind}-`)).slice(0, 2))
      .map(({ name, path }) => {
        const contents = readFileSync(path, "utf8");
        if (name.startsWith("terminal-")) {
          return `${name} (worker/terminal head/tail):\n${contents.slice(0, 4_096)}\n...\n${contents.slice(-2_048)}`;
        }
        const related = contents
          .split(/\r?\n/)
          .filter(
            (line) =>
              (sessionId !== undefined && line.includes(sessionId)) ||
              /process identity|identityVerified|load|pending|handshake|foreign.generation|handover/i.test(
                line,
              ),
          );
        if (related.length === 0) {
          return `${name} (no matching events; head/tail):\n${contents.slice(0, 4_096)}\n...\n${contents.slice(-2_048)}`;
        }
        const events = related.join("\n");
        // Preserve startup/load events even when later relay retries fill the end of the file.
        const excerpt =
          events.length <= 8_192
            ? events
            : `${events.slice(0, 6_144)}\n...[matching events truncated]...\n${events.slice(-2_048)}`;
        return `${name} (${related.length} matching events):\n${excerpt}`;
      })
      .join("\n");
  } catch (error) {
    return `Fixture logs unavailable: ${String(error)}`;
  }
}
async function cleanupFixture(fixture: Fixture): Promise<void> {
  // PID files are intentionally corrupted by these tests; only control identifies test services.
  const service = await observeService(fixture);
  if (!service) {
    if (!runtimeIsFree(fixture))
      throw new Error(`Fixture service is unresponsive: ${fixture.root}`);
    return;
  }
  await requestServiceControl(fixture.paths.serviceControlPath, "stop", 1_000);
  if (!(await waitForProcessToExit(service.pid))) {
    const current = await observeService(fixture);
    if (
      current?.instanceId === service.instanceId &&
      fixture.observedInstances.get(service.instanceId) === service.pid
    ) {
      process.kill(service.pid, "SIGKILL");
      if (!(await waitForProcessToExit(service.pid)))
        throw new Error("Fixture service could not be stopped");
    }
  }
}
afterEach(async () => {
  for (const terminal of terminalPtys) terminal.kill();
  await Promise.all([...terminalPtys].map((terminal) => waitForProcessToExit(terminal.pid)));
  terminalPtys.clear();
  for (const [child] of commandChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(commandChildren.values());
  commandChildren.clear();
  for (const fixture of fixtures) await cleanupFixture(fixture);
  for (const root of new Set([...fixtures].map((fixture) => fixture.root)))
    rmSync(root, { recursive: true, force: true });
  fixtures.clear();
});

describe.sequential("daemon CLI lifecycle process boundary", () => {
  it("starts normally when a stale PID file names an unrelated process", async () => {
    const fixture = await createFixture();
    const unrelated = startNode(["-e", "setInterval(() => {}, 1000)"], fixture.env);
    expect(unrelated.pid).toBeDefined();
    mkdirSync(fixture.paths.runDir, { recursive: true });
    writeFileSync(fixture.paths.pidPath, String(unrelated.pid));
    expectSuccess(await runCli(fixture, ["serve", "start"]));
    const service = await readyService(fixture);
    expect(service.pid).not.toBe(unrelated.pid);
    expect(runtimeIsFree(fixture)).toBe(false);
    expect(processIsAlive(unrelated.pid!)).toBe(true);
  }, 20_000);

  it("cleans up an immediately failing daemon without publishing readiness", async () => {
    const fixture = await createFixture();
    writeFileSync(
      fixture.paths.configPath,
      JSON.stringify({
        defaultProfile: fixture.profile,
        autoUpdate: false,
        profiles: { [fixture.profile]: { relay: "missing" } },
        relays: {},
      }),
    );
    const result = await runCli(fixture, ["serve", "start"]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.signal).toBeNull();
    expect(await observeService(fixture)).toBeNull();
    expect(runtimeIsFree(fixture)).toBe(true);
  }, 20_000);

  it("uses one ready instance across parallel CLI starts and initial terminal connections", async () => {
    const fixture = await createFixture();
    const [first, second, ...terminals] = await Promise.all([
      runCli(fixture, ["serve", "start"]),
      runCli(fixture, ["serve", "start"]),
      runAutoStart(fixture),
      runAutoStart(fixture),
      runAutoStart(fixture),
    ]);
    for (const result of [first, second, ...terminals]) expectSuccess(result);
    const service = await readyService(fixture);
    for (const terminal of terminals)
      expect(JSON.parse(terminal.stdout)).toEqual({
        connected: true,
        pid: service.pid,
        instanceId: service.instanceId,
      });
    expect(fixture.observedInstances.size).toBe(1);
    expect(runtimeIsFree(fixture)).toBe(false);
  }, 30_000);

  it.each(["missing", "unrelated"] as const)(
    "stops and restarts through control when the PID file is %s",
    async (damage) => {
      const fixture = await createFixture();
      const unrelated = startNode(["-e", "setInterval(() => {}, 1000)"], fixture.env);
      expect(unrelated.pid).toBeDefined();
      expectSuccess(await runCli(fixture, ["serve", "start"]));
      const original = await readyService(fixture);
      const damagePid = () => {
        if (damage === "missing") rmSync(fixture.paths.pidPath, { force: true });
        else writeFileSync(fixture.paths.pidPath, String(unrelated.pid));
      };
      damagePid();
      expectSuccess(await runCli(fixture, ["serve", "restart"]));
      const replacement = await readyService(fixture);
      expect(replacement.pid).not.toBe(original.pid);
      expect(replacement.instanceId).not.toBe(original.instanceId);
      expect(await waitForProcessToExit(original.pid)).toBe(true);
      expect(processIsAlive(unrelated.pid!)).toBe(true);
      damagePid();
      expectSuccess(await runCli(fixture, ["serve", "stop"]));
      expect(await waitForProcessToExit(replacement.pid)).toBe(true);
      expect(await observeService(fixture)).toBeNull();
      expect(runtimeIsFree(fixture)).toBe(true);
      expect(processIsAlive(unrelated.pid!)).toBe(true);
    },
    30_000,
  );

  it("keeps stopped services stopped for reconnects and allows an explicit new invocation", async () => {
    const fixture = await createFixture();
    expectSuccess(await runAutoStart(fixture));
    const original = await readyService(fixture);
    expectSuccess(await runCli(fixture, ["serve", "stop"]));
    expect(await waitForProcessToExit(original.pid)).toBe(true);
    expect(existsSync(fixture.paths.stoppedPath)).toBe(true);
    const reconnect = await runAutoStart(fixture, "reconnect");
    expect(reconnect.code, `${reconnect.stdout}\n${reconnect.stderr}`).toBe(1);
    expect(await observeService(fixture)).toBeNull();
    expect(runtimeIsFree(fixture)).toBe(true);
    expectSuccess(await runAutoStart(fixture, "initial"));
    expect((await readyService(fixture)).instanceId).not.toBe(original.instanceId);
    expect(existsSync(fixture.paths.stoppedPath)).toBe(false);
  }, 30_000);

  it("does not add a background instance while the foreground service is running", async () => {
    const fixture = await createFixture();
    const child = startNode([CLI_PATH, "--profile", fixture.profile, "serve"], fixture.env);
    const foregroundResult = collectProcess(child);
    const foreground = await waitForReady(fixture);
    expect(foreground.pid).toBe(child.pid);
    expectSuccess(await runCli(fixture, ["serve", "start"]));
    expect((await readyService(fixture)).instanceId).toBe(foreground.instanceId);
    expectSuccess(await runCli(fixture, ["serve", "stop"]));
    expectSuccess(await foregroundResult);
  }, 30_000);

  it("does not add a foreground instance while the background service is running", async () => {
    const fixture = await createFixture();
    expectSuccess(await runCli(fixture, ["serve", "start"]));
    const background = await readyService(fixture);
    expectSuccess(await runCli(fixture, ["serve"]));
    expect((await readyService(fixture)).instanceId).toBe(background.instanceId);
    expect(fixture.observedInstances.size).toBe(1);
  }, 30_000);

  it("isolates different profiles under the same home directory", async () => {
    const first = await createFixture("one");
    const second = await createFixture("two", first.root);
    for (const result of await Promise.all([
      runCli(first, ["serve", "start"]),
      runCli(second, ["serve", "start"]),
    ]))
      expectSuccess(result);
    const firstService = await readyService(first);
    const secondService = await readyService(second);
    expect(firstService.pid).not.toBe(secondService.pid);
    expect(firstService.instanceId).not.toBe(secondService.instanceId);
    expectSuccess(await runCli(first, ["serve", "stop"]));
    expect(await waitForProcessToExit(firstService.pid)).toBe(true);
    expect((await readyService(second)).instanceId).toBe(secondService.instanceId);
    expect(runtimeIsFree(second)).toBe(false);
  }, 30_000);

  it.each(["foreground", "daemon"] as const)(
    "starts through the %s login entry without replacing an existing service",
    async (mode) => {
      const fixture = await createFixture();
      const child = startNode(
        [
          CLI_PATH,
          "--profile",
          fixture.profile,
          "serve",
          "autostart",
          "run",
          ...(mode === "daemon" ? ["--daemon"] : []),
        ],
        fixture.env,
      );
      const loginResult = collectProcess(child);
      const original = await waitForReady(fixture);
      if (mode === "foreground") expect(original.pid).toBe(child.pid);
      else {
        expect(original.pid).not.toBe(child.pid);
        expectSuccess(await loginResult);
      }

      // These invoke the entry point directly; no actual login item or scheduled task is registered.
      for (const args of [
        ["serve", "autostart", "run"],
        ["serve", "autostart", "run", "--daemon"],
        ["serve", "start"],
      ]) {
        expectSuccess(await runCli(fixture, args));
        const current = await readyService(fixture);
        expect(current.pid).toBe(original.pid);
        expect(current.instanceId).toBe(original.instanceId);
      }
      expect(fixture.observedInstances.size).toBe(1);
      expectSuccess(await runCli(fixture, ["serve", "stop"]));
      expectSuccess(await loginResult);
      expect(await waitForProcessToExit(original.pid)).toBe(true);
      expect(runtimeIsFree(fixture)).toBe(true);
    },
    30_000,
  );

  it("restarts with the environment prepared by the restart command", async () => {
    const fixture = await createFixture();
    const oldRelay = "ws://127.0.0.1:22101";
    const newRelay = "ws://127.0.0.1:22102";
    expectSuccess(await runCli(fixture, ["serve", "start"], { RELAY_URL: oldRelay }));
    const original = await readyService(fixture);
    expectSuccess(await runCli(fixture, ["serve", "restart"], { RELAY_URL: newRelay }));
    const replacement = await readyService(fixture);
    expect(replacement.pid).not.toBe(original.pid);
    expect(await waitForProcessToExit(original.pid)).toBe(true);
    expect(replacement.info?.config.relayUrl).toBe(newRelay);
    expect(replacement.info?.config.relayUrlSource).toBe("env");
  }, 30_000);

  it("keeps a local terminal session and its original PTY child alive across restart", async () => {
    const fixture = await createFixture();
    let phase = "ready";
    // Enable real fixture file logs for failure diagnostics.
    delete fixture.env.VITEST;
    const agentPath = join(fixture.root, "fake-agent.mjs");
    copyFileSync(FAKE_AGENT_SOURCE, agentPath);
    const terminal = spawnPty(
      process.execPath,
      ["--import", "tsx", CLI_PATH, "--profile", fixture.profile, "kimi", agentPath],
      {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: REPO_ROOT,
        env: {
          ...fixture.env,
          KIMI_BIN: process.execPath,
          DEV_ANYWHERE_CWD: fixture.root,
        } as Record<string, string>,
      },
    );
    terminalPtys.add(terminal);
    let output = "";
    let exited = false;
    terminal.onData((chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > OUTPUT_LIMIT_BYTES) terminal.kill();
    });
    const terminalResult = new Promise<{ exitCode: number; signal?: number }>((resolve) =>
      terminal.onExit((result) => {
        exited = true;
        terminalPtys.delete(terminal);
        resolve(result);
      }),
    );
    const waitForOutput = async (pattern: RegExp): Promise<RegExpMatchArray> => {
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        const match = output.match(pattern);
        if (match) return match;
        if (exited) throw new Error(`Terminal exited before fixture output: ${output}`);
        await sleep(10);
      }
      throw new Error(`Timed out waiting for fixture output: ${output}`);
    };
    let agentPid: number | undefined;
    let sessionId: string | undefined;
    let failed = false;
    let failure: unknown;
    let failureDetails = "";
    const captureFailure = (): string => {
      const processState = {
        terminalPid: terminal.pid,
        terminalAlive: processIsAlive(terminal.pid),
        terminalExited: exited,
        agentPid,
        agentAlive: agentPid === undefined ? null : processIsAlive(agentPid),
      };
      // This single query diagnoses the still-owned fixture, not the earlier daemon's decision.
      const queryStarted = performance.now();
      const argv = readProcessArgv(terminal.pid);
      const postFailureIdentity = {
        elapsedMs: Math.round(performance.now() - queryStarted),
        argv,
        matches:
          argv === null || sessionId === undefined
            ? null
            : processArgvMatchesManagedSession(argv, {
                id: sessionId,
                mode: "pty",
                provider: "kimi",
                ptyOwner: "local-terminal",
              }),
      };
      return `Local terminal preservation failed during ${phase}:\n${JSON.stringify(processState)}\nPost-failure identity query:\n${JSON.stringify(postFailureIdentity)}\nTerminal output tail:\n${output.slice(-2_048)}\nFixture lifecycle events:\n${fixtureFailureLogs(fixture, sessionId)}`;
    };
    try {
      const ready = await waitForOutput(/FAKE_AGENT_READY:(\d+)/);
      agentPid = Number(ready[1]);
      const original = await readyService(fixture);
      expect(original.info?.sessions).toHaveLength(1);
      const originalSession = original.info!.sessions[0];
      sessionId = originalSession.id;
      expect(originalSession.mode).toBe("pty");
      expect(originalSession.hasWorker).toBe(false);
      expect(JSON.parse(readFileSync(fixture.paths.sessionsPath, "utf8"))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: originalSession.id,
            pid: terminal.pid,
            ptyOwner: "local-terminal",
          }),
        ]),
      );
      expect(processIsAlive(agentPid)).toBe(true);
      expect(exited).toBe(false);

      phase = "restart";
      const restarted = await runCli(fixture, ["serve", "restart", "--json"]);
      expectSuccess(restarted);
      const response = JSON.parse(restarted.stdout);
      expect(response).toMatchObject({ status: "ready", missingSessionIds: [] });
      const replacement = await readyService(fixture);
      expect(replacement.pid).not.toBe(original.pid);
      expect(await waitForProcessToExit(original.pid)).toBe(true);
      expect(replacement.info?.sessions.map((session) => session.id)).toEqual([originalSession.id]);
      expect(exited).toBe(false);
      expect(processIsAlive(terminal.pid)).toBe(true);
      expect(processIsAlive(agentPid)).toBe(true);
      expect(output.match(/FAKE_AGENT_READY:/g)).toHaveLength(1);

      phase = "pong";
      terminal.write("ping\r");
      const pong = await waitForOutput(/FAKE_AGENT_PONG:(\d+)/);
      expect(Number(pong[1])).toBe(agentPid);
    } catch (error) {
      failed = true;
      failure = error;
      failureDetails = captureFailure();
      console.error(failureDetails);
    } finally {
      phase = "exit";
      try {
        if (!exited) terminal.write("exit\r");
        await expect.poll(() => exited, { timeout: 5_000 }).toBe(true);
        expect((await terminalResult).exitCode, output).toBe(0);
        if (agentPid !== undefined) expect(await waitForProcessToExit(agentPid)).toBe(true);
      } catch (error) {
        if (failed) {
          console.error(`Terminal cleanup also failed: ${String(error).slice(-1_024)}`);
        } else {
          failed = true;
          failure = error;
          failureDetails = captureFailure();
          console.error(failureDetails);
        }
      }
    }
    if (failed) {
      // Preserve the original failure and put pre-cleanup evidence in the reporter's message.
      throw new Error(`${String(failure)}\n${failureDetails}`, { cause: failure });
    }
  }, 30_000);

  it("preserves a hosted Agent's worker, PTY and offline output until explicit termination", async () => {
    const fixture = await createFixture("hosted");
    delete fixture.env.VITEST;
    const workDir = join(fixture.root, "工作 目录");
    mkdirSync(workDir);
    const agentPath = join(workDir, "fake-agent.mjs");
    const agentBin = join(workDir, process.platform === "win32" ? "kimi.cmd" : "kimi");
    const journalPath = join(fixture.root, "agent-journal.txt");
    const controlPath = join(fixture.root, "agent-control.txt");
    copyFileSync(FAKE_AGENT_SOURCE, agentPath);
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      agentBin,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${agentPath}" %*\r\n`
        : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(agentPath)} "$@"\n`,
      { mode: 0o755 },
    );
    Object.assign(fixture.env, {
      KIMI_BIN: agentBin,
      DA_LIFECYCLE_AGENT_JOURNAL: journalPath,
      DA_LIFECYCLE_AGENT_CONTROL: controlPath,
    });
    const relay = createRelayServer({
      logger: createLogger({ name: "hosted-lifecycle-fixture", silent: true }),
      dataDir: join(fixture.root, "relay"),
      webAssetDir: false,
      heartbeatInterval: 60_000,
    });
    let client: WebSocket | undefined;
    const messages: RelayControlMessage[] = [];
    const output: Array<{ sessionId: string; outputSeq: number; text: string }> = [];
    let phase = "start";
    let requestNumber = 0;
    let proxyId: string | undefined;
    let sessionId: string | undefined;
    let workerPid: number | undefined;
    let agentPid: number | undefined;
    let socketError: string | undefined;
    let failure: unknown;
    const journal = () => (existsSync(journalPath) ? readFileSync(journalPath, "utf8") : "");
    const persistedSessions = () =>
      (existsSync(fixture.paths.sessionsPath)
        ? JSON.parse(readFileSync(fixture.paths.sessionsPath, "utf8"))
        : []) as Array<{ id: string; pid: number; ptyOwner: string }>;
    const send = (message: RelayControlMessage) => {
      if (client?.readyState !== WebSocket.OPEN) throw new Error("Fixture Web client is closed");
      client.send(JSON.stringify(message));
    };
    const waitForMessage = async <T extends RelayControlType>(type: T, requestId?: string) => {
      const find = () =>
        messages.find(
          (message) =>
            message.type === type &&
            (requestId === undefined ||
              ("requestId" in message && message.requestId === requestId)),
        ) as ControlMessage<T> | undefined;
      await expect.poll(find, { timeout: 15_000, message: `Waiting for ${type}` }).toBeDefined();
      return find()!;
    };
    const snapshot = async () => {
      if (!sessionId) throw new Error("Fixture session was not created");
      const requestId = `snapshot-${++requestNumber}`;
      send({ type: "session_subscribe", sessionId, requestId });
      return waitForMessage("session_snapshot", requestId);
    };
    const selectProxy = async () => {
      if (!proxyId) throw new Error("Fixture Proxy did not register");
      await expect.poll(() => relay.registry.getProxy(proxyId!), { timeout: 10_000 }).toBeDefined();
      const requestId = `select-${++requestNumber}`;
      send({ type: "proxy_select", proxyId, requestId });
      expect(await waitForMessage("proxy_select_response", requestId)).toMatchObject({
        success: true,
      });
    };
    const expectSameSession = async () => {
      await expect
        .poll(
          async () => (await observeService(fixture))?.info?.sessions.map((session) => session.id),
          { timeout: 15_000 },
        )
        .toEqual([sessionId]);
      expect(persistedSessions()).toEqual([
        expect.objectContaining({ id: sessionId, pid: workerPid, ptyOwner: "proxy-hosted" }),
      ]);
      expect(processIsAlive(workerPid!)).toBe(true);
      expect(processIsAlive(agentPid!)).toBe(true);
      expect(journal().match(/FAKE_AGENT_READY:/g)).toHaveLength(1);
      // Relay unbinds clients while a Proxy is offline. Match the browser's selection
      // handshake before requesting the reconnected terminal's snapshot.
      await selectProxy();
    };
    const cleanupOwnedProcesses = async () => {
      // This out-of-band exit is only failure cleanup for our fake CLI, never the assertion
      // path. It does not use or signal the developer's active Proxy or terminal processes.
      writeFileSync(controlPath, "exit");
      agentPid ??= Number(journal().match(/FAKE_AGENT_READY:(\d+)/)?.[1]) || undefined;
      if (agentPid !== undefined && !(await waitForProcessToExit(agentPid))) {
        const argv = readProcessArgv(agentPid);
        if (!argv?.includes(agentPath)) {
          throw new Error("Refusing to clean up an unverified fixture Agent");
        }
        process.kill(agentPid, "SIGKILL");
        expect(await waitForProcessToExit(agentPid)).toBe(true);
      }
      if (workerPid !== undefined && !(await waitForProcessToExit(workerPid))) {
        const argv = readProcessArgv(workerPid);
        if (
          !sessionId ||
          !argv ||
          !processArgvMatchesManagedSession(argv, {
            id: sessionId,
            kind: "agent",
            mode: "pty",
            provider: "kimi",
            ptyOwner: "proxy-hosted",
          })
        ) {
          throw new Error("Refusing to clean up an unverified fixture worker");
        }
        process.kill(workerPid, "SIGTERM");
        expect(await waitForProcessToExit(workerPid)).toBe(true);
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        relay.httpServer.once("error", reject);
        relay.httpServer.listen(0, "127.0.0.1", resolve);
      });
      const address = relay.httpServer.address();
      if (!address || typeof address === "string") throw new Error("Fixture Relay has no port");
      fixture.env.RELAY_URL = `ws://127.0.0.1:${address.port}`;
      expectSuccess(await runCli(fixture, ["serve", "start", "--json"]));
      const original = await readyService(fixture);
      proxyId = readFileSync(fixture.paths.proxyIdPath, "utf8").trim();

      client = new WebSocket(`ws://127.0.0.1:${address.port}/client`);
      client.on("error", (error) => (socketError = String(error)));
      client.on("message", (data, isBinary) => {
        if (isBinary) {
          const buffer = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          const frame = decodeBinaryFrame(buffer);
          if (frame)
            output.push({
              sessionId: frame.sessionId,
              outputSeq: frame.outputSeq,
              text: Buffer.from(frame.data).toString("utf8"),
            });
          if (output.length > 1_024) output.shift();
        } else {
          messages.push(JSON.parse(data.toString()) as RelayControlMessage);
          if (messages.length > 256) messages.shift();
        }
      });
      await expect.poll(() => client?.readyState, { timeout: 5_000 }).toBe(WebSocket.OPEN);
      send({
        type: "client_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        clientId: "hosted-lifecycle-browser",
        browserName: "Chrome",
        osName: process.platform === "win32" ? "Windows" : "macOS",
        deviceKind: "desktop",
      });
      await waitForMessage("client_register_response");
      await selectProxy();

      phase = "create hosted Agent";
      send({
        type: "session_create",
        requestId: "create-hosted",
        kind: "agent",
        provider: "kimi",
        mode: "pty",
        cwd: workDir,
        cols: 100,
        rows: 30,
      });
      const created = await waitForMessage("session_create_response", "create-hosted");
      expect(created).toMatchObject({
        success: true,
        kind: "agent",
        mode: "pty",
        ptyOwner: "proxy-hosted",
      });
      if (!created.success) throw new Error(created.error);
      sessionId = created.sessionId;
      workerPid = persistedSessions().find((session) => session.id === sessionId)?.pid;
      await expect.poll(() => journal(), { timeout: 10_000 }).toMatch(/FAKE_AGENT_READY:\d+/);
      agentPid = Number(journal().match(/FAKE_AGENT_READY:(\d+)/)![1]);
      expect(workerPid).toBeGreaterThan(0);
      expect(workerPid).not.toBe(agentPid);
      expect(workerPid).not.toBe(original.pid);
      const initialSnapshot = await snapshot();

      phase = "restart";
      const restarted = await runCli(fixture, ["serve", "restart", "--json"]);
      expectSuccess(restarted);
      expect(JSON.parse(restarted.stdout)).toMatchObject({
        status: "ready",
        missingSessionIds: [],
      });
      const replacement = await readyService(fixture);
      expect(replacement.pid).not.toBe(original.pid);
      expect(await waitForProcessToExit(original.pid)).toBe(true);
      await expectSameSession();
      const restartedSnapshot = await snapshot();
      expect(restartedSnapshot).toMatchObject({ sessionId, cols: 100, rows: 30 });
      expect(restartedSnapshot.data).toContain(`FAKE_AGENT_READY:${agentPid}`);
      expect(restartedSnapshot.outputSeq).toBeGreaterThanOrEqual(initialSnapshot.outputSeq);

      phase = "output while Proxy is stopped";
      expectSuccess(await runCli(fixture, ["serve", "stop", "--json"]));
      expect(await waitForProcessToExit(replacement.pid)).toBe(true);
      expect(await observeService(fixture)).toBeNull();
      writeFileSync(controlPath, "offline");
      await expect
        .poll(() => journal().match(/FAKE_AGENT_OFFLINE:/g)?.length ?? 0, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(3);
      writeFileSync(controlPath, "");
      const offlineLine = journal()
        .match(/FAKE_AGENT_OFFLINE:\d+:\d+/g)!
        .at(-1)!;
      expect(await observeService(fixture)).toBeNull();
      expect(processIsAlive(workerPid!)).toBe(true);
      expect(processIsAlive(agentPid)).toBe(true);

      phase = "reattach snapshot and input";
      expectSuccess(await runCli(fixture, ["serve", "start", "--json"]));
      await expectSameSession();
      const reattachedSnapshot = await snapshot();
      expect(reattachedSnapshot).toMatchObject({ sessionId, cols: 100, rows: 30 });
      expect(reattachedSnapshot.data).toContain(offlineLine);
      expect(reattachedSnapshot.outputSeq).toBeGreaterThan(restartedSnapshot.outputSeq);
      send({ type: "remote_input_raw", sessionId, data: "ping\r" });
      await expect
        .poll(
          () =>
            output
              .filter(
                (frame) =>
                  frame.sessionId === sessionId && frame.outputSeq > reattachedSnapshot.outputSeq,
              )
              .map((frame) => frame.text)
              .join(""),
          { timeout: 5_000 },
        )
        .toContain(`FAKE_AGENT_PONG:${agentPid}`);

      phase = "explicit session termination";
      send({ type: "session_terminate", sessionId });
      expect(await waitForProcessToExit(agentPid)).toBe(true);
      expect(await waitForProcessToExit(workerPid!)).toBe(true);
      await expect.poll(() => persistedSessions().map((session) => session.id)).toEqual([]);
      expectSuccess(await runCli(fixture, ["serve", "restart", "--json"]));
      expect((await readyService(fixture)).info?.sessions).toEqual([]);
      expect(journal().match(/FAKE_AGENT_READY:/g)).toHaveLength(1);
    } catch (error) {
      failure = new Error(
        `${String(error)}\nHosted lifecycle failed during ${phase}.\n` +
          `runtime=${process.version}, executable=${process.execPath}\n` +
          `sessionId=${sessionId}, workerPid=${workerPid}, agentPid=${agentPid}, socketError=${socketError}\n` +
          `Agent journal:\n${journal().slice(-4_096)}\n` +
          `Web messages:\n${JSON.stringify(messages.slice(-8)).slice(-4_096)}\n` +
          fixtureFailureLogs(fixture, sessionId),
        { cause: error },
      );
    } finally {
      try {
        await cleanupOwnedProcesses();
      } catch (error) {
        if (failure) console.error(`Hosted fixture cleanup also failed: ${String(error)}`);
        else failure = error;
      } finally {
        client?.terminate();
        await relay.close();
      }
    }
    if (failure) throw failure;
  }, 90_000);
});
