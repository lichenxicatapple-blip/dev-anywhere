import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import WebSocket, { type RawData } from "ws";

const execFileAsync = promisify(nodeExecFile);

const SIMCTL_TIMEOUT_MS = 10_000;
const SIMCTL_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const BAGUETTE_VERSION_TIMEOUT_MS = 5_000;
const BAGUETTE_VERSION_OUTPUT_LIMIT_BYTES = 16 * 1024;
const BAGUETTE_LAYOUT_TIMEOUT_MS = 10_000;
const BAGUETTE_LAYOUT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const BAGUETTE_COMMAND_MAX_LENGTH = 4_096;
const INPUT_ACK_TIMEOUT_MS = 5_000;
const INPUT_LINE_LIMIT_BYTES = 64 * 1024;
const INPUT_TEXT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_MAX_JPEG_FRAME_BYTES = 32 * 1024 * 1024;
const DEFAULT_STREAM_QUEUE_LIMIT = 2;
const DEFAULT_SERVE_STARTUP_TIMEOUT_MS = 10_000;
const SERVE_CONNECT_ATTEMPT_TIMEOUT_MS = 250;
const SERVE_CONNECT_RETRY_DELAY_MS = 50;
const CHILD_FORCE_KILL_DELAY_MS = 1_000;
const MAX_SIMULATOR_COUNT = 1_024;
const MAX_LOGICAL_POINT_EDGE = 16_384;
const MINIMUM_BAGUETTE_VERSION = [0, 1, 96] as const;

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const IOS_RUNTIME_PATTERN = /(?:^|\.)iOS(?:-|$)/i;
const SEMVER_PATTERN =
  /^(?:baguette(?:\s+version)?\s+)?v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/i;

export const IOS_SIMULATOR_UDID_PATTERN =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export type IosSimulatorOrientation =
  | "portrait"
  | "portrait-upside-down"
  | "landscape-left"
  | "landscape-right";

export type IosSimulatorState = "booted" | "shutdown" | "transitioning";

export interface LogicalPointSize {
  width: number;
  height: number;
}

export interface IosSimulatorDevice {
  platform: "ios";
  udid: string;
  name: string;
  runtimeIdentifier: string;
  rawState: string;
  state: IosSimulatorState;
  booted: boolean;
  interactive: boolean;
  logicalPointSize?: LogicalPointSize;
  orientation?: IosSimulatorOrientation;
}

export interface IosSimulatorTargetMetadata {
  udid: string;
  logicalPointSize: LogicalPointSize;
  orientation: IosSimulatorOrientation;
}

export interface BaguetteCapability {
  available: boolean;
  command?: string;
  version?: string;
  reason?:
    | "not_configured"
    | "not_found"
    | "invalid_version"
    | "unsupported_version"
    | "unavailable";
}

export type IosSimulatorInput =
  | {
      type: "tap";
      x: number;
      y: number;
      durationMs?: number;
    }
  | {
      type: "swipe";
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      durationMs?: number;
    }
  | {
      type: "text";
      text: string;
    }
  | {
      type: "home";
    }
  | {
      type: "orientation";
      orientation: IosSimulatorOrientation;
    };

export interface ExecFileRunnerOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
}

export interface ExecFileRunnerResult {
  stdout: string;
  stderr: string;
}

export type ExecFileRunner = (
  command: string,
  args: readonly string[],
  options: ExecFileRunnerOptions,
) => Promise<ExecFileRunnerResult>;

export type SpawnRunner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type LoopbackPortAllocator = () => Promise<number>;

export type BaguetteWebSocketFactory = (url: string) => WebSocket;

export interface IosSimulatorAdapterOptions {
  /** Resolved externally; omit to expose only simctl discovery. */
  baguetteCommand?: string;
  /** Passed as-is (after a defensive copy); PATH/login-shell policy stays outside this adapter. */
  baguetteEnv?: NodeJS.ProcessEnv;
  xcrunCommand?: string;
  simctlEnv?: NodeJS.ProcessEnv;
  execFile?: ExecFileRunner;
  spawn?: SpawnRunner;
  reserveLoopbackPort?: LoopbackPortAllocator;
  createWebSocket?: BaguetteWebSocketFactory;
  inputAckTimeoutMs?: number;
  maxJpegFrameBytes?: number;
  streamQueueLimit?: number;
  serveStartupTimeoutMs?: number;
}

export interface StreamMjpegOptions {
  udid: string;
  signal?: AbortSignal;
}

export interface SendInputOptions {
  signal?: AbortSignal;
}

export type IosSimulatorAdapterErrorCode =
  | "INVALID_UDID"
  | "INVALID_TARGET_METADATA"
  | "SIMCTL_UNAVAILABLE"
  | "SIMCTL_INVALID_RESPONSE"
  | "BAGUETTE_UNAVAILABLE"
  | "UNKNOWN_DEVICE"
  | "DEVICE_NOT_BOOTED"
  | "POINT_SIZE_UNAVAILABLE"
  | "INVALID_INPUT"
  | "STREAM_FAILED"
  | "INPUT_FAILED"
  | "INPUT_TIMEOUT"
  | "INPUT_PROTOCOL_ERROR";

export class IosSimulatorAdapterError extends Error {
  constructor(
    readonly code: IosSimulatorAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IosSimulatorAdapterError";
  }
}

interface StoredDevice {
  udid: string;
  name: string;
  runtimeIdentifier: string;
  rawState: string;
  state: IosSimulatorState;
  booted: boolean;
}

interface StoredTargetMetadata {
  portraitPointSize: LogicalPointSize;
  orientation: IosSimulatorOrientation;
}

interface SimctlDeviceRecord {
  udid?: unknown;
  name?: unknown;
  state?: unknown;
  isAvailable?: unknown;
}

async function defaultExecFileRunner(
  command: string,
  args: readonly string[],
  options: ExecFileRunnerOptions,
): Promise<ExecFileRunnerResult> {
  const result = await execFileAsync(command, [...args], {
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    windowsHide: true,
    encoding: "utf8",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function defaultSpawnRunner(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return nodeSpawn(command, [...args], options);
}

async function defaultReserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(streamFailure("Could not reserve a loopback port for Baguette"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

const terminatingChildren = new WeakSet<ChildProcess>();

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  if (child.signalCode !== null && child.signalCode !== undefined) return;
  if (terminatingChildren.has(child)) return;
  terminatingChildren.add(child);
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may have exited between the status check and kill.
  }
  const forceKill = setTimeout(() => {
    if (child.exitCode !== null && child.exitCode !== undefined) return;
    if (child.signalCode !== null && child.signalCode !== undefined) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may have exited between the status check and kill.
    }
  }, CHILD_FORCE_KILL_DELAY_MS);
  forceKill.unref();
  child.once("close", () => clearTimeout(forceKill));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUdid(value: string): string {
  if (typeof value !== "string" || !IOS_SIMULATOR_UDID_PATTERN.test(value)) {
    throw new IosSimulatorAdapterError("INVALID_UDID", "Invalid iOS Simulator UDID");
  }
  return value.toUpperCase();
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  if (
    command.length === 0 ||
    command.length > BAGUETTE_COMMAND_MAX_LENGTH ||
    containsControlCharacter(command) ||
    command.trim() !== command
  ) {
    throw new IosSimulatorAdapterError("BAGUETTE_UNAVAILABLE", "Invalid Baguette command");
  }
  return command;
}

function validateLogicalPointSize(size: LogicalPointSize): LogicalPointSize {
  if (
    !size ||
    typeof size !== "object" ||
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > MAX_LOGICAL_POINT_EDGE ||
    size.height > MAX_LOGICAL_POINT_EDGE
  ) {
    throw new IosSimulatorAdapterError(
      "INVALID_TARGET_METADATA",
      "Invalid iOS Simulator logical point size",
    );
  }
  return { width: size.width, height: size.height };
}

function validateOrientation(value: unknown): IosSimulatorOrientation {
  if (
    value !== "portrait" &&
    value !== "portrait-upside-down" &&
    value !== "landscape-left" &&
    value !== "landscape-right"
  ) {
    throw new IosSimulatorAdapterError("INVALID_INPUT", "Invalid iOS Simulator orientation");
  }
  return value;
}

function isLandscape(orientation: IosSimulatorOrientation): boolean {
  return orientation === "landscape-left" || orientation === "landscape-right";
}

function logicalSizeFor(metadata: StoredTargetMetadata): LogicalPointSize {
  const { portraitPointSize, orientation } = metadata;
  return isLandscape(orientation)
    ? { width: portraitPointSize.height, height: portraitPointSize.width }
    : { ...portraitPointSize };
}

function normalizeState(rawState: string): IosSimulatorState {
  if (rawState === "Booted") return "booted";
  if (rawState === "Shutdown") return "shutdown";
  return "transitioning";
}

function processCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  return /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code) ? error.code : undefined;
}

function inputFailure(message: string): IosSimulatorAdapterError {
  return new IosSimulatorAdapterError("INPUT_FAILED", message);
}

function streamFailure(message: string): IosSimulatorAdapterError {
  return new IosSimulatorAdapterError("STREAM_FAILED", message);
}

function validateNormalizedCoordinate(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new IosSimulatorAdapterError(
      "INVALID_INPUT",
      `${name} must be a finite number between 0 and 1`,
    );
  }
  return value;
}

function validateDuration(
  durationMs: number | undefined,
  defaultMs: number,
  maximumMs: number,
): number {
  const value = durationMs ?? defaultMs;
  if (!Number.isFinite(value) || value <= 0 || value > maximumMs) {
    throw new IosSimulatorAdapterError("INVALID_INPUT", "Invalid input duration");
  }
  return value / 1_000;
}

function devicePoint(value: number, extent: number): number {
  return Number((value * extent).toFixed(3));
}

export function parseBaguetteVersion(output: string): string | null {
  if (Buffer.byteLength(output, "utf8") > BAGUETTE_VERSION_OUTPUT_LIMIT_BYTES) return null;
  const match = output.trim().match(SEMVER_PATTERN);
  const version = match?.[1];
  if (!version) return null;
  const withoutBuild = version.split("+", 1)[0]!;
  const prereleaseSeparator = withoutBuild.indexOf("-");
  const prerelease =
    prereleaseSeparator === -1 ? undefined : withoutBuild.slice(prereleaseSeparator + 1);
  if (prerelease?.split(".").some((part) => /^0\d+$/u.test(part))) return null;
  return version;
}

export function isSupportedBaguetteVersion(version: string): boolean {
  const parsed = parseBaguetteVersion(version);
  if (!parsed) return false;
  const withoutBuild = parsed.split("+", 1)[0]!;
  // A prerelease can still change the serve/stream contract. Be conservative even when its core
  // version sorts above the minimum stable release.
  if (withoutBuild.includes("-")) return false;
  const parts = withoutBuild.split(".").map(Number);
  for (let index = 0; index < MINIMUM_BAGUETTE_VERSION.length; index += 1) {
    const actual = parts[index]!;
    const minimum = MINIMUM_BAGUETTE_VERSION[index];
    if (actual > minimum) return true;
    if (actual < minimum) return false;
  }
  return true;
}

export function parseBaguetteChromeLayout(output: string): LogicalPointSize {
  if (Buffer.byteLength(output, "utf8") > BAGUETTE_LAYOUT_OUTPUT_LIMIT_BYTES) {
    throw new IosSimulatorAdapterError(
      "INVALID_TARGET_METADATA",
      "Baguette chrome layout exceeded the size limit",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new IosSimulatorAdapterError(
      "INVALID_TARGET_METADATA",
      "Baguette chrome layout returned invalid JSON",
    );
  }
  if (!isRecord(parsed)) {
    throw new IosSimulatorAdapterError(
      "INVALID_TARGET_METADATA",
      "Baguette chrome layout is not an object",
    );
  }
  const screen = parsed.screen;
  if (!isRecord(screen)) {
    throw new IosSimulatorAdapterError(
      "INVALID_TARGET_METADATA",
      "Baguette chrome layout is missing screen geometry",
    );
  }
  return validateLogicalPointSize({
    width: screen.width as number,
    height: screen.height as number,
  });
}

function parseSimctlDevices(output: string): StoredDevice[] {
  if (Buffer.byteLength(output, "utf8") > SIMCTL_OUTPUT_LIMIT_BYTES) {
    throw new IosSimulatorAdapterError(
      "SIMCTL_INVALID_RESPONSE",
      "simctl response exceeded the size limit",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new IosSimulatorAdapterError("SIMCTL_INVALID_RESPONSE", "simctl returned invalid JSON");
  }

  if (!isRecord(parsed) || !isRecord(parsed.devices)) {
    throw new IosSimulatorAdapterError(
      "SIMCTL_INVALID_RESPONSE",
      "simctl response is missing devices",
    );
  }

  const devices: StoredDevice[] = [];
  const seen = new Set<string>();
  for (const [runtimeIdentifier, records] of Object.entries(parsed.devices)) {
    if (!IOS_RUNTIME_PATTERN.test(runtimeIdentifier) || !Array.isArray(records)) continue;
    for (const candidate of records) {
      if (devices.length >= MAX_SIMULATOR_COUNT) {
        throw new IosSimulatorAdapterError(
          "SIMCTL_INVALID_RESPONSE",
          "simctl returned too many devices",
        );
      }
      if (!isRecord(candidate)) continue;
      const record = candidate as SimctlDeviceRecord;
      if (
        typeof record.udid !== "string" ||
        typeof record.name !== "string" ||
        typeof record.state !== "string" ||
        record.name.length === 0 ||
        record.name.length > 512 ||
        record.isAvailable === false
      ) {
        continue;
      }

      let udid: string;
      try {
        udid = normalizeUdid(record.udid);
      } catch {
        continue;
      }
      if (seen.has(udid)) continue;
      seen.add(udid);
      const state = normalizeState(record.state);
      devices.push({
        udid,
        name: record.name,
        runtimeIdentifier,
        rawState: record.state,
        state,
        booted: state === "booted",
      });
    }
  }
  return devices;
}

export class JpegStreamFramer {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_JPEG_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 4) {
      throw new RangeError("maxFrameBytes must be an integer of at least 4");
    }
  }

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.byteLength === 0) return [];
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: Buffer[] = [];

    while (this.buffer.length > 0) {
      const start = this.buffer.indexOf(JPEG_SOI);
      if (start === -1) {
        this.buffer =
          this.buffer[this.buffer.length - 1] === 0xff ? Buffer.from([0xff]) : Buffer.alloc(0);
        break;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);

      const endMarker = this.buffer.indexOf(JPEG_EOI, JPEG_SOI.length);
      const nestedStart = this.buffer.indexOf(JPEG_SOI, JPEG_SOI.length);
      if (nestedStart !== -1 && (endMarker === -1 || nestedStart < endMarker)) {
        this.buffer = this.buffer.subarray(nestedStart);
        continue;
      }
      if (endMarker === -1) {
        if (this.buffer.length > this.maxFrameBytes) {
          this.buffer = Buffer.alloc(0);
          throw streamFailure("MJPEG frame exceeded the configured size limit");
        }
        break;
      }

      const frameEnd = endMarker + JPEG_EOI.length;
      if (frameEnd > this.maxFrameBytes) {
        this.buffer = this.buffer.subarray(frameEnd);
        throw streamFailure("MJPEG frame exceeded the configured size limit");
      }
      frames.push(Buffer.from(this.buffer.subarray(0, frameEnd)));
      this.buffer = this.buffer.subarray(frameEnd);
    }

    return frames;
  }
}

class AsyncFrameQueue {
  private readonly values: Buffer[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<Buffer>) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private error: Error | null = null;

  constructor(private readonly limit: number) {}

  push(value: Buffer): void {
    if (this.ended || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    while (this.values.length >= this.limit) this.values.shift();
    this.values.push(value);
  }

  end(): void {
    if (this.ended || this.error) return;
    this.ended = true;
    if (this.values.length > 0) return;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.ended || this.error) return;
    this.error = error;
    this.values.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<Buffer>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function waitForWebSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState !== WebSocket.CONNECTING) {
    return Promise.reject(streamFailure("Baguette stream socket closed before opening"));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onOpen = (): void => settle();
    const onError = (): void => settle(streamFailure("Could not connect to Baguette stream"));
    const onClose = (): void =>
      settle(streamFailure("Baguette stream socket closed before opening"));
    const onAbort = (): void => settle(abortError());
    const timer = setTimeout(
      () => settle(streamFailure("Timed out connecting to Baguette stream")),
      timeoutMs,
    );
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

interface PendingPasteResult {
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  sent: boolean;
  callerSettled: boolean;
}

class BaguetteServeSession {
  private readonly frames: AsyncFrameQueue;
  private inputTail: Promise<void> = Promise.resolve();
  private pendingPaste: PendingPasteResult | null = null;
  private closed = false;

  private readonly onOutput = (): void => {
    // Drain local process output so the private server cannot block on full pipes.
  };

  private readonly onMessage = (data: RawData, isBinary: boolean): void => {
    if (this.closed) return;
    if (!isBinary) {
      this.acceptTextMessage(rawDataToBuffer(data));
      return;
    }
    const frame = rawDataToBuffer(data);
    if (
      frame.length < 4 ||
      frame.length > this.maxJpegFrameBytes ||
      frame[0] !== JPEG_SOI[0] ||
      frame[1] !== JPEG_SOI[1] ||
      frame[frame.length - 2] !== JPEG_EOI[0] ||
      frame[frame.length - 1] !== JPEG_EOI[1]
    ) {
      this.fail(streamFailure("Baguette stream returned an invalid JPEG frame"));
      return;
    }
    this.frames.push(Buffer.from(frame));
  };

  private readonly onSocketError = (): void => {
    this.fail(streamFailure("Baguette stream socket failed"));
  };

  private readonly onSocketClose = (): void => {
    this.fail(streamFailure("Baguette stream socket closed"));
  };

  private readonly onProcessError = (error: Error): void => {
    const code = processCode(error);
    this.fail(
      streamFailure(
        code ? `Baguette serve process failed (${code})` : "Baguette serve process failed",
      ),
    );
  };

  private readonly onProcessClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.fail(
      streamFailure(
        `Baguette serve process closed (code=${String(code)}, signal=${String(signal)})`,
      ),
      false,
    );
  };

  constructor(
    private readonly child: ChildProcess,
    private readonly socket: WebSocket,
    queueLimit: number,
    private readonly maxJpegFrameBytes: number,
    private readonly inputAckTimeoutMs: number,
  ) {
    if (!child.stdout || !child.stderr) {
      terminateChild(child);
      throw streamFailure("Baguette serve process did not expose output pipes");
    }
    this.frames = new AsyncFrameQueue(queueLimit);
    child.stdout.on("data", this.onOutput);
    child.stderr.on("data", this.onOutput);
    child.once("error", this.onProcessError);
    child.once("close", this.onProcessClose);
    socket.on("message", this.onMessage);
    socket.once("error", this.onSocketError);
    socket.once("close", this.onSocketClose);
  }

  nextFrame(): Promise<IteratorResult<Buffer>> {
    return this.frames.next();
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.inputTail.then(async () => {
      if (this.closed) throw inputFailure("Baguette preview session is closed");
      return operation();
    });
    this.inputTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  sendEnvelope(envelope: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return this.runExclusive(() =>
      envelope.type === "paste"
        ? this.sendPasteEnvelope(envelope, signal)
        : this.sendJson(envelope, signal),
    );
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (reason) this.frames.fail(reason);
    else this.frames.end();
    this.completePendingPaste(reason ?? inputFailure("Baguette preview session was closed"));
    this.detach();
    try {
      this.socket.terminate();
    } catch {
      // The socket may already be closed.
    }
    terminateChild(this.child);
  }

  private sendJson(envelope: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(inputFailure("Baguette preview session is closed"));
    }
    const payload = JSON.stringify(envelope);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => finish(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.socket.send(payload, (error) =>
          finish(error ? inputFailure("Could not send input to Baguette") : undefined),
        );
      } catch {
        finish(inputFailure("Could not send input to Baguette"));
      }
    });
  }

  private sendPasteEnvelope(
    envelope: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (this.pendingPaste) {
      return Promise.reject(
        new IosSimulatorAdapterError(
          "INPUT_PROTOCOL_ERROR",
          "Baguette already has a pending paste result",
        ),
      );
    }
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(inputFailure("Baguette preview session is closed"));
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.pendingPaste;
        if (!pending) return;
        if (pending.sent) this.settlePasteCaller(abortError());
        else this.completePendingPaste(abortError());
      };
      const timer = setTimeout(
        () =>
          this.settlePasteCaller(
            new IosSimulatorAdapterError(
              "INPUT_TIMEOUT",
              `Baguette paste did not acknowledge within ${this.inputAckTimeoutMs}ms`,
            ),
          ),
        this.inputAckTimeoutMs,
      );
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      this.pendingPaste = { resolve, reject, cleanup, sent: false, callerSettled: false };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.pendingPaste.sent = true;
        this.socket.send(JSON.stringify(envelope), (error) => {
          if (error) {
            this.completePendingPaste(inputFailure("Could not send paste input to Baguette"));
          }
        });
      } catch {
        this.completePendingPaste(inputFailure("Could not send paste input to Baguette"));
      }
    });
  }

  private acceptTextMessage(payload: Buffer): void {
    if (payload.byteLength > INPUT_LINE_LIMIT_BYTES) {
      this.completePendingPaste(
        new IosSimulatorAdapterError(
          "INPUT_PROTOCOL_ERROR",
          "Baguette input response exceeded the size limit",
        ),
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString("utf8")) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.type !== "paste_result") return;
    if (!this.pendingPaste) return;
    if (typeof parsed.ok !== "boolean") {
      this.completePendingPaste(
        new IosSimulatorAdapterError(
          "INPUT_PROTOCOL_ERROR",
          "Baguette sent an invalid paste result",
        ),
      );
      return;
    }
    if (parsed.ok) {
      this.completePendingPaste();
      return;
    }
    const detail =
      typeof parsed.error === "string" && parsed.error.length > 0
        ? parsed.error.slice(0, 512)
        : "Baguette rejected the paste input";
    this.completePendingPaste(inputFailure(detail));
  }

  private settlePasteCaller(error: Error): void {
    const pending = this.pendingPaste;
    if (!pending || pending.callerSettled) return;
    pending.callerSettled = true;
    pending.cleanup();
    pending.reject(error);
  }

  private completePendingPaste(error?: Error): void {
    const pending = this.pendingPaste;
    if (!pending) return;
    this.pendingPaste = null;
    pending.cleanup();
    if (pending.callerSettled) return;
    pending.callerSettled = true;
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private fail(error: Error, kill = true): void {
    if (this.closed) return;
    this.closed = true;
    this.frames.fail(error);
    this.completePendingPaste(error);
    this.detach();
    try {
      this.socket.terminate();
    } catch {
      // The socket may already be closed.
    }
    if (kill) terminateChild(this.child);
  }

  private detach(): void {
    this.child.stdout?.off("data", this.onOutput);
    this.child.stderr?.off("data", this.onOutput);
    this.child.off("error", this.onProcessError);
    this.child.off("close", this.onProcessClose);
    this.socket.off("message", this.onMessage);
    this.socket.off("error", this.onSocketError);
    this.socket.off("close", this.onSocketClose);
  }
}

interface BaguetteServeSlot {
  abort: AbortController;
  promise: Promise<BaguetteServeSession>;
}

export class IosSimulatorAdapter {
  private readonly baguetteCommand?: string;
  private readonly baguetteEnv: NodeJS.ProcessEnv;
  private readonly xcrunCommand: string;
  private readonly simctlEnv: NodeJS.ProcessEnv;
  private readonly execFile: ExecFileRunner;
  private readonly spawn: SpawnRunner;
  private readonly reserveLoopbackPort: LoopbackPortAllocator;
  private readonly createWebSocket: BaguetteWebSocketFactory;
  private readonly inputAckTimeoutMs: number;
  private readonly maxJpegFrameBytes: number;
  private readonly streamQueueLimit: number;
  private readonly serveStartupTimeoutMs: number;
  private readonly devices = new Map<string, StoredDevice>();
  private readonly metadata = new Map<string, StoredTargetMetadata>();
  private readonly serveSessions = new Map<string, BaguetteServeSlot>();

  constructor(options: IosSimulatorAdapterOptions = {}) {
    this.baguetteCommand = validateCommand(options.baguetteCommand);
    this.baguetteEnv = { ...(options.baguetteEnv ?? {}) };
    this.xcrunCommand = options.xcrunCommand ?? "xcrun";
    this.simctlEnv = { ...(options.simctlEnv ?? process.env) };
    this.execFile = options.execFile ?? defaultExecFileRunner;
    this.spawn = options.spawn ?? defaultSpawnRunner;
    this.reserveLoopbackPort = options.reserveLoopbackPort ?? defaultReserveLoopbackPort;
    this.inputAckTimeoutMs = options.inputAckTimeoutMs ?? INPUT_ACK_TIMEOUT_MS;
    this.maxJpegFrameBytes = options.maxJpegFrameBytes ?? DEFAULT_MAX_JPEG_FRAME_BYTES;
    this.streamQueueLimit = options.streamQueueLimit ?? DEFAULT_STREAM_QUEUE_LIMIT;
    this.serveStartupTimeoutMs = options.serveStartupTimeoutMs ?? DEFAULT_SERVE_STARTUP_TIMEOUT_MS;
    this.createWebSocket =
      options.createWebSocket ??
      ((url) =>
        new WebSocket(url, {
          perMessageDeflate: false,
          maxPayload: Math.max(this.maxJpegFrameBytes, INPUT_LINE_LIMIT_BYTES),
        }));

    if (!Number.isSafeInteger(this.inputAckTimeoutMs) || this.inputAckTimeoutMs <= 0) {
      throw new RangeError("inputAckTimeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.streamQueueLimit) || this.streamQueueLimit <= 0) {
      throw new RangeError("streamQueueLimit must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxJpegFrameBytes) || this.maxJpegFrameBytes < 4) {
      throw new RangeError("maxJpegFrameBytes must be an integer of at least 4");
    }
    if (!Number.isSafeInteger(this.serveStartupTimeoutMs) || this.serveStartupTimeoutMs <= 0) {
      throw new RangeError("serveStartupTimeoutMs must be a positive integer");
    }
  }

  async inspectBaguetteCapability(): Promise<BaguetteCapability> {
    const command = this.baguetteCommand;
    if (!command) return { available: false, reason: "not_configured" };

    try {
      const result = await this.execFile(command, ["--version"], {
        env: this.baguetteEnv,
        timeoutMs: BAGUETTE_VERSION_TIMEOUT_MS,
        maxBufferBytes: BAGUETTE_VERSION_OUTPUT_LIMIT_BYTES,
      });
      const version = parseBaguetteVersion(result.stdout);
      if (!version) return { available: false, command, reason: "invalid_version" };
      if (!isSupportedBaguetteVersion(version)) {
        return { available: false, command, version, reason: "unsupported_version" };
      }
      return { available: true, command, version };
    } catch (error) {
      return {
        available: false,
        command,
        reason: processCode(error) === "ENOENT" ? "not_found" : "unavailable",
      };
    }
  }

  async discoverDevices(): Promise<IosSimulatorDevice[]> {
    let result: ExecFileRunnerResult;
    try {
      result = await this.execFile(
        this.xcrunCommand,
        ["simctl", "list", "devices", "available", "--json"],
        {
          env: this.simctlEnv,
          timeoutMs: SIMCTL_TIMEOUT_MS,
          maxBufferBytes: SIMCTL_OUTPUT_LIMIT_BYTES,
        },
      );
    } catch (error) {
      const code = processCode(error);
      throw new IosSimulatorAdapterError(
        "SIMCTL_UNAVAILABLE",
        code ? `Could not run simctl (${code})` : "Could not run simctl",
      );
    }

    const parsed = parseSimctlDevices(result.stdout);
    this.devices.clear();
    for (const device of parsed) this.devices.set(device.udid, device);
    for (const udid of this.metadata.keys()) {
      if (!this.devices.get(udid)?.booted) this.metadata.delete(udid);
    }
    for (const udid of this.serveSessions.keys()) {
      if (this.devices.get(udid)?.booted) continue;
      this.closeInput(udid);
    }

    if (this.baguetteCommand) {
      for (const device of parsed) {
        if (!device.booted) continue;
        try {
          await this.refreshTargetMetadata(device.udid);
        } catch {
          // Streaming remains usable when DeviceKit has no chrome layout for this model.
        }
      }
    }
    return parsed.map((device) => this.presentDevice(device));
  }

  async refreshTargetMetadata(udidValue: string): Promise<IosSimulatorTargetMetadata> {
    const device = this.requireBootedDevice(udidValue);
    const command = this.requireBaguetteCommand();
    try {
      const result = await this.execFile(command, ["chrome", "layout", "--udid", device.udid], {
        env: this.baguetteEnv,
        timeoutMs: BAGUETTE_LAYOUT_TIMEOUT_MS,
        maxBufferBytes: BAGUETTE_LAYOUT_OUTPUT_LIMIT_BYTES,
      });
      const portraitPointSize = parseBaguetteChromeLayout(result.stdout);
      const orientation = this.metadata.get(device.udid)?.orientation ?? "portrait";
      const stored = { portraitPointSize, orientation };
      this.metadata.set(device.udid, stored);
      return {
        udid: device.udid,
        logicalPointSize: logicalSizeFor(stored),
        orientation,
      };
    } catch (error) {
      this.metadata.delete(device.udid);
      if (error instanceof IosSimulatorAdapterError) throw error;
      const code = processCode(error);
      throw new IosSimulatorAdapterError(
        "INVALID_TARGET_METADATA",
        code
          ? `Could not read iOS Simulator layout (${code})`
          : "Could not read iOS Simulator layout",
      );
    }
  }

  listDiscoveredDevices(): IosSimulatorDevice[] {
    return [...this.devices.values()].map((device) => this.presentDevice(device));
  }

  async *streamMjpeg(options: StreamMjpegOptions): AsyncGenerator<Buffer> {
    const udid = this.requireBootedDevice(options.udid).udid;
    this.requireBaguetteCommand();
    throwIfAborted(options.signal);
    if (this.serveSessions.has(udid)) {
      throw streamFailure("An iOS Simulator preview is already active for this target");
    }

    const lifecycle = new AbortController();
    const forwardAbort = (): void => lifecycle.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) lifecycle.abort();
    const slot: BaguetteServeSlot = {
      abort: lifecycle,
      promise: this.startServeSession(udid, lifecycle.signal),
    };
    this.serveSessions.set(udid, slot);
    let session: BaguetteServeSession | undefined;
    const closeForAbort = (): void => session?.close(abortError());
    try {
      session = await slot.promise;
      lifecycle.signal.addEventListener("abort", closeForAbort, { once: true });
      if (lifecycle.signal.aborted) closeForAbort();
      while (true) {
        const next = await session.nextFrame();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
      lifecycle.signal.removeEventListener("abort", closeForAbort);
      if (this.serveSessions.get(udid) === slot) this.serveSessions.delete(udid);
      lifecycle.abort();
      session?.close();
    }
  }

  sendInput(
    udidValue: string,
    input: IosSimulatorInput,
    options: SendInputOptions = {},
  ): Promise<void> {
    const device = this.requireBootedDevice(udidValue);
    this.requirePointSize(device.udid);

    if (input.type === "orientation") {
      const orientation = validateOrientation(input.orientation);
      const session = this.requireActiveSession(device.udid);
      return session.then((active) =>
        active.runExclusive(async () => {
          throwIfAborted(options.signal);
          const command = this.requireBaguetteCommand();
          try {
            await this.execFile(command, ["orientation", "--udid", device.udid, orientation], {
              env: this.baguetteEnv,
              timeoutMs: this.inputAckTimeoutMs,
              maxBufferBytes: INPUT_LINE_LIMIT_BYTES,
              ...(options.signal ? { signal: options.signal } : {}),
            });
          } catch (error) {
            if (isAbortError(error) || options.signal?.aborted) throw abortError();
            const code = processCode(error);
            throw inputFailure(
              code ? `Baguette orientation failed (${code})` : "Baguette orientation failed",
            );
          }
          const metadata = this.metadata.get(device.udid);
          if (metadata) metadata.orientation = orientation;
        }),
      );
    }

    const envelope = this.createInputEnvelope(device.udid, input);
    return this.requireActiveSession(device.udid).then((session) =>
      session.sendEnvelope(envelope, options.signal),
    );
  }

  closeInput(udidValue: string): void {
    const udid = normalizeUdid(udidValue);
    const slot = this.serveSessions.get(udid);
    if (!slot) return;
    this.serveSessions.delete(udid);
    slot.abort.abort();
    void slot.promise.then(
      (session) => session.close(),
      () => undefined,
    );
  }

  dispose(): void {
    for (const udid of [...this.serveSessions.keys()]) this.closeInput(udid);
  }

  private presentDevice(device: StoredDevice): IosSimulatorDevice {
    const metadata = this.metadata.get(device.udid);
    return {
      platform: "ios",
      ...device,
      interactive: metadata !== undefined,
      ...(metadata
        ? {
            logicalPointSize: logicalSizeFor(metadata),
            orientation: metadata.orientation,
          }
        : {}),
    };
  }

  private requireBaguetteCommand(): string {
    if (!this.baguetteCommand) {
      throw new IosSimulatorAdapterError(
        "BAGUETTE_UNAVAILABLE",
        "Baguette command is not configured",
      );
    }
    return this.baguetteCommand;
  }

  private requireBootedDevice(udidValue: string): StoredDevice {
    const udid = normalizeUdid(udidValue);
    const device = this.devices.get(udid);
    if (!device) {
      throw new IosSimulatorAdapterError(
        "UNKNOWN_DEVICE",
        "iOS Simulator was not returned by the latest discovery",
      );
    }
    if (!device.booted) {
      throw new IosSimulatorAdapterError("DEVICE_NOT_BOOTED", "iOS Simulator is not booted");
    }
    return device;
  }

  private requirePointSize(udid: string): LogicalPointSize {
    const metadata = this.metadata.get(udid);
    if (!metadata) {
      throw new IosSimulatorAdapterError(
        "POINT_SIZE_UNAVAILABLE",
        "iOS Simulator logical point size is unavailable",
      );
    }
    return logicalSizeFor(metadata);
  }

  private requireActiveSession(udid: string): Promise<BaguetteServeSession> {
    const slot = this.serveSessions.get(udid);
    if (!slot) throw inputFailure("The iOS Simulator preview stream is not active");
    return slot.promise;
  }

  private async startServeSession(
    udid: string,
    signal: AbortSignal,
  ): Promise<BaguetteServeSession> {
    const deadline = Date.now() + this.serveStartupTimeoutMs;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await this.startServeAttempt(udid, deadline, signal);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw abortError();
        lastError = error;
        if (Date.now() >= deadline) break;
        await delay(SERVE_CONNECT_RETRY_DELAY_MS, signal);
      }
    }
    const code = processCode(lastError);
    throw streamFailure(
      code
        ? `Could not start Baguette preview server (${code})`
        : "Could not start Baguette preview server",
    );
  }

  private async startServeAttempt(
    udid: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<BaguetteServeSession> {
    throwIfAborted(signal);
    const port = await this.reserveLoopbackPort();
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw streamFailure("Could not reserve a valid loopback port for Baguette");
    }
    throwIfAborted(signal);

    const command = this.requireBaguetteCommand();
    let child: ChildProcess;
    try {
      child = this.spawn(
        command,
        ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-plugins"],
        {
          env: this.baguetteEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      const code = processCode(error);
      throw streamFailure(
        code ? `Could not start Baguette serve (${code})` : "Could not start Baguette serve",
      );
    }
    if (!child.stdout || !child.stderr) {
      terminateChild(child);
      throw streamFailure("Baguette serve process did not expose output pipes");
    }

    let processFailure: Error | undefined;
    const onOutput = (): void => {
      // Drain stdout/stderr during startup without exposing local process output.
    };
    const onProcessError = (error: Error): void => {
      const code = processCode(error);
      processFailure = streamFailure(
        code ? `Baguette serve process failed (${code})` : "Baguette serve process failed",
      );
    };
    const onProcessClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
      processFailure = streamFailure(
        `Baguette serve process closed (code=${String(code)}, signal=${String(closeSignal)})`,
      );
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", onProcessError);
    child.once("close", onProcessClose);

    let promoted = false;
    try {
      while (Date.now() < deadline) {
        throwIfAborted(signal);
        if (processFailure) throw processFailure;
        let socket: WebSocket;
        try {
          socket = this.createWebSocket(
            `ws://127.0.0.1:${port}/simulators/${encodeURIComponent(udid)}/stream?format=mjpeg`,
          );
        } catch {
          await delay(SERVE_CONNECT_RETRY_DELAY_MS, signal);
          continue;
        }
        const drainSocketError = (): void => {
          // Failed connection attempts are expected until the local server is ready.
        };
        socket.on("error", drainSocketError);
        try {
          await waitForWebSocketOpen(
            socket,
            Math.max(1, Math.min(SERVE_CONNECT_ATTEMPT_TIMEOUT_MS, deadline - Date.now())),
            signal,
          );
        } catch (error) {
          try {
            socket.terminate();
          } catch {
            // The socket may already be closed.
          }
          if (isAbortError(error) || signal.aborted) throw abortError();
          if (processFailure) throw processFailure;
          await delay(SERVE_CONNECT_RETRY_DELAY_MS, signal);
          continue;
        }

        if (processFailure) {
          try {
            socket.terminate();
          } catch {
            // The socket may already be closed.
          }
          throw processFailure;
        }

        const session = new BaguetteServeSession(
          child,
          socket,
          this.streamQueueLimit,
          this.maxJpegFrameBytes,
          this.inputAckTimeoutMs,
        );
        child.stdout.off("data", onOutput);
        child.stderr.off("data", onOutput);
        child.off("error", onProcessError);
        child.off("close", onProcessClose);
        promoted = true;
        try {
          await session.sendEnvelope({ type: "set_fps", fps: 15 }, signal);
        } catch (error) {
          session.close(
            error instanceof Error ? error : streamFailure("Could not configure stream"),
          );
          throw error;
        }
        return session;
      }
      throw streamFailure("Timed out starting Baguette preview server");
    } finally {
      if (!promoted) {
        child.stdout.off("data", onOutput);
        child.stderr.off("data", onOutput);
        child.off("error", onProcessError);
        child.off("close", onProcessClose);
        terminateChild(child);
      }
    }
  }

  private createInputEnvelope(
    udid: string,
    input: Exclude<IosSimulatorInput, { type: "orientation" }>,
  ): Record<string, unknown> {
    if (input.type === "home") return { type: "button", button: "home" };
    if (input.type === "text") {
      if (
        typeof input.text !== "string" ||
        input.text.length === 0 ||
        Buffer.byteLength(input.text, "utf8") > INPUT_TEXT_LIMIT_BYTES
      ) {
        throw new IosSimulatorAdapterError(
          "INVALID_INPUT",
          "Text input must be non-empty and within the size limit",
        );
      }
      return { type: "paste", text: input.text };
    }

    const size = this.requirePointSize(udid);
    if (input.type === "tap") {
      return {
        type: "tap",
        x: devicePoint(validateNormalizedCoordinate(input.x, "x"), size.width),
        y: devicePoint(validateNormalizedCoordinate(input.y, "y"), size.height),
        width: size.width,
        height: size.height,
        duration: validateDuration(input.durationMs, 50, 10_000),
      };
    }

    return {
      type: "swipe",
      startX: devicePoint(validateNormalizedCoordinate(input.startX, "startX"), size.width),
      startY: devicePoint(validateNormalizedCoordinate(input.startY, "startY"), size.height),
      endX: devicePoint(validateNormalizedCoordinate(input.endX, "endX"), size.width),
      endY: devicePoint(validateNormalizedCoordinate(input.endY, "endY"), size.height),
      width: size.width,
      height: size.height,
      duration: validateDuration(input.durationMs, 300, 30_000),
    };
  }
}
