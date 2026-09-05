const PRE_ADMISSION_PATH_MAX_LENGTH = 4_096;
const PRE_ADMISSION_SESSION_ID_MAX_LENGTH = 256;

interface UnversionedTerminalReconnect {
  sessionId: string;
  pid: number;
  provider: "claude" | "codex" | "kimi";
  kind?: "agent" | "terminal";
}

interface VersionedTerminalReconnect {
  sessionId: string;
  protocolVersion: number;
  pid?: number;
  provider?: "claude" | "codex" | "kimi";
  kind?: "agent" | "terminal";
}

const UNVERSIONED_RECONNECT_KEYS = new Set([
  "type",
  "mode",
  "provider",
  "cwd",
  "name",
  "pid",
  "sessionId",
  "kind",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedNonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

// This is not an old business-protocol decoder.  It recognizes only the frozen unversioned
// reconnect envelope so the daemon can send its one-way retirement control.  The request is never
// admitted as a session.
export function parseUnversionedTerminalReconnect(
  value: unknown,
): UnversionedTerminalReconnect | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !UNVERSIONED_RECONNECT_KEYS.has(key))) return null;
  if (value.type !== "session_create_request" || value.mode !== "pty") return null;
  if (value.provider !== "claude" && value.provider !== "codex" && value.provider !== "kimi") {
    return null;
  }
  if (!isBoundedNonEmptyString(value.cwd, PRE_ADMISSION_PATH_MAX_LENGTH)) return null;
  if (
    value.name !== undefined &&
    (typeof value.name !== "string" || value.name.length > PRE_ADMISSION_PATH_MAX_LENGTH)
  ) {
    return null;
  }
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    return null;
  }
  if (!isBoundedNonEmptyString(value.sessionId, PRE_ADMISSION_SESSION_ID_MAX_LENGTH)) return null;
  if (value.kind !== undefined && value.kind !== "agent" && value.kind !== "terminal") return null;
  return {
    sessionId: value.sessionId,
    pid: value.pid,
    provider: value.provider,
    ...(value.kind !== undefined ? { kind: value.kind } : {}),
  };
}

// Before the admission prefix existed, a versioned terminal sent its business create request as
// the first frame.  Read only the stable retirement fields here.  In particular, do not run an
// older request through the current business schema: a future schema may have changed every other
// field and still needs to retire an already-running local terminal without starting a reconnect
// loop.  Unknown keys are ignored because they carry no authority in this path.
export function parseVersionedTerminalReconnect(value: unknown): VersionedTerminalReconnect | null {
  if (!isRecord(value)) return null;
  if (value.type !== "session_create_request" || value.mode !== "pty") return null;
  if (
    typeof value.protocolVersion !== "number" ||
    !Number.isSafeInteger(value.protocolVersion) ||
    value.protocolVersion < 0
  ) {
    return null;
  }
  if (!isBoundedNonEmptyString(value.sessionId, PRE_ADMISSION_SESSION_ID_MAX_LENGTH)) return null;
  if (
    value.pid !== undefined &&
    (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0)
  ) {
    return null;
  }
  if (
    value.provider !== undefined &&
    value.provider !== "claude" &&
    value.provider !== "codex" &&
    value.provider !== "kimi"
  ) {
    return null;
  }
  if (value.kind !== undefined && value.kind !== "agent" && value.kind !== "terminal") {
    return null;
  }
  return {
    sessionId: value.sessionId,
    protocolVersion: value.protocolVersion,
    ...(value.pid !== undefined ? { pid: value.pid } : {}),
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.kind !== undefined ? { kind: value.kind } : {}),
  };
}

// Keep these wire shapes independent from the current IpcMessageSchema.  They are frozen one-way
// retirement controls, not an attempt to accept an earlier business protocol.
export function serializePreAdmissionTerminalRetirement(
  sessionId: string,
  action: "detach" | "terminate",
): string {
  return `${JSON.stringify({
    type: action === "terminate" ? "pty_terminate" : "pty_detach",
    sessionId,
  })}\n`;
}
