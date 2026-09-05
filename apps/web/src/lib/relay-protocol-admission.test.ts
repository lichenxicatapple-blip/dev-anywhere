import { describe, expect, it } from "vitest";
import { RELAY_CONTROL_PROTOCOL_VERSION, RelayProtocolRejectReason } from "@dev-anywhere/shared";
import { compareRelayControlProtocol, isRelayProtocolIssue } from "./relay-protocol-admission";

describe("Relay protocol admission", () => {
  it("identifies which side is behind", () => {
    expect(compareRelayControlProtocol(1, 2)).toBe(RelayProtocolRejectReason.SERVICE_OUTDATED);
    expect(compareRelayControlProtocol(RELAY_CONTROL_PROTOCOL_VERSION)).toBeNull();
    expect(compareRelayControlProtocol(RELAY_CONTROL_PROTOCOL_VERSION + 1)).toBe(
      RelayProtocolRejectReason.PAGE_OUTDATED,
    );
  });

  it("accepts only stable machine-readable reject reasons", () => {
    expect(isRelayProtocolIssue(RelayProtocolRejectReason.PAGE_OUTDATED)).toBe(true);
    expect(isRelayProtocolIssue("refresh the page")).toBe(false);
  });
});
