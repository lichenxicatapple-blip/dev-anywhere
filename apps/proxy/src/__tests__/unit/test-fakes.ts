import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { vi, type Mock } from "vitest";
import type { Socket } from "node:net";
import type { Logger } from "pino";
import { SessionState } from "@dev-anywhere/shared";
import type { RelayConnection } from "#src/serve/relay-connection.js";
import type { WorkerRegistry } from "#src/serve/worker-registry.js";
import type { SessionInfo, SessionManager } from "#src/serve/session-manager.js";
import type { JsonObserver } from "#src/serve/json-observer.js";

interface RelayConnectionFake {
  relayConnection: RelayConnection;
  raw: string[];
  envelopes: unknown[];
  sendRaw: Mock<(raw: string) => void>;
  sendEnvelope: Mock<(envelope: unknown) => void>;
}

export function createRelayConnectionFake(): RelayConnectionFake {
  const raw: string[] = [];
  const envelopes: unknown[] = [];
  const sendRaw = vi.fn((message: string): void => {
    raw.push(message);
  });
  const sendEnvelope = vi.fn((envelope: unknown): void => {
    envelopes.push(envelope);
  });

  const relayConnection = Object.assign(new EventEmitter(), {
    sendRaw,
    sendEnvelope,
  }) as unknown as RelayConnection;

  return {
    relayConnection,
    raw,
    envelopes,
    sendRaw,
    sendEnvelope,
  };
}

export function createWritableSocketFake(write: unknown = vi.fn()) {
  return createSocketFake({ write });
}

export function createSocketFake(options?: { writable?: boolean; write?: unknown; end?: unknown }) {
  const write = (options?.write ?? vi.fn()) as Mock;
  const end = (options?.end ?? vi.fn()) as Mock;
  const socket = {
    writable: options?.writable ?? true,
    write: write as (data: string) => void,
    end: end as (data: string, callback?: () => void) => void,
  } as unknown as Socket;

  return { socket, write, end };
}

export function createWorkerRegistryFake(options?: {
  send?: unknown;
  spawn?: unknown;
  connect?: unknown;
  terminateProcess?: unknown;
}): WorkerRegistry {
  return {
    send: options?.send ?? vi.fn(),
    spawn: options?.spawn ?? vi.fn(),
    connect: options?.connect ?? vi.fn(),
    terminateProcess: options?.terminateProcess ?? vi.fn(() => false),
  } as unknown as WorkerRegistry;
}

type SessionFake = Partial<SessionInfo> & Pick<SessionInfo, "id">;

export function createSessionManagerFake(sessions: SessionFake[] = []): SessionManager {
  const normalized = sessions.map((session) => ({
    mode: "pty" as const,
    provider: "claude" as const,
    state: SessionState.IDLE,
    createdAt: 0,
    updatedAt: 0,
    cwd: "/tmp",
    pid: 1,
    ...session,
  }));

  return {
    getSession: vi.fn((id: string) => normalized.find((session) => session.id === id)),
    listSessions: vi.fn(() => normalized),
    terminateSession: vi.fn(() => ({ success: true })),
    setClaudeSessionId: vi.fn(),
    setHistorySessionId: vi.fn(),
  } as unknown as SessionManager;
}

export function createJsonObserverFake(overrides?: Partial<JsonObserver>): JsonObserver {
  return {
    onTurnStart: vi.fn(),
    onTurnResult: vi.fn(),
    onApprovalRequested: vi.fn(),
    onChannelBroken: vi.fn(),
    ...overrides,
  } as unknown as JsonObserver;
}

interface ChildProcessFake extends ChildProcess {
  mockStdout: PassThrough;
  mockStdin: PassThrough;
  mockStderr: PassThrough;
}

export function createChildProcessFake(): ChildProcessFake {
  const mockStdout = new PassThrough();
  const mockStdin = new PassThrough();
  const mockStderr = new PassThrough();

  return Object.assign(new EventEmitter(), {
    stdin: mockStdin,
    stdout: mockStdout,
    stderr: mockStderr,
    pid: 12345,
    killed: false,
    connected: true,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: "",
    kill: vi.fn().mockReturnValue(true),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    stdio: [mockStdin, mockStdout, mockStderr, null, null] as ChildProcess["stdio"],
    [Symbol.dispose]: vi.fn(),
    mockStdout,
    mockStdin,
    mockStderr,
  }) as unknown as ChildProcessFake;
}

type TerminalStdinFake = NodeJS.ReadStream;

export function createTerminalStdinFake(isTTY = true): TerminalStdinFake {
  return Object.assign(new EventEmitter(), {
    isTTY,
    setRawMode: vi.fn().mockReturnThis(),
    resume: vi.fn().mockReturnThis(),
  }) as unknown as TerminalStdinFake;
}

interface TerminalStdoutFake extends NodeJS.WriteStream {
  columns: number;
  rows: number;
  write: Mock<(data: string) => boolean>;
}

export function createTerminalStdoutFake(cols = 120, rows = 40): TerminalStdoutFake {
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: cols,
    rows,
    write: vi.fn().mockReturnValue(true),
  }) as unknown as TerminalStdoutFake;
}

interface LogCall {
  level: "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

interface LoggerFake extends Logger {
  calls: LogCall[];
}

export function createLoggerFake(): LoggerFake {
  const calls: LogCall[] = [];
  const record = (level: LogCall["level"]) => (obj: Record<string, unknown>, msg: string) => {
    calls.push({ level, obj, msg });
  };

  return {
    calls,
    warn: record("warn"),
    error: record("error"),
  } as unknown as LoggerFake;
}
