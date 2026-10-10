import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MINIMUM_NODE_VERSION, unsupportedNodeMessage } from "#src/common/node-version.js";

describe("Node.js runtime requirement", () => {
  it("matches the engines.node declared in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"),
    ) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`);
  });

  it("rejects older Node.js with an actionable message", () => {
    const message = unsupportedNodeMessage("20.19.0");
    expect(message).toContain(`Node.js ${MINIMUM_NODE_VERSION} or newer`);
    expect(message).toContain("20.19.0");
    expect(unsupportedNodeMessage("22.20.0")).not.toBeNull();
    expect(unsupportedNodeMessage("22.22.1")).not.toBeNull();
  });

  it("accepts the minimum and newer versions", () => {
    expect(unsupportedNodeMessage(MINIMUM_NODE_VERSION)).toBeNull();
    expect(unsupportedNodeMessage("22.23.3")).toBeNull();
    expect(unsupportedNodeMessage("24.0.0")).toBeNull();
  });
});
