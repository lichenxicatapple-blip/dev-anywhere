import { describe, expect, it } from "vitest";
import {
  createApprovalRequestIdFactory,
  createScopedApprovalRequestIdFactory,
} from "#src/common/approval-request-id.js";

describe("createApprovalRequestIdFactory", () => {
  it("keeps approval request IDs unique within the same millisecond", () => {
    const nextId = createApprovalRequestIdFactory("session-1", () => 1779202130902);

    expect(nextId()).toBe("session-1-1779202130902-0");
    expect(nextId()).toBe("session-1-1779202130902-1");
    expect(nextId()).toBe("session-1-1779202130902-2");
  });

  it("keeps fallback hook approval IDs unique across sessions in the same millisecond", () => {
    const nextId = createScopedApprovalRequestIdFactory(() => 1779202130902);

    expect(nextId("pty-session-1")).toBe("pty-session-1-1779202130902-0");
    expect(nextId("pty-session-2")).toBe("pty-session-2-1779202130902-1");
  });
});
