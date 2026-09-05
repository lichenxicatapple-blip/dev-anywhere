import { execFile as nodeExecFile, type ExecFileOptions } from "node:child_process";
import { posix, win32 } from "node:path";
import { environmentValue, normalizeProcessEnvironment } from "../../common/executable.js";

const ADB_TIMEOUT_MS = 5_000;
const ADB_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export type AndroidDisplayRotation = 0 | 90 | 180 | 270;

interface AndroidEmulatorDevice {
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
  | { type: "home" }
  | { type: "back" }
  | { type: "rotate"; rotation: AndroidDisplayRotation }
  | { type: "free" };

export interface AndroidExecFileResult {
  stdout: Buffer | string;
  stderr: Buffer | string;
}

export type AndroidExecFile = (
  command: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<AndroidExecFileResult>;

interface AndroidDebugBridgeCapability {
  available: boolean;
  command?: string;
  version?: string;
  error?: string;
}

interface AndroidEmulatorAdapterOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  execFile?: AndroidExecFile;
  platform?: NodeJS.Platform;
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
      | "input-failed",
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

function adbCandidates(
  command: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const explicit = command?.trim();
  if (explicit) {
    if (!validCommand(explicit)) return [];
    return [explicit];
  }

  const executable = platform === "win32" ? "adb.exe" : "adb";
  const { join, delimiter } = platform === "win32" ? win32 : posix;
  const readEnv = (key: string) => environmentValue(env, key, platform);
  const candidates: string[] = [];
  const sdkRoots = [readEnv("ANDROID_SDK_ROOT"), readEnv("ANDROID_HOME")];
  const home = readEnv("HOME");
  const localAppData = readEnv("LOCALAPPDATA");
  if (platform === "win32") {
    if (localAppData) sdkRoots.push(join(localAppData, "Android", "Sdk"));
  } else if (home) {
    sdkRoots.push(
      platform === "darwin"
        ? join(home, "Library", "Android", "sdk")
        : join(home, "Android", "Sdk"),
    );
  }
  for (const root of sdkRoots) {
    if (root) candidates.push(join(root, "platform-tools", executable));
  }
  for (const entry of (readEnv("PATH") ?? "").split(delimiter)) {
    if (entry)
      candidates.push(
        join(platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry, executable),
      );
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

export class AndroidEmulatorAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestedCommand?: string;
  private readonly platform: NodeJS.Platform;
  private readonly execFile: AndroidExecFile;
  private readonly allowedDevices = new Map<string, AndroidEmulatorDevice>();
  private readonly inputQueues = new Map<string, Promise<void>>();
  private locatedCommand: string | null = null;

  constructor(options: AndroidEmulatorAdapterOptions) {
    this.platform = options.platform ?? process.platform;
    this.env = normalizeProcessEnvironment({ ...(options.env ?? process.env) }, this.platform);
    this.requestedCommand = options.command;
    this.execFile = options.execFile ?? defaultExecFile;
  }

  async inspect(): Promise<AndroidDebugBridgeCapability> {
    if (this.locatedCommand) {
      return { available: true, command: this.locatedCommand };
    }

    for (const candidate of adbCandidates(this.requestedCommand, this.env, this.platform)) {
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
    const previousDevices = new Map(this.allowedDevices);

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
        // A transient metadata command failure is not proof that a still-listed emulator went
        // offline. Keep only a previously verified snapshot; a first-seen unverifiable device is
        // still excluded from the allow-list.
        const previous = previousDevices.get(entry.serial);
        if (previous) discovered.push({ ...previous });
      }
    }

    this.allowedDevices.clear();
    for (const device of discovered) {
      this.allowedDevices.set(device.serial, device);
    }
    return discovered.map((device) => ({ ...device }));
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
        await this.lockRotation(serial, input.rotation / 90);
        return;
      case "free":
        await this.enableAutomaticRotation(serial);
        return;
    }
  }

  private async lockRotation(serial: string, quarterTurns: number): Promise<void> {
    try {
      await this.adbText(serial, ["shell", "wm", "fixed-to-user-rotation", "enabled"]);
    } catch (error) {
      throw new AndroidEmulatorAdapterError(
        "input-failed",
        "Failed to enable fixed Android Emulator orientation",
        { cause: error },
      );
    }

    try {
      await this.adbText(serial, ["shell", "wm", "user-rotation", "lock", String(quarterTurns)]);
    } catch (error) {
      try {
        await this.adbText(serial, ["shell", "wm", "fixed-to-user-rotation", "default"]);
      } catch (rollbackError) {
        throw new AndroidEmulatorAdapterError(
          "input-failed",
          "Failed to lock Android Emulator orientation and restore app orientation handling",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      throw new AndroidEmulatorAdapterError(
        "input-failed",
        "Failed to lock Android Emulator orientation",
        { cause: error },
      );
    }
  }

  private async enableAutomaticRotation(serial: string): Promise<void> {
    try {
      await this.adbText(serial, ["shell", "wm", "fixed-to-user-rotation", "default"]);
    } catch (error) {
      throw new AndroidEmulatorAdapterError(
        "input-failed",
        "Failed to restore app orientation handling before enabling automatic Android Emulator rotation",
        { cause: error },
      );
    }

    try {
      // Keep this last: user-rotation free enables Android's sensor orientation listener
      // after fixed-to-user-rotation has stopped overriding app orientation requests.
      await this.adbText(serial, ["shell", "wm", "user-rotation", "free"]);
    } catch (error) {
      try {
        await this.adbText(serial, ["shell", "wm", "fixed-to-user-rotation", "enabled"]);
      } catch (rollbackError) {
        throw new AndroidEmulatorAdapterError(
          "input-failed",
          "Failed to enable automatic Android Emulator rotation and restore fixed orientation",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      throw new AndroidEmulatorAdapterError(
        "input-failed",
        "Failed to enable automatic Android Emulator rotation",
        { cause: error },
      );
    }
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
