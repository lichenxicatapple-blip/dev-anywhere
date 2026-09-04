import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScrcpyVideoAdapter,
  type ScrcpyExecFile,
  type ScrcpySpawn,
  type ScrcpyVideoPacket,
} from "#src/serve/device-preview/scrcpy-video-adapter.js";

const ADB = "/opt/android/platform-tools/adb";
const SERIAL = "emulator-5554";
const FORWARDED_PORT = 43_210;
const SCID = "12345678";
const SESSION_FLAG = 1n << 63n;
const CONFIGURATION_FLAG = 1n << 62n;
const KEYFRAME_FLAG = 1n << 61n;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function result(stdout = "", stderr = "") {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scrcpy-video-adapter-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function portableServer(): Promise<string> {
  const directory = await temporaryDirectory();
  const server = join(directory, "scrcpy-server");
  await writeFile(server, "test scrcpy server");
  return server;
}

function createExecFile(
  calls: Array<{ command: string; args: readonly string[] }> = [],
): ScrcpyExecFile {
  return vi.fn(async (calledCommand, args) => {
    calls.push({ command: calledCommand, args: [...args] });
    if (calledCommand !== ADB) throw new Error(`Unexpected command: ${calledCommand}`);
    if (args[2] === "forward" && args[3] === "tcp:0") {
      return result(`${FORWARDED_PORT}\n`);
    }
    return result();
  });
}

function fakeChild(): { child: ChildProcess; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess;
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  Object.assign(child, {
    stderr,
    stdout: null,
    stdin: null,
    exitCode: null,
    signalCode: null,
    kill,
  });
  return { child, kill };
}

function fakeSocket(): Socket {
  return new PassThrough() as unknown as Socket;
}

function createSocketPairConnector(videoSocket: Socket, controlSocket: Socket) {
  let count = 0;
  return vi.fn(() => {
    count += 1;
    if (count === 1) return videoSocket;
    if (count === 2) {
      queueMicrotask(() => controlSocket.emit("connect"));
      return controlSocket;
    }
    throw new Error("Unexpected extra scrcpy socket connection");
  });
}

function packetRecord(flags: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(flags, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function sessionRecord(width: number, height: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(SESSION_FLAG, 0);
  header.writeUInt32BE(width, 4);
  header.writeUInt32BE(height, 8);
  return header;
}

function streamMetadata(width = 320, height = 720): Buffer {
  const codec = Buffer.alloc(4);
  codec.writeUInt32BE(0x6832_3634, 0);
  return Buffer.concat([codec, sessionRecord(width, height)]);
}

function annexB(nalType: number, ...body: number[]): Buffer {
  return Buffer.from([0, 0, 0, 1, nalType, ...body]);
}

function writeInPieces(socket: Socket, data: Buffer): void {
  const sizes = [1, 2, 7, 3, 19, 4, 11, 5];
  let offset = 0;
  let index = 0;
  while (offset < data.length) {
    const end = Math.min(data.length, offset + sizes[index % sizes.length]!);
    socket.write(data.subarray(offset, end));
    offset = end;
    index += 1;
  }
}

function expectTouchMessage(
  value: unknown,
  expected: {
    action: number;
    x: number;
    y: number;
    width: number;
    height: number;
    pressure: number;
  },
): void {
  const message = Buffer.from(value as Uint8Array);
  expect(message).toHaveLength(32);
  expect(message[0]).toBe(0x02);
  expect(message[1]).toBe(expected.action);
  expect(message.readBigUInt64BE(2)).toBe(0n);
  expect(message.readInt32BE(10)).toBe(expected.x);
  expect(message.readInt32BE(14)).toBe(expected.y);
  expect(message.readUInt16BE(18)).toBe(expected.width);
  expect(message.readUInt16BE(20)).toBe(expected.height);
  expect(message.readUInt16BE(22)).toBe(expected.pressure);
  expect(message.readUInt32BE(24)).toBe(0);
  expect(message.readUInt32BE(28)).toBe(0);
}

function splitTouchMessages(value: unknown): Buffer[] {
  const messages = Buffer.from(value as Uint8Array);
  expect(messages.length).toBeGreaterThan(0);
  expect(messages.length % 32).toBe(0);
  return Array.from({ length: messages.length / 32 }, (_, index) =>
    messages.subarray(index * 32, (index + 1) * 32),
  );
}

describe("ScrcpyVideoAdapter resolution", () => {
  it("resolves the bundled server without a scrcpy executable in PATH", async () => {
    const execFile = vi.fn(async () => result()) as ScrcpyExecFile;
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      env: { PATH: "" },
      execFile,
    });

    const capability = await adapter.inspect();
    expect(capability).toMatchObject({
      available: true,
      version: "4.1",
    });
    expect(capability.serverPath).toMatch(/assets\/scrcpy\/scrcpy-server-v4\.1$/u);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("uses an explicitly injected server path", async () => {
    const server = await portableServer();
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
    });

    await expect(adapter.resolve()).resolves.toEqual({
      version: "4.1",
      serverPath: await realpath(server),
    });
  });

  it("fails closed when the injected server does not exist", async () => {
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: "/missing/scrcpy-server-v4.1",
    });

    await expect(adapter.resolve()).rejects.toMatchObject({
      code: "scrcpy-server-unavailable",
    });
  });

  it("rejects a directory in place of the bundled server file", async () => {
    const directory = await temporaryDirectory();
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: directory,
    });

    await expect(adapter.resolve()).rejects.toMatchObject({
      code: "scrcpy-server-unavailable",
    });
  });
});

describe("ScrcpyVideoAdapter streaming", () => {
  it("parses split frame headers and payloads, preserves flags, and clamps durations", async () => {
    const server = await portableServer();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const execFile = createExecFile(calls);
    const { child, kill } = fakeChild();
    const spawn = vi.fn(() => child) as unknown as ScrcpySpawn;
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const controlResume = vi.spyOn(controlSocket, "resume");
    const connect = createSocketPairConnector(videoSocket, controlSocket);
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile,
      spawn,
      connect,
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });
    const abort = new AbortController();
    const received: ScrcpyVideoPacket[] = [];
    const config = annexB(0x67, 0x42, 0, 0x1f, 0, 0, 0, 1, 0x68, 0xce);
    const keyframe = annexB(0x65, 1, 2, 3);
    const shortDelta = annexB(0x41, 4, 5);
    const longDelta = annexB(0x41, 6, 7);
    const wire = Buffer.concat([
      streamMetadata(),
      packetRecord(CONFIGURATION_FLAG, config),
      packetRecord(KEYFRAME_FLAG | 1_000_000n, keyframe),
      packetRecord(1_000_100n, shortDelta),
      packetRecord(2_000_100n, longDelta),
    ]);

    const streaming = adapter.stream(SERIAL, abort.signal, (packet) => {
      received.push(packet);
      if (received.length === 4) abort.abort();
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    videoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    writeInPieces(videoSocket, wire);
    await expect(streaming).resolves.toBeUndefined();

    expect(received).toEqual([
      {
        kind: "configuration",
        keyframe: false,
        durationMs: 0,
        data: config,
      },
      {
        kind: "frame",
        keyframe: true,
        durationMs: 33,
        data: keyframe,
      },
      {
        kind: "frame",
        keyframe: false,
        durationMs: 1,
        data: shortDelta,
      },
      {
        kind: "frame",
        keyframe: false,
        durationMs: 250,
        data: longDelta,
      },
    ]);
    expect(connect).toHaveBeenNthCalledWith(1, { host: "127.0.0.1", port: FORWARDED_PORT });
    expect(connect).toHaveBeenNthCalledWith(2, { host: "127.0.0.1", port: FORWARDED_PORT });
    expect(controlResume).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    const [spawnCommand, spawnArgs, spawnOptions] = vi.mocked(spawn).mock.calls[0]!;
    expect(spawnCommand).toBe(ADB);
    expect(spawnOptions).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"] });
    expect(spawnArgs).toEqual(
      expect.arrayContaining([
        "audio=false",
        "control=true",
        "clipboard_autosync=false",
        "max_size=720",
        "max_fps=30",
        "video_bit_rate=4000000",
        "video_codec_options=i-frame-interval=1",
        "send_device_meta=false",
        "send_dummy_byte=true",
        "send_stream_meta=true",
        "send_frame_meta=true",
      ]),
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          command: ADB,
          args: [
            "-s",
            SERIAL,
            "push",
            await realpath(server),
            `/data/local/tmp/dev-anywhere-scrcpy-${SCID}.jar`,
          ],
        },
        {
          command: ADB,
          args: ["-s", SERIAL, "forward", "--remove", `tcp:${FORWARDED_PORT}`],
        },
        {
          command: ADB,
          args: [
            "-s",
            SERIAL,
            "shell",
            "rm",
            "-f",
            `/data/local/tmp/dev-anywhere-scrcpy-${SCID}.jar`,
          ],
        },
      ]),
    );
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(videoSocket.destroyed).toBe(true);
    expect(controlSocket.destroyed).toBe(true);
  });

  it("rejects oversized packets before buffering their payload and still cleans up", async () => {
    const server = await portableServer();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const { child, kill } = fakeChild();
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(calls),
      spawn: vi.fn(() => child) as unknown as ScrcpySpawn,
      connect: createSocketPairConnector(videoSocket, controlSocket),
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
      maxPacketBytes: 16,
    });
    const header = Buffer.alloc(12);
    header.writeBigUInt64BE(0n, 0);
    header.writeUInt32BE(17, 8);

    const streaming = adapter.stream(SERIAL, new AbortController().signal, vi.fn());
    videoSocket.write(Buffer.concat([Buffer.from([0]), streamMetadata(), header]));

    await expect(streaming).rejects.toMatchObject({ code: "stream-protocol-error" });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(videoSocket.destroyed).toBe(true);
    expect(controlSocket.destroyed).toBe(true);
    expect(calls.some((call) => call.args.includes("--remove"))).toBe(true);
    expect(calls.some((call) => call.args.includes("rm"))).toBe(true);
  });

  it("requests a video reset over the active control socket and coalesces calls for 500ms", async () => {
    const server = await portableServer();
    const { child } = fakeChild();
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const connect = createSocketPairConnector(videoSocket, controlSocket);
    const controlWrite = vi.spyOn(controlSocket, "write");
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(),
      spawn: vi.fn(() => child) as unknown as ScrcpySpawn,
      connect,
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });

    await expect(adapter.requestVideoReset(SERIAL)).rejects.toMatchObject({
      code: "stream-control-unavailable",
      message: expect.stringContaining(SERIAL),
    });

    const abort = new AbortController();
    let receivedConfiguration!: () => void;
    const configurationReceived = new Promise<void>((resolvePromise) => {
      receivedConfiguration = resolvePromise;
    });
    const streaming = adapter.stream(SERIAL, abort.signal, (packet) => {
      if (packet.kind === "configuration") receivedConfiguration();
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    videoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    videoSocket.write(
      Buffer.concat([streamMetadata(), packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x42))]),
    );
    await configurationReceived;

    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await Promise.all([
      adapter.requestVideoReset(SERIAL),
      adapter.requestVideoReset(SERIAL),
      adapter.requestVideoReset(SERIAL),
    ]);
    expect(controlWrite).toHaveBeenCalledTimes(1);
    expect(Buffer.from(controlWrite.mock.calls[0]![0] as Uint8Array)).toEqual(Buffer.from([0x11]));

    now.mockReturnValue(1_499);
    await adapter.requestVideoReset(SERIAL);
    expect(controlWrite).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_500);
    await adapter.requestVideoReset(SERIAL);
    expect(controlWrite).toHaveBeenCalledTimes(2);
    expect(Buffer.from(controlWrite.mock.calls[1]![0] as Uint8Array)).toEqual(Buffer.from([0x11]));
    now.mockRestore();

    abort.abort();
    await expect(streaming).resolves.toBeUndefined();
    await expect(adapter.requestVideoReset(SERIAL)).rejects.toMatchObject({
      code: "stream-control-unavailable",
    });
  });

  it("pastes UTF-8 text through the active Scrcpy clipboard control message", async () => {
    const server = await portableServer();
    const { child } = fakeChild();
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const connect = createSocketPairConnector(videoSocket, controlSocket);
    const controlWrite = vi.spyOn(controlSocket, "write");
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(),
      spawn: vi.fn(() => child) as unknown as ScrcpySpawn,
      connect,
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });
    const text = "你好 👋🏽\n第二行";

    await expect(adapter.pasteText(SERIAL, text)).rejects.toMatchObject({
      code: "stream-control-unavailable",
      message: expect.stringContaining(SERIAL),
    });

    const abort = new AbortController();
    let receivedConfiguration!: () => void;
    const configurationReceived = new Promise<void>((resolvePromise) => {
      receivedConfiguration = resolvePromise;
    });
    const streaming = adapter.stream(SERIAL, abort.signal, (packet) => {
      if (packet.kind === "configuration") receivedConfiguration();
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    videoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    videoSocket.write(
      Buffer.concat([streamMetadata(), packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x42))]),
    );
    await configurationReceived;

    await adapter.pasteText(SERIAL, text);

    expect(controlWrite).toHaveBeenCalledOnce();
    const message = Buffer.from(controlWrite.mock.calls[0]![0] as Uint8Array);
    const payload = Buffer.from(text, "utf8");
    expect(message[0]).toBe(0x09);
    // Scrcpy 4.1 sequence 0 is SC_SEQUENCE_INVALID, so the server will not enqueue an ACK.
    expect(message.readBigUInt64BE(1)).toBe(0n);
    expect(message[9]).toBe(1);
    expect(message.readUInt32BE(10)).toBe(payload.length);
    expect(message.subarray(14)).toEqual(payload);

    abort.abort();
    await expect(streaming).resolves.toBeUndefined();
    await expect(adapter.pasteText(SERIAL, text)).rejects.toMatchObject({
      code: "stream-control-unavailable",
    });
  });

  it("fails closed when an aborted clipboard write never invokes its socket callback", async () => {
    const server = await portableServer();
    const { child } = fakeChild();
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const connect = createSocketPairConnector(videoSocket, controlSocket);
    const controlWrite = vi.spyOn(controlSocket, "write");
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(),
      spawn: vi.fn(() => child) as unknown as ScrcpySpawn,
      connect,
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });
    const streamAbort = new AbortController();
    let receivedConfiguration!: () => void;
    const configurationReceived = new Promise<void>((resolvePromise) => {
      receivedConfiguration = resolvePromise;
    });
    const streaming = adapter
      .stream(SERIAL, streamAbort.signal, (packet) => {
        if (packet.kind === "configuration") receivedConfiguration();
      })
      .then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    videoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    videoSocket.write(
      Buffer.concat([streamMetadata(), packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x42))]),
    );
    await configurationReceived;

    let lateWriteCallback: ((error?: Error | null) => void) | undefined;
    controlWrite.mockImplementationOnce(((
      _chunk: Uint8Array,
      callback: (error?: Error | null) => void,
    ) => {
      lateWriteCallback = callback;
      return true;
    }) as typeof controlSocket.write);
    const inputAbort = new AbortController();
    let settlements = 0;
    const pendingPaste = adapter.pasteText(SERIAL, "不会粘连", inputAbort.signal);
    void pendingPaste.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    await vi.waitFor(() => expect(controlWrite).toHaveBeenCalledOnce());

    inputAbort.abort();
    await expect(pendingPaste).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(settlements).toBe(1));
    expect(controlSocket.destroyed).toBe(true);
    await expect(adapter.releaseTouch(SERIAL)).resolves.toBeUndefined();

    lateWriteCallback?.(new Error("late write callback"));
    await Promise.resolve();
    expect(settlements).toBe(1);
    await expect(streaming).resolves.toMatchObject({
      status: "rejected",
      error: { code: "stream-control-unavailable" },
    });
  });

  it("aborts a pending touch write, drains the queue, and accepts input after stream rebuild", async () => {
    const server = await portableServer();
    const firstVideoSocket = fakeSocket();
    const firstControlSocket = fakeSocket();
    const secondVideoSocket = fakeSocket();
    const secondControlSocket = fakeSocket();
    const sockets = [firstVideoSocket, firstControlSocket, secondVideoSocket, secondControlSocket];
    let socketIndex = 0;
    const connect = vi.fn(() => {
      const socket = sockets[socketIndex];
      socketIndex += 1;
      if (!socket) throw new Error("Unexpected extra scrcpy socket connection");
      if (socket === firstControlSocket || socket === secondControlSocket) {
        queueMicrotask(() => socket.emit("connect"));
      }
      return socket;
    });
    const firstChild = fakeChild().child;
    const secondChild = fakeChild().child;
    const spawn = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild) as unknown as ScrcpySpawn;
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(),
      spawn,
      connect,
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });

    const firstStreamAbort = new AbortController();
    let receivedFirstConfiguration!: () => void;
    const firstConfigurationReceived = new Promise<void>((resolvePromise) => {
      receivedFirstConfiguration = resolvePromise;
    });
    const firstStreaming = adapter
      .stream(SERIAL, firstStreamAbort.signal, (packet) => {
        if (packet.kind === "configuration") receivedFirstConfiguration();
      })
      .then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    firstVideoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    firstVideoSocket.write(
      Buffer.concat([streamMetadata(), packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x42))]),
    );
    await firstConfigurationReceived;

    const firstControlWrite = vi.spyOn(firstControlSocket, "write");
    let lateWriteCallback: ((error?: Error | null) => void) | undefined;
    firstControlWrite.mockImplementationOnce(((
      _chunk: Uint8Array,
      callback: (error?: Error | null) => void,
    ) => {
      lateWriteCallback = callback;
      return true;
    }) as typeof firstControlSocket.write);
    const inputAbort = new AbortController();
    let settlements = 0;
    const pendingTouch = adapter.sendTouch(
      SERIAL,
      { phase: "down", x: 0.25, y: 0.5 },
      inputAbort.signal,
    );
    void pendingTouch.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    await vi.waitFor(() => expect(firstControlWrite).toHaveBeenCalledOnce());

    inputAbort.abort();
    await expect(pendingTouch).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(settlements).toBe(1));
    await expect(adapter.releaseTouch(SERIAL)).resolves.toBeUndefined();
    await expect(
      adapter.sendTouch(SERIAL, { phase: "down", x: 0.5, y: 0.5 }),
    ).rejects.toMatchObject({ code: "stream-control-unavailable" });
    await expect(firstStreaming).resolves.toMatchObject({
      status: "rejected",
      error: { code: "stream-control-unavailable" },
    });

    const secondStreamAbort = new AbortController();
    let receivedSecondConfiguration!: () => void;
    const secondConfigurationReceived = new Promise<void>((resolvePromise) => {
      receivedSecondConfiguration = resolvePromise;
    });
    const secondStreaming = adapter.stream(SERIAL, secondStreamAbort.signal, (packet) => {
      if (packet.kind === "configuration") receivedSecondConfiguration();
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    secondVideoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(4));
    secondVideoSocket.write(
      Buffer.concat([streamMetadata(), packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x42))]),
    );
    await secondConfigurationReceived;

    lateWriteCallback?.(new Error("late write callback"));
    await Promise.resolve();
    expect(settlements).toBe(1);
    const secondControlWrite = vi.spyOn(secondControlSocket, "write");
    await adapter.sendTouch(SERIAL, { phase: "down", x: 0.4, y: 0.5 });
    await adapter.sendTouch(SERIAL, { phase: "up", x: 0.6, y: 0.5 });
    expect(secondControlWrite).toHaveBeenCalledTimes(2);
    expectTouchMessage(secondControlWrite.mock.calls[0]![0], {
      action: 0,
      x: 128,
      y: 360,
      width: 320,
      height: 720,
      pressure: 0xffff,
    });
    expectTouchMessage(secondControlWrite.mock.calls[1]![0], {
      action: 1,
      x: 191,
      y: 360,
      width: 320,
      height: 720,
      pressure: 0,
    });

    secondStreamAbort.abort();
    await expect(secondStreaming).resolves.toBeUndefined();
  });

  it("encodes one touch with a fixed internal pointer and safely replaces repeated down", async () => {
    const server = await portableServer();
    const { child } = fakeChild();
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const connect = createSocketPairConnector(videoSocket, controlSocket);
    const controlWrite = vi.spyOn(controlSocket, "write");
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(),
      spawn: vi.fn(() => child) as unknown as ScrcpySpawn,
      connect,
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });

    await expect(adapter.sendTouch(SERIAL, { phase: "down", x: 0, y: 0.5 })).rejects.toMatchObject({
      code: "stream-control-unavailable",
    });
    await expect(
      adapter.sendTouch(SERIAL, { phase: "down", x: -0.1, y: 0.5 }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    const abort = new AbortController();
    let receivedConfiguration!: () => void;
    const configurationReceived = new Promise<void>((resolvePromise) => {
      receivedConfiguration = resolvePromise;
    });
    const streaming = adapter.stream(SERIAL, abort.signal, (packet) => {
      if (packet.kind === "configuration") receivedConfiguration();
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    videoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    videoSocket.write(
      Buffer.concat([
        streamMetadata(320, 720),
        packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x42)),
      ]),
    );
    await configurationReceived;

    await adapter.sendTouch(SERIAL, { phase: "down", x: 0, y: 0.5 });
    await adapter.sendTouch(SERIAL, { phase: "move", x: 0.25, y: 0.5 });
    await adapter.sendTouch(SERIAL, { phase: "up", x: 0.8, y: 0.5 });
    await adapter.sendTouch(SERIAL, { phase: "move", x: 0.5, y: 0.5 });
    expect(controlWrite).toHaveBeenCalledTimes(3);
    expectTouchMessage(controlWrite.mock.calls[0]![0], {
      action: 0,
      x: 0,
      y: 360,
      width: 320,
      height: 720,
      pressure: 0xffff,
    });
    expectTouchMessage(controlWrite.mock.calls[1]![0], {
      action: 2,
      x: 80,
      y: 360,
      width: 320,
      height: 720,
      pressure: 0xffff,
    });
    expectTouchMessage(controlWrite.mock.calls[2]![0], {
      action: 1,
      x: 255,
      y: 360,
      width: 320,
      height: 720,
      pressure: 0,
    });

    await adapter.sendTouch(SERIAL, { phase: "down", x: 0.25, y: 0.4 });
    await adapter.sendTouch(SERIAL, { phase: "down", x: 0.75, y: 0.6 });
    const replacement = splitTouchMessages(controlWrite.mock.calls[4]![0]);
    expect(replacement).toHaveLength(2);
    expectTouchMessage(replacement[0], {
      action: 1,
      x: 80,
      y: 288,
      width: 320,
      height: 720,
      pressure: 0,
    });
    expectTouchMessage(replacement[1], {
      action: 0,
      x: 239,
      y: 431,
      width: 320,
      height: 720,
      pressure: 0xffff,
    });
    await adapter.sendTouch(SERIAL, { phase: "up", x: 0.75, y: 0.6 });
    expect(controlWrite).toHaveBeenCalledTimes(6);

    abort.abort();
    await expect(streaming).resolves.toBeUndefined();
  });

  it("releases the active touch on video rotation, explicit release, and stream abort", async () => {
    const server = await portableServer();
    const { child } = fakeChild();
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const connect = createSocketPairConnector(videoSocket, controlSocket);
    const controlWrite = vi.spyOn(controlSocket, "write");
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(),
      spawn: vi.fn(() => child) as unknown as ScrcpySpawn,
      connect,
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });
    const abort = new AbortController();
    let receivedConfiguration!: () => void;
    const configurationReceived = new Promise<void>((resolvePromise) => {
      receivedConfiguration = resolvePromise;
    });
    const streaming = adapter.stream(SERIAL, abort.signal, (packet) => {
      if (packet.kind === "configuration") receivedConfiguration();
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    videoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    videoSocket.write(
      Buffer.concat([streamMetadata(), packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x42))]),
    );
    await configurationReceived;

    await adapter.sendTouch(SERIAL, { phase: "down", x: 0.25, y: 0.4 });
    videoSocket.write(
      Buffer.concat([
        sessionRecord(720, 320),
        packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x64)),
      ]),
    );
    await vi.waitFor(() => expect(controlWrite).toHaveBeenCalledTimes(2));
    expectTouchMessage(controlWrite.mock.calls[1]![0], {
      action: 1,
      x: 80,
      y: 288,
      width: 320,
      height: 720,
      pressure: 0,
    });

    await adapter.sendTouch(SERIAL, { phase: "down", x: 0.25, y: 0.4 });
    await adapter.releaseTouch(SERIAL);
    await adapter.releaseTouch(SERIAL);
    expect(controlWrite).toHaveBeenCalledTimes(4);
    expectTouchMessage(controlWrite.mock.calls[3]![0], {
      action: 1,
      x: 180,
      y: 128,
      width: 720,
      height: 320,
      pressure: 0,
    });

    await adapter.sendTouch(SERIAL, { phase: "down", x: 0.3, y: 0.5 });
    abort.abort();
    await expect(streaming).resolves.toBeUndefined();
    expect(controlWrite).toHaveBeenCalledTimes(6);
    expectTouchMessage(controlWrite.mock.calls[5]![0], {
      action: 1,
      x: 216,
      y: 160,
      width: 720,
      height: 320,
      pressure: 0,
    });
  });

  it("fails closed and clears the active touch after a control write callback fails", async () => {
    const server = await portableServer();
    const { child } = fakeChild();
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const connect = createSocketPairConnector(videoSocket, controlSocket);
    const controlWrite = vi.spyOn(controlSocket, "write");
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(),
      spawn: vi.fn(() => child) as unknown as ScrcpySpawn,
      connect,
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });
    const abort = new AbortController();
    let receivedConfiguration!: () => void;
    const configurationReceived = new Promise<void>((resolvePromise) => {
      receivedConfiguration = resolvePromise;
    });
    const streaming = adapter
      .stream(SERIAL, abort.signal, (packet) => {
        if (packet.kind === "configuration") receivedConfiguration();
      })
      .then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    videoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    videoSocket.write(
      Buffer.concat([streamMetadata(), packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x42))]),
    );
    await configurationReceived;

    await adapter.sendTouch(SERIAL, { phase: "down", x: 0.3, y: 0.5 });
    controlWrite.mockImplementationOnce(((
      _chunk: Uint8Array,
      callback: (error?: Error | null) => void,
    ) => {
      callback(new Error("write failed"));
      return false;
    }) as typeof controlSocket.write);
    await expect(
      adapter.sendTouch(SERIAL, { phase: "down", x: 0.7, y: 0.5 }),
    ).rejects.toMatchObject({ code: "stream-control-failed" });

    expect(controlWrite).toHaveBeenCalledTimes(2);
    expect(controlSocket.destroyed).toBe(true);
    await expect(adapter.releaseTouch(SERIAL)).resolves.toBeUndefined();
    await expect(
      adapter.sendTouch(SERIAL, { phase: "move", x: 0.4, y: 0.5 }),
    ).rejects.toMatchObject({ code: "stream-control-unavailable" });
    await expect(
      adapter.sendTouch(SERIAL, { phase: "down", x: 0.5, y: 0.5 }),
    ).rejects.toMatchObject({ code: "stream-control-unavailable" });
    await expect(streaming).resolves.toMatchObject({
      status: "rejected",
      error: { code: "stream-control-unavailable" },
    });
  });

  it("invalidates the control channel when touch release misses its write deadline", async () => {
    const server = await portableServer();
    const { child } = fakeChild();
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const connect = createSocketPairConnector(videoSocket, controlSocket);
    const controlWrite = vi.spyOn(controlSocket, "write");
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(),
      spawn: vi.fn(() => child) as unknown as ScrcpySpawn,
      connect,
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });
    const streamAbort = new AbortController();
    let receivedConfiguration!: () => void;
    const configurationReceived = new Promise<void>((resolvePromise) => {
      receivedConfiguration = resolvePromise;
    });
    const streaming = adapter
      .stream(SERIAL, streamAbort.signal, (packet) => {
        if (packet.kind === "configuration") receivedConfiguration();
      })
      .then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    videoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    videoSocket.write(
      Buffer.concat([streamMetadata(), packetRecord(CONFIGURATION_FLAG, annexB(0x67, 0x42))]),
    );
    await configurationReceived;
    await adapter.sendTouch(SERIAL, { phase: "down", x: 0.5, y: 0.5 });

    let lateReleaseCallback: ((error?: Error | null) => void) | undefined;
    controlWrite.mockImplementationOnce(((
      _chunk: Uint8Array,
      callback: (error?: Error | null) => void,
    ) => {
      lateReleaseCallback = callback;
      return true;
    }) as typeof controlSocket.write);
    vi.useFakeTimers();
    const release = adapter.releaseTouch(SERIAL).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(release).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "stream-control-failed",
        message: expect.stringContaining("control write timed out"),
      },
    });
    expect(controlSocket.destroyed).toBe(true);
    await expect(adapter.releaseTouch(SERIAL)).resolves.toBeUndefined();
    lateReleaseCallback?.();
    await Promise.resolve();
    vi.useRealTimers();
    await expect(streaming).resolves.toMatchObject({
      status: "rejected",
      error: { code: "stream-control-unavailable" },
    });
  });

  it("treats abort as a graceful stop and removes the child, forward, and remote jar", async () => {
    const server = await portableServer();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const { child, kill } = fakeChild();
    const videoSocket = fakeSocket();
    const controlSocket = fakeSocket();
    const connectPair = createSocketPairConnector(videoSocket, controlSocket);
    let connected!: () => void;
    const didConnect = new Promise<void>((resolvePromise) => {
      connected = resolvePromise;
    });
    const adapter = new ScrcpyVideoAdapter({
      adbCommand: ADB,
      serverPath: server,
      execFile: createExecFile(calls),
      spawn: vi.fn(() => child) as unknown as ScrcpySpawn,
      connect: () => {
        connected();
        return connectPair();
      },
      randomBytes: () => Buffer.from([0x12, 0x34, 0x56, 0x78]),
    });
    const abort = new AbortController();
    const streaming = adapter.stream(SERIAL, abort.signal, vi.fn());

    await didConnect;
    videoSocket.write(Buffer.from([0]));
    await vi.waitFor(() => expect(connectPair).toHaveBeenCalledTimes(2));
    abort.abort();

    await expect(streaming).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(videoSocket.destroyed).toBe(true);
    expect(controlSocket.destroyed).toBe(true);
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          command: ADB,
          args: ["-s", SERIAL, "forward", "--remove", `tcp:${FORWARDED_PORT}`],
        },
        {
          command: ADB,
          args: [
            "-s",
            SERIAL,
            "shell",
            "rm",
            "-f",
            `/data/local/tmp/dev-anywhere-scrcpy-${SCID}.jar`,
          ],
        },
      ]),
    );
  });
});
