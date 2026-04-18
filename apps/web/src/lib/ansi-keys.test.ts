import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ANSI_INTERRUPT,
  ANSI_TAB,
  ANSI_UP,
  ANSI_DOWN,
  ANSI_ESC,
  ansiForAction,
  sendRemoteInputRaw,
  sendSemanticAction,
} from "./ansi-keys";

// 通过 mock use-relay-setup 截获 wsManagerRef 的 send 调用
const sendSpy = vi.fn();
vi.mock("@/hooks/use-relay-setup", () => ({
  get wsManagerRef() {
    return { send: sendSpy };
  },
}));

describe("ANSI constants", () => {
  it("ANSI_INTERRUPT maps to Ctrl+C (0x03)", () => {
    expect(ANSI_INTERRUPT).toBe("\x03");
    expect(ANSI_INTERRUPT.length).toBe(1);
  });

  it("ANSI_TAB is the literal tab character", () => {
    expect(ANSI_TAB).toBe("\t");
  });

  it("ANSI_UP is ESC [ A", () => {
    expect(ANSI_UP).toBe("\x1b[A");
    expect(ANSI_UP.length).toBe(3);
  });

  it("ANSI_DOWN is ESC [ B", () => {
    expect(ANSI_DOWN).toBe("\x1b[B");
    expect(ANSI_DOWN.length).toBe(3);
  });

  it("ANSI_ESC is the literal ESC character", () => {
    expect(ANSI_ESC).toBe("\x1b");
    expect(ANSI_ESC.length).toBe(1);
  });
});

describe("ansiForAction", () => {
  it("maps interrupt to Ctrl+C", () => {
    expect(ansiForAction("interrupt")).toBe("\x03");
  });

  it("maps toggle_permission to Tab", () => {
    expect(ansiForAction("toggle_permission")).toBe("\t");
  });

  it("maps history_prev to ESC [ A", () => {
    expect(ansiForAction("history_prev")).toBe("\x1b[A");
  });

  it("maps history_next to ESC [ B", () => {
    expect(ansiForAction("history_next")).toBe("\x1b[B");
  });

  it("maps cancel to ESC", () => {
    expect(ansiForAction("cancel")).toBe("\x1b");
  });
});

describe("sendRemoteInputRaw", () => {
  beforeEach(() => {
    sendSpy.mockClear();
  });

  it("sends a remote_input_raw envelope via wsManagerRef", () => {
    sendRemoteInputRaw("sess-1", "\x03");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendSpy.mock.calls[0][0] as string);
    expect(payload.type).toBe("remote_input_raw");
    expect(payload.sessionId).toBe("sess-1");
    expect(payload.data).toBe("\x03");
  });

  it("does not send when sessionId missing", () => {
    sendRemoteInputRaw("", "\x03");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does not send when data empty", () => {
    sendRemoteInputRaw("sess-1", "");
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("sendSemanticAction", () => {
  beforeEach(() => {
    sendSpy.mockClear();
  });

  it("sends the correct ANSI for each action", () => {
    sendSemanticAction("s", "interrupt");
    sendSemanticAction("s", "history_prev");
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sendSpy.mock.calls[0][0] as string).data).toBe("\x03");
    expect(JSON.parse(sendSpy.mock.calls[1][0] as string).data).toBe("\x1b[A");
  });

  it("sends toggle_permission as Tab", () => {
    sendSemanticAction("s", "toggle_permission");
    expect(JSON.parse(sendSpy.mock.calls[0][0] as string).data).toBe("\t");
  });

  it("sends cancel as ESC", () => {
    sendSemanticAction("s", "cancel");
    expect(JSON.parse(sendSpy.mock.calls[0][0] as string).data).toBe("\x1b");
  });
});
