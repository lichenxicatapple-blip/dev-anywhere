import { describe, expect, it } from "vitest";
import { parseProxyUpgradeBootstrapRequest } from "#src/proxy-upgrade-bootstrap.js";

const sourceRegistration = JSON.stringify({
  type: "proxy_register",
  proxyId: "source-proxy",
  proxyVersion: "0.8.1",
});

describe("parseProxyUpgradeBootstrapRequest", () => {
  it("accepts the exact source registration only when the target is a newer stable version", () => {
    expect(parseProxyUpgradeBootstrapRequest(sourceRegistration, "0.9.1")).toEqual({
      type: "proxy_register",
      proxyId: "source-proxy",
      proxyVersion: "0.8.1",
    });
  });

  it.each(["0.8.1", "0.8.0", "0.9.1-beta.1", "latest", "9007199254740992.0.0"])(
    "rejects target version %s",
    (targetVersion) => {
      expect(parseProxyUpgradeBootstrapRequest(sourceRegistration, targetVersion)).toBeNull();
    },
  );
});
