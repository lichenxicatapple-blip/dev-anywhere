import type { Socket } from "node:net";
import {
  parseTerminalAdmissionResponse,
  serializeTerminalAdmissionMessage,
  TERMINAL_ADMISSION_FRAME_MAX_BYTES,
  TERMINAL_ADMISSION_VERSION,
  type TerminalAdmissionRecoveryAction,
  type TerminalAdmissionRetirementCode,
  type TerminalAdmissionResponse,
} from "../ipc/terminal-admission.js";

const TERMINAL_ADMISSION_TIMEOUT_MS = 5_000;

export class TerminalAdmissionRetiredError extends Error {
  constructor(
    message: string,
    readonly code: TerminalAdmissionRetirementCode,
    readonly action: TerminalAdmissionRecoveryAction,
    readonly daemonTerminalProtocolVersion: number | null,
  ) {
    super(message);
    this.name = "TerminalAdmissionRetiredError";
  }
}

interface RequestTerminalAdmissionBaseOptions {
  terminalProtocolVersion: number;
  timeoutMs?: number;
}

type RequestTerminalAdmissionOptions = RequestTerminalAdmissionBaseOptions &
  (
    | { clientKind: "local-terminal"; sessionId?: string }
    | { clientKind: "terminal-worker"; sessionId: string }
  );

function readProtocolVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mismatchedAcceptedError(
  terminalProtocolVersion: number,
  daemonTerminalProtocolVersion: number,
): TerminalAdmissionRetiredError {
  const runtimeIsOutdated = terminalProtocolVersion < daemonTerminalProtocolVersion;
  return new TerminalAdmissionRetiredError(
    runtimeIsOutdated
      ? `This terminal uses local IPC protocol ${terminalProtocolVersion}, but the running DEV Anywhere service requires ${daemonTerminalProtocolVersion}. Restart the terminal with the current DEV Anywhere CLI.`
      : `This terminal uses local IPC protocol ${terminalProtocolVersion}, but the running DEV Anywhere service only supports ${daemonTerminalProtocolVersion}. Restart the DEV Anywhere service with the current CLI.`,
    runtimeIsOutdated ? "TERMINAL_RUNTIME_OUTDATED" : "TERMINAL_SERVICE_OUTDATED",
    runtimeIsOutdated ? "restart_terminal" : "restart_service",
    daemonTerminalProtocolVersion,
  );
}

function invalidAdmissionResponseError(
  raw: unknown,
  terminalProtocolVersion: number,
): TerminalAdmissionRetiredError {
  const daemonTerminalProtocolVersion =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? readProtocolVersion((raw as { terminalProtocolVersion?: unknown }).terminalProtocolVersion)
      : null;
  const action: TerminalAdmissionRecoveryAction =
    daemonTerminalProtocolVersion !== null &&
    daemonTerminalProtocolVersion > terminalProtocolVersion
      ? "restart_terminal"
      : "restart_service";
  return new TerminalAdmissionRetiredError(
    action === "restart_terminal"
      ? "The running DEV Anywhere service returned a newer admission response that this terminal cannot understand. Restart the terminal with the current DEV Anywhere CLI."
      : "The running DEV Anywhere service returned an invalid terminal admission response. Restart the DEV Anywhere service with the current CLI.",
    "ADMISSION_RESPONSE_INVALID",
    action,
    daemonTerminalProtocolVersion,
  );
}

// Negotiate the permanently stable admission prefix before installing any business-IPC reader.
// A transport failure remains retryable; a structured `retired` result is permanent and callers
// must not reconnect the same runtime.
export function requestTerminalAdmission(
  socket: Socket,
  options: RequestTerminalAdmissionOptions,
): Promise<Extract<TerminalAdmissionResponse, { status: "accepted" }>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const timeoutMs = options.timeoutMs ?? TERMINAL_ADMISSION_TIMEOUT_MS;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onEnd = (): void => {
      // EOF does not identify the peer's version. The attempt failed without a complete reply;
      // ordinary reconnect policy, not a guessed compatibility result, decides what happens next.
      fail(new Error("Serve ended before completing terminal admission"));
    };
    const onClose = (): void => fail(new Error("Serve socket closed during terminal admission"));
    const onError = (error: Error): void => fail(error);
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const newlineIndex = incoming.indexOf(0x0a);
      const firstFrameBytes = buffer.length + (newlineIndex >= 0 ? newlineIndex : incoming.length);
      if (firstFrameBytes > TERMINAL_ADMISSION_FRAME_MAX_BYTES) {
        fail(invalidAdmissionResponseError(null, options.terminalProtocolVersion));
        return;
      }
      if (newlineIndex < 0) {
        buffer = Buffer.concat([buffer, incoming]);
        return;
      }

      const line = Buffer.concat([buffer, incoming.subarray(0, newlineIndex)]).toString("utf-8");
      const remainder = incoming.subarray(newlineIndex + 1);
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        fail(invalidAdmissionResponseError(null, options.terminalProtocolVersion));
        return;
      }
      const response = parseTerminalAdmissionResponse(raw);
      if (response === null) {
        fail(invalidAdmissionResponseError(raw, options.terminalProtocolVersion));
        return;
      }
      if (response.status === "retired") {
        fail(
          new TerminalAdmissionRetiredError(
            response.message,
            response.code,
            response.action,
            response.terminalProtocolVersion,
          ),
        );
        return;
      }
      if (response.terminalProtocolVersion !== options.terminalProtocolVersion) {
        fail(
          mismatchedAcceptedError(
            options.terminalProtocolVersion,
            response.terminalProtocolVersion,
          ),
        );
        return;
      }

      settled = true;
      socket.pause();
      cleanup();
      if (remainder.length > 0) socket.unshift(remainder);
      resolve(response);
      // Promise continuations install the business reader before the stream resumes.
      queueMicrotask(() => {
        if (!socket.destroyed) socket.resume();
      });
    };

    timer = setTimeout(
      () => fail(new Error("Timed out waiting for terminal admission")),
      timeoutMs,
    );
    timer.unref?.();
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.write(
      serializeTerminalAdmissionMessage({
        type: "terminal_admission_request",
        admissionVersion: TERMINAL_ADMISSION_VERSION,
        terminalProtocolVersion: options.terminalProtocolVersion,
        clientKind: options.clientKind,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      }),
    );
  });
}
