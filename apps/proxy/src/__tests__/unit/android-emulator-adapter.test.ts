import { describe, expect, it, vi } from "vitest";
import {
  AndroidEmulatorAdapter,
  type AndroidExecFile,
} from "#src/serve/device-preview/android-adapter.js";

const ADB = "/opt/android/platform-tools/adb";
const SERIAL = "emulator-5554";

function result(stdout = "", stderr = "") {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function argsKey(args: readonly string[]): string {
  return args.join("\u0000");
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

function createAdapter(execFile: AndroidExecFile) {
  return new AndroidEmulatorAdapter({
    command: ADB,
    env: { PATH: "/ignored", MARKER: "test-env" },
    execFile,
  });
}

describe("AndroidEmulatorAdapter discovery", () => {
  it.each([
    [
      "win32",
      { LocalAppData: "C:\\Users\\dev\\AppData\\Local" },
      "C:\\Users\\dev\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe",
    ],
    ["win32", { android_home: "D:\\Android" }, "D:\\Android\\platform-tools\\adb.exe"],
    ["win32", { Path: '"D:\\Android Tools";C:\\Tools' }, "D:\\Android Tools\\adb.exe"],
    ["darwin", { HOME: "/Users/dev" }, "/Users/dev/Library/Android/sdk/platform-tools/adb"],
    ["linux", { HOME: "/home/dev" }, "/home/dev/Android/Sdk/platform-tools/adb"],
  ] as const)("finds adb in %s platform paths", async (platform, env, expected) => {
    const execFile: AndroidExecFile = vi.fn(async (command) => {
      if (command !== expected) throw new Error("not found");
      return result("Android Debug Bridge version 1.0.41");
    });
    const adapter = new AndroidEmulatorAdapter({ platform, env, execFile });
    await expect(adapter.inspect()).resolves.toMatchObject({ available: true, command: expected });
  });

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

    const devices = await adapter.discover();
    expect(devices).toEqual([
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
    expect(devices[0]?.width).toBe(2400);
  });

  it("rejects syntactically valid but undiscovered serials before running adb", async () => {
    const execFile = createExecFile(discoveryResponses());
    const adapter = createAdapter(execFile);
    await adapter.discover();
    const callsBefore = vi.mocked(execFile).mock.calls.length;

    await expect(adapter.sendInput("emulator-9999", { type: "home" })).rejects.toMatchObject({
      code: "device-not-allowed",
    });

    expect(vi.mocked(execFile).mock.calls).toHaveLength(callsBefore);
  });

  it("does not add an emulator to the allow-list until sys.boot_completed is exactly 1", async () => {
    const responses = discoveryResponses({
      [argsKey(["-s", SERIAL, "shell", "getprop", "sys.boot_completed"])]: "true\n",
    });
    const adapter = createAdapter(createExecFile(responses));

    await expect(adapter.discover()).resolves.toEqual([]);
    await expect(adapter.sendInput(SERIAL, { type: "home" })).rejects.toMatchObject({
      code: "device-not-allowed",
    });
  });

  it("keeps a previously verified emulator when a later metadata probe fails", async () => {
    const responses = discoveryResponses();
    let failMetadata = false;
    const execFile: AndroidExecFile = vi.fn(async (_command, args) => {
      const key = argsKey(args);
      if (
        failMetadata &&
        key === argsKey(["-s", SERIAL, "shell", "getprop", "ro.build.version.release"])
      ) {
        throw new Error("transient adb failure");
      }
      const response = responses[key];
      if (response !== undefined) return result(response);
      if (args[0] === "-s" && args[1] === SERIAL) return result();
      throw new Error(`Unexpected adb call: ${args.join(" ")}`);
    });
    const adapter = createAdapter(execFile);
    const initial = await adapter.discover();
    failMetadata = true;

    await expect(adapter.discover()).resolves.toEqual(initial);
    await expect(adapter.sendInput(SERIAL, { type: "home" })).resolves.toBeUndefined();
  });
});

describe("AndroidEmulatorAdapter input", () => {
  it("serializes toolbar input for one emulator", async () => {
    let releaseHome!: () => void;
    let homeStarted!: () => void;
    const homeStartedPromise = new Promise<void>((resolve) => {
      homeStarted = resolve;
    });
    const responses = discoveryResponses();
    const calls: readonly string[][] = [];
    const execFile: AndroidExecFile = vi.fn(async (_command, args) => {
      (calls as string[][]).push([...args]);
      if (argsKey(args) === argsKey(["-s", SERIAL, "shell", "input", "keyevent", "KEYCODE_HOME"])) {
        homeStarted();
        await new Promise<void>((resolve) => {
          releaseHome = resolve;
        });
        return result();
      }
      if (argsKey(args) === argsKey(["-s", SERIAL, "shell", "input", "keyevent", "KEYCODE_BACK"])) {
        return result();
      }
      const response = responses[argsKey(args)];
      if (response === undefined) throw new Error(`Unexpected adb call: ${args.join(" ")}`);
      return result(response);
    });
    const adapter = createAdapter(execFile);
    await adapter.discover();

    const home = adapter.sendInput(SERIAL, { type: "home" });
    const back = adapter.sendInput(SERIAL, { type: "back" });
    await homeStartedPromise;
    expect(calls.some((args) => args.includes("KEYCODE_BACK"))).toBe(false);
    releaseHome();
    await Promise.all([home, back]);

    expect(calls).toContainEqual(["-s", SERIAL, "shell", "input", "keyevent", "KEYCODE_HOME"]);
    expect(calls).toContainEqual(["-s", SERIAL, "shell", "input", "keyevent", "KEYCODE_BACK"]);
    expect(calls.filter((args) => args[0] === "-s").every((args) => args[1] === SERIAL)).toBe(true);
  });

  it("supports back, fixed rotation, and free rotation without emulator lifecycle calls", async () => {
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

    await adapter.sendInput(SERIAL, { type: "back" });
    await adapter.sendInput(SERIAL, { type: "rotate", rotation: 270 });
    await adapter.sendInput(SERIAL, { type: "free" });

    expect(calls).toContainEqual(["-s", SERIAL, "shell", "input", "keyevent", "KEYCODE_BACK"]);
    expect(calls).toContainEqual([
      "-s",
      SERIAL,
      "shell",
      "wm",
      "fixed-to-user-rotation",
      "enabled",
    ]);
    expect(calls).toContainEqual(["-s", SERIAL, "shell", "wm", "user-rotation", "lock", "3"]);
    expect(calls).toContainEqual(["-s", SERIAL, "shell", "wm", "user-rotation", "free"]);
    expect(calls).toContainEqual([
      "-s",
      SERIAL,
      "shell",
      "wm",
      "fixed-to-user-rotation",
      "default",
    ]);
    expect(calls.some((args) => args.includes("kill-server"))).toBe(false);
    expect(calls.some((args) => args.includes("emu"))).toBe(false);
  });

  it("uses WindowManager rotation commands that survive app orientation reversion", async () => {
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

    await adapter.sendInput(SERIAL, { type: "rotate", rotation: 0 });
    await adapter.sendInput(SERIAL, { type: "rotate", rotation: 90 });
    await adapter.sendInput(SERIAL, { type: "rotate", rotation: 180 });
    await adapter.sendInput(SERIAL, { type: "rotate", rotation: 270 });
    await adapter.sendInput(SERIAL, { type: "free" });

    const rotationCalls = calls.filter(
      (args) =>
        args[3] === "wm" && (args[4] === "user-rotation" || args[4] === "fixed-to-user-rotation"),
    );
    expect(rotationCalls).toEqual([
      ["-s", SERIAL, "shell", "wm", "fixed-to-user-rotation", "enabled"],
      ["-s", SERIAL, "shell", "wm", "user-rotation", "lock", "0"],
      ["-s", SERIAL, "shell", "wm", "fixed-to-user-rotation", "enabled"],
      ["-s", SERIAL, "shell", "wm", "user-rotation", "lock", "1"],
      ["-s", SERIAL, "shell", "wm", "fixed-to-user-rotation", "enabled"],
      ["-s", SERIAL, "shell", "wm", "user-rotation", "lock", "2"],
      ["-s", SERIAL, "shell", "wm", "fixed-to-user-rotation", "enabled"],
      ["-s", SERIAL, "shell", "wm", "user-rotation", "lock", "3"],
      ["-s", SERIAL, "shell", "wm", "fixed-to-user-rotation", "default"],
      ["-s", SERIAL, "shell", "wm", "user-rotation", "free"],
    ]);
    expect(calls.some((args) => args[3] === "settings" && args.includes("user_rotation"))).toBe(
      false,
    );
  });

  it("restores default app orientation handling when the rotation lock command fails", async () => {
    const responses = discoveryResponses();
    const calls: string[][] = [];
    const execFile: AndroidExecFile = vi.fn(async (_command, args) => {
      calls.push([...args]);
      const key = argsKey(args);
      if (key in responses) return result(responses[key]);
      if (args[3] === "wm" && args[4] === "user-rotation") {
        throw new Error("lock failed");
      }
      if (args[0] === "-s" && args[1] === SERIAL) return result();
      throw new Error(`Unexpected adb call: ${args.join(" ")}`);
    });
    const adapter = createAdapter(execFile);
    await adapter.discover();

    await expect(adapter.sendInput(SERIAL, { type: "rotate", rotation: 90 })).rejects.toMatchObject(
      {
        name: "AndroidEmulatorAdapterError",
        code: "input-failed",
        message: "Failed to lock Android Emulator orientation",
      },
    );
    expect(calls.slice(-3)).toEqual([
      ["-s", SERIAL, "shell", "wm", "fixed-to-user-rotation", "enabled"],
      ["-s", SERIAL, "shell", "wm", "user-rotation", "lock", "1"],
      ["-s", SERIAL, "shell", "wm", "fixed-to-user-rotation", "default"],
    ]);
  });

  it("restores the fixed-orientation override when releasing the user lock fails", async () => {
    const responses = discoveryResponses();
    const calls: string[][] = [];
    const execFile: AndroidExecFile = vi.fn(async (_command, args) => {
      calls.push([...args]);
      const key = argsKey(args);
      if (key in responses) return result(responses[key]);
      if (args[3] === "wm" && args[4] === "user-rotation" && args[5] === "free") {
        throw new Error("free failed");
      }
      if (args[0] === "-s" && args[1] === SERIAL) return result();
      throw new Error(`Unexpected adb call: ${args.join(" ")}`);
    });
    const adapter = createAdapter(execFile);
    await adapter.discover();

    await expect(adapter.sendInput(SERIAL, { type: "free" })).rejects.toMatchObject({
      name: "AndroidEmulatorAdapterError",
      code: "input-failed",
      message: "Failed to enable automatic Android Emulator rotation",
    });
    expect(calls.slice(-3)).toEqual([
      ["-s", SERIAL, "shell", "wm", "fixed-to-user-rotation", "default"],
      ["-s", SERIAL, "shell", "wm", "user-rotation", "free"],
      ["-s", SERIAL, "shell", "wm", "fixed-to-user-rotation", "enabled"],
    ]);
  });

  it("keeps the user rotation lock when releasing the app override fails", async () => {
    const responses = discoveryResponses();
    const calls: string[][] = [];
    const execFile: AndroidExecFile = vi.fn(async (_command, args) => {
      calls.push([...args]);
      const key = argsKey(args);
      if (key in responses) return result(responses[key]);
      if (args[3] === "wm" && args[4] === "fixed-to-user-rotation") {
        throw new Error("default failed");
      }
      if (args[0] === "-s" && args[1] === SERIAL) return result();
      throw new Error(`Unexpected adb call: ${args.join(" ")}`);
    });
    const adapter = createAdapter(execFile);
    await adapter.discover();

    await expect(adapter.sendInput(SERIAL, { type: "free" })).rejects.toMatchObject({
      name: "AndroidEmulatorAdapterError",
      code: "input-failed",
      message:
        "Failed to restore app orientation handling before enabling automatic Android Emulator rotation",
    });
    expect(calls.at(-1)).toEqual([
      "-s",
      SERIAL,
      "shell",
      "wm",
      "fixed-to-user-rotation",
      "default",
    ]);
    expect(calls.some((args) => args[4] === "user-rotation" && args[5] === "free")).toBe(false);
  });
});
