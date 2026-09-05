import type { Socket } from "node:net";
import {
  isTerminalAdmissionRequestCandidate,
  parseTerminalAdmissionRequest,
  serializeTerminalAdmissionMessage,
  TERMINAL_ADMISSION_FRAME_MAX_BYTES,
  TERMINAL_ADMISSION_VERSION,
  type TerminalAdmissionContext,
  type TerminalAdmissionRecoveryAction,
  type TerminalAdmissionRetirementCode,
} from "../ipc/terminal-admission.js";
import {
  parseUnversionedTerminalReconnect,
  parseVersionedTerminalReconnect,
  serializePreAdmissionTerminalRetirement,
} from "./pre-admission-terminal-retirement.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REJECTION_DRAIN_MS = 30_000;
const DEFAULT_MAX_MANAGED_CONNECTIONS = 128;
const DEFAULT_LOG_AGGREGATION_MS = 60_000;

interface AdmissionLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

interface ManagedConnection {
  socket: Socket;
  buffer: Buffer;
  phase: "awaiting" | "draining" | "retiring_reconnect";
  handshakeTimer: NodeJS.Timeout | null;
  drainTimer: NodeJS.Timeout | null;
  retirementKey: string | null;
  onData: (chunk: Buffer | string) => void;
  onClose: () => void;
  onEnd: () => void;
  onError: () => void;
}

interface LogBucket {
  lastLoggedAt: number;
  suppressed: number;
  fields: Record<string, unknown>;
  message: string;
}

interface TerminalIpcAdmissionOptions {
  terminalProtocolVersion: number;
  logger: AdmissionLogger;
  handshakeTimeoutMs?: number;
  rejectionDrainMs?: number;
  maxManagedConnections?: number;
  logAggregationMs?: number;
  now?: () => number;
}

interface TerminalIpcAdmissionController {
  handle(socket: Socket, accept: (context: TerminalAdmissionContext) => void): void;
  destroyAll(): void;
  readonly managedConnectionCount: number;
}

function reconnectRetirementKey(
  generation: "unversioned" | `protocol-${number}`,
  sessionId: string,
  pid?: number,
): string {
  // Diagnostic/coalescing key only.  A pre-admission client controls every component, so this key
  // must never be used as process identity or as authority to signal a PID.
  return `${generation}\0${pid ?? "unknown"}\0${sessionId}`;
}

export function createTerminalIpcAdmissionController(
  options: TerminalIpcAdmissionOptions,
): TerminalIpcAdmissionController {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const rejectionDrainMs = options.rejectionDrainMs ?? DEFAULT_REJECTION_DRAIN_MS;
  const maxManagedConnections = options.maxManagedConnections ?? DEFAULT_MAX_MANAGED_CONNECTIONS;
  const logAggregationMs = options.logAggregationMs ?? DEFAULT_LOG_AGGREGATION_MS;
  const now = options.now ?? Date.now;
  const managed = new Map<Socket, ManagedConnection>();
  const retiringReconnects = new Map<string, Set<Socket>>();
  const logBuckets = new Map<string, LogBucket>();

  const recordWarning = (key: string, fields: Record<string, unknown>, message: string): void => {
    const timestamp = now();
    const existing = logBuckets.get(key);
    if (!existing) {
      options.logger.warn(fields, message);
      logBuckets.set(key, { lastLoggedAt: timestamp, suppressed: 0, fields, message });
      return;
    }
    if (timestamp - existing.lastLoggedAt < logAggregationMs) {
      existing.suppressed += 1;
      existing.fields = fields;
      return;
    }
    options.logger.warn({ ...fields, suppressedSinceLastLog: existing.suppressed }, message);
    existing.lastLoggedAt = timestamp;
    existing.suppressed = 0;
    existing.fields = fields;
    existing.message = message;
  };

  const flushWarnings = (): void => {
    for (const bucket of logBuckets.values()) {
      if (bucket.suppressed === 0) continue;
      options.logger.warn(
        { ...bucket.fields, suppressedSinceLastLog: bucket.suppressed },
        bucket.message,
      );
      bucket.suppressed = 0;
    }
  };

  const removeManaged = (entry: ManagedConnection): void => {
    if (entry.handshakeTimer) clearTimeout(entry.handshakeTimer);
    if (entry.drainTimer) clearTimeout(entry.drainTimer);
    entry.socket.off("data", entry.onData);
    entry.socket.off("close", entry.onClose);
    entry.socket.off("end", entry.onEnd);
    entry.socket.off("error", entry.onError);
    managed.delete(entry.socket);
    if (entry.retirementKey) {
      const sockets = retiringReconnects.get(entry.retirementKey);
      sockets?.delete(entry.socket);
      if (sockets?.size === 0) retiringReconnects.delete(entry.retirementKey);
    }
  };

  const destroyRetirementGroup = (key: string): void => {
    const sockets = retiringReconnects.get(key);
    if (!sockets) return;
    retiringReconnects.delete(key);
    for (const socket of [...sockets]) {
      const entry = managed.get(socket);
      if (entry) removeManaged(entry);
      socket.destroy();
    }
  };

  const startQuietDrain = (
    entry: ManagedConnection,
    phase: ManagedConnection["phase"],
    timeoutMs = rejectionDrainMs,
  ): void => {
    if (entry.handshakeTimer) clearTimeout(entry.handshakeTimer);
    entry.handshakeTimer = null;
    entry.phase = phase;
    entry.buffer = Buffer.alloc(0);
    // Keep consuming without parsing or logging.  In particular, do not close a pre-admission
    // terminal while its old waitForMessage close handler can recursively create another loop.
    entry.socket.off("data", entry.onData);
    entry.onData = () => {};
    entry.socket.on("data", entry.onData);
    entry.socket.resume();
    entry.drainTimer = setTimeout(() => {
      if (entry.retirementKey) {
        destroyRetirementGroup(entry.retirementKey);
        return;
      }
      removeManaged(entry);
      entry.socket.destroy();
    }, timeoutMs);
    entry.drainTimer.unref?.();
  };

  const rejectAdmission = (
    entry: ManagedConnection,
    code: TerminalAdmissionRetirementCode,
    action: TerminalAdmissionRecoveryAction,
    message: string,
  ): void => {
    entry.socket.write(
      serializeTerminalAdmissionMessage({
        type: "terminal_admission_response",
        admissionVersion: TERMINAL_ADMISSION_VERSION,
        status: "retired",
        terminalProtocolVersion: options.terminalProtocolVersion,
        code,
        action,
        message,
      }),
    );
    recordWarning(code, { code }, "Terminal admission permanently rejected");
    startQuietDrain(entry, "draining");
  };

  const retireReconnect = (
    entry: ManagedConnection,
    request: {
      sessionId: string;
      pid?: number;
      provider?: "claude" | "codex" | "kimi";
      kind?: "agent" | "terminal";
      generation: "unversioned" | `protocol-${number}`;
    },
  ): void => {
    const key = reconnectRetirementKey(request.generation, request.sessionId, request.pid);
    entry.retirementKey = key;
    let sockets = retiringReconnects.get(key);
    if (!sockets) {
      sockets = new Set();
      retiringReconnects.set(key, sockets);
    }
    sockets.add(entry.socket);
    const action = request.kind === "terminal" ? "terminate" : "detach";
    entry.socket.write(serializePreAdmissionTerminalRetirement(request.sessionId, action));
    recordWarning(
      "pre_admission_terminal_retired",
      {
        sessionId: request.sessionId,
        provider: request.provider,
        action,
        generation: request.generation,
      },
      "Pre-admission terminal remote view retired after reconnect",
    );
    startQuietDrain(entry, "retiring_reconnect");
  };

  const promote = (
    entry: ManagedConnection,
    accept: (context: TerminalAdmissionContext) => void,
    context: TerminalAdmissionContext,
    remainder: Buffer,
  ): void => {
    const socket = entry.socket;
    socket.pause();
    removeManaged(entry);
    try {
      if (remainder.length > 0) socket.unshift(remainder);
      accept(context);
      socket.resume();
    } catch (error) {
      recordWarning(
        "admission_dispatch_failed",
        { error: error instanceof Error ? error.message : String(error) },
        "Terminal admission dispatch failed",
      );
      socket.destroy();
    }
  };

  const handleFirstLine = (
    entry: ManagedConnection,
    line: string,
    remainder: Buffer,
    accept: (context: TerminalAdmissionContext) => void,
  ): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      recordWarning(
        "invalid_first_frame",
        { lineBytes: Buffer.byteLength(line) },
        "Terminal connection sent an invalid first frame",
      );
      startQuietDrain(entry, "draining");
      return;
    }

    if (isTerminalAdmissionRequestCandidate(raw)) {
      const request = parseTerminalAdmissionRequest(raw);
      if (request === null) {
        const rawAdmissionVersion =
          raw !== null && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as { admissionVersion?: unknown }).admissionVersion
            : undefined;
        const rawTerminalProtocolVersion =
          raw !== null && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as { terminalProtocolVersion?: unknown }).terminalProtocolVersion
            : undefined;
        const serviceIsOutdated =
          (typeof rawAdmissionVersion === "number" &&
            Number.isSafeInteger(rawAdmissionVersion) &&
            rawAdmissionVersion > TERMINAL_ADMISSION_VERSION) ||
          (typeof rawTerminalProtocolVersion === "number" &&
            Number.isSafeInteger(rawTerminalProtocolVersion) &&
            rawTerminalProtocolVersion > options.terminalProtocolVersion);
        rejectAdmission(
          entry,
          serviceIsOutdated ? "TERMINAL_SERVICE_OUTDATED" : "ADMISSION_REQUEST_INVALID",
          serviceIsOutdated ? "restart_service" : "restart_terminal",
          serviceIsOutdated
            ? "This terminal requires a newer local protocol. Restart the DEV Anywhere service with the current CLI."
            : "The running DEV Anywhere service could not understand this terminal's admission request. Restart the terminal with the current DEV Anywhere CLI.",
        );
        return;
      }
      if (request.terminalProtocolVersion !== options.terminalProtocolVersion) {
        const runtimeIsOutdated = request.terminalProtocolVersion < options.terminalProtocolVersion;
        rejectAdmission(
          entry,
          runtimeIsOutdated ? "TERMINAL_RUNTIME_OUTDATED" : "TERMINAL_SERVICE_OUTDATED",
          runtimeIsOutdated ? "restart_terminal" : "restart_service",
          runtimeIsOutdated
            ? `This terminal uses local IPC protocol ${request.terminalProtocolVersion}, but the running DEV Anywhere service requires ${options.terminalProtocolVersion}. Restart the terminal with the current DEV Anywhere CLI.`
            : `This terminal uses local IPC protocol ${request.terminalProtocolVersion}, but the running DEV Anywhere service only supports ${options.terminalProtocolVersion}. Restart the DEV Anywhere service with the current CLI.`,
        );
        return;
      }
      entry.socket.write(
        serializeTerminalAdmissionMessage({
          type: "terminal_admission_response",
          admissionVersion: TERMINAL_ADMISSION_VERSION,
          status: "accepted",
          terminalProtocolVersion: options.terminalProtocolVersion,
        }),
      );
      promote(
        entry,
        accept,
        {
          clientKind: request.clientKind,
          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        },
        remainder,
      );
      return;
    }

    const unversionedReconnect = parseUnversionedTerminalReconnect(raw);
    if (unversionedReconnect) {
      retireReconnect(entry, { ...unversionedReconnect, generation: "unversioned" });
      return;
    }

    const versionedReconnect = parseVersionedTerminalReconnect(raw);
    if (versionedReconnect) {
      retireReconnect(entry, {
        ...versionedReconnect,
        generation: `protocol-${versionedReconnect.protocolVersion}`,
      });
      return;
    }

    recordWarning(
      "unsupported_first_frame",
      {
        type:
          raw !== null && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as { type?: unknown }).type
            : undefined,
      },
      "Terminal connection sent an unsupported first frame",
    );
    startQuietDrain(entry, "draining");
  };

  return {
    handle(socket, accept): void {
      if (managed.size >= maxManagedConnections) {
        recordWarning(
          "admission_capacity_exceeded",
          { maxManagedConnections },
          "Terminal admission connection capacity exceeded",
        );
        socket.destroy();
        return;
      }

      const entry: ManagedConnection = {
        socket,
        buffer: Buffer.alloc(0),
        phase: "awaiting",
        handshakeTimer: null,
        drainTimer: null,
        retirementKey: null,
        onData: () => {},
        onClose: () => {},
        onEnd: () => {},
        onError: () => {},
      };
      const onClose = (): void => {
        if (managed.has(socket)) removeManaged(entry);
      };
      const onEnd = (): void => {
        // A pre-admission terminal calls socket.end only after setting its process-wide
        // remoteDetached flag.  At that point every sibling reconnect loop is safe to close.
        if (entry.phase === "retiring_reconnect" && entry.retirementKey) {
          destroyRetirementGroup(entry.retirementKey);
        }
      };
      const onError = (): void => {
        // close performs the single cleanup path; retaining an error listener avoids an uncaught
        // EventEmitter error while a deliberately quiet rejection is draining.
      };
      const onData = (chunk: Buffer | string): void => {
        if (entry.phase !== "awaiting") return;
        const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const newlineIndex = incoming.indexOf(0x0a);
        const firstFrameBytes =
          entry.buffer.length + (newlineIndex >= 0 ? newlineIndex : incoming.length);
        if (firstFrameBytes > TERMINAL_ADMISSION_FRAME_MAX_BYTES) {
          recordWarning(
            "admission_frame_too_large",
            { maxFrameBytes: TERMINAL_ADMISSION_FRAME_MAX_BYTES },
            "Terminal admission first frame exceeded the byte limit",
          );
          startQuietDrain(entry, "draining");
          return;
        }
        if (newlineIndex < 0) {
          entry.buffer = Buffer.concat([entry.buffer, incoming]);
          return;
        }
        const line = Buffer.concat([entry.buffer, incoming.subarray(0, newlineIndex)]).toString(
          "utf-8",
        );
        const remainder = Buffer.from(incoming.subarray(newlineIndex + 1));
        handleFirstLine(entry, line, remainder, accept);
      };

      entry.onData = onData;
      entry.onClose = onClose;
      entry.onEnd = onEnd;
      entry.onError = onError;
      managed.set(socket, entry);
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.once("end", onEnd);
      socket.on("error", onError);
      entry.handshakeTimer = setTimeout(() => {
        recordWarning(
          "admission_timeout",
          { timeoutMs: handshakeTimeoutMs },
          "Terminal connection did not send a first frame in time",
        );
        removeManaged(entry);
        socket.destroy();
      }, handshakeTimeoutMs);
      entry.handshakeTimer.unref?.();
    },

    destroyAll(): void {
      flushWarnings();
      for (const entry of [...managed.values()]) {
        removeManaged(entry);
        entry.socket.destroy();
      }
      retiringReconnects.clear();
    },

    get managedConnectionCount(): number {
      return managed.size;
    },
  };
}
