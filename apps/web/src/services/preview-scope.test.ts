import { describe, expect, it } from "vitest";
import { createPreviewScope, samePreviewScope } from "./preview-scope";

describe("PreviewScope", () => {
  it("treats separately constructed instances of the same signed wire scope as equal", () => {
    expect(
      samePreviewScope(
        createPreviewScope("proxy-a", "binding-1"),
        createPreviewScope("proxy-a", "binding-1"),
      ),
    ).toBe(true);
  });

  it("distinguishes a new binding even when the Proxy id returns to the same value", () => {
    const first = createPreviewScope("proxy-a", "binding-1");
    const second = createPreviewScope("proxy-a", "binding-2");

    expect(samePreviewScope(first, second)).toBe(false);
  });

  it("requires both the Proxy id and Relay-signed binding id to match", () => {
    const first = createPreviewScope("proxy-a", "binding-1");
    const second = createPreviewScope("proxy-b", "binding-1");

    expect(samePreviewScope(first, second)).toBe(false);
  });

  it("exposes a frozen scope object", () => {
    const scope = createPreviewScope("proxy-a", "binding-1");

    expect(Object.isFrozen(scope)).toBe(true);
  });

  it("rejects either empty wire identity", () => {
    expect(() => createPreviewScope("", "binding-1")).toThrow("proxyId must not be empty");
    expect(() => createPreviewScope("proxy-a", "")).toThrow("bindingId must not be empty");
  });
});
