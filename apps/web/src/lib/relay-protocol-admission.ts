import {
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayProtocolRejectReason,
  type RelayProtocolRejectReasonType,
} from "@dev-anywhere/shared";

export type RelayProtocolIssue = RelayProtocolRejectReasonType;

export function compareRelayControlProtocol(
  remoteVersion: number,
  pageVersion: number = RELAY_CONTROL_PROTOCOL_VERSION,
): RelayProtocolIssue | null {
  if (remoteVersion > pageVersion) {
    return RelayProtocolRejectReason.PAGE_OUTDATED;
  }
  if (remoteVersion < pageVersion) {
    return RelayProtocolRejectReason.SERVICE_OUTDATED;
  }
  return null;
}

export function isRelayProtocolIssue(value: unknown): value is RelayProtocolIssue {
  return Object.values(RelayProtocolRejectReason).some((reason) => reason === value);
}
