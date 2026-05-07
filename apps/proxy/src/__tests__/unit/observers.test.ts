import { describe, it, expect, vi } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import { JsonObserver } from "#src/serve/json-observer.js";

describe("JsonObserver", () => {
  function setup(): {
    observer: JsonObserver;
    spy: ReturnType<typeof vi.fn>;
    emitAgentStatus: ReturnType<typeof vi.fn>;
  } {
    const spy = vi.fn().mockReturnValue(true);
    const emitAgentStatus = vi.fn();
    const observer = new JsonObserver({ changeSessionState: spy, emitAgentStatus });
    return { observer, spy, emitAgentStatus };
  }

  it("onTurnStart → WORKING", () => {
    const { observer, spy, emitAgentStatus } = setup();
    observer.onTurnStart("s1");
    expect(spy).toHaveBeenCalledWith("s1", SessionState.WORKING);
    expect(emitAgentStatus).toHaveBeenCalledWith("s1", "thinking");
  });

  it("onTurnResult → IDLE", () => {
    const { observer, spy, emitAgentStatus } = setup();
    observer.onTurnResult("s1");
    expect(spy).toHaveBeenCalledWith("s1", SessionState.IDLE);
    expect(emitAgentStatus).toHaveBeenCalledWith("s1", "idle");
  });

  it("onApprovalRequested → WAITING_APPROVAL", () => {
    const { observer, spy, emitAgentStatus } = setup();
    observer.onApprovalRequested("s1");
    expect(spy).toHaveBeenCalledWith("s1", SessionState.WAITING_APPROVAL);
    expect(emitAgentStatus).toHaveBeenCalledWith("s1", "waiting_permission");
  });

  it("onChannelBroken → ERROR (proxy ↔ worker observation channel lost)", () => {
    const { observer, spy } = setup();
    observer.onChannelBroken("s1");
    expect(spy).toHaveBeenCalledWith("s1", SessionState.ERROR);
  });
});
