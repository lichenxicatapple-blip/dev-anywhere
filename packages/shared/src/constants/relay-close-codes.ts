// WebSocket close codes in the private 4000-4999 range.
export const RelayCloseCode = {
  CLIENT_KICKED: 4401,
  CLIENT_PROTOCOL_REJECTED: 4402,
  DEVICE_STREAM_PROTOCOL_REJECTED: 4403,
  DEVICE_STREAM_BINDING_REJECTED: 4404,
  PROXY_PROTOCOL_REJECTED: 4405,
} as const;

// Stable machine-readable reasons used by the HTTP/WS admission layer. They intentionally live
// outside the versioned Relay business-message schema so incompatible peers can still explain
// which side needs updating.
export const RelayProtocolRejectReason = {
  PAGE_OUTDATED: "page_outdated",
  SERVICE_OUTDATED: "service_outdated",
  PROTOCOL_MISMATCH: "protocol_mismatch",
} as const;

export type RelayProtocolRejectReasonType =
  (typeof RelayProtocolRejectReason)[keyof typeof RelayProtocolRejectReason];

// Proxy <-> Relay admission is intentionally separate from the Web client admission reasons
// above. These values are carried as WebSocket close reasons, before either side may safely parse
// the versioned RelayControl schema.
export const ProxyProtocolAdmissionDirection = {
  COMPATIBLE: "compatible",
  PROXY_OUTDATED: "proxy_outdated",
  RELAY_OUTDATED: "relay_outdated",
  PROTOCOL_MISMATCH: "protocol_mismatch",
} as const;

export type ProxyProtocolAdmissionDirectionType =
  (typeof ProxyProtocolAdmissionDirection)[keyof typeof ProxyProtocolAdmissionDirection];

export type ProxyProtocolRejectDirection = Exclude<
  ProxyProtocolAdmissionDirectionType,
  typeof ProxyProtocolAdmissionDirection.COMPATIBLE
>;

function isPositiveSafeProtocolVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * The sole ordering rule for Proxy <-> Relay control-protocol admission.
 *
 * Invalid or absent inputs deliberately fail closed instead of being ordered. Callers must not
 * infer upgrade direction from package versions or from versioned business-message parse errors.
 */
export function compareProxyRelayProtocolVersions(
  proxyProtocolVersion: unknown,
  relayProtocolVersion: unknown,
): ProxyProtocolAdmissionDirectionType {
  if (
    !isPositiveSafeProtocolVersion(proxyProtocolVersion) ||
    !isPositiveSafeProtocolVersion(relayProtocolVersion)
  ) {
    return ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH;
  }
  if (proxyProtocolVersion === relayProtocolVersion) {
    return ProxyProtocolAdmissionDirection.COMPATIBLE;
  }
  return proxyProtocolVersion < relayProtocolVersion
    ? ProxyProtocolAdmissionDirection.PROXY_OUTDATED
    : ProxyProtocolAdmissionDirection.RELAY_OUTDATED;
}

export function isProxyProtocolRejectDirection(
  value: unknown,
): value is ProxyProtocolRejectDirection {
  return (
    value === ProxyProtocolAdmissionDirection.PROXY_OUTDATED ||
    value === ProxyProtocolAdmissionDirection.RELAY_OUTDATED ||
    value === ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH
  );
}
