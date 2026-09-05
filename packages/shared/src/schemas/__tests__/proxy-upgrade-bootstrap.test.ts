import { describe, expect, it } from "vitest";
import {
  compareProxyRelayProtocolVersions,
  PROXY_UPGRADE_BOOTSTRAP_VERSION,
  ProxyProtocolAdmissionDirection,
  ProxyUpgradeBootstrapResponseSchema,
} from "../../index.js";

describe("ProxyUpgradeBootstrapResponseSchema", () => {
  it("accepts the stable upgrade discovery response", () => {
    expect(
      ProxyUpgradeBootstrapResponseSchema.parse({
        bootstrapVersion: PROXY_UPGRADE_BOOTSTRAP_VERSION,
        relayVersion: "0.9.1",
        controlProtocolVersion: 1,
      }),
    ).toEqual({
      bootstrapVersion: 1,
      relayVersion: "0.9.1",
      controlProtocolVersion: 1,
    });
  });

  it.each([
    { bootstrapVersion: 2, relayVersion: "0.9.1", controlProtocolVersion: 1 },
    { bootstrapVersion: 1, relayVersion: "latest", controlProtocolVersion: 1 },
    { bootstrapVersion: 1, relayVersion: "0.9.1-beta.1", controlProtocolVersion: 1 },
    { bootstrapVersion: 1, relayVersion: "0.9.1", controlProtocolVersion: 0 },
  ])("rejects an unsafe response: %j", (response) => {
    expect(ProxyUpgradeBootstrapResponseSchema.safeParse(response).success).toBe(false);
  });

  it("ignores additive fields so a future Relay can still tell an older Proxy to update", () => {
    expect(
      ProxyUpgradeBootstrapResponseSchema.parse({
        bootstrapVersion: 1,
        relayVersion: "0.9.1",
        controlProtocolVersion: 1,
        minimumProxyVersion: "0.10.0",
      }),
    ).toEqual({
      bootstrapVersion: 1,
      relayVersion: "0.9.1",
      controlProtocolVersion: 1,
    });
  });
});

describe("compareProxyRelayProtocolVersions", () => {
  it.each([
    [1, 1, ProxyProtocolAdmissionDirection.COMPATIBLE],
    [1, 2, ProxyProtocolAdmissionDirection.PROXY_OUTDATED],
    [2, 1, ProxyProtocolAdmissionDirection.RELAY_OUTDATED],
    [undefined, 1, ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH],
    [1, undefined, ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH],
    ["1", 1, ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH],
    [0, 1, ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH],
    [1.5, 1, ProxyProtocolAdmissionDirection.PROTOCOL_MISMATCH],
  ])("classifies Proxy %j against Relay %j as %s", (proxy, relay, expected) => {
    expect(compareProxyRelayProtocolVersions(proxy, relay)).toBe(expected);
  });
});
