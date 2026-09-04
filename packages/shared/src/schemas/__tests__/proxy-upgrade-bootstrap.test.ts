import { describe, expect, it } from "vitest";
import {
  PROXY_UPGRADE_BOOTSTRAP_VERSION,
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
    {
      bootstrapVersion: 1,
      relayVersion: "0.9.1",
      controlProtocolVersion: 1,
      sessionProtocol: "accepted",
    },
  ])("rejects an unsafe or expanded response: %j", (response) => {
    expect(ProxyUpgradeBootstrapResponseSchema.safeParse(response).success).toBe(false);
  });
});
