import { describe, it, expect, vi } from "vitest";
import { SessionState } from "@dev-anywhere/shared";
import { PtyObserver } from "#src/serve/pty-observer.js";
import { JsonObserver } from "#src/serve/json-observer.js";

describe("PtyObserver", () => {
  function setup(): { observer: PtyObserver; calls: Array<[string, SessionState]> } {
    const calls: Array<[string, SessionState]> = [];
    const observer = new PtyObserver({
      changeSessionState: (sid, next) => {
        calls.push([sid, next]);
        return true;
      },
    });
    return { observer, calls };
  }

  it("maps OSC working signal to WORKING", () => {
    const { observer, calls } = setup();
    observer.onPtySignal("s1", "working");
    expect(calls).toEqual([["s1", SessionState.WORKING]]);
  });

  it("maps OSC turn_complete signal to IDLE", () => {
    const { observer, calls } = setup();
    observer.onPtySignal("s1", "turn_complete");
    expect(calls).toEqual([["s1", SessionState.IDLE]]);
  });

  it("maps OSC approval_wait signal to WAITING_APPROVAL", () => {
    const { observer, calls } = setup();
    observer.onPtySignal("s1", "approval_wait");
    expect(calls).toEqual([["s1", SessionState.WAITING_APPROVAL]]);
  });

  it("ignores mid_pause signal (heartbeat, not a state transition)", () => {
    const { observer, calls } = setup();
    observer.onPtySignal("s1", "mid_pause");
    expect(calls).toEqual([]);
  });

  it("ignores unknown signal", () => {
    const { observer, calls } = setup();
    observer.onPtySignal("s1", "something_else");
    expect(calls).toEqual([]);
  });

  it("onTerminalAttached sets session to IDLE", () => {
    const { observer, calls } = setup();
    observer.onTerminalAttached("s1");
    expect(calls).toEqual([["s1", SessionState.IDLE]]);
  });
});

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
