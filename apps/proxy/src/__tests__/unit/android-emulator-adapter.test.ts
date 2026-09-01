import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  AndroidEmulatorAdapter,
  AndroidEmulatorAdapterError,
  type AndroidExecFile,
  type AndroidSpawn,
} from "#src/serve/device-preview/android-adapter.js";

const ADB = "/opt/android/platform-tools/adb";
const SERIAL = "emulator-5554";

function result(stdout = "", stderr = "") {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function argsKey(args: readonly string[]): string {
  return args.join("\u0000");
}

function png(width: number, height: number): Buffer {
  const frame = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(frame);
  frame.write("IHDR", 12, "ascii");
  frame.writeUInt32BE(width, 16);
  frame.writeUInt32BE(height, 20);
  return frame;
}

function discoveryResponses(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [argsKey(["version"])]: "Android Debug Bridge version 1.0.41\n",
    [argsKey(["devices", "-l"])]:
      "List of devices attached\n" +
      `${SERIAL} device product:sdk model:Ignored_Model transport_id:1\n`,
    [argsKey(["-s", SERIAL, "shell", "getprop", "sys.boot_completed"])]: "1\n",
    [argsKey(["-s", SERIAL, "shell", "getprop", "ro.product.model"])]: "Pixel 9 Pro\n",
    [argsKey(["-s", SERIAL, "shell", "getprop", "ro.build.version.sdk"])]: "35\n",
    [argsKey(["-s", SERIAL, "shell", "getprop", "ro.build.version.release"])]: "15\n",
    [argsKey(["-s", SERIAL, "shell", "wm", "size"])]: "Physical size: 1080x2400\n",
    [argsKey(["-s", SERIAL, "shell", "dumpsys", "input"])]: "SurfaceOrientation: 0\n",
    ...overrides,
  };
}

function createExecFile(
  responses: Record<string, string>,
  calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [],
): AndroidExecFile {
  return vi.fn(async (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env ?? {} });
    const key = argsKey(args);
    if (!(key in responses)) throw new Error(`Unexpected adb call: ${args.join(" ")}`);
    return result(responses[key]);
  });
}

function createAdapter(
  execFile: AndroidExecFile,
  options: { spawn?: AndroidSpawn; frameIntervalMs?: number } = {},
) {
  return new AndroidEmulatorAdapter({
    command: ADB,
    env: { PATH: "/ignored", MARKER: "test-env" },
    execFile,
    spawn: options.spawn,
    frameIntervalMs: options.frameIntervalMs,
    encodePngToJpeg: vi.fn(async (input) => Buffer.concat([Buffer.from("jpeg:"), input])),
  });
}

function successfulScreenshotSpawn(frame: Buffer): AndroidSpawn {
  return vi.fn(() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    queueMicrotask(() => {
      stdout.end(frame);
      stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  });
}

describe("AndroidEmulatorAdapter discovery", () => {
  it("only allows fully booted emulator serials and queries their metadata with an explicit -s", async () => {
    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const responses = discoveryResponses({
      [argsKey(["devices", "-l"])]:
        "List of devices attached\n" +
        `${SERIAL} device product:sdk model:Ignored_Model transport_id:1\n` +
        "emulator-5556 offline transport_id:2\n" +
        "emulator-5558 device model:Still_Booting transport_id:3\n" +
        "-s device model:Option_Injection transport_id:4\n" +
        "192.168.0.2:5555 device model:Physical_Device transport_id:5\n",
      [argsKey(["-s", "emulator-5558", "shell", "getprop", "sys.boot_completed"])]: "0\n",
      [argsKey(["-s", SERIAL, "shell", "wm", "size"])]:
        "Physical size: 1440x3120\nOverride size: 1080x2400\n",
      [argsKey(["-s", SERIAL, "shell", "dumpsys", "input"])]: "SurfaceOrientation: 1\n",
    });
    const adapter = createAdapter(createExecFile(responses, calls));

    await expect(adapter.discover()).resolves.toEqual([
      {
        platform: "android",
        serial: SERIAL,
        model: "Pixel 9 Pro",
        apiLevel: 35,
        release: "15",
        width: 2400,
        height: 1080,
        rotation: 90,
      },
    ]);

    expect(calls[0]).toMatchObject({ command: ADB, args: ["version"] });
    expect(calls.every((call) => call.env.MARKER === "test-env")).toBe(true);
    const serialCalls = calls.filter((call) => call.args[0] === "-s");
    expect(serialCalls.length).toBeGreaterThan(0);
    expect(serialCalls.every((call) => /^emulator-\d+$/u.test(call.args[1] ?? ""))).toBe(true);
    expect(calls.some((call) => call.args.includes("-s device"))).toBe(false);
    expect(adapter.getDevice(SERIAL)?.width).toBe(2400);
  });

  it("rejects syntactically valid but undiscovered serials before spawning or running adb", async () => {
    const execFile = createExecFile(discoveryResponses());
    const spawn = vi.fn() as unknown as AndroidSpawn;
    const adapter = createAdapter(execFile, { spawn });
    await adapter.discover();
    const callsBefore = vi.mocked(execFile).mock.calls.length;

    await expect(adapter.sendInput("emulator-9999", { type: "home" })).rejects.toMatchObject({
      code: "device-not-allowed",
    });
    await expect(
      adapter.streamFrames("-s", vi.fn(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "device-not-allowed" });

    expect(vi.mocked(execFile).mock.calls).toHaveLength(callsBefore);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not add an emulator to the allow-list until sys.boot_completed is exactly 1", async () => {
    const responses = discoveryResponses({
      [argsKey(["-s", SERIAL, "shell", "getprop", "sys.boot_completed"])]: "true\n",
    });
    const adapter = createAdapter(createExecFile(responses));

    await expect(adapter.discover()).resolves.toEqual([]);
    expect(adapter.getDevice(SERIAL)).toBeUndefined();
  });
});

describe("AndroidEmulatorAdapter frame capture", () => {
  it("captures frames sequentially, updates the latest size, and requests 720px quality-70 JPEGs", async () => {
    const execFile = createExecFile(discoveryResponses());
    const spawn = successfulScreenshotSpawn(png(2400, 1080));
    let encodersInFlight = 0;
    let maxEncodersInFlight = 0;
    const encodePngToJpeg = vi.fn(async (_input: Buffer, options) => {
      encodersInFlight += 1;
      maxEncodersInFlight = Math.max(maxEncodersInFlight, encodersInFlight);
      await Promise.resolve();
      encodersInFlight -= 1;
      expect(options).toMatchObject({ width: 720, quality: 70 });
      return Buffer.from("jpeg-frame");
    });
    const adapter = new AndroidEmulatorAdapter({
      command: ADB,
      execFile,
      spawn,
      encodePngToJpeg,
      frameIntervalMs: 50,
    });
    await adapter.discover();
    const abort = new AbortController();
    const frames: Buffer[] = [];

    await adapter.streamFrames(
      SERIAL,
      (frame) => {
        frames.push(frame);
        if (frames.length === 2) abort.abort();
      },
      { signal: abort.signal },
    );

    expect(frames.map(String)).toEqual(["jpeg-frame", "jpeg-frame"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      ADB,
      ["-s", SERIAL, "exec-out", "screencap", "-p"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(encodePngToJpeg).toHaveBeenCalledTimes(2);
    expect(maxEncodersInFlight).toBe(1);
    expect(adapter.getDevice(SERIAL)).toMatchObject({ width: 2400, height: 1080 });
  });

  it("kills an in-flight screencap and resolves normally when aborted", async () => {
    const execFile = createExecFile(discoveryResponses());
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const spawn = vi.fn(() => child) as unknown as AndroidSpawn;
    const adapter = createAdapter(execFile, { spawn });
    await adapter.discover();
    const abort = new AbortController();

    const streaming = adapter.streamFrames(SERIAL, vi.fn(), { signal: abort.signal });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    abort.abort();

    await expect(streaming).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("surfaces a bounded capture error instead of retrying indefinitely", async () => {
    const execFile = createExecFile(discoveryResponses());
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdout, stderr, kill: vi.fn(() => true) });
      queueMicrotask(() => {
        stderr.end("device offline");
        stdout.end();
        child.emit("close", 1, null);
      });
      return child;
    }) as unknown as AndroidSpawn;
    const adapter = createAdapter(execFile, { spawn });
    await adapter.discover();

    await expect(
      adapter.streamFrames(SERIAL, vi.fn(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "capture-failed" });
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe("AndroidEmulatorAdapter input", () => {
  it("serializes input and maps normalized coordinates against freshly queried dimensions", async () => {
    let releaseTap!: () => void;
    let tapStarted!: () => void;
    const tapStartedPromise = new Promise<void>((resolve) => {
      tapStarted = resolve;
    });
    const responses = discoveryResponses({
      [argsKey(["-s", SERIAL, "shell", "wm", "size"])]: "Physical size: 100x200\n",
    });
    const calls: readonly string[][] = [];
    const execFile: AndroidExecFile = vi.fn(async (_command, args) => {
      (calls as string[][]).push([...args]);
      if (argsKey(args) === argsKey(["-s", SERIAL, "shell", "input", "tap", "99", "100"])) {
        tapStarted();
        await new Promise<void>((resolve) => {
          releaseTap = resolve;
        });
        return result();
      }
      if (argsKey(args) === argsKey(["-s", SERIAL, "shell", "input", "keyevent", "KEYCODE_HOME"])) {
        return result();
      }
      const response = responses[argsKey(args)];
      if (response === undefined) throw new Error(`Unexpected adb call: ${args.join(" ")}`);
      return result(response);
    });
    const adapter = createAdapter(execFile);
    await adapter.discover();

    const tap = adapter.sendInput(SERIAL, { type: "tap", x: 1, y: 0.5 });
    const home = adapter.sendInput(SERIAL, { type: "home" });
    await tapStartedPromise;
    expect(calls.some((args) => args.includes("KEYCODE_HOME"))).toBe(false);
    releaseTap();
    await Promise.all([tap, home]);

    expect(calls).toContainEqual(["-s", SERIAL, "shell", "input", "tap", "99", "100"]);
    expect(calls).toContainEqual(["-s", SERIAL, "shell", "input", "keyevent", "KEYCODE_HOME"]);
    expect(calls.filter((args) => args[0] === "-s").every((args) => args[1] === SERIAL)).toBe(true);
  });

  it("supports swipe, quoted text, back, fixed rotation, and free rotation without emulator lifecycle calls", async () => {
    const responses = discoveryResponses();
    const calls: string[][] = [];
    const execFile: AndroidExecFile = vi.fn(async (_command, args) => {
      calls.push([...args]);
      const key = argsKey(args);
      if (key in responses) return result(responses[key]);
      if (args[0] === "-s" && args[1] === SERIAL) return result();
      throw new Error(`Unexpected adb call: ${args.join(" ")}`);
    });
    const adapter = createAdapter(execFile);
    await adapter.discover();

    await adapter.sendInput(SERIAL, {
      type: "swipe",
      from: { x: 0, y: 0.25 },
      to: { x: 1, y: 0.75 },
      durationMs: 420,
    });
    await adapter.sendInput(SERIAL, { type: "text", text: "hello'; reboot; echo ' world" });
    await adapter.sendInput(SERIAL, { type: "back" });
    await adapter.sendInput(SERIAL, { type: "rotate", rotation: 270 });
    await adapter.sendInput(SERIAL, { type: "free" });

    expect(calls).toContainEqual([
      "-s",
      SERIAL,
      "shell",
      "input",
      "swipe",
      "0",
      "600",
      "1079",
      "1799",
      "420",
    ]);
    const textCall = calls.find((args) => args[3] === "input" && args[4] === "text");
    expect(textCall).toEqual([
      "-s",
      SERIAL,
      "shell",
      "input",
      "text",
      "'hello'\\'';%sreboot;%secho%s'\\''%sworld'",
    ]);
    expect(calls).toContainEqual(["-s", SERIAL, "shell", "input", "keyevent", "KEYCODE_BACK"]);
    expect(calls).toContainEqual([
      "-s",
      SERIAL,
      "shell",
      "settings",
      "put",
      "system",
      "user_rotation",
      "3",
    ]);
    expect(calls).toContainEqual([
      "-s",
      SERIAL,
      "shell",
      "settings",
      "put",
      "system",
      "accelerometer_rotation",
      "1",
    ]);
    expect(calls.some((args) => args.includes("kill-server"))).toBe(false);
    expect(calls.some((args) => args.includes("emu"))).toBe(false);
  });

  it("rejects invalid normalized coordinates before invoking the input command", async () => {
    const execFile = createExecFile(discoveryResponses());
    const adapter = createAdapter(execFile);
    await adapter.discover();

    await expect(
      adapter.sendInput(SERIAL, { type: "tap", x: -0.01, y: 0.5 }),
    ).rejects.toBeInstanceOf(AndroidEmulatorAdapterError);
    expect(
      vi.mocked(execFile).mock.calls.some((call) => (call[1] as readonly string[]).includes("tap")),
    ).toBe(false);
  });
});
