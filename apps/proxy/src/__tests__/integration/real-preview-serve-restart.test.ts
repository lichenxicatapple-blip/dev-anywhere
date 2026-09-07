import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { createRelayServer } from "@dev-anywhere/relay/server";
import {
  DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES,
  RELAY_CONTROL_PROTOCOL_VERSION,
  decodeDevicePreviewHttpFrameHeader,
  type ControlMessage,
  type PreviewScope,
  type RelayControlMessage,
  type RelayControlType,
} from "@dev-anywhere/shared";
import { createLogger } from "@dev-anywhere/shared/logger";
import { tryAcquireFileLock } from "#src/common/file-lock.js";
import { readProcessArgv } from "#src/common/managed-session-process.js";
import { buildProxyProfilePaths } from "#src/common/paths.js";
import { PREVIEW_GATEWAY_MARKER_HEADER } from "#src/serve/preview/preview-response-headers.js";

// Opt-in only: requires an already configured Cpolar and the exact iOS Simulator target to use.
// HOME/config.json are never replaced; all writes belong to one newly allocated profile/site.
const ENABLED = process.env.DEV_ANYWHERE_REAL_PREVIEW_RESTART === "1";
const BUILT = process.env.DEV_ANYWHERE_PREVIEW_TEST_BUILT === "1";
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const SERVE_PATH = fileURLToPath(
  new URL(BUILT ? "../../../dist/serve.js" : "../../serve.ts", import.meta.url),
);
const WORKER_PATH = fileURLToPath(
  new URL(BUILT ? "../../../dist/preview-worker.js" : "../../preview-worker.ts", import.meta.url),
);

async function waitUntil(check: () => boolean | Promise<boolean>, label: string, timeout = 20_000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error(`${label} timed out`);
    await sleep(100);
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("No fixture hook port");
  return address.port;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function stopServe(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  child.kill("SIGTERM");
  await waitUntil(
    () => child.exitCode !== null || child.signalCode !== null,
    "owned Serve exit",
    30_000,
  );
}

describe.skipIf(!ENABLED).sequential("real preview survival across Serve restart", () => {
  it("preserves Cpolar URL and iOS preview identity, then reconnects with a new stream lease", async () => {
    if (process.platform !== "darwin") throw new Error("This real iOS test requires macOS");
    const targetId = process.env.DEV_ANYWHERE_PREVIEW_TEST_TARGET;
    if (!targetId)
      throw new Error("Set DEV_ANYWHERE_PREVIEW_TEST_TARGET to the exact iOS targetId");
    const cpolarBin = process.env.DEV_ANYWHERE_CPOLAR_BIN;
    if (cpolarBin) {
      if (!isAbsolute(cpolarBin)) throw new Error("DEV_ANYWHERE_CPOLAR_BIN must be absolute");
      await access(cpolarBin, constants.X_OK);
    }
    const profile = `pr-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const paths = buildProxyProfilePaths(homedir(), profile);
    const configHash = async () =>
      createHash("sha256")
        .update(await readFile(paths.configPath))
        .digest("hex");
    const originalConfigHash = await configHash();
    await expect(lstat(paths.profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(dirname(paths.profileDir), { recursive: true });
    await mkdir(paths.profileDir); // Exclusive allocation: never reuse an existing user's profile.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "da-preview-restart-"));
    const proxyToken = randomUUID();
    const clientToken = randomUUID();
    const relay = createRelayServer({
      logger: createLogger({ name: "real-preview-restart", silent: true }),
      dataDir: join(fixtureRoot, "relay"),
      webAssetDir: false,
      heartbeatInterval: 60_000,
      proxyToken,
      clientToken,
    });
    const children: ChildProcess[] = [];
    const streams: Array<{
      abort: AbortController;
      reader: ReadableStreamDefaultReader<Uint8Array>;
    }> = [];
    let client: WebSocket | undefined;
    let serve: ChildProcess | undefined;
    let workerPid: number | undefined;
    let scope: PreviewScope | undefined;
    let proxyId: string | undefined;
    let relayUrl = "";
    let phase = "start";
    let failure: unknown;
    let requestNumber = 0;
    const requestId = () => `restart-${++requestNumber}`;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("DEV_ANYWHERE_") || key.startsWith("RELAY_") || key.startsWith("VITEST"))
        delete env[key];
    }
    Object.assign(env, {
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      RELAY_PROXY_TOKEN: proxyToken,
    });
    if (cpolarBin) env.PATH = `${dirname(cpolarBin)}:${env.PATH ?? ""}`;

    function startServe(): ChildProcess {
      const child = spawn(
        process.execPath,
        [...(BUILT ? [] : ["--import", "tsx"]), SERVE_PATH, "--profile", profile],
        {
          cwd: REPO_ROOT,
          env,
          stdio: "ignore",
        },
      );
      child.on("error", () => undefined); // Readiness below reports failure without dumping env/logs.
      children.push(child);
      serve = child;
      return child;
    }

    function exchange<T extends RelayControlType>(
      message: RelayControlMessage,
      type: T,
      timeout = 20_000,
    ): Promise<ControlMessage<T>> {
      const socket = client;
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Fixture client closed");
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          socket.off("message", receive);
          socket.off("close", closed);
        };
        const closed = () => {
          cleanup();
          reject(new Error(`Fixture client closed waiting for ${type}`));
        };
        const receive = (data: WebSocket.RawData) => {
          const response = JSON.parse(data.toString()) as RelayControlMessage;
          if (
            "requestId" in message &&
            (!("requestId" in response) || response.requestId !== message.requestId)
          )
            return;
          if (
            message.type === "device_preview_input" &&
            (response.type !== "device_preview_input_ack" ||
              response.leaseId !== message.leaseId ||
              response.inputSeq !== message.inputSeq)
          )
            return;
          if (response.type !== type && response.type !== "relay_error") return;
          cleanup();
          if (response.type === "relay_error")
            reject(new Error(`Relay rejected ${message.type}: ${response.message}`));
          else resolve(response as ControlMessage<T>);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Waiting for ${type} timed out`));
        }, timeout);
        socket.on("message", receive);
        socket.once("close", closed);
        socket.send(JSON.stringify(message));
      });
    }

    async function selectProxy(): Promise<PreviewScope> {
      await waitUntil(async () => {
        try {
          proxyId = (await readFile(paths.proxyIdPath, "utf8")).trim();
        } catch {
          return false;
        }
        return relay.registry.getProxy(proxyId)?.readyState === WebSocket.OPEN;
      }, "isolated Proxy registration");
      const selected = await exchange(
        { type: "proxy_select", proxyId: proxyId!, requestId: requestId() },
        "proxy_select_response",
      );
      if (!selected.success) throw new Error(`Fixture selection failed: ${selected.error}`);
      scope = { proxyId: selected.proxyId, bindingId: selected.bindingId };
      return scope;
    }
    const webList = () =>
      exchange(
        { type: "preview_list_request", scope: scope!, requestId: requestId() },
        "preview_list_response",
      );
    const deviceList = () =>
      exchange(
        { type: "device_preview_list_request", scope: scope!, requestId: requestId() },
        "device_preview_list_response",
      );

    async function readWorkerPid(): Promise<number | undefined> {
      let log: string;
      try {
        log = await readFile(join(paths.logDir, "preview-worker.log"), "utf8");
      } catch {
        return undefined;
      }
      for (const line of log.split("\n")) {
        try {
          const record = JSON.parse(line) as { msg?: string; profile?: string; pid?: number };
          if (
            record.msg === "Preview worker ready" &&
            record.profile === profile &&
            Number.isSafeInteger(record.pid)
          )
            return record.pid;
        } catch {
          /* A live log may end with a partial record. */
        }
      }
      return undefined;
    }
    function workerIdentityMatches(pid: number): boolean {
      const argv = readProcessArgv(pid);
      const entry = argv?.indexOf(WORKER_PATH) ?? -1;
      return !!argv && entry >= 0 && argv[entry + 1] === "--profile" && argv[entry + 2] === profile;
    }
    async function publicPage(url: string): Promise<string> {
      const target = new URL(url);
      target.searchParams.set("restart_probe", randomUUID());
      const response = await fetch(target, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get(PREVIEW_GATEWAY_MARKER_HEADER)).toBe("1");
      return response.text();
    }
    async function openPicture(previewId: string): Promise<string> {
      let access: ControlMessage<"device_preview_stream_url_response"> | undefined;
      await waitUntil(async () => {
        access = await exchange(
          {
            type: "device_preview_stream_url_request",
            requestId: requestId(),
            scope: scope!,
            previewId,
            profile: { format: "jpeg", maxFps: 5 },
          },
          "device_preview_stream_url_response",
        );
        if (!access.success && access.errorCode !== "PROCESS_START_FAILED")
          throw new Error(access.error);
        return access.success;
      }, "dedicated preview transport");
      if (!access?.success) throw new Error("No device stream lease");
      const abort = new AbortController();
      const response = await fetch(new URL(access.url, relayUrl), {
        headers: { authorization: `Bearer ${clientToken}` },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/x-dev-anywhere-device-preview",
      );
      expect(response.headers.get("cache-control")).toContain("no-store");
      const reader = response.body!.getReader();
      streams.push({ abort, reader });
      let bytes = Buffer.alloc(0);
      while (true) {
        const frame = await reader.read();
        if (frame.done) throw new Error("Device stream ended before a complete JPEG");
        bytes = Buffer.concat([bytes, frame.value]);
        if (bytes.length < DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES) continue;
        const header = decodeDevicePreviewHttpFrameHeader(bytes);
        if (!header) throw new Error("Invalid device preview HTTP frame header");
        const recordLength = DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES + header.jpegLength;
        if (bytes.length < recordLength) continue;
        const jpeg = bytes.subarray(DEVICE_PREVIEW_HTTP_FRAME_HEADER_BYTES, recordLength);
        expect(header.frameSequence).toBeGreaterThanOrEqual(0);
        expect(jpeg.length).toBeGreaterThan(4);
        expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
        expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
        return access.leaseId;
      }
    }

    try {
      env.DEV_ANYWHERE_HOOK_PORT = String(await unusedPort());
      await new Promise<void>((resolve, reject) => {
        relay.httpServer.once("error", reject);
        relay.httpServer.listen(0, "127.0.0.1", resolve);
      });
      const address = relay.httpServer.address();
      if (!address || typeof address === "string") throw new Error("Fixture Relay has no port");
      relayUrl = `http://127.0.0.1:${address.port}`;
      env.RELAY_URL = `ws://127.0.0.1:${address.port}`;
      startServe();
      client = new WebSocket(`${env.RELAY_URL}/client?token=${clientToken}`);
      client.on("error", () => undefined);
      await waitUntil(() => client?.readyState === WebSocket.OPEN, "fixture client open");
      await exchange(
        {
          type: "client_register",
          protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
          clientId: profile,
          browserName: "Preview restart test",
          osName: "macOS",
          deviceKind: "desktop",
        },
        "client_register_response",
      );
      const oldScope = await selectProxy();
      const targets = await exchange(
        {
          type: "device_preview_targets_request",
          requestId: requestId(),
          scope: scope!,
          refresh: true,
        },
        "device_preview_targets_response",
      );
      if (!targets.success) throw new Error(targets.error);
      expect(targets.targets.find((target) => target.targetId === targetId)).toMatchObject({
        platform: "ios",
        interactive: true,
      });

      phase = "create and rename previews";
      const site = join(fixtureRoot, "site");
      await mkdir(site);
      const content = `<!doctype html><h1>preview-restart-${randomUUID()}</h1>`;
      await writeFile(join(site, "index.html"), content);
      const web = await exchange(
        {
          type: "preview_create_request",
          requestId: requestId(),
          scope: scope!,
          operationId: randomUUID(),
          source: { kind: "static", path: await realpath(site), entryPath: "index.html" },
          tunnelProvider: "cpolar",
          name: "Restart site",
        },
        "preview_create_response",
        90_000,
      );
      if (!web.accepted) throw new Error(web.error);
      const device = await exchange(
        {
          type: "device_preview_create_request",
          requestId: requestId(),
          scope: scope!,
          operationId: randomUUID(),
          targetId,
          name: "Restart simulator",
        },
        "device_preview_create_response",
        45_000,
      );
      if (!device.accepted) throw new Error(device.error);
      expect(
        await exchange(
          {
            type: "preview_rename_request",
            requestId: requestId(),
            scope: scope!,
            operationId: randomUUID(),
            previewId: web.previewId,
            name: "Retained site",
          },
          "preview_rename_response",
        ),
      ).toMatchObject({ success: true });
      expect(
        await exchange(
          {
            type: "device_preview_rename_request",
            requestId: requestId(),
            scope: scope!,
            operationId: randomUUID(),
            previewId: device.previewId,
            name: "Retained simulator",
          },
          "device_preview_rename_response",
        ),
      ).toMatchObject({ success: true });
      await waitUntil(
        async () => (await webList()).previews[0]?.state === "ready",
        "Cpolar readiness",
        90_000,
      );
      const beforeWeb = await webList();
      const beforeDevice = await deviceList();
      expect(beforeWeb.previews).toHaveLength(1);
      expect(beforeDevice.previews).toHaveLength(1);
      expect(beforeWeb.previews[0]).toMatchObject({
        previewId: web.previewId,
        name: "Retained site",
      });
      expect(beforeDevice.previews[0]).toMatchObject({
        previewId: device.previewId,
        name: "Retained simulator",
        targetId,
      });
      const summary = beforeWeb.previews[0]!;
      if (summary.state !== "ready") throw new Error("Web preview is not ready");
      expect(await publicPage(summary.publicUrl)).toBe(content);
      const oldLease = await openPicture(device.previewId);
      await waitUntil(async () => {
        workerPid = await readWorkerPid();
        return workerPid !== undefined;
      }, "worker identity log");
      expect(workerIdentityMatches(workerPid!)).toBe(true);

      phase = "Serve stopped while previews survive";
      const firstServe = serve!;
      await stopServe(firstServe);
      expect(firstServe.exitCode).toBe(0);
      expect(alive(workerPid!)).toBe(true);
      expect(await publicPage(summary.publicUrl)).toBe(content);

      phase = "reattach and refresh preview lists";
      startServe();
      const newScope = await selectProxy();
      expect(newScope.bindingId).not.toBe(oldScope.bindingId);
      const afterWeb = await webList();
      const afterDevice = await deviceList();
      expect(afterWeb.epoch).toBe(beforeWeb.epoch);
      expect(afterDevice.epoch).toBe(beforeDevice.epoch);
      expect(afterWeb.previews).toEqual(beforeWeb.previews);
      expect(afterDevice.previews).toEqual(beforeDevice.previews);
      expect(await readWorkerPid()).toBe(workerPid);
      expect(await publicPage(summary.publicUrl)).toBe(content);
      const newLease = await openPicture(device.previewId);
      expect(newLease).not.toBe(oldLease);
      expect(
        await exchange(
          {
            type: "device_preview_input",
            scope: scope!,
            leaseId: newLease,
            inputSeq: 1,
            input: { kind: "button", button: "home" },
          },
          "device_preview_input_ack",
        ),
      ).toMatchObject({ success: true, leaseId: newLease });
    } catch (error) {
      failure = new Error(
        `Real preview restart failed during ${phase}; fixture logs: ${paths.logDir}`,
        { cause: error },
      );
    }
    {
      const cleanupErrors: unknown[] = [];
      for (const stream of streams) {
        stream.abort.abort();
        await stream.reader.cancel().catch(() => undefined);
      }
      try {
        // A create ACK can be lost. This exclusively allocated profile owns every listed preview.
        if (proxyId && client?.readyState === WebSocket.OPEN) {
          if (!serve || serve.exitCode !== null || serve.signalCode !== null) startServe();
          await selectProxy();
          for (const preview of (await deviceList()).previews) {
            expect(
              await exchange(
                {
                  type: "device_preview_close_request",
                  requestId: requestId(),
                  scope: scope!,
                  operationId: randomUUID(),
                  previewId: preview.previewId,
                },
                "device_preview_close_response",
              ),
            ).toMatchObject({ success: true });
          }
          for (const preview of (await webList()).previews) {
            expect(
              await exchange(
                {
                  type: "preview_close_request",
                  requestId: requestId(),
                  scope: scope!,
                  operationId: randomUUID(),
                  previewId: preview.previewId,
                },
                "preview_close_response",
              ),
            ).toMatchObject({ success: true });
          }
          expect((await webList()).previews).toEqual([]);
          expect((await deviceList()).previews).toEqual([]);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const child of children) {
        try {
          await stopServe(child);
        } catch (error) {
          cleanupErrors.push(error);
          child.kill("SIGKILL"); // Only a ChildProcess spawned by this fixture.
          await waitUntil(
            () => child.exitCode !== null || child.signalCode !== null,
            "fixture Serve cleanup",
          ).catch((error: unknown) => cleanupErrors.push(error));
        }
      }
      client?.terminate();
      await relay.close().catch((error: unknown) => cleanupErrors.push(error));
      workerPid ??= await readWorkerPid();
      try {
        if (workerPid !== undefined) {
          try {
            await waitUntil(() => !alive(workerPid!), "empty preview worker exit", 20_000);
          } catch (error) {
            cleanupErrors.push(error);
            if (!workerIdentityMatches(workerPid))
              throw new Error("Refusing to signal an unverified worker", { cause: error });
            process.kill(workerPid, "SIGTERM");
            await waitUntil(() => !alive(workerPid!), "owned worker failure cleanup");
          }
        }
        const lock = tryAcquireFileLock(paths.previewWorkerLock);
        if (!lock) throw new Error("Preview worker still owns the fixture; preserving its files");
        lock.release();
        await rm(paths.profileDir, { recursive: true });
        await rm(fixtureRoot, { recursive: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        expect(await configHash()).toBe(originalConfigHash);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          failure ? [failure, ...cleanupErrors] : cleanupErrors,
          `Preview fixture cleanup failed; profile ${profile}`,
        );
    }
    if (failure) throw failure;
  }, 300_000);
});
