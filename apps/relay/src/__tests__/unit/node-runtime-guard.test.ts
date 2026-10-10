import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MINIMUM_NODE_VERSION,
  isSupportedNodeVersion,
  unsupportedNodeMessage,
} from "../../node-runtime-guard.js";

describe("Relay Node.js runtime requirement", () => {
  it("matches the engines.node declared in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"),
    ) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`);
  });

  it("rejects older Node.js with an actionable message", () => {
    expect(isSupportedNodeVersion("20.19.0")).toBe(false);
    expect(isSupportedNodeVersion("22.22.1")).toBe(false);
    const message = unsupportedNodeMessage("20.19.0");
    expect(message).toContain(`Node.js ${MINIMUM_NODE_VERSION} or newer`);
    expect(message).toContain("20.19.0");
  });

  it("accepts the minimum and newer versions", () => {
    expect(unsupportedNodeMessage(MINIMUM_NODE_VERSION)).toBeNull();
    expect(unsupportedNodeMessage("v22.23.3")).toBeNull();
    expect(unsupportedNodeMessage("24.0.0")).toBeNull();
  });
});
