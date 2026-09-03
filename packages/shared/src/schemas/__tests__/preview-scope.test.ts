import { describe, expect, it } from "vitest";
import { PreviewScopeSchema } from "../preview-scope.js";

describe("PreviewScopeSchema", () => {
  it("requires both the Proxy and binding generation identities", () => {
    const scope = { proxyId: "proxy-1", bindingId: "binding-1" };
    expect(PreviewScopeSchema.parse(scope)).toEqual(scope);
    expect(PreviewScopeSchema.safeParse({ proxyId: "proxy-1" }).success).toBe(false);
    expect(PreviewScopeSchema.safeParse({ bindingId: "binding-1" }).success).toBe(false);
    expect(PreviewScopeSchema.safeParse({ ...scope, generation: 1 }).success).toBe(false);
  });
});
