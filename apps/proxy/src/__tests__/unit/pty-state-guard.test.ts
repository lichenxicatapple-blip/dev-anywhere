import { describe, expect, it } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import { shouldPromotePtyActivityToWorking } from "#src/serve/pty-state-guard.js";
import type { SessionInfo } from "#src/serve/session-manager.js";

function session(state: SessionState): SessionInfo {
  return {
    id: "s1",
    mode: "pty",
    provider: "claude",
    state,
    createdAt: 1,
    updatedAt: 1,
    cwd: "/tmp",
    pid: 1,
  };
}

describe("PTY state guard", () => {
  it("does not treat PTY activity as approval resolution while broker has pending approvals", () => {
    expect(shouldPromotePtyActivityToWorking(session(SessionState.WAITING_APPROVAL), 1)).toBe(
      false,
    );
  });

  it("allows PTY activity to resume working after approval has been cleared", () => {
    expect(shouldPromotePtyActivityToWorking(session(SessionState.WAITING_APPROVAL), 0)).toBe(true);
  });

  it("does not promote non-approval sessions", () => {
    expect(shouldPromotePtyActivityToWorking(session(SessionState.IDLE), 0)).toBe(false);
    expect(shouldPromotePtyActivityToWorking(session(SessionState.WORKING), 0)).toBe(false);
    expect(shouldPromotePtyActivityToWorking(undefined, 0)).toBe(false);
  });
});
