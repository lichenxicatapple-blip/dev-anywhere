import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  IosSimulatorAdapter,
  isSupportedBaguetteVersion,
  parseBaguetteChromeLayout,
  parseBaguetteVersion,
  type BaguetteWebSocketFactory,
  type ExecFileRunner,
  type SpawnRunner,
} from "#src/serve/device-preview/ios-adapter.js";

const BAGUETTE = "/opt/dev-anywhere/bin/baguette";
const BOOTED_UDID = "8A9E7E48-71B5-48C1-BD3F-E29CDBDC7A21";
const SHUTDOWN_UDID = "117F8F48-A899-469B-A544-8B1D7DF8AB31";

interface MockChild {
  child: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

class MockWebSocket extends EventEmitter {
  readyState = 0;
  readonly sent: string[] = [];
  readonly ping = vi.fn((_callback?: (error?: Error) => void) => {
    queueMicrotask(() => _callback?.());
  });
  readonly terminate = vi.fn(() => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", 1006, Buffer.alloc(0));
  });

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  send(payload: string | Buffer, callback?: (error?: Error) => void): void {
    this.sent.push(payload.toString());
    queueMicrotask(() => callback?.());
  }

  receiveBinary(payload: Buffer): void {
    this.emit("message", payload, true);
  }

  receiveJson(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)), false);
  }

  receivePong(): void {
    this.emit("pong", Buffer.alloc(0));
  }
}

interface MockSocketHarness {
  socket: MockWebSocket;
  createWebSocket: BaguetteWebSocketFactory;
  urls: string[];
}

function mockSocketHarness(): MockSocketHarness {
  const socket = new MockWebSocket();
  const urls: string[] = [];
  const createWebSocket: BaguetteWebSocketFactory = vi.fn((url) => {
    urls.push(url);
    queueMicrotask(() => socket.open());
    return socket as unknown as WebSocket;
  });
  return { socket, createWebSocket, urls };
}

function simctlOutput(): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
        {
          udid: BOOTED_UDID.toLowerCase(),
          name: "iPhone 17 Pro",
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
          state: "Booted",
          isAvailable: true,
        },
        {
          udid: SHUTDOWN_UDID,
          name: "iPhone Air",
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-Air",
          state: "Shutdown",
          isAvailable: true,
        },
        {
          udid: "--help",
          name: "Injected",
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
          state: "Booted",
          isAvailable: true,
        },
      ],
      "com.apple.CoreSimulator.SimRuntime.tvOS-26-0": [
        {
          udid: "DA1C6E74-AB0E-47F1-B764-47A7D4C242B1",
          name: "Apple TV",
          state: "Booted",
          isAvailable: true,
        },
      ],
    },
  });
}

function chromeLayoutOutput(width = 402, height = 874): string {
  return JSON.stringify({
    identifier: "phone-test",
    composite: { width: 450, height: 922 },
    screen: { x: 24, y: 24, width, height },
    buttons: [],
  });
}

function mockChild(): MockChild {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill,
  });
  return { child, stdin, stdout, stderr, kill };
}

function spawnWithInputProcess(serveProcess: MockChild, inputProcess: MockChild): SpawnRunner {
  return vi.fn((_command, args) => (args[0] === "input" ? inputProcess.child : serveProcess.child));
}

function acknowledgeInputProcess(
  inputProcess: MockChild,
  acknowledge = true,
): Array<Record<string, unknown>> {
  const envelopes: Array<Record<string, unknown>> = [];
  let buffered = "";
  inputProcess.stdin.setEncoding("utf8");
  inputProcess.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines) {
      if (!line) continue;
      envelopes.push(JSON.parse(line) as Record<string, unknown>);
      if (acknowledge) queueMicrotask(() => inputProcess.stdout.write('{"ok":true}\n'));
    }
  });
  return envelopes;
}

function discoveryExecFile(
  onOther?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>,
  layoutOutput = chromeLayoutOutput(),
): ExecFileRunner {
  return vi.fn(async (command, args) => {
    if (
      command === "xcrun" &&
      args.join("\0") === ["simctl", "list", "devices", "available", "--json"].join("\0")
    ) {
      return { stdout: simctlOutput(), stderr: "" };
    }
    if (
      command === BAGUETTE &&
      args.join("\0") === ["chrome", "layout", "--udid", BOOTED_UDID].join("\0")
    ) {
      return { stdout: layoutOutput, stderr: "" };
    }
    if (onOther) return onOther(command, args);
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
}

function adapterWith(
  execFile: ExecFileRunner,
  spawn?: SpawnRunner,
  options: {
    inputAckTimeoutMs?: number;
    maxJpegFrameBytes?: number;
    createWebSocket?: BaguetteWebSocketFactory;
    reserveLoopbackPort?: () => Promise<number>;
  } = {},
): IosSimulatorAdapter {
  return new IosSimulatorAdapter({
    baguetteCommand: BAGUETTE,
    baguetteEnv: { PATH: "/isolated", BAGUETTE_MARKER: "test" },
    simctlEnv: { PATH: "/usr/bin", SIMCTL_MARKER: "test" },
    execFile,
    spawn,
    reserveLoopbackPort: async () => 43_123,
    ...options,
  });
}

describe("IosSimulatorAdapter capability and discovery", () => {
  it("parses only a single exact semantic Baguette version", () => {
    expect(parseBaguetteVersion("0.1.97\n")).toBe("0.1.97");
    expect(parseBaguetteVersion("baguette 0.1.97-beta.1+build.7")).toBe("0.1.97-beta.1+build.7");
    expect(parseBaguetteVersion("Baguette version v1.2.3")).toBe("1.2.3");
    expect(parseBaguetteVersion("baguette 01.2.3")).toBeNull();
    expect(parseBaguetteVersion("baguette 1.2.3-alpha.01")).toBeNull();
    expect(parseBaguetteVersion("baguette 1.2.3\nuntrusted output")).toBeNull();
    expect(parseBaguetteVersion("1.2")).toBeNull();
  });

  it("requires stable Baguette 0.1.96 or newer for the serve data path", () => {
    expect(isSupportedBaguetteVersion("0.1.95")).toBe(false);
    expect(isSupportedBaguetteVersion("0.1.96-beta.1")).toBe(false);
    expect(isSupportedBaguetteVersion("0.1.96")).toBe(true);
    expect(isSupportedBaguetteVersion("0.1.97+release.1")).toBe(true);
    expect(isSupportedBaguetteVersion("1.0.0-rc.1")).toBe(false);
    expect(isSupportedBaguetteVersion("1.0.0")).toBe(true);
  });

  it("strictly parses logical point dimensions from Baguette chrome layout", () => {
    expect(parseBaguetteChromeLayout(chromeLayoutOutput())).toEqual({
      width: 402,
      height: 874,
    });
    for (const invalid of [
      "not-json",
      "null",
      "[]",
      "{}",
      '{"screen":null}',
      '{"screen":{"width":"402","height":874}}',
      '{"screen":{"width":402.5,"height":874}}',
      '{"screen":{"width":0,"height":874}}',
      '{"screen":{"width":402,"height":16385}}',
    ]) {
      expect(() => parseBaguetteChromeLayout(invalid)).toThrowError(
        expect.objectContaining({ code: "INVALID_TARGET_METADATA" }),
      );
    }
  });

  it("checks the externally resolved command with exactly the supplied environment", async () => {
    const execFile: ExecFileRunner = vi.fn(async () => ({
      stdout: "baguette 0.1.97\n",
      stderr: "",
    }));
    const adapter = adapterWith(execFile);

    await expect(adapter.inspectBaguetteCapability()).resolves.toEqual({
      available: true,
      command: BAGUETTE,
      version: "0.1.97",
    });
    expect(execFile).toHaveBeenCalledWith(BAGUETTE, ["--version"], {
      env: { PATH: "/isolated", BAGUETTE_MARKER: "test" },
      timeoutMs: 5_000,
      maxBufferBytes: 16 * 1024,
    });
  });

  it("reports missing and malformed Baguette capabilities without leaking process output", async () => {
    const missing: ExecFileRunner = vi.fn(async () => {
      throw Object.assign(new Error("secret local path"), { code: "ENOENT" });
    });
    const malformed: ExecFileRunner = vi.fn(async () => ({
      stdout: "not a version: /Users/example/private",
      stderr: "private stderr",
    }));

    await expect(adapterWith(missing).inspectBaguetteCapability()).resolves.toEqual({
      available: false,
      command: BAGUETTE,
      reason: "not_found",
    });
    await expect(adapterWith(malformed).inspectBaguetteCapability()).resolves.toEqual({
      available: false,
      command: BAGUETTE,
      reason: "invalid_version",
    });
    await expect(
      new IosSimulatorAdapter({ execFile: malformed }).inspectBaguetteCapability(),
    ).resolves.toEqual({ available: false, reason: "not_configured" });

    const outdated: ExecFileRunner = vi.fn(async () => ({ stdout: "0.1.95\n", stderr: "" }));
    await expect(adapterWith(outdated).inspectBaguetteCapability()).resolves.toEqual({
      available: false,
      command: BAGUETTE,
      version: "0.1.95",
      reason: "unsupported_version",
    });
  });

  it("discovers only available iOS simulators and recognizes Booted exactly", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];
    const execFile: ExecFileRunner = vi.fn(async (command, args, options) => {
      calls.push({ command, args: [...args], env: options.env });
      if (command === "xcrun") return { stdout: simctlOutput(), stderr: "" };
      return { stdout: chromeLayoutOutput(), stderr: "" };
    });
    const adapter = adapterWith(execFile);

    await expect(adapter.discoverDevices()).resolves.toEqual([
      {
        platform: "ios",
        udid: BOOTED_UDID,
        name: "iPhone 17 Pro",
        model: "iPhone 17 Pro",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        rawState: "Booted",
        state: "booted",
        booted: true,
        interactive: true,
        logicalPointSize: { width: 402, height: 874 },
        orientation: "portrait",
      },
      {
        platform: "ios",
        udid: SHUTDOWN_UDID,
        name: "iPhone Air",
        model: "iPhone Air",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        rawState: "Shutdown",
        state: "shutdown",
        booted: false,
        interactive: false,
      },
    ]);
    expect(calls).toEqual([
      {
        command: "xcrun",
        args: ["simctl", "list", "devices", "available", "--json"],
        env: { PATH: "/usr/bin", SIMCTL_MARKER: "test" },
      },
      {
        command: BAGUETTE,
        args: ["chrome", "layout", "--udid", BOOTED_UDID],
        env: { PATH: "/isolated", BAGUETTE_MARKER: "test" },
      },
    ]);
  });

  it("keeps a Booted simulator viewable but non-interactive when chrome layout fails", async () => {
    const process = mockChild();
    const spawn: SpawnRunner = vi.fn(() => process.child);
    const adapter = adapterWith(discoveryExecFile(undefined, "{}"), spawn);

    await expect(adapter.discoverDevices()).resolves.toEqual([
      expect.objectContaining({
        udid: BOOTED_UDID,
        booted: true,
        interactive: false,
      }),
      expect.objectContaining({ udid: SHUTDOWN_UDID, interactive: false }),
    ]);
    expect(() => adapter.sendInput(BOOTED_UDID, { type: "home" })).toThrowError(
      expect.objectContaining({ code: "POINT_SIZE_UNAVAILABLE" }),
    );
    expect(spawn).not.toHaveBeenCalled();

    const abort = new AbortController();
    const frame = adapter.streamMjpeg({ udid: BOOTED_UDID, signal: abort.signal }).next();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    abort.abort();
    await expect(frame).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects invalid, undiscovered, and non-Booted UDIDs before starting Baguette", async () => {
    const spawn = vi.fn() as unknown as SpawnRunner;
    const adapter = adapterWith(discoveryExecFile(), spawn);
    await adapter.discoverDevices();

    expect(() => adapter.sendInput("--help", { type: "home" })).toThrowError(
      expect.objectContaining({ code: "INVALID_UDID" }),
    );
    expect(() =>
      adapter.sendInput("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", { type: "home" }),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_DEVICE" }));
    expect(() => adapter.sendInput(SHUTDOWN_UDID, { type: "home" })).toThrowError(
      expect.objectContaining({ code: "DEVICE_NOT_BOOTED" }),
    );
    await expect(adapter.streamMjpeg({ udid: "--help" }).next()).rejects.toMatchObject({
      code: "INVALID_UDID",
    });
    await expect(adapter.streamMjpeg({ udid: SHUTDOWN_UDID }).next()).rejects.toMatchObject({
      code: "DEVICE_NOT_BOOTED",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("loads logical input dimensions from baguette chrome layout instead of framebuffer pixels", async () => {
    const execFile = discoveryExecFile();
    const adapter = adapterWith(execFile);
    const devices = await adapter.discoverDevices();

    await expect(adapter.refreshTargetMetadata(BOOTED_UDID)).resolves.toEqual({
      udid: BOOTED_UDID,
      logicalPointSize: { width: 402, height: 874 },
      orientation: "portrait",
    });
    expect(devices[0]).toMatchObject({
      logicalPointSize: { width: 402, height: 874 },
      orientation: "portrait",
    });
  });

  it("keeps layout failures view-only by rejecting metadata without starting input", async () => {
    const execFile = discoveryExecFile(undefined, "{}");
    const spawn = vi.fn() as unknown as SpawnRunner;
    const adapter = adapterWith(execFile, spawn);
    const devices = await adapter.discoverDevices();

    await expect(adapter.refreshTargetMetadata(BOOTED_UDID)).rejects.toMatchObject({
      code: "INVALID_TARGET_METADATA",
    });
    expect(devices[0]?.logicalPointSize).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("IosSimulatorAdapter MJPEG streaming", () => {
  function jpeg(marker: number): Buffer {
    return Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9]);
  }

  it("runs a private loopback Baguette server, reads raw JPEG messages, and aborts cleanly", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const spawn: SpawnRunner = vi.fn(() => process.child);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const abort = new AbortController();
    const iterator = adapter.streamMjpeg({
      udid: BOOTED_UDID.toLowerCase(),
      signal: abort.signal,
    });

    const first = iterator.next();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(spawn).toHaveBeenCalledWith(
      BAGUETTE,
      ["serve", "--host", "127.0.0.1", "--port", "43123", "--no-plugins"],
      {
        env: { PATH: "/isolated", BAGUETTE_MARKER: "test" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(1));
    expect(harness.urls).toEqual([
      `ws://127.0.0.1:43123/simulators/${BOOTED_UDID}/stream?format=mjpeg`,
    ]);
    expect(JSON.parse(harness.socket.sent[0]!)).toEqual({ type: "set_fps", fps: 15 });

    harness.socket.receiveBinary(Buffer.from([0xff, 0xd8, 0x41, 0xff, 0xd9]));
    await expect(first).resolves.toEqual({
      done: false,
      value: Buffer.from([0xff, 0xd8, 0x41, 0xff, 0xd9]),
    });

    const pending = iterator.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(harness.socket.terminate).toHaveBeenCalledOnce();
  });

  it("keeps a static MJPEG stream alive while every heartbeat receives a pong", async () => {
    vi.useFakeTimers();
    try {
      const process = mockChild();
      const harness = mockSocketHarness();
      const adapter = adapterWith(
        discoveryExecFile(),
        vi.fn(() => process.child),
        { createWebSocket: harness.createWebSocket },
      );
      await adapter.discoverDevices();
      const abort = new AbortController();
      const iterator = adapter.streamMjpeg({ udid: BOOTED_UDID, signal: abort.signal });
      const first = iterator.next();
      await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(1));
      harness.socket.receiveBinary(jpeg(1));
      await expect(first).resolves.toEqual({ done: false, value: jpeg(1) });

      let pendingSettled = false;
      const pending = iterator.next().finally(() => {
        pendingSettled = true;
      });
      for (let heartbeat = 1; heartbeat <= 8; heartbeat += 1) {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.socket.ping).toHaveBeenCalledTimes(heartbeat);
        harness.socket.receivePong();
      }

      expect(pendingSettled).toBe(false);
      expect(process.kill).not.toHaveBeenCalled();
      expect(harness.socket.terminate).not.toHaveBeenCalled();

      abort.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails only the current MJPEG session when its heartbeat pong deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const process = mockChild();
      const harness = mockSocketHarness();
      const adapter = adapterWith(
        discoveryExecFile(),
        vi.fn(() => process.child),
        { createWebSocket: harness.createWebSocket },
      );
      await adapter.discoverDevices();
      const iterator = adapter.streamMjpeg({ udid: BOOTED_UDID });
      const first = iterator.next();
      await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(1));
      harness.socket.receiveBinary(jpeg(1));
      await expect(first).resolves.toEqual({ done: false, value: jpeg(1) });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(harness.socket.ping).toHaveBeenCalledOnce();

      const frameDuringPongDeadline = iterator.next();
      await vi.advanceTimersByTimeAsync(5_000);
      harness.socket.receiveBinary(jpeg(2));
      await expect(frameDuringPongDeadline).resolves.toEqual({ done: false, value: jpeg(2) });
      expect(process.kill).not.toHaveBeenCalled();

      const failure = expect(iterator.next()).rejects.toMatchObject({ code: "STREAM_FAILED" });
      await vi.advanceTimersByTimeAsync(10_000);

      await failure;
      expect(process.kill).toHaveBeenCalledWith("SIGTERM");
      expect(harness.socket.terminate).toHaveBeenCalledOnce();
      expect(harness.socket.listenerCount("pong")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fully detaches an old heartbeat before a replacement MJPEG session starts", async () => {
    vi.useFakeTimers();
    try {
      const firstProcess = mockChild();
      const secondProcess = mockChild();
      const firstSocket = new MockWebSocket();
      const secondSocket = new MockWebSocket();
      const spawn: SpawnRunner = vi
        .fn<SpawnRunner>()
        .mockImplementationOnce(() => firstProcess.child)
        .mockImplementationOnce(() => secondProcess.child);
      const createWebSocket: BaguetteWebSocketFactory = vi
        .fn<BaguetteWebSocketFactory>()
        .mockImplementationOnce(() => {
          queueMicrotask(() => firstSocket.open());
          return firstSocket as unknown as WebSocket;
        })
        .mockImplementationOnce(() => {
          queueMicrotask(() => secondSocket.open());
          return secondSocket as unknown as WebSocket;
        });
      const adapter = adapterWith(discoveryExecFile(), spawn, { createWebSocket });
      await adapter.discoverDevices();

      const firstAbort = new AbortController();
      const firstPending = adapter
        .streamMjpeg({ udid: BOOTED_UDID, signal: firstAbort.signal })
        .next();
      await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));
      firstAbort.abort();
      await expect(firstPending).rejects.toMatchObject({ name: "AbortError" });
      expect(firstSocket.listenerCount("pong")).toBe(0);

      const secondAbort = new AbortController();
      const secondIterator = adapter.streamMjpeg({
        udid: BOOTED_UDID,
        signal: secondAbort.signal,
      });
      const secondFirst = secondIterator.next();
      await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1));
      secondSocket.receiveBinary(jpeg(2));
      await expect(secondFirst).resolves.toEqual({ done: false, value: jpeg(2) });
      const secondPending = secondIterator.next();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(firstSocket.ping).not.toHaveBeenCalled();
      expect(secondSocket.ping).toHaveBeenCalledOnce();
      firstSocket.receivePong();
      secondSocket.receivePong();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(firstSocket.ping).not.toHaveBeenCalled();
      expect(secondSocket.ping).toHaveBeenCalledTimes(2);
      secondSocket.receivePong();

      expect(secondProcess.kill).not.toHaveBeenCalled();
      secondAbort.abort();
      await expect(secondPending).rejects.toMatchObject({ name: "AbortError" });
      expect(secondSocket.listenerCount("pong")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on a non-JPEG WebSocket frame and reaps the private server", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      vi.fn(() => process.child),
      {
        createWebSocket: harness.createWebSocket,
      },
    );
    await adapter.discoverDevices();

    const frame = adapter.streamMjpeg({ udid: BOOTED_UDID }).next();
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(1));
    harness.socket.receiveBinary(Buffer.from("not-a-jpeg"));

    await expect(frame).rejects.toMatchObject({ code: "STREAM_FAILED" });
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("aborts startup and reaps both the connecting socket and serve process", async () => {
    const process = mockChild();
    const socket = new MockWebSocket();
    const createWebSocket: BaguetteWebSocketFactory = vi.fn(() => socket as unknown as WebSocket);
    const adapter = adapterWith(
      discoveryExecFile(),
      vi.fn(() => process.child),
      {
        createWebSocket,
      },
    );
    await adapter.discoverDevices();
    const abort = new AbortController();

    const frame = adapter.streamMjpeg({ udid: BOOTED_UDID, signal: abort.signal }).next();
    await vi.waitFor(() => expect(createWebSocket).toHaveBeenCalledOnce());
    abort.abort();

    await expect(frame).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("retries the stream socket while the private server is becoming ready", async () => {
    const process = mockChild();
    const firstSocket = new MockWebSocket();
    const readySocket = new MockWebSocket();
    const createWebSocket: BaguetteWebSocketFactory = vi
      .fn<(url: string) => WebSocket>()
      .mockImplementationOnce(() => {
        queueMicrotask(() => firstSocket.emit("error", new Error("not listening yet")));
        return firstSocket as unknown as WebSocket;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => readySocket.open());
        return readySocket as unknown as WebSocket;
      });
    const spawn: SpawnRunner = vi.fn(() => process.child);
    const adapter = adapterWith(discoveryExecFile(), spawn, { createWebSocket });
    await adapter.discoverDevices();
    const abort = new AbortController();
    const iterator = adapter.streamMjpeg({ udid: BOOTED_UDID, signal: abort.signal });

    const firstFrame = iterator.next();
    await vi.waitFor(() => expect(createWebSocket).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(readySocket.sent).toHaveLength(1));
    readySocket.receiveBinary(Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]));
    await expect(firstFrame).resolves.toMatchObject({ done: false });
    expect(spawn).toHaveBeenCalledOnce();
    expect(firstSocket.terminate).toHaveBeenCalledOnce();

    const pending = iterator.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("delivers the first frame immediately and only the latest frame from a burst", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      vi.fn(() => process.child),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const abort = new AbortController();
    const iterator = adapter.streamMjpeg({ udid: BOOTED_UDID, signal: abort.signal });
    const first = iterator.next();
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    try {
      harness.socket.receiveBinary(jpeg(1));
      await expect(first).resolves.toEqual({ done: false, value: jpeg(1) });

      let secondSettled = false;
      const second = iterator.next().then((result) => {
        secondSettled = true;
        return result;
      });
      harness.socket.receiveBinary(jpeg(2));
      harness.socket.receiveBinary(jpeg(3));
      harness.socket.receiveBinary(jpeg(4));
      await vi.advanceTimersByTimeAsync(60);
      expect(secondSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await expect(second).resolves.toEqual({ done: false, value: jpeg(4) });

      const pending = iterator.next();
      abort.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not catch up or burst after a slow consumer resumes", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      vi.fn(() => process.child),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const abort = new AbortController();
    const iterator = adapter.streamMjpeg({ udid: BOOTED_UDID, signal: abort.signal });
    const first = iterator.next();
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(1));

    vi.useFakeTimers();
    try {
      harness.socket.receiveBinary(jpeg(1));
      await expect(first).resolves.toEqual({ done: false, value: jpeg(1) });

      harness.socket.receiveBinary(jpeg(2));
      harness.socket.receiveBinary(jpeg(3));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(iterator.next()).resolves.toEqual({ done: false, value: jpeg(3) });

      let nextSettled = false;
      const next = iterator.next().then((result) => {
        nextSettled = true;
        return result;
      });
      harness.socket.receiveBinary(jpeg(4));
      await vi.advanceTimersByTimeAsync(60);
      expect(nextSettled).toBe(false);
      harness.socket.receiveBinary(jpeg(5));
      await vi.advanceTimersByTimeAsync(10);
      await expect(next).resolves.toEqual({ done: false, value: jpeg(5) });

      const pending = iterator.next();
      abort.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["socket", "process"] as const)(
    "rejects a pending sampled frame and clears buffered work on %s failure",
    async (failureSource) => {
      const process = mockChild();
      const harness = mockSocketHarness();
      const adapter = adapterWith(
        discoveryExecFile(),
        vi.fn(() => process.child),
        { createWebSocket: harness.createWebSocket },
      );
      await adapter.discoverDevices();
      const iterator = adapter.streamMjpeg({ udid: BOOTED_UDID });
      const first = iterator.next();
      await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(1));
      harness.socket.receiveBinary(jpeg(1));
      await expect(first).resolves.toMatchObject({ done: false });

      const pending = iterator.next();
      harness.socket.receiveBinary(jpeg(2));
      if (failureSource === "socket") {
        harness.socket.emit("error", new Error("socket failed"));
      } else {
        process.child.emit("error", Object.assign(new Error("process failed"), { code: "EIO" }));
      }

      await expect(pending).rejects.toMatchObject({ code: "STREAM_FAILED" });
      expect(process.kill).toHaveBeenCalledWith("SIGTERM");
      expect(harness.socket.terminate).toHaveBeenCalledOnce();
    },
  );

  it("closes a consumer-ended stream normally without draining a buffered frame", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      vi.fn(() => process.child),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const iterator = adapter.streamMjpeg({ udid: BOOTED_UDID });
    const first = iterator.next();
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(1));
    harness.socket.receiveBinary(jpeg(1));
    await expect(first).resolves.toEqual({ done: false, value: jpeg(1) });
    harness.socket.receiveBinary(jpeg(2));

    await expect(iterator.return(undefined)).resolves.toEqual({ done: true, value: undefined });
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(harness.socket.terminate).toHaveBeenCalledOnce();
    harness.socket.receiveBinary(jpeg(3));
  });
});

describe("IosSimulatorAdapter input", () => {
  async function startPreview(
    adapter: IosSimulatorAdapter,
    harness: MockSocketHarness,
  ): Promise<{
    abort: AbortController;
    pendingFrame: Promise<IteratorResult<Buffer>>;
  }> {
    const abort = new AbortController();
    const pendingFrame = adapter.streamMjpeg({ udid: BOOTED_UDID, signal: abort.signal }).next();
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(1));
    return { abort, pendingFrame };
  }

  async function stopPreview(
    abort: AbortController,
    pendingFrame: Promise<IteratorResult<Buffer>>,
  ): Promise<void> {
    abort.abort();
    await expect(pendingFrame).rejects.toMatchObject({ name: "AbortError" });
  }

  it("serializes toolbar input on the stream socket and waits only for paste_result", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const spawn: SpawnRunner = vi.fn(() => process.child);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const home = adapter.sendInput(BOOTED_UDID, { type: "home" });
    const text = adapter.sendInput(BOOTED_UDID, {
      type: "text",
      text: '你好 👋\n"quoted"',
    });

    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(3));
    expect(JSON.parse(harness.socket.sent[1]!)).toEqual({ type: "button", button: "home" });
    await expect(home).resolves.toBeUndefined();
    expect(JSON.parse(harness.socket.sent[2]!)).toEqual({
      type: "paste",
      text: '你好 👋\n"quoted"',
    });
    harness.socket.receiveJson({ type: "paste_result", ok: true });
    await expect(text).resolves.toBeUndefined();

    expect(spawn).toHaveBeenCalledOnce();
    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("forwards phased touch input in device points", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess);
    const harness = mockSocketHarness();
    const spawn = spawnWithInputProcess(serveProcess, inputProcess);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    await adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    await adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "move",
      x: 0.48,
      y: 0.6,
    });
    await adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "up",
      x: 0.48,
      y: 0.58,
    });
    expect(inputEnvelopes).toEqual([
      {
        type: "touch1-down",
        x: 201,
        y: 874,
        width: 402,
        height: 874,
      },
      {
        type: "touch1-move",
        x: 192.96,
        y: 524.4,
        width: 402,
        height: 874,
      },
      {
        type: "touch1-up",
        x: 192.96,
        y: 506.92,
        width: 402,
        height: 874,
      },
    ]);
    expect(harness.socket.sent).toHaveLength(1);
    expect(spawn).toHaveBeenNthCalledWith(2, BAGUETTE, ["input", "--udid", BOOTED_UDID], {
      env: { PATH: "/isolated", BAGUETTE_MARKER: "test" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    await stopPreview(preview.abort, preview.pendingFrame);
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects out-of-order and concurrent phases without corrupting the active touch", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess);
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      spawnWithInputProcess(serveProcess, inputProcess),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    await expect(
      adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "move",
        x: 0.5,
        y: 0.5,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "up",
        x: 0.5,
        y: 0.5,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.25,
      y: 0.5,
    });
    await expect(
      adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "down",
        x: 0.75,
        y: 0.5,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "move",
      x: 0.3,
      y: 0.55,
    });
    await adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "up",
      x: 0.3,
      y: 0.55,
    });
    await expect(
      adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "up",
        x: 0.3,
        y: 0.55,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(inputEnvelopes.map((envelope) => envelope.type)).toEqual([
      "touch1-down",
      "touch1-move",
      "touch1-up",
    ]);
    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("waits for each phased-touch ACK and keeps stream-socket input behind it", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess, false);
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      spawnWithInputProcess(serveProcess, inputProcess),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    let downSettled = false;
    const down = adapter
      .sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "down",
        x: 0.5,
        y: 1,
      })
      .finally(() => {
        downSettled = true;
      });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(1));
    await Promise.resolve();
    expect(downSettled).toBe(false);

    const home = adapter.sendInput(BOOTED_UDID, { type: "home" });
    await Promise.resolve();
    expect(harness.socket.sent).toHaveLength(1);
    inputProcess.stdout.write('{"ok":true}\n');
    await expect(down).resolves.toBeUndefined();
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(2));
    await expect(home).resolves.toBeUndefined();

    let moveSettled = false;
    const move = adapter
      .sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "move",
        x: 0.5,
        y: 0.58,
      })
      .finally(() => {
        moveSettled = true;
      });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(2));
    inputProcess.stdout.write('{"ok":');
    await Promise.resolve();
    expect(moveSettled).toBe(false);
    inputProcess.stdout.write("true}\n");
    await expect(move).resolves.toBeUndefined();

    const up = adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "up",
      x: 0.5,
      y: 0.58,
    });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(3));
    inputProcess.stdout.write('{"ok":true}\n');
    await expect(up).resolves.toBeUndefined();
    expect(JSON.parse(harness.socket.sent[1]!)).toEqual({ type: "button", button: "home" });

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("poisons an unacknowledged input helper without interrupting video and recreates it", async () => {
    const serveProcess = mockChild();
    const firstInputProcess = mockChild();
    const secondInputProcess = mockChild();
    const firstEnvelopes = acknowledgeInputProcess(firstInputProcess, false);
    const secondEnvelopes = acknowledgeInputProcess(secondInputProcess);
    let inputIndex = 0;
    const spawn: SpawnRunner = vi.fn((_command, args) => {
      if (args[0] !== "input") return serveProcess.child;
      return [firstInputProcess, secondInputProcess][inputIndex++]!.child;
    });
    const harness = mockSocketHarness();
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      inputAckTimeoutMs: 20,
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const timedOut = adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    const timeoutExpectation = expect(timedOut).rejects.toMatchObject({ code: "INPUT_TIMEOUT" });
    await vi.waitFor(() => expect(firstEnvelopes).toHaveLength(1));
    await timeoutExpectation;
    expect(firstInputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(serveProcess.kill).not.toHaveBeenCalled();

    await expect(
      adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "down",
        x: 0.5,
        y: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "up",
        x: 0.5,
        y: 0.5,
      }),
    ).resolves.toBeUndefined();
    expect(secondEnvelopes.map((envelope) => envelope.type)).toEqual(["touch1-down", "touch1-up"]);
    expect(harness.socket.readyState).toBe(1);

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("terminates a phased-touch helper when its written request is aborted", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess, false);
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      spawnWithInputProcess(serveProcess, inputProcess),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);
    const abort = new AbortController();

    const pending = adapter.sendInput(
      BOOTED_UDID,
      { type: "touch", phase: "down", x: 0.5, y: 1 },
      { signal: abort.signal },
    );
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(1));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(serveProcess.kill).not.toHaveBeenCalled();

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("treats an acknowledged touch as successful when abort arrives in the same turn", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess, false);
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      spawnWithInputProcess(serveProcess, inputProcess),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);
    const abort = new AbortController();

    const down = adapter.sendInput(
      BOOTED_UDID,
      { type: "touch", phase: "down", x: 0.5, y: 1 },
      { signal: abort.signal },
    );
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(1));
    inputProcess.stdout.write('{"ok":true}\n');
    abort.abort();
    await expect(down).resolves.toBeUndefined();

    const release = adapter.releaseTouch(BOOTED_UDID);
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(2));
    inputProcess.stdout.write('{"ok":true}\n');
    await expect(release).resolves.toBeUndefined();
    expect(inputEnvelopes[1]?.type).toBe("touch1-up");

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("does not poison an active helper when a queued touch aborts before writing", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess, false);
    const harness = mockSocketHarness();
    const spawn = spawnWithInputProcess(serveProcess, inputProcess);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const down = adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(1));
    const abort = new AbortController();
    const queuedMove = adapter.sendInput(
      BOOTED_UDID,
      { type: "touch", phase: "move", x: 0.5, y: 0.7 },
      { signal: abort.signal },
    );
    abort.abort();
    inputProcess.stdout.write('{"ok":true}\n');
    await expect(down).resolves.toBeUndefined();
    await expect(queuedMove).rejects.toMatchObject({ name: "AbortError" });
    expect(inputEnvelopes).toHaveLength(1);
    expect(inputProcess.kill).not.toHaveBeenCalled();

    const up = adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "up",
      x: 0.5,
      y: 0.7,
    });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(2));
    inputProcess.stdout.write('{"ok":true}\n');
    await expect(up).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("clears an owned touch when its acknowledged helper closes", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess, false);
    const harness = mockSocketHarness();
    const spawn = spawnWithInputProcess(serveProcess, inputProcess);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const down = adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(1));
    inputProcess.stdout.write('{"ok":true}\n');
    await expect(down).resolves.toBeUndefined();
    inputProcess.child.emit("close", 0, null);

    await expect(
      adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "move",
        x: 0.5,
        y: 0.6,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(spawn).toHaveBeenCalledTimes(2);

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("does not commit a down when its helper ends immediately after the ACK", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess, false);
    const harness = mockSocketHarness();
    const spawn = spawnWithInputProcess(serveProcess, inputProcess);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const down = adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(1));
    inputProcess.stdout.end('{"ok":true}\n');
    await down.catch(() => undefined);
    await vi.waitFor(() => expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM"));

    await expect(
      adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "move",
        x: 0.5,
        y: 0.6,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(spawn).toHaveBeenCalledTimes(2);

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it.each([
    ["malformed JSON", Buffer.from("{]\n"), "INPUT_PROTOCOL_ERROR"],
    ["invalid ok field", Buffer.from('{"ok":"yes"}\n'), "INPUT_PROTOCOL_ERROR"],
    ["negative ACK", Buffer.from('{"ok":false,"error":"denied"}\n'), "INPUT_FAILED"],
    [
      "invalid UTF-8",
      Buffer.concat([
        Buffer.from('{"ok":true,"extra":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]),
      "INPUT_PROTOCOL_ERROR",
    ],
    ["unsolicited second ACK", Buffer.from('{"ok":true}\n{"ok":true}\n'), "INPUT_PROTOCOL_ERROR"],
    ["oversized response", Buffer.alloc(64 * 1024 + 1, 0x61), "INPUT_PROTOCOL_ERROR"],
  ])("poisons only the input helper for %s", async (_name, response, code) => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess, false);
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      spawnWithInputProcess(serveProcess, inputProcess),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const down = adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    const expectation = expect(down).rejects.toMatchObject({ code });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(1));
    inputProcess.stdout.write(response);
    await expectation;
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(serveProcess.kill).not.toHaveBeenCalled();
    expect(harness.socket.readyState).toBe(1);

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("handles a stdout pipe error without an unhandled process error", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess, false);
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      spawnWithInputProcess(serveProcess, inputProcess),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const down = adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    const expectation = expect(down).rejects.toMatchObject({ code: "INPUT_FAILED" });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(1));
    inputProcess.stdout.emit("error", new Error("broken pipe"));
    await expectation;
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(serveProcess.kill).not.toHaveBeenCalled();

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("rejects a pending touch and reaps both helpers when disposed", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess, false);
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      spawnWithInputProcess(serveProcess, inputProcess),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const down = adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    const downExpectation = expect(down).rejects.toMatchObject({ code: "INPUT_FAILED" });
    await vi.waitFor(() => expect(inputEnvelopes).toHaveLength(1));
    adapter.dispose();

    await downExpectation;
    await expect(preview.pendingFrame).rejects.toMatchObject({ name: "AbortError" });
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(serveProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("releases an interrupted touch at its last point", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess);
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      spawnWithInputProcess(serveProcess, inputProcess),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    await adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "down",
      x: 0.5,
      y: 1,
    });
    await adapter.sendInput(BOOTED_UDID, {
      type: "touch",
      phase: "move",
      x: 0.48,
      y: 0.6,
    });
    await adapter.releaseTouch(BOOTED_UDID);
    await adapter.releaseTouch(BOOTED_UDID);

    expect(inputEnvelopes).toEqual([
      {
        type: "touch1-down",
        x: 201,
        y: 874,
        width: 402,
        height: 874,
      },
      {
        type: "touch1-move",
        x: 192.96,
        y: 524.4,
        width: 402,
        height: 874,
      },
      {
        type: "touch1-up",
        x: 192.96,
        y: 524.4,
        width: 402,
        height: 874,
      },
    ]);

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("maps visual touch coordinates for every simulator orientation", async () => {
    const serveProcess = mockChild();
    const inputProcess = mockChild();
    const inputEnvelopes = acknowledgeInputProcess(inputProcess);
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(async () => ({ stdout: "", stderr: "" })),
      spawnWithInputProcess(serveProcess, inputProcess),
      { createWebSocket: harness.createWebSocket },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const cases = [
      {
        orientation: "portrait" as const,
        x: 100.5,
        y: 655.5,
        width: 402,
        height: 874,
      },
      {
        orientation: "landscape-left" as const,
        x: 655.5,
        y: 301.5,
        width: 874,
        height: 402,
      },
      {
        orientation: "portrait-upside-down" as const,
        x: 301.5,
        y: 218.5,
        width: 402,
        height: 874,
      },
      {
        orientation: "landscape-right" as const,
        x: 218.5,
        y: 100.5,
        width: 874,
        height: 402,
      },
    ];

    for (const current of cases) {
      await adapter.sendInput(BOOTED_UDID, {
        type: "orientation",
        orientation: current.orientation,
      });
      await adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "down",
        x: 0.25,
        y: 0.75,
      });
      await adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "up",
        x: 0.25,
        y: 0.75,
      });
    }

    const downEnvelopes = inputEnvelopes.filter((envelope) => envelope.type === "touch1-down");
    expect(downEnvelopes).toEqual(
      cases.map(({ orientation: _orientation, ...point }) => ({ type: "touch1-down", ...point })),
    );

    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("serializes home and orientation while updating logical point orientation", async () => {
    const orientationCalls: Array<{ command: string; args: readonly string[] }> = [];
    const execFile = discoveryExecFile(async (command, args) => {
      orientationCalls.push({ command, args: [...args] });
      return { stdout: "", stderr: "" };
    });
    const process = mockChild();
    const harness = mockSocketHarness();
    const spawn: SpawnRunner = vi.fn(() => process.child);
    const adapter = adapterWith(execFile, spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const home = adapter.sendInput(BOOTED_UDID, { type: "home" });
    const rotate = adapter.sendInput(BOOTED_UDID, {
      type: "orientation",
      orientation: "landscape-left",
    });
    await expect(home).resolves.toBeUndefined();
    await expect(rotate).resolves.toBeUndefined();
    expect(JSON.parse(harness.socket.sent[1]!)).toEqual({ type: "button", button: "home" });
    expect(orientationCalls).toEqual([
      {
        command: BAGUETTE,
        args: ["orientation", "--udid", BOOTED_UDID, "landscape-left"],
      },
    ]);
    expect(adapter.getTargetMetadata(BOOTED_UDID)).toMatchObject({
      logicalPointSize: { width: 874, height: 402 },
      orientation: "landscape-left",
    });

    const devices = await adapter.discoverDevices();
    expect(devices[0]).toMatchObject({
      logicalPointSize: { width: 874, height: 402 },
      orientation: "landscape-left",
    });
    expect(spawn).toHaveBeenCalledOnce();
    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("times out a missing paste_result without tearing down the active stream", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const spawn: SpawnRunner = vi.fn(() => process.child);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      inputAckTimeoutMs: 20,
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const pending = adapter.sendInput(BOOTED_UDID, { type: "text", text: "hello" });
    const timedOut = expect(pending).rejects.toMatchObject({ code: "INPUT_TIMEOUT" });
    await timedOut;
    await expect(adapter.sendInput(BOOTED_UDID, { type: "home" })).resolves.toBeUndefined();
    expect(process.kill).not.toHaveBeenCalled();
    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("validates touch input before serving and aborts one input without closing the stream", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const spawn: SpawnRunner = vi.fn(() => process.child);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();

    expect(() =>
      adapter.sendInput(BOOTED_UDID, {
        type: "touch",
        phase: "down",
        x: Number.NaN,
        y: 0.5,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() =>
      adapter.sendInput(BOOTED_UDID, { type: "touch", phase: "down", x: -0.1, y: 0.5 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => adapter.sendInput(BOOTED_UDID, { type: "text", text: "" })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(spawn).not.toHaveBeenCalled();

    const preview = await startPreview(adapter, harness);
    const abort = new AbortController();
    const pending = adapter.sendInput(
      BOOTED_UDID,
      { type: "text", text: "cancel me" },
      { signal: abort.signal },
    );
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(2));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      adapter.sendInput(BOOTED_UDID, { type: "text", text: "too early" }),
    ).rejects.toMatchObject({ code: "INPUT_PROTOCOL_ERROR" });
    harness.socket.receiveJson({ type: "paste_result", ok: true });
    const resynchronized = adapter.sendInput(BOOTED_UDID, { type: "text", text: "after ACK" });
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(3));
    harness.socket.receiveJson({ type: "paste_result", ok: true });
    await expect(resynchronized).resolves.toBeUndefined();
    await expect(adapter.sendInput(BOOTED_UDID, { type: "home" })).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("rejects negative and malformed paste_result messages without confusing unrelated text", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const adapter = adapterWith(
      discoveryExecFile(),
      vi.fn(() => process.child),
      {
        createWebSocket: harness.createWebSocket,
      },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const rejected = adapter.sendInput(BOOTED_UDID, { type: "text", text: "first" });
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(2));
    harness.socket.receiveJson({ type: "server_status", ok: true });
    harness.socket.receiveJson({ type: "paste_result", ok: false, error: "not permitted" });
    await expect(rejected).rejects.toMatchObject({
      code: "INPUT_FAILED",
      message: "not permitted",
    });

    const malformed = adapter.sendInput(BOOTED_UDID, { type: "text", text: "second" });
    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(3));
    harness.socket.receiveJson({ type: "paste_result", ok: "yes" });
    await expect(malformed).rejects.toMatchObject({ code: "INPUT_PROTOCOL_ERROR" });
    await expect(adapter.sendInput(BOOTED_UDID, { type: "home" })).resolves.toBeUndefined();
    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("closing the last target session reaps Baguette without shutting down the Simulator", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const execFile = discoveryExecFile();
    const adapter = adapterWith(
      execFile,
      vi.fn(() => process.child),
      {
        createWebSocket: harness.createWebSocket,
      },
    );
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    adapter.closeInput(BOOTED_UDID);
    await expect(preview.pendingFrame).rejects.toMatchObject({ name: "AbortError" });
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(execFile).not.toHaveBeenCalledWith(
      "xcrun",
      expect.arrayContaining(["shutdown"]),
      expect.anything(),
    );
  });
});
