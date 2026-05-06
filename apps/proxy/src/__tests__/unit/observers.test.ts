import { describe, it, expect, vi } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import { JsonObserver } from "#src/serve/json-observer.js";

describe("JsonObserver", () => {
  function setup(): { observer: JsonObserver; spy: ReturnType<typeof vi.fn> } {
    const spy = vi.fn().mockReturnValue(true);
    const observer = new JsonObserver({ changeSessionState: spy });
    return { observer, spy };
  }

  it("onTurnStart → WORKING", () => {
    const { observer, spy } = setup();
    observer.onTurnStart("s1");
    expect(spy).toHaveBeenCalledWith("s1", SessionState.WORKING);
  });

  it("onTurnResult → IDLE", () => {
    const { observer, spy } = setup();
    observer.onTurnResult("s1");
    expect(spy).toHaveBeenCalledWith("s1", SessionState.IDLE);
  });

  it("onApprovalRequested → WAITING_APPROVAL", () => {
    const { observer, spy } = setup();
    observer.onApprovalRequested("s1");
    expect(spy).toHaveBeenCalledWith("s1", SessionState.WAITING_APPROVAL);
  });

  it("onChannelBroken → ERROR (proxy ↔ worker observation channel lost)", () => {
    const { observer, spy } = setup();
    observer.onChannelBroken("s1");
    expect(spy).toHaveBeenCalledWith("s1", SessionState.ERROR);
  });
});
