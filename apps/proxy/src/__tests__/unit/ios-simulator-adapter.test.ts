import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  IosSimulatorAdapter,
  JpegStreamFramer,
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
          state: "Booted",
          isAvailable: true,
        },
        {
          udid: SHUTDOWN_UDID,
          name: "iPhone Air",
          state: "Shutdown",
          isAvailable: true,
        },
        {
          udid: "--help",
          name: "Injected",
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
    await adapter.discoverDevices();

    await expect(adapter.refreshTargetMetadata(BOOTED_UDID)).resolves.toEqual({
      udid: BOOTED_UDID,
      logicalPointSize: { width: 402, height: 874 },
      orientation: "portrait",
    });
    expect(adapter.listDiscoveredDevices()[0]).toMatchObject({
      logicalPointSize: { width: 402, height: 874 },
      orientation: "portrait",
    });
  });

  it("keeps layout failures view-only by rejecting metadata without starting input", async () => {
    const execFile = discoveryExecFile(undefined, "{}");
    const spawn = vi.fn() as unknown as SpawnRunner;
    const adapter = adapterWith(execFile, spawn);
    await adapter.discoverDevices();

    await expect(adapter.refreshTargetMetadata(BOOTED_UDID)).rejects.toMatchObject({
      code: "INVALID_TARGET_METADATA",
    });
    expect(adapter.listDiscoveredDevices()[0]?.logicalPointSize).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("JpegStreamFramer", () => {
  it("finds multiple JPEGs across arbitrary chunk and multipart boundaries", () => {
    const framer = new JpegStreamFramer();

    expect(framer.push(Buffer.from([0x2d, 0x2d, 0xff]))).toEqual([]);
    expect(framer.push(Buffer.from([0xd8, 0x01, 0xff]))).toEqual([]);
    expect(
      framer.push(Buffer.from([0xd9, 0x0d, 0x0a, 0xff, 0xd8, 0x02, 0x03, 0xff, 0xd9])),
    ).toEqual([
      Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]),
      Buffer.from([0xff, 0xd8, 0x02, 0x03, 0xff, 0xd9]),
    ]);
  });

  it("fails closed when an unterminated JPEG exceeds its configured bound", () => {
    const framer = new JpegStreamFramer(5);
    expect(() => framer.push(Buffer.from([0xff, 0xd8, 1, 2, 3, 4]))).toThrowError(
      expect.objectContaining({ code: "STREAM_FAILED" }),
    );
  });

  it("resynchronizes at a new SOI after a truncated frame", () => {
    const framer = new JpegStreamFramer();
    expect(framer.push(Buffer.from([0xff, 0xd8, 0x01, 0x02]))).toEqual([]);
    expect(framer.push(Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]))).toEqual([
      Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]),
    ]);
  });
});

describe("IosSimulatorAdapter MJPEG streaming", () => {
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

  it("serializes gestures on the stream socket and waits only for paste_result", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const spawn: SpawnRunner = vi.fn(() => process.child);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();
    const preview = await startPreview(adapter, harness);

    const tap = adapter.sendInput(BOOTED_UDID, {
      type: "tap",
      x: 0.25,
      y: 0.5,
      durationMs: 80,
    });
    const swipe = adapter.sendInput(BOOTED_UDID, {
      type: "swipe",
      startX: 0,
      startY: 1,
      endX: 1,
      endY: 0.25,
      durationMs: 450,
    });
    const text = adapter.sendInput(BOOTED_UDID, {
      type: "text",
      text: '你好 👋\n"quoted"',
    });

    await vi.waitFor(() => expect(harness.socket.sent).toHaveLength(4));
    expect(JSON.parse(harness.socket.sent[1]!)).toEqual({
      type: "tap",
      x: 100.5,
      y: 437,
      width: 402,
      height: 874,
      duration: 0.08,
    });
    await expect(tap).resolves.toBeUndefined();
    expect(JSON.parse(harness.socket.sent[2]!)).toEqual({
      type: "swipe",
      startX: 0,
      startY: 874,
      endX: 402,
      endY: 218.5,
      width: 402,
      height: 874,
      duration: 0.45,
    });
    await expect(swipe).resolves.toBeUndefined();
    expect(JSON.parse(harness.socket.sent[3]!)).toEqual({
      type: "paste",
      text: '你好 👋\n"quoted"',
    });
    harness.socket.receiveJson({ type: "paste_result", ok: true });
    await expect(text).resolves.toBeUndefined();

    expect(spawn).toHaveBeenCalledOnce();
    await stopPreview(preview.abort, preview.pendingFrame);
  });

  it("serializes home, orientation, and later gestures while updating logical point orientation", async () => {
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
    expect(adapter.listDiscoveredDevices()[0]).toMatchObject({
      logicalPointSize: { width: 874, height: 402 },
      orientation: "landscape-left",
    });

    const tap = adapter.sendInput(BOOTED_UDID, { type: "tap", x: 0.5, y: 0.5 });
    await expect(tap).resolves.toBeUndefined();
    expect(JSON.parse(harness.socket.sent[2]!)).toMatchObject({
      type: "tap",
      x: 437,
      y: 201,
      width: 874,
      height: 402,
    });
    await adapter.discoverDevices();
    expect(adapter.listDiscoveredDevices()[0]).toMatchObject({
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

  it("validates normalized input before serving and aborts one input without closing the stream", async () => {
    const process = mockChild();
    const harness = mockSocketHarness();
    const spawn: SpawnRunner = vi.fn(() => process.child);
    const adapter = adapterWith(discoveryExecFile(), spawn, {
      createWebSocket: harness.createWebSocket,
    });
    await adapter.discoverDevices();

    expect(() =>
      adapter.sendInput(BOOTED_UDID, { type: "tap", x: Number.NaN, y: 0.5 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => adapter.sendInput(BOOTED_UDID, { type: "tap", x: -0.1, y: 0.5 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
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
