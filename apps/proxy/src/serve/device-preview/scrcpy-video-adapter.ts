import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { PROXY_PACKAGE_ROOT } from "../../version.js";

const SCRCPY_SERVER_VERSION = "4.1";
const BUNDLED_SCRCPY_SERVER_PATH = join(
  PROXY_PACKAGE_ROOT,
  "assets",
  "scrcpy",
  `scrcpy-server-v${SCRCPY_SERVER_VERSION}`,
);
const COMMAND_TIMEOUT_MS = 5_000;
const PUSH_TIMEOUT_MS = 15_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const SERVER_ERROR_LIMIT_BYTES = 64 * 1024;
const SERVER_START_TIMEOUT_MS = 5_000;
const SOCKET_ATTEMPT_TIMEOUT_MS = 250;
const SOCKET_RETRY_DELAY_MS = 40;
const CONTROL_WRITE_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_PACKET_BYTES = 2 * 1024 * 1024;
const DEFAULT_FRAME_DURATION_MS = 33;
const MIN_FRAME_DURATION_MS = 1;
const MAX_FRAME_DURATION_MS = 250;
const VIDEO_RESET_INTERVAL_MS = 500;
const CONTROL_MESSAGE_SET_CLIPBOARD = 0x09;
const CONTROL_MESSAGE_MAX_BYTES = 1 << 18;
const SET_CLIPBOARD_HEADER_BYTES = 14;
const CLIPBOARD_TEXT_MAX_BYTES = CONTROL_MESSAGE_MAX_BYTES - SET_CLIPBOARD_HEADER_BYTES;
// Scrcpy 4.1 reserves sequence 0 for SET_CLIPBOARD messages that do not request an ACK.
const SCRCPY_SEQUENCE_INVALID = 0n;
const SCRCPY_CODEC_H264 = 0x6832_3634;
const CONTROL_MESSAGE_INJECT_TOUCH = 0x02;
const TOUCH_MESSAGE_BYTES = 32;
const SCRCPY_TOUCH_POINTER_ID = 0n;
const RESET_VIDEO_MESSAGE = Buffer.from([0x11]);

const PACKET_FLAG_SESSION = 1n << 63n;
const PACKET_FLAG_CONFIGURATION = 1n << 62n;
const PACKET_FLAG_KEYFRAME = 1n << 61n;
const PACKET_PTS_MASK = PACKET_FLAG_KEYFRAME - 1n;

export interface ScrcpyVideoPacket {
  kind: "configuration" | "frame";
  keyframe: boolean;
  durationMs: number;
  data: Buffer;
}

interface ScrcpyVideoInstallation {
  version: typeof SCRCPY_SERVER_VERSION;
  serverPath: string;
}

export interface ScrcpyVideoCapability {
  available: boolean;
  version?: string;
  serverPath?: string;
  error?: string;
}

interface ScrcpyTouchInput {
  phase: "down" | "move" | "up";
  x: number;
  y: number;
}

export interface ScrcpyExecFileResult {
  stdout: Buffer | string;
  stderr: Buffer | string;
}

export type ScrcpyExecFile = (
  command: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<ScrcpyExecFileResult>;

export type ScrcpySpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type ScrcpySocketFactory = (options: { host: string; port: number }) => Socket;

interface ScrcpyVideoAdapterOptions {
  adbCommand: string;
  serverPath?: string;
  env?: NodeJS.ProcessEnv;
  execFile?: ScrcpyExecFile;
  spawn?: ScrcpySpawn;
  connect?: ScrcpySocketFactory;
  randomBytes?: (size: number) => Buffer;
  maxPacketBytes?: number;
}

type ScrcpyVideoAdapterErrorCode =
  | "scrcpy-server-unavailable"
  | "invalid-input"
  | "stream-start-failed"
  | "stream-control-unavailable"
  | "stream-control-failed"
  | "stream-protocol-error";

class ScrcpyVideoAdapterError extends Error {
  constructor(
    readonly code: ScrcpyVideoAdapterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScrcpyVideoAdapterError";
  }
}

interface OpenedVideoSocket {
  socket: Socket;
  initialData: Buffer;
}

interface ActiveControlSocket {
  socket: Socket;
  lastResetAt: number;
  lastReset?: Promise<void>;
  videoSize?: ScrcpyVideoSize;
  activeTouch?: NormalizedTouchPoint;
}

interface ScrcpyVideoSize {
  width: number;
  height: number;
}

interface NormalizedTouchPoint {
  x: number;
  y: number;
}

class RetryableSocketError extends Error {}

function defaultExecFile(
  command: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<ScrcpyExecFileResult> {
  return new Promise((resolvePromise, reject) => {
    nodeExecFile(
      command,
      [...args],
      { ...options, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({ stdout, stderr });
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

function defaultConnect(options: { host: string; port: number }): Socket {
  return createConnection(options);
}

function outputText(output: Buffer | string): string {
  return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validCommand(command: string): boolean {
  return command.length > 0 && !containsControlCharacter(command);
}

function validSerial(serial: string): boolean {
  return /^[A-Za-z0-9._:~-]{1,255}$/u.test(serial) && !serial.startsWith("-");
}

function setClipboardMessage(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length === 0 || payload.length > CLIPBOARD_TEXT_MAX_BYTES) {
    throw new ScrcpyVideoAdapterError(
      "invalid-input",
      `Scrcpy clipboard text must contain between 1 and ${CLIPBOARD_TEXT_MAX_BYTES} UTF-8 bytes`,
    );
  }

  const message = Buffer.allocUnsafe(SET_CLIPBOARD_HEADER_BYTES + payload.length);
  message[0] = CONTROL_MESSAGE_SET_CLIPBOARD;
  // Device messages on the reverse control channel are intentionally not enabled for this
  // video-only session, so clipboard messages must not request an acknowledgement.
  message.writeBigUInt64BE(SCRCPY_SEQUENCE_INVALID, 1);
  message[9] = 1;
  message.writeUInt32BE(payload.length, 10);
  payload.copy(message, SET_CLIPBOARD_HEADER_BYTES);
  return message;
}

function validNormalizedCoordinate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalizedTouchPoint(input: ScrcpyTouchInput): NormalizedTouchPoint {
  if (!validNormalizedCoordinate(input.x) || !validNormalizedCoordinate(input.y)) {
    throw new ScrcpyVideoAdapterError(
      "invalid-input",
      "Scrcpy touch coordinates must be normalized between 0 and 1",
    );
  }
  return { x: input.x, y: input.y };
}

function touchMessage(
  phase: ScrcpyTouchInput["phase"],
  point: NormalizedTouchPoint,
  size: ScrcpyVideoSize,
): Buffer {
  const action = phase === "down" ? 0 : phase === "up" ? 1 : 2;
  const x = Math.round(point.x * Math.max(0, size.width - 1));
  const y = Math.round(point.y * Math.max(0, size.height - 1));
  const message = Buffer.alloc(TOUCH_MESSAGE_BYTES);
  message[0] = CONTROL_MESSAGE_INJECT_TOUCH;
  message[1] = action;
  message.writeBigUInt64BE(SCRCPY_TOUCH_POINTER_ID, 2);
  message.writeInt32BE(x, 10);
  message.writeInt32BE(y, 14);
  message.writeUInt16BE(size.width, 18);
  message.writeUInt16BE(size.height, 20);
  message.writeUInt16BE(phase === "up" ? 0 : 0xffff, 22);
  // Android finger events must not carry mouse action-button or button-state flags.
  message.writeUInt32BE(0, 24);
  message.writeUInt32BE(0, 28);
  return message;
}

function abortError(): Error {
  const error = new Error("Scrcpy video stream was aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish(abortError());
    function finish(error?: Error) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAnnexB(data: Buffer): boolean {
  return (
    (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1) ||
    (data.length >= 3 && data[0] === 0 && data[1] === 0 && data[2] === 1)
  );
}

function boundedDuration(currentPts: bigint, previousPts: bigint | null): number {
  if (previousPts === null || currentPts <= previousPts) return DEFAULT_FRAME_DURATION_MS;
  const milliseconds = Number(currentPts - previousPts) / 1_000;
  if (!Number.isFinite(milliseconds)) return MAX_FRAME_DURATION_MS;
  return Math.min(MAX_FRAME_DURATION_MS, Math.max(MIN_FRAME_DURATION_MS, Math.round(milliseconds)));
}

class ScrcpyFrameParser {
  private pending = Buffer.alloc(0);
  private previousFramePts: bigint | null = null;
  private codecRead = false;
  private videoSize: ScrcpyVideoSize | null = null;

  constructor(
    private readonly maxPacketBytes: number,
    private readonly onVideoSession: (size: ScrcpyVideoSize) => void,
  ) {}

  push(chunk: Buffer): ScrcpyVideoPacket[] {
    if (chunk.length === 0) return [];
    this.pending =
      this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const packets: ScrcpyVideoPacket[] = [];

    if (!this.codecRead) {
      if (this.pending.length < 4) return packets;
      const codec = this.pending.readUInt32BE(0);
      if (codec !== SCRCPY_CODEC_H264) {
        throw new ScrcpyVideoAdapterError(
          "stream-protocol-error",
          `Unexpected scrcpy video codec: 0x${codec.toString(16).padStart(8, "0")}`,
        );
      }
      this.pending = this.pending.subarray(4);
      this.codecRead = true;
    }

    while (this.pending.length >= 12) {
      const ptsAndFlags = this.pending.readBigUInt64BE(0);
      if ((ptsAndFlags & PACKET_FLAG_SESSION) !== 0n) {
        const width = this.pending.readUInt32BE(4);
        const height = this.pending.readUInt32BE(8);
        if (width < 1 || width > 0xffff || height < 1 || height > 0xffff) {
          throw new ScrcpyVideoAdapterError(
            "stream-protocol-error",
            `Invalid scrcpy video session size: ${width}x${height}`,
          );
        }
        this.pending = this.pending.subarray(12);
        this.previousFramePts = null;
        this.videoSize = { width, height };
        this.onVideoSession(this.videoSize);
        continue;
      }

      if (!this.videoSize) {
        throw new ScrcpyVideoAdapterError(
          "stream-protocol-error",
          "Scrcpy sent H.264 media before video session metadata",
        );
      }

      const packetLength = this.pending.readUInt32BE(8);
      if (packetLength === 0 || packetLength > this.maxPacketBytes) {
        throw new ScrcpyVideoAdapterError(
          "stream-protocol-error",
          `Invalid scrcpy H.264 packet length: ${packetLength}`,
        );
      }
      if (this.pending.length < 12 + packetLength) break;

      const data = Buffer.from(this.pending.subarray(12, 12 + packetLength));
      this.pending = this.pending.subarray(12 + packetLength);
      if (!isAnnexB(data)) {
        throw new ScrcpyVideoAdapterError(
          "stream-protocol-error",
          "Scrcpy returned a non-Annex-B H.264 packet",
        );
      }

      const configuration = (ptsAndFlags & PACKET_FLAG_CONFIGURATION) !== 0n;
      if (configuration) {
        packets.push({
          kind: "configuration",
          keyframe: false,
          durationMs: 0,
          data,
        });
        continue;
      }

      const pts = ptsAndFlags & PACKET_PTS_MASK;
      const durationMs = boundedDuration(pts, this.previousFramePts);
      this.previousFramePts = pts;
      packets.push({
        kind: "frame",
        keyframe: (ptsAndFlags & PACKET_FLAG_KEYFRAME) !== 0n,
        durationMs,
        data,
      });
    }

    if (this.pending.length > this.maxPacketBytes + 12) {
      throw new ScrcpyVideoAdapterError(
        "stream-protocol-error",
        "Buffered scrcpy H.264 data exceeded the safety limit",
      );
    }
    return packets;
  }

  finish(): void {
    if (!this.codecRead || !this.videoSize || this.pending.length !== 0) {
      throw new ScrcpyVideoAdapterError(
        "stream-protocol-error",
        "Scrcpy H.264 stream ended with a truncated packet",
      );
    }
  }
}

export class ScrcpyVideoAdapter {
  private readonly adbCommand: string;
  private readonly requestedServerPath?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly execFile: ScrcpyExecFile;
  private readonly spawn: ScrcpySpawn;
  private readonly connect: ScrcpySocketFactory;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly maxPacketBytes: number;
  private readonly activeControlSockets = new Map<string, ActiveControlSocket>();
  private installation: ScrcpyVideoInstallation | null = null;

  constructor(options: ScrcpyVideoAdapterOptions) {
    const adbCommand = options.adbCommand.trim();
    if (!validCommand(adbCommand)) {
      throw new ScrcpyVideoAdapterError("invalid-input", "Invalid adb command");
    }
    if (
      options.maxPacketBytes !== undefined &&
      (!Number.isSafeInteger(options.maxPacketBytes) || options.maxPacketBytes < 1)
    ) {
      throw new ScrcpyVideoAdapterError(
        "invalid-input",
        "Scrcpy maximum packet size must be a positive integer",
      );
    }

    this.adbCommand = adbCommand;
    this.requestedServerPath = options.serverPath;
    this.env = { ...(options.env ?? process.env) };
    this.execFile = options.execFile ?? defaultExecFile;
    this.spawn = options.spawn ?? defaultSpawn;
    this.connect = options.connect ?? defaultConnect;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.maxPacketBytes = options.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES;
  }

  async inspect(): Promise<ScrcpyVideoCapability> {
    try {
      const installation = await this.resolve();
      return { available: true, ...installation };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : "Scrcpy is unavailable",
      };
    }
  }

  async resolve(): Promise<ScrcpyVideoInstallation> {
    if (this.installation) return { ...this.installation };
    const serverPath = await this.resolveServerPath();
    this.installation = { version: SCRCPY_SERVER_VERSION, serverPath };
    return { ...this.installation };
  }

  requestVideoReset(serial: string): Promise<void> {
    if (!validSerial(serial)) {
      return Promise.reject(
        new ScrcpyVideoAdapterError("invalid-input", "Invalid Android device serial"),
      );
    }

    const active = this.activeControlSockets.get(serial);
    if (!active || active.socket.destroyed || !active.socket.writable) {
      return Promise.reject(
        new ScrcpyVideoAdapterError(
          "stream-control-unavailable",
          `No active scrcpy control channel for Android device ${serial}`,
        ),
      );
    }

    const now = Date.now();
    if (active.lastReset && now - active.lastResetAt < VIDEO_RESET_INTERVAL_MS) {
      return active.lastReset;
    }

    active.lastResetAt = now;
    active.lastReset = this.writeControlMessage(
      active,
      serial,
      RESET_VIDEO_MESSAGE,
      `Failed to reset scrcpy video for Android device ${serial}`,
    );
    return active.lastReset;
  }

  pasteText(serial: string, text: string, signal?: AbortSignal): Promise<void> {
    if (!validSerial(serial)) {
      return Promise.reject(
        new ScrcpyVideoAdapterError("invalid-input", "Invalid Android device serial"),
      );
    }
    if (signal?.aborted) return Promise.reject(abortError());

    let message: Buffer;
    try {
      message = setClipboardMessage(text);
    } catch (error) {
      return Promise.reject(error);
    }

    const active = this.activeControlSockets.get(serial);
    if (!active || active.socket.destroyed || !active.socket.writable) {
      return Promise.reject(
        new ScrcpyVideoAdapterError(
          "stream-control-unavailable",
          `No active scrcpy control channel for Android device ${serial}`,
        ),
      );
    }

    return this.writeControlMessage(
      active,
      serial,
      message,
      `Failed to paste text into Android device ${serial}`,
      signal,
    );
  }

  sendTouch(serial: string, input: ScrcpyTouchInput, signal?: AbortSignal): Promise<void> {
    if (!validSerial(serial)) {
      return Promise.reject(
        new ScrcpyVideoAdapterError("invalid-input", "Invalid Android device serial"),
      );
    }
    if (signal?.aborted) return Promise.reject(abortError());

    let point: NormalizedTouchPoint;
    try {
      point = normalizedTouchPoint(input);
    } catch (error) {
      return Promise.reject(error);
    }

    const active = this.activeControlSockets.get(serial);
    if (!active || active.socket.destroyed || !active.socket.writable) {
      return Promise.reject(
        new ScrcpyVideoAdapterError(
          "stream-control-unavailable",
          `No active scrcpy control channel for Android device ${serial}`,
        ),
      );
    }
    if (!active.videoSize) {
      return Promise.reject(
        new ScrcpyVideoAdapterError(
          "stream-control-unavailable",
          `Scrcpy video session metadata is not ready for Android device ${serial}`,
        ),
      );
    }

    const previousPoint = active.activeTouch;
    const messages: Buffer[] = [];
    if (input.phase === "down" && previousPoint) {
      messages.push(touchMessage("up", previousPoint, active.videoSize));
    } else if (input.phase !== "down" && !previousPoint) {
      // A capture reset or control revocation may already have cancelled this touch.
      return Promise.resolve();
    }
    messages.push(touchMessage(input.phase, point, active.videoSize));
    if (input.phase === "up") {
      active.activeTouch = undefined;
    } else {
      active.activeTouch = point;
    }

    return this.writeControlMessage(
      active,
      serial,
      messages.length === 1 ? messages[0]! : Buffer.concat(messages),
      `Failed to send touch input to Android device ${serial}`,
      signal,
    );
  }

  releaseTouch(serial: string): Promise<void> {
    if (!validSerial(serial)) {
      return Promise.reject(
        new ScrcpyVideoAdapterError("invalid-input", "Invalid Android device serial"),
      );
    }
    const active = this.activeControlSockets.get(serial);
    return active ? this.releaseActiveTouch(active, serial) : Promise.resolve();
  }

  async stream(
    serial: string,
    signal: AbortSignal,
    onPacket: (packet: ScrcpyVideoPacket) => void | Promise<void>,
  ): Promise<void> {
    if (!validSerial(serial)) {
      throw new ScrcpyVideoAdapterError("invalid-input", "Invalid Android device serial");
    }
    throwIfAborted(signal);

    const installation = await this.resolve();
    throwIfAborted(signal);

    const scid = this.randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    const scidHex = scid.toString(16).padStart(8, "0");
    const socketName = `scrcpy_${scidHex}`;
    const remoteServerPath = `/data/local/tmp/dev-anywhere-scrcpy-${scidHex}.jar`;
    let forwardedPort: number | null = null;
    let child: ChildProcess | null = null;
    let videoSocket: Socket | null = null;
    let controlSocket: Socket | null = null;
    let activeControl: ActiveControlSocket | null = null;
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];

    try {
      await this.runAdb(
        ["-s", serial, "push", installation.serverPath, remoteServerPath],
        PUSH_TIMEOUT_MS,
        signal,
      );
      const forward = await this.runAdb(
        ["-s", serial, "forward", "tcp:0", `localabstract:${socketName}`],
        COMMAND_TIMEOUT_MS,
        signal,
      );
      forwardedPort = this.parseForwardedPort(outputText(forward.stdout));

      child = this.spawnServer(serial, installation.version, scidHex, remoteServerPath);
      const serverErrors = this.collectServerErrors(child);
      const opened = await this.openVideoSocket(forwardedPort, child, signal, serverErrors);
      videoSocket = opened.socket;
      controlSocket = await this.openControlSocket(forwardedPort, child, signal, serverErrors);
      activeControl = {
        socket: controlSocket,
        lastResetAt: Number.NEGATIVE_INFINITY,
      };
      this.activeControlSockets.set(serial, activeControl);
      await this.consumeVideoSocket(
        videoSocket,
        controlSocket,
        activeControl,
        serial,
        opened.initialData,
        child,
        signal,
        onPacket,
        serverErrors,
      );
    } catch (error) {
      primaryError = error;
    } finally {
      if (activeControl) {
        try {
          await this.releaseActiveTouch(activeControl, serial);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (activeControl && this.activeControlSockets.get(serial) === activeControl) {
        this.activeControlSockets.delete(serial);
      }
      videoSocket?.destroy();
      controlSocket?.destroy();
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      if (forwardedPort !== null) {
        try {
          await this.runAdb(
            ["-s", serial, "forward", "--remove", `tcp:${forwardedPort}`],
            COMMAND_TIMEOUT_MS,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await this.runAdb(
          ["-s", serial, "shell", "rm", "-f", remoteServerPath],
          COMMAND_TIMEOUT_MS,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (signal.aborted || isAbortError(primaryError)) return;
    if (primaryError) {
      if (primaryError instanceof ScrcpyVideoAdapterError) throw primaryError;
      throw new ScrcpyVideoAdapterError(
        "stream-start-failed",
        `Failed to stream Android device ${serial} with scrcpy`,
        { cause: primaryError },
      );
    }
    if (cleanupErrors.length > 0) {
      throw new ScrcpyVideoAdapterError(
        "stream-start-failed",
        "Failed to clean up the scrcpy video stream",
        { cause: cleanupErrors[0] },
      );
    }
  }

  private async resolveServerPath(): Promise<string> {
    const serverPath = this.requestedServerPath ?? BUNDLED_SCRCPY_SERVER_PATH;
    if (validCommand(serverPath)) {
      const server = await this.regularFile(serverPath);
      if (server) return server;
    }
    throw new ScrcpyVideoAdapterError(
      "scrcpy-server-unavailable",
      "The bundled Android preview component is unavailable",
    );
  }

  private async regularFile(path: string): Promise<string | null> {
    try {
      const file = await stat(path);
      if (!file.isFile()) return null;
      return await realpath(path);
    } catch {
      return null;
    }
  }

  private parseForwardedPort(output: string): number {
    const value = output.trim();
    if (!/^\d{1,5}$/u.test(value)) {
      throw new ScrcpyVideoAdapterError(
        "stream-start-failed",
        `adb returned an invalid forwarded port: ${value || "<empty>"}`,
      );
    }
    const port = Number(value);
    if (port < 1 || port > 65_535) {
      throw new ScrcpyVideoAdapterError(
        "stream-start-failed",
        `adb returned an invalid forwarded port: ${value}`,
      );
    }
    return port;
  }

  private spawnServer(
    serial: string,
    version: string,
    scidHex: string,
    remoteServerPath: string,
  ): ChildProcess {
    try {
      return this.spawn(
        this.adbCommand,
        [
          "-s",
          serial,
          "shell",
          `CLASSPATH=${remoteServerPath}`,
          "app_process",
          "/",
          "com.genymobile.scrcpy.Server",
          version,
          `scid=${scidHex}`,
          "log_level=warn",
          "tunnel_forward=true",
          "audio=false",
          "control=true",
          "clipboard_autosync=false",
          "cleanup=false",
          "max_size=720",
          "max_fps=30",
          "video_bit_rate=4000000",
          "video_codec_options=i-frame-interval=1",
          "send_device_meta=false",
          "send_dummy_byte=true",
          "send_stream_meta=true",
          "send_frame_meta=true",
        ],
        {
          env: this.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      throw new ScrcpyVideoAdapterError(
        "stream-start-failed",
        "Failed to start the scrcpy server process",
        { cause: error },
      );
    }
  }

  private collectServerErrors(child: ChildProcess): () => string {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const collect = (chunk: Buffer | string) => {
      if (bytes >= SERVER_ERROR_LIMIT_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = SERVER_ERROR_LIMIT_BYTES - bytes;
      chunks.push(buffer.subarray(0, remaining));
      bytes += Math.min(remaining, buffer.length);
    };
    // Android's scrcpy server logs to stdout, while adb itself may use stderr.
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    return () => Buffer.concat(chunks, bytes).toString("utf8").trim();
  }

  private async openVideoSocket(
    port: number,
    child: ChildProcess,
    signal: AbortSignal,
    serverErrors: () => string,
  ): Promise<OpenedVideoSocket> {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    let lastError: unknown;
    do {
      throwIfAborted(signal);
      try {
        return await this.openVideoSocketAttempt(port, child, signal, serverErrors);
      } catch (error) {
        if (isAbortError(error) || !(error instanceof RetryableSocketError)) throw error;
        lastError = error;
      }
      await delay(SOCKET_RETRY_DELAY_MS, signal);
    } while (Date.now() < deadline);

    throw new ScrcpyVideoAdapterError(
      "stream-start-failed",
      "Timed out waiting for the scrcpy video socket",
      { cause: lastError },
    );
  }

  private openVideoSocketAttempt(
    port: number,
    child: ChildProcess,
    signal: AbortSignal,
    serverErrors: () => string,
  ): Promise<OpenedVideoSocket> {
    return new Promise((resolvePromise, reject) => {
      let socket: Socket;
      try {
        socket = this.connect({ host: "127.0.0.1", port });
      } catch (error) {
        reject(new RetryableSocketError("Failed to create scrcpy video socket", { cause: error }));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        finish(new RetryableSocketError("Scrcpy video socket did not become ready"));
      }, SOCKET_ATTEMPT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        socket.removeListener("data", onData);
        socket.removeListener("end", onEnd);
        socket.removeListener("close", onClose);
        socket.removeListener("error", onSocketError);
        child.removeListener("error", onChildError);
        child.removeListener("close", onChildClose);
      };
      const finish = (error?: Error, opened?: OpenedVideoSocket) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          resolvePromise(opened!);
        }
      };
      const onAbort = () => finish(abortError());
      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        socket.pause();
        if (buffer[0] !== 0) {
          finish(
            new ScrcpyVideoAdapterError(
              "stream-protocol-error",
              "Scrcpy video socket returned an invalid readiness byte",
            ),
          );
          return;
        }
        finish(undefined, { socket, initialData: Buffer.from(buffer.subarray(1)) });
      };
      const onEnd = () => finish(new RetryableSocketError("Scrcpy video socket closed early"));
      const onClose = () => finish(new RetryableSocketError("Scrcpy video socket closed early"));
      const onSocketError = (error: Error) =>
        finish(new RetryableSocketError("Scrcpy video socket connection failed", { cause: error }));
      const onChildError = (error: Error) =>
        finish(
          new ScrcpyVideoAdapterError(
            "stream-start-failed",
            "Scrcpy server process failed to start",
            { cause: error },
          ),
        );
      const onChildClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
        const detail = serverErrors();
        finish(
          new ScrcpyVideoAdapterError(
            "stream-start-failed",
            `Scrcpy server exited with ${code ?? closeSignal ?? "unknown status"}${detail ? `: ${detail}` : ""}`,
          ),
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });
      socket.on("data", onData);
      socket.once("end", onEnd);
      socket.once("close", onClose);
      socket.once("error", onSocketError);
      child.once("error", onChildError);
      child.once("close", onChildClose);
    });
  }

  private async openControlSocket(
    port: number,
    child: ChildProcess,
    signal: AbortSignal,
    serverErrors: () => string,
  ): Promise<Socket> {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    let lastError: unknown;
    do {
      throwIfAborted(signal);
      try {
        return await this.openControlSocketAttempt(port, child, signal, serverErrors);
      } catch (error) {
        if (isAbortError(error) || !(error instanceof RetryableSocketError)) throw error;
        lastError = error;
      }
      await delay(SOCKET_RETRY_DELAY_MS, signal);
    } while (Date.now() < deadline);

    throw new ScrcpyVideoAdapterError(
      "stream-start-failed",
      "Timed out waiting for the scrcpy control socket",
      { cause: lastError },
    );
  }

  private openControlSocketAttempt(
    port: number,
    child: ChildProcess,
    signal: AbortSignal,
    serverErrors: () => string,
  ): Promise<Socket> {
    return new Promise((resolvePromise, reject) => {
      let socket: Socket;
      try {
        socket = this.connect({ host: "127.0.0.1", port });
      } catch (error) {
        reject(
          new RetryableSocketError("Failed to create scrcpy control socket", { cause: error }),
        );
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        finish(new RetryableSocketError("Scrcpy control socket did not become ready"));
      }, SOCKET_ATTEMPT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        socket.removeListener("connect", onConnect);
        socket.removeListener("end", onEnd);
        socket.removeListener("close", onClose);
        socket.removeListener("error", onSocketError);
        child.removeListener("error", onChildError);
        child.removeListener("close", onChildClose);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          socket.setNoDelay?.(true);
          resolvePromise(socket);
        }
      };
      const onAbort = () => finish(abortError());
      const onConnect = () => finish();
      const onEnd = () => finish(new RetryableSocketError("Scrcpy control socket closed early"));
      const onClose = () => finish(new RetryableSocketError("Scrcpy control socket closed early"));
      const onSocketError = (error: Error) =>
        finish(
          new RetryableSocketError("Scrcpy control socket connection failed", { cause: error }),
        );
      const onChildError = (error: Error) =>
        finish(
          new ScrcpyVideoAdapterError(
            "stream-start-failed",
            "Scrcpy server process failed to start",
            { cause: error },
          ),
        );
      const onChildClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
        const detail = serverErrors();
        finish(
          new ScrcpyVideoAdapterError(
            "stream-start-failed",
            `Scrcpy server exited with ${code ?? closeSignal ?? "unknown status"}${detail ? `: ${detail}` : ""}`,
          ),
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", onConnect);
      socket.once("end", onEnd);
      socket.once("close", onClose);
      socket.once("error", onSocketError);
      child.once("error", onChildError);
      child.once("close", onChildClose);
    });
  }

  private consumeVideoSocket(
    socket: Socket,
    controlSocket: Socket,
    activeControl: ActiveControlSocket,
    serial: string,
    initialData: Buffer,
    child: ChildProcess,
    signal: AbortSignal,
    onPacket: (packet: ScrcpyVideoPacket) => void | Promise<void>,
    serverErrors: () => string,
  ): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      let delivery = Promise.resolve();

      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        socket.removeListener("data", onData);
        socket.removeListener("end", onEnd);
        socket.removeListener("error", onSocketError);
        controlSocket.removeListener("end", onControlEnd);
        controlSocket.removeListener("close", onControlClose);
        controlSocket.removeListener("error", onControlSocketError);
        child.removeListener("error", onChildError);
        child.removeListener("close", onChildClose);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolvePromise();
      };
      const parser = new ScrcpyFrameParser(this.maxPacketBytes, (size) =>
        this.updateVideoSession(activeControl, serial, size),
      );
      const onAbort = () => finish();
      const onEnd = () => {
        if (signal.aborted) {
          finish();
          return;
        }
        try {
          parser.finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        finish(
          new ScrcpyVideoAdapterError(
            "stream-start-failed",
            "Scrcpy video stream ended unexpectedly",
          ),
        );
      };
      const onSocketError = (error: Error) => {
        if (signal.aborted) finish();
        else
          finish(
            new ScrcpyVideoAdapterError("stream-start-failed", "Scrcpy video socket failed", {
              cause: error,
            }),
          );
      };
      const onControlEnd = () => {
        if (signal.aborted) finish();
        else
          finish(
            new ScrcpyVideoAdapterError(
              "stream-control-unavailable",
              "Scrcpy control channel ended unexpectedly",
            ),
          );
      };
      const onControlClose = () => onControlEnd();
      const onControlSocketError = (error: Error) => {
        if (signal.aborted) finish();
        else
          finish(
            new ScrcpyVideoAdapterError("stream-control-failed", "Scrcpy control socket failed", {
              cause: error,
            }),
          );
      };
      const onChildError = (error: Error) =>
        finish(
          new ScrcpyVideoAdapterError("stream-start-failed", "Scrcpy server process failed", {
            cause: error,
          }),
        );
      const onChildClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (signal.aborted) {
          finish();
          return;
        }
        const detail = serverErrors();
        finish(
          new ScrcpyVideoAdapterError(
            "stream-start-failed",
            `Scrcpy server exited with ${code ?? closeSignal ?? "unknown status"}${detail ? `: ${detail}` : ""}`,
          ),
        );
      };

      const ingest = (chunk: Buffer | string): boolean => {
        if (settled) return false;
        let packets: ScrcpyVideoPacket[];
        try {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          packets = parser.push(buffer);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return false;
        }
        if (packets.length === 0) return false;

        socket.pause();
        delivery = delivery
          .then(async () => {
            for (const packet of packets) {
              if (settled || signal.aborted) return;
              await onPacket(packet);
            }
          })
          .then(
            () => {
              if (!settled && !signal.aborted) socket.resume();
            },
            (error: unknown) => {
              finish(
                error instanceof ScrcpyVideoAdapterError
                  ? error
                  : new ScrcpyVideoAdapterError(
                      "stream-start-failed",
                      "Scrcpy H.264 packet consumer failed",
                      { cause: error },
                    ),
              );
            },
          );
        return true;
      };
      const onData = (chunk: Buffer | string) => ingest(chunk);

      signal.addEventListener("abort", onAbort, { once: true });
      socket.on("data", onData);
      socket.once("end", onEnd);
      socket.once("error", onSocketError);
      controlSocket.once("end", onControlEnd);
      controlSocket.once("close", onControlClose);
      controlSocket.once("error", onControlSocketError);
      child.once("error", onChildError);
      child.once("close", onChildClose);
      controlSocket.resume();
      const deliveryQueued = ingest(initialData);
      if (!settled && !deliveryQueued) socket.resume();
    });
  }

  private updateVideoSession(active: ActiveControlSocket, serial: string, size: ScrcpyVideoSize) {
    if (active.videoSize && active.activeTouch) {
      void this.releaseActiveTouch(active, serial).catch(() => undefined);
    }
    active.videoSize = size;
  }

  private releaseActiveTouch(active: ActiveControlSocket, serial: string): Promise<void> {
    const size = active.videoSize;
    const touch = active.activeTouch;
    active.activeTouch = undefined;
    if (!touch || !size || active.socket.destroyed || !active.socket.writable) {
      return Promise.resolve();
    }
    return this.writeControlMessage(
      active,
      serial,
      touchMessage("up", touch, size),
      `Failed to release active touch input on Android device ${serial}`,
    );
  }

  private writeControlMessage(
    active: ActiveControlSocket,
    serial: string,
    message: Buffer,
    errorMessage: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      this.invalidateControlSocket(active, serial);
      return Promise.reject(abortError());
    }
    return new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(
          new ScrcpyVideoAdapterError(
            "stream-control-failed",
            `${errorMessage}: control write timed out`,
          ),
          true,
        );
      }, CONTROL_WRITE_TIMEOUT_MS);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error, invalidate = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (invalidate) this.invalidateControlSocket(active, serial);
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      };
      const onAbort = () => finish(abortError(), true);

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        active.socket.write(message, (error) => {
          if (error) {
            finish(
              new ScrcpyVideoAdapterError("stream-control-failed", errorMessage, {
                cause: error,
              }),
              true,
            );
            return;
          }
          finish();
        });
      } catch (error) {
        finish(
          new ScrcpyVideoAdapterError("stream-control-failed", errorMessage, { cause: error }),
          true,
        );
      }
    });
  }

  private invalidateControlSocket(active: ActiveControlSocket, serial: string): void {
    active.activeTouch = undefined;
    active.lastReset = undefined;
    if (this.activeControlSockets.get(serial) === active) {
      this.activeControlSockets.delete(serial);
    }
    if (!active.socket.destroyed) active.socket.destroy();
  }

  private runAdb(
    args: readonly string[],
    timeout: number,
    signal?: AbortSignal,
  ): Promise<ScrcpyExecFileResult> {
    return this.execFile(this.adbCommand, args, {
      env: this.env,
      timeout,
      maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
  }
}
