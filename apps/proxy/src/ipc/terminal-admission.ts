// Terminal admission is deliberately separate from the business IPC schema.  Keep version 1
// small and additive: a future daemon must be able to reject an incompatible terminal before it
// attempts to parse that generation's session messages.
export const TERMINAL_ADMISSION_VERSION = 1 as const;
export const TERMINAL_ADMISSION_FRAME_MAX_BYTES = 16 * 1024;

const ADMISSION_TEXT_MAX_LENGTH = 1_024;

export type TerminalAdmissionClientKind = "local-terminal" | "terminal-worker";
export type TerminalAdmissionRecoveryAction = "restart_terminal" | "restart_service";
export type TerminalAdmissionRetirementCode =
  | "ADMISSION_REQUEST_INVALID"
  | "ADMISSION_RESPONSE_INVALID"
  | "TERMINAL_RUNTIME_OUTDATED"
  | "TERMINAL_SERVICE_OUTDATED";

interface TerminalAdmissionRequest {
  type: "terminal_admission_request";
  admissionVersion: typeof TERMINAL_ADMISSION_VERSION;
  terminalProtocolVersion: number;
  clientKind: TerminalAdmissionClientKind;
  sessionId?: string;
}

export interface TerminalAdmissionContext {
  clientKind: TerminalAdmissionClientKind;
  sessionId?: string;
}

export type TerminalAdmissionResponse =
  | {
      type: "terminal_admission_response";
      admissionVersion: typeof TERMINAL_ADMISSION_VERSION;
      status: "accepted";
      terminalProtocolVersion: number;
    }
  | {
      type: "terminal_admission_response";
      admissionVersion: typeof TERMINAL_ADMISSION_VERSION;
      status: "retired";
      terminalProtocolVersion: number;
      code: TerminalAdmissionRetirementCode;
      action: TerminalAdmissionRecoveryAction;
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProtocolVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= ADMISSION_TEXT_MAX_LENGTH &&
    (allowEmpty || value.length > 0)
  );
}

export function isTerminalAdmissionRequestCandidate(value: unknown): boolean {
  return isRecord(value) && value.type === "terminal_admission_request";
}

// Unknown object keys are intentionally ignored.  Admission v1 is a permanently stable prefix;
// later clients may add diagnostics/capabilities without making an older daemon unable to return
// a useful permanent rejection.
export function parseTerminalAdmissionRequest(value: unknown): TerminalAdmissionRequest | null {
  if (!isRecord(value) || value.type !== "terminal_admission_request") return null;
  if (value.admissionVersion !== TERMINAL_ADMISSION_VERSION) return null;
  if (!isProtocolVersion(value.terminalProtocolVersion)) return null;
  if (value.clientKind !== "local-terminal" && value.clientKind !== "terminal-worker") {
    return null;
  }
  if (value.sessionId !== undefined && !isBoundedText(value.sessionId)) return null;
  if (value.clientKind === "terminal-worker" && value.sessionId === undefined) return null;
  return {
    type: "terminal_admission_request",
    admissionVersion: TERMINAL_ADMISSION_VERSION,
    terminalProtocolVersion: value.terminalProtocolVersion,
    clientKind: value.clientKind,
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
  };
}

export function parseTerminalAdmissionResponse(value: unknown): TerminalAdmissionResponse | null {
  if (!isRecord(value) || value.type !== "terminal_admission_response") return null;
  if (value.admissionVersion !== TERMINAL_ADMISSION_VERSION) return null;
  if (!isProtocolVersion(value.terminalProtocolVersion)) return null;
  if (value.status === "accepted") {
    return {
      type: "terminal_admission_response",
      admissionVersion: TERMINAL_ADMISSION_VERSION,
      status: "accepted",
      terminalProtocolVersion: value.terminalProtocolVersion,
    };
  }
  if (
    value.status !== "retired" ||
    (value.code !== "ADMISSION_REQUEST_INVALID" &&
      value.code !== "ADMISSION_RESPONSE_INVALID" &&
      value.code !== "TERMINAL_RUNTIME_OUTDATED" &&
      value.code !== "TERMINAL_SERVICE_OUTDATED") ||
    (value.action !== "restart_terminal" && value.action !== "restart_service") ||
    !isBoundedText(value.message)
  ) {
    return null;
  }
  return {
    type: "terminal_admission_response",
    admissionVersion: TERMINAL_ADMISSION_VERSION,
    status: "retired",
    terminalProtocolVersion: value.terminalProtocolVersion,
    code: value.code,
    action: value.action,
    message: value.message,
  };
}

export function serializeTerminalAdmissionMessage(
  message: TerminalAdmissionRequest | TerminalAdmissionResponse,
): string {
  return `${JSON.stringify(message)}\n`;
}
