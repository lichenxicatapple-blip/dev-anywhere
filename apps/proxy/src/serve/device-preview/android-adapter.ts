import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import { delimiter, join } from "node:path";

const ADB_TIMEOUT_MS = 5_000;
const ADB_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const SCREENSHOT_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const SCREENSHOT_ERROR_LIMIT_BYTES = 64 * 1024;
const SCREENSHOT_TIMEOUT_MS = 5_000;
const DEFAULT_FRAME_INTERVAL_MS = 250;
const DEFAULT_JPEG_WIDTH = 720;
const DEFAULT_JPEG_QUALITY = 70;
const MAX_TEXT_BYTES = 4 * 1024;

export type AndroidDisplayRotation = 0 | 90 | 180 | 270;

export interface AndroidEmulatorDevice {
  platform: "android";
  serial: string;
  model: string;
  apiLevel: number;
  release: string;
  width: number;
  height: number;
  rotation: AndroidDisplayRotation;
}

export type AndroidEmulatorInput =
  | { type: "tap"; x: number; y: number }
  | {
      type: "swipe";
      from: { x: number; y: number };
      to: { x: number; y: number };
      durationMs?: number;
    }
  | { type: "text"; text: string }
  | { type: "home" }
  | { type: "back" }
  | { type: "rotate"; rotation: AndroidDisplayRotation }
  | { type: "free" };

export interface AndroidJpegEncodeOptions {
  width: number;
  quality: number;
  signal: AbortSignal;
}

export type AndroidPngToJpegEncoder = (
  png: Buffer,
  options: AndroidJpegEncodeOptions,
) => Promise<Buffer>;

export interface AndroidExecFileResult {
  stdout: Buffer | string;
  stderr: Buffer | string;
}

export type AndroidExecFile = (
  command: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<AndroidExecFileResult>;

export type AndroidSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface AndroidDebugBridgeCapability {
  available: boolean;
  command?: string;
  version?: string;
  error?: string;
}

export interface AndroidEmulatorAdapterOptions {
  encodePngToJpeg: AndroidPngToJpegEncoder;
  command?: string;
  env?: NodeJS.ProcessEnv;
  execFile?: AndroidExecFile;
  spawn?: AndroidSpawn;
  frameIntervalMs?: number;
}

export interface AndroidFrameStreamOptions {
  signal: AbortSignal;
  frameIntervalMs?: number;
}

interface DisplayMetrics {
  width: number;
  height: number;
  rotation: AndroidDisplayRotation;
}

interface ListedDevice {
  serial: string;
  modelHint?: string;
}

export class AndroidEmulatorAdapterError extends Error {
  constructor(
    readonly code:
      | "adb-unavailable"
      | "device-not-allowed"
      | "invalid-device-metadata"
      | "invalid-input"
      | "capture-failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AndroidEmulatorAdapterError";
  }
}

function defaultExecFile(
  command: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<AndroidExecFileResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      command,
      [...args],
      { ...options, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return nodeSpawn(command, [...args], options);
}

function boundedFrameInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FRAME_INTERVAL_MS;
  if (!Number.isFinite(value) || value < 50 || value > 10_000) {
    throw new AndroidEmulatorAdapterError(
      "invalid-input",
      "Android frame interval must be between 50 and 10000 milliseconds",
    );
  }
  return Math.floor(value);
}

function outputText(output: Buffer | string): string {
  return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validCommand(command: string): boolean {
  return command.length > 0 && !containsControlCharacter(command);
}

function validEmulatorSerial(serial: string): boolean {
  const match = /^emulator-([1-9]\d{0,4})$/u.exec(serial);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port <= 65_535;
}

function adbCandidates(command: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const explicit = command?.trim();
  if (explicit) {
    if (!validCommand(explicit)) return [];
    return [explicit];
  }

  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates: string[] = [];
  const sdkRoots = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME];
  if (env.HOME) {
    sdkRoots.push(
      process.platform === "darwin"
        ? join(env.HOME, "Library", "Android", "sdk")
        : join(env.HOME, "Android", "Sdk"),
    );
  }
  for (const root of sdkRoots) {
    if (root) candidates.push(join(root, "platform-tools", executable));
  }
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry) candidates.push(join(entry, executable));
  }
  candidates.push(executable);
  return [...new Set(candidates.filter(validCommand))];
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/u, 1)[0]?.trim() ?? "";
}

function parseDeviceList(output: string): ListedDevice[] {
  const devices: ListedDevice[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(emulator-\S+)\s+device(?:\s+(.*))?$/u.exec(line.trim());
    if (!match) continue;
    const serial = match[1];
    if (!serial || !validEmulatorSerial(serial) || seen.has(serial)) continue;
    seen.add(serial);
    const modelHint = /(?:^|\s)model:([^\s]+)/u.exec(match[2] ?? "")?.[1]?.replaceAll("_", " ");
    devices.push({ serial, ...(modelHint ? { modelHint } : {}) });
  }
  return devices;
}

function parseRotation(output: string): AndroidDisplayRotation | null {
  const rotationEnumMatch = /(?:rotation|orientation)\s*[:=]\s*ROTATION_([0-3])\b/iu.exec(output);
  if (rotationEnumMatch) return (Number(rotationEnumMatch[1]) * 90) as AndroidDisplayRotation;

  const degreeMatch = /(?:rotation|orientation)\s*[:=]\s*(?:ROTATION_)?(0|90|180|270)\b/iu.exec(
    output,
  );
  if (degreeMatch) return Number(degreeMatch[1]) as AndroidDisplayRotation;

  const quarterTurnMatch =
    /(?:SurfaceOrientation|mCurrentOrientation|user_rotation)\s*[:=]\s*([0-3])\b/iu.exec(output);
  if (!quarterTurnMatch) return null;
  return (Number(quarterTurnMatch[1]) * 90) as AndroidDisplayRotation;
}

function parseNaturalSize(output: string): { width: number; height: number } | null {
  const matches = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/giu)];
  if (matches.length === 0) return null;
  let override: RegExpExecArray | undefined;
  for (const match of matches) {
    if (match[0].toLowerCase().startsWith("override")) override = match;
  }
  const selected = override ?? matches.at(-1);
  const width = Number(selected?.[1]);
  const height = Number(selected?.[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 32_768 ||
    height > 32_768
  ) {
    return null;
  }
  return { width, height };
}

function orientSize(
  naturalSize: { width: number; height: number },
  rotation: AndroidDisplayRotation,
): DisplayMetrics {
  if (rotation === 90 || rotation === 270) {
    return { width: naturalSize.height, height: naturalSize.width, rotation };
  }
  return { ...naturalSize, rotation };
}

function parsePngSize(png: Buffer): { width: number; height: number } | null {
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 32_768 || height > 32_768) return null;
  return { width, height };
}

function normalizedCoordinate(value: number, extent: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AndroidEmulatorAdapterError(
      "invalid-input",
      `${label} must be a normalized coordinate between 0 and 1`,
    );
  }
  return Math.round(value * Math.max(0, extent - 1));
}

function swipeDuration(durationMs: number | undefined): number {
  if (durationMs === undefined) return 300;
  if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > 60_000) {
    throw new AndroidEmulatorAdapterError(
      "invalid-input",
      "Swipe duration must be between 1 and 60000 milliseconds",
    );
  }
  return Math.floor(durationMs);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function encodedInputText(text: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES || containsControlCharacter(text)) {
    throw new AndroidEmulatorAdapterError(
      "invalid-input",
      "Android text input must contain at most 4096 bytes and no control characters",
    );
  }
  return shellQuote(text.replaceAll(" ", "%s"));
}

function abortError(): Error {
  const error = new Error("Android frame stream was aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class AndroidEmulatorAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestedCommand?: string;
  private readonly execFile: AndroidExecFile;
  private readonly spawn: AndroidSpawn;
  private readonly encodePngToJpeg: AndroidPngToJpegEncoder;
  private readonly frameIntervalMs: number;
  private readonly allowedDevices = new Map<string, AndroidEmulatorDevice>();
  private readonly inputQueues = new Map<string, Promise<void>>();
  private readonly activeFrameStreams = new Set<string>();
  private locatedCommand: string | null = null;

  constructor(options: AndroidEmulatorAdapterOptions) {
    this.env = { ...(options.env ?? process.env) };
    this.requestedCommand = options.command;
    this.execFile = options.execFile ?? defaultExecFile;
    this.spawn = options.spawn ?? defaultSpawn;
    this.encodePngToJpeg = options.encodePngToJpeg;
    this.frameIntervalMs = boundedFrameInterval(options.frameIntervalMs);
  }

  async inspect(): Promise<AndroidDebugBridgeCapability> {
    if (this.locatedCommand) {
      return { available: true, command: this.locatedCommand };
    }

    for (const candidate of adbCandidates(this.requestedCommand, this.env)) {
      try {
        const result = await this.execFile(candidate, ["version"], {
          env: this.env,
          timeout: ADB_TIMEOUT_MS,
          maxBuffer: ADB_OUTPUT_LIMIT_BYTES,
          windowsHide: true,
        });
        const version = firstLine(`${outputText(result.stdout)}\n${outputText(result.stderr)}`);
        this.locatedCommand = candidate;
        return {
          available: true,
          command: candidate,
          version: version || "Android Debug Bridge",
        };
      } catch {
        // A candidate may be stale; continue through SDK roots and PATH.
      }
    }

    return { available: false, error: "未找到 Android Debug Bridge (adb)" };
  }

  async discover(): Promise<AndroidEmulatorDevice[]> {
    const command = await this.requireCommand();
    const result = await this.execFile(command, ["devices", "-l"], this.execOptions());
    const listed = parseDeviceList(outputText(result.stdout));
    const discovered: AndroidEmulatorDevice[] = [];

    for (const entry of listed) {
      try {
        const bootCompleted = firstLine(
          await this.adbText(entry.serial, ["shell", "getprop", "sys.boot_completed"]),
        );
        if (bootCompleted !== "1") continue;

        const model = firstLine(
          await this.adbText(entry.serial, ["shell", "getprop", "ro.product.model"]),
        );
        const apiLevelText = firstLine(
          await this.adbText(entry.serial, ["shell", "getprop", "ro.build.version.sdk"]),
        );
        const release = firstLine(
          await this.adbText(entry.serial, ["shell", "getprop", "ro.build.version.release"]),
        );
        const metrics = await this.queryDisplayMetrics(entry.serial);
        const apiLevel = Number(apiLevelText);
        if (!Number.isSafeInteger(apiLevel) || apiLevel <= 0 || apiLevel > 999 || !release) {
          throw new AndroidEmulatorAdapterError(
            "invalid-device-metadata",
            `Android Emulator ${entry.serial} returned invalid version metadata`,
          );
        }

        discovered.push({
          platform: "android",
          serial: entry.serial,
          model: model || entry.modelHint || entry.serial,
          apiLevel,
          release,
          ...metrics,
        });
      } catch {
        // Never allow a device whose boot state or display metadata cannot be verified.
      }
    }

    this.allowedDevices.clear();
    for (const device of discovered) this.allowedDevices.set(device.serial, device);
    return discovered.map((device) => ({ ...device }));
  }

  getDevice(serial: string): AndroidEmulatorDevice | undefined {
    const device = this.allowedDevices.get(serial);
    return device ? { ...device } : undefined;
  }

  async streamFrames(
    serial: string,
    onFrame: (jpeg: Buffer) => void | Promise<void>,
    options: AndroidFrameStreamOptions,
  ): Promise<void> {
    this.requireAllowedDevice(serial);
    if (this.activeFrameStreams.has(serial)) {
      throw new AndroidEmulatorAdapterError(
        "capture-failed",
        `Android Emulator ${serial} already has an active frame stream`,
      );
    }

    const intervalMs = boundedFrameInterval(options.frameIntervalMs ?? this.frameIntervalMs);
    this.activeFrameStreams.add(serial);
    try {
      while (!options.signal.aborted) {
        const startedAt = Date.now();
        try {
          const png = await this.capturePng(serial, options.signal);
          if (options.signal.aborted) return;
          const size = parsePngSize(png);
          if (!size) {
            throw new AndroidEmulatorAdapterError(
              "capture-failed",
              `Android Emulator ${serial} returned an invalid PNG screenshot`,
            );
          }
          const device = this.requireAllowedDevice(serial);
          this.allowedDevices.set(serial, { ...device, ...size });
          const jpeg = await this.encodePngToJpeg(png, {
            width: DEFAULT_JPEG_WIDTH,
            quality: DEFAULT_JPEG_QUALITY,
            signal: options.signal,
          });
          if (options.signal.aborted) return;
          if (!Buffer.isBuffer(jpeg) || jpeg.length === 0) {
            throw new AndroidEmulatorAdapterError(
              "capture-failed",
              "Android JPEG encoder returned an empty frame",
            );
          }
          await onFrame(jpeg);
        } catch (error) {
          if (options.signal.aborted || isAbortError(error)) return;
          if (error instanceof AndroidEmulatorAdapterError) throw error;
          throw new AndroidEmulatorAdapterError(
            "capture-failed",
            `Failed to capture Android Emulator ${serial}`,
            { cause: error },
          );
        }

        await abortableDelay(intervalMs - (Date.now() - startedAt), options.signal);
      }
    } finally {
      this.activeFrameStreams.delete(serial);
    }
  }

  sendInput(serial: string, input: AndroidEmulatorInput): Promise<void> {
    const previous = this.inputQueues.get(serial) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.performInput(serial, input));
    this.inputQueues.set(serial, current);
    void current.then(
      () => {
        if (this.inputQueues.get(serial) === current) this.inputQueues.delete(serial);
      },
      () => {
        if (this.inputQueues.get(serial) === current) this.inputQueues.delete(serial);
      },
    );
    return current;
  }

  private async performInput(serial: string, input: AndroidEmulatorInput): Promise<void> {
    this.requireAllowedDevice(serial);
    switch (input.type) {
      case "tap": {
        const metrics = await this.refreshDisplayMetrics(serial);
        const x = normalizedCoordinate(input.x, metrics.width, "Tap x");
        const y = normalizedCoordinate(input.y, metrics.height, "Tap y");
        await this.adbText(serial, ["shell", "input", "tap", String(x), String(y)]);
        return;
      }
      case "swipe": {
        const metrics = await this.refreshDisplayMetrics(serial);
        const fromX = normalizedCoordinate(input.from.x, metrics.width, "Swipe start x");
        const fromY = normalizedCoordinate(input.from.y, metrics.height, "Swipe start y");
        const toX = normalizedCoordinate(input.to.x, metrics.width, "Swipe end x");
        const toY = normalizedCoordinate(input.to.y, metrics.height, "Swipe end y");
        await this.adbText(serial, [
          "shell",
          "input",
          "swipe",
          String(fromX),
          String(fromY),
          String(toX),
          String(toY),
          String(swipeDuration(input.durationMs)),
        ]);
        return;
      }
      case "text":
        await this.adbText(serial, ["shell", "input", "text", encodedInputText(input.text)]);
        return;
      case "home":
        await this.adbText(serial, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
        return;
      case "back":
        await this.adbText(serial, ["shell", "input", "keyevent", "KEYCODE_BACK"]);
        return;
      case "rotate":
        if (![0, 90, 180, 270].includes(input.rotation)) {
          throw new AndroidEmulatorAdapterError(
            "invalid-input",
            "Android rotation must be 0, 90, 180, or 270 degrees",
          );
        }
        await this.adbText(serial, [
          "shell",
          "settings",
          "put",
          "system",
          "accelerometer_rotation",
          "0",
        ]);
        await this.adbText(serial, [
          "shell",
          "settings",
          "put",
          "system",
          "user_rotation",
          String(input.rotation / 90),
        ]);
        return;
      case "free":
        await this.adbText(serial, [
          "shell",
          "settings",
          "put",
          "system",
          "accelerometer_rotation",
          "1",
        ]);
        return;
    }
  }

  private async refreshDisplayMetrics(serial: string): Promise<DisplayMetrics> {
    const metrics = await this.queryDisplayMetrics(serial);
    const device = this.requireAllowedDevice(serial);
    this.allowedDevices.set(serial, { ...device, ...metrics });
    return metrics;
  }

  private async queryDisplayMetrics(serial: string): Promise<DisplayMetrics> {
    const sizeOutput = await this.adbText(serial, ["shell", "wm", "size"]);
    const naturalSize = parseNaturalSize(sizeOutput);
    if (!naturalSize) {
      throw new AndroidEmulatorAdapterError(
        "invalid-device-metadata",
        `Android Emulator ${serial} returned an invalid display size`,
      );
    }

    const inputState = await this.adbText(serial, ["shell", "dumpsys", "input"]);
    let rotation = parseRotation(inputState);
    if (rotation === null) {
      const userRotation = await this.adbText(serial, [
        "shell",
        "settings",
        "get",
        "system",
        "user_rotation",
      ]);
      rotation = parseRotation(`user_rotation=${firstLine(userRotation)}`);
    }
    if (rotation === null) {
      throw new AndroidEmulatorAdapterError(
        "invalid-device-metadata",
        `Android Emulator ${serial} returned an invalid display rotation`,
      );
    }
    return orientSize(naturalSize, rotation);
  }

  private async capturePng(serial: string, signal: AbortSignal): Promise<Buffer> {
    const command = await this.requireCommand();
    if (signal.aborted) throw abortError();

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawn(command, ["-s", serial, "exec-out", "screencap", "-p"], {
          env: this.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(error);
        return;
      }

      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdout || !stderr) {
        child.kill("SIGKILL");
        reject(
          new AndroidEmulatorAdapterError(
            "capture-failed",
            "Android screenshot process did not expose output pipes",
          ),
        );
        return;
      }

      const chunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      let outputBytes = 0;
      let errorBytes = 0;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        stdout.removeAllListeners();
        stderr.removeAllListeners();
        child.removeAllListeners("error");
        child.removeAllListeners("close");
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(Buffer.concat(chunks, outputBytes));
      };
      const onAbort = () => {
        child.kill("SIGKILL");
        finish(abortError());
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(
          new AndroidEmulatorAdapterError(
            "capture-failed",
            "Android screenshot process timed out after 5 seconds",
          ),
        );
      }, SCREENSHOT_TIMEOUT_MS);
      timeout.unref?.();

      signal.addEventListener("abort", onAbort, { once: true });
      stdout.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > SCREENSHOT_OUTPUT_LIMIT_BYTES) {
          child.kill("SIGKILL");
          finish(
            new AndroidEmulatorAdapterError(
              "capture-failed",
              "Android screenshot exceeded the 32 MiB safety limit",
            ),
          );
          return;
        }
        chunks.push(buffer);
      });
      stderr.on("data", (chunk: Buffer | string) => {
        if (errorBytes >= SCREENSHOT_ERROR_LIMIT_BYTES) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = SCREENSHOT_ERROR_LIMIT_BYTES - errorBytes;
        errorChunks.push(buffer.subarray(0, remaining));
        errorBytes += Math.min(buffer.length, remaining);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code, closeSignal) => {
        if (code === 0) {
          finish();
          return;
        }
        const detail = Buffer.concat(errorChunks, errorBytes).toString("utf8").trim();
        finish(
          new AndroidEmulatorAdapterError(
            "capture-failed",
            `Android screenshot process exited with ${code ?? closeSignal ?? "unknown status"}${detail ? `: ${detail}` : ""}`,
          ),
        );
      });
    });
  }

  private execOptions(): ExecFileOptions {
    return {
      env: this.env,
      timeout: ADB_TIMEOUT_MS,
      maxBuffer: ADB_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
    };
  }

  private async adbText(serial: string, args: readonly string[]): Promise<string> {
    if (!validEmulatorSerial(serial)) {
      throw new AndroidEmulatorAdapterError(
        "device-not-allowed",
        "Invalid Android Emulator serial",
      );
    }
    const command = await this.requireCommand();
    const result = await this.execFile(command, ["-s", serial, ...args], this.execOptions());
    return outputText(result.stdout);
  }

  private requireAllowedDevice(serial: string): AndroidEmulatorDevice {
    if (!validEmulatorSerial(serial) || !this.allowedDevices.has(serial)) {
      throw new AndroidEmulatorAdapterError(
        "device-not-allowed",
        "Android Emulator must be discovered, fully booted, and explicitly allowed before use",
      );
    }
    return this.allowedDevices.get(serial)!;
  }

  private async requireCommand(): Promise<string> {
    if (this.locatedCommand) return this.locatedCommand;
    const capability = await this.inspect();
    if (!capability.available || !capability.command) {
      throw new AndroidEmulatorAdapterError(
        "adb-unavailable",
        capability.error ?? "Android Debug Bridge is unavailable",
      );
    }
    return capability.command;
  }
}
