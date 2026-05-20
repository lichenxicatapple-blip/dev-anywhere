import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendRemoteInputRaw } from "./ansi-keys";

// 通过 mock use-relay-setup 截获 wsManagerRef 的 send 调用
const sendSpy = vi.fn();
vi.mock("@/hooks/use-relay-setup", () => ({
  get wsManagerRef() {
    return { send: sendSpy };
  },
}));

describe("sendRemoteInputRaw", () => {
  beforeEach(() => {
    sendSpy.mockClear();
    window.localStorage.removeItem("dev_anywhere_pty_input_latency_trace");
    window.__devAnywherePtyInputLatencyTrace = [];
  });

  it("sends a remote_input_raw envelope via wsManagerRef", () => {
    sendRemoteInputRaw("sess-1", "\x03");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendSpy.mock.calls[0][0] as string);
    expect(payload.type).toBe("remote_input_raw");
    expect(payload.sessionId).toBe("sess-1");
    expect(payload.data).toBe("\x03");
    expect(sendSpy).toHaveBeenCalledWith(expect.any(String), { queueWhenDisconnected: true });
  });

  it("does not send when sessionId missing", () => {
    sendRemoteInputRaw("", "\x03");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does not send when data empty", () => {
    sendRemoteInputRaw("sess-1", "");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("adds traceId when PTY input latency trace is enabled", () => {
    window.localStorage.setItem("dev_anywhere_pty_input_latency_trace", "1");

    sendRemoteInputRaw("sess-1", "a");

    const payload = JSON.parse(sendSpy.mock.calls[0][0] as string);
    expect(payload.traceId).toMatch(/^pty-in-/);
    expect(
      window.__devAnywherePtyInputLatencyTrace?.some((entry) => entry.event === "input:start"),
    ).toBe(true);
  });
});
