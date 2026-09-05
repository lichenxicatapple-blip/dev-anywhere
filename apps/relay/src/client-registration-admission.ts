import {
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayProtocolRejectReason,
  type RelayProtocolRejectReasonType,
} from "@dev-anywhere/shared";

export type ClientRegistrationAdmission =
  | { kind: "not_client_registration" }
  | { kind: "unversioned_client_registration"; clientId?: string }
  | {
      kind: "versioned_client_registration";
      clientId?: string;
      protocolVersion: unknown;
    };

// Registration is the transport admission boundary. Inspect its small, stable envelope before
// handing the payload to the versioned business schema so an incompatible client can receive a
// terminal transport signal instead of entering the ordinary reconnect path.
export function inspectClientRegistrationAdmission(raw: string): ClientRegistrationAdmission {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "not_client_registration" };
  }

  if (value === null || typeof value !== "object") {
    return { kind: "not_client_registration" };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "client_register") {
    return { kind: "not_client_registration" };
  }

  const clientId = typeof candidate.clientId === "string" ? candidate.clientId : undefined;
  if (!("protocolVersion" in candidate)) {
    return {
      kind: "unversioned_client_registration",
      ...(clientId !== undefined ? { clientId } : {}),
    };
  }

  return {
    kind: "versioned_client_registration",
    ...(clientId !== undefined ? { clientId } : {}),
    protocolVersion: candidate.protocolVersion,
  };
}

export function classifyClientRegistrationProtocol(
  clientVersion: unknown,
  relayVersion: number = RELAY_CONTROL_PROTOCOL_VERSION,
): RelayProtocolRejectReasonType | null {
  if (
    typeof clientVersion !== "number" ||
    !Number.isSafeInteger(clientVersion) ||
    clientVersion <= 0
  ) {
    return RelayProtocolRejectReason.PROTOCOL_MISMATCH;
  }
  if (clientVersion === relayVersion) return null;
  return clientVersion < relayVersion
    ? RelayProtocolRejectReason.PAGE_OUTDATED
    : RelayProtocolRejectReason.SERVICE_OUTDATED;
}
