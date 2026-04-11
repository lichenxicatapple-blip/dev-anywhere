import { describe, it, expect, vi, beforeEach } from "vitest";
import { appReducer, initialAppState, cleanStorageForPhaseTransition } from "@/stores/app-store";
import type { AppState, AppPhase } from "@/stores/app-store";
import Taro from "@tarojs/taro";

vi.mock("@tarojs/taro", () => ({
  default: {
    getStorageSync: vi.fn(() => ""),
    setStorageSync: vi.fn(),
    removeStorageSync: vi.fn(),
  },
}));

function stateWith(phase: AppPhase, overrides?: Partial<AppState>): AppState {
  return { ...initialAppState, phase, ...overrides };
}

describe("appReducer SET_PHASE", () => {
  it("updates phase", () => {
    const next = appReducer(stateWith("connecting"), { type: "SET_PHASE", phase: "proxy_selecting" });
    expect(next.phase).toBe("proxy_selecting");
  });

  it("records phaseBeforeDisconnect when entering reconnecting", () => {
    const next = appReducer(stateWith("chatting"), { type: "SET_PHASE", phase: "reconnecting" });
    expect(next.phase).toBe("reconnecting");
    expect(next.phaseBeforeDisconnect).toBe("chatting");
  });

  it("records phaseBeforeDisconnect when entering proxy_lost", () => {
    const next = appReducer(stateWith("session_browsing"), { type: "SET_PHASE", phase: "proxy_lost" });
    expect(next.phaseBeforeDisconnect).toBe("session_browsing");
  });

  it("preserves phaseBeforeDisconnect on normal transitions", () => {
    const state = stateWith("reconnecting", { phaseBeforeDisconnect: "chatting" });
    const next = appReducer(state, { type: "SET_PHASE", phase: "proxy_selecting" });
    expect(next.phaseBeforeDisconnect).toBe("chatting");
  });
});

describe("cleanStorageForPhaseTransition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears proxyId and sessionId when transitioning to proxy_selecting", () => {
    cleanStorageForPhaseTransition("chatting", "proxy_selecting");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_proxyId");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_sessionId");
  });

  it("clears sessionId when transitioning from chatting to session_browsing", () => {
    cleanStorageForPhaseTransition("chatting", "session_browsing");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_sessionId");
    expect(Taro.removeStorageSync).not.toHaveBeenCalledWith("cc_proxyId");
  });

  it("clears sessionId when transitioning from proxy_lost to session_browsing", () => {
    cleanStorageForPhaseTransition("proxy_lost", "session_browsing");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_sessionId");
  });

  it("does not clear anything for session_browsing to chatting", () => {
    cleanStorageForPhaseTransition("session_browsing", "chatting");
    expect(Taro.removeStorageSync).not.toHaveBeenCalled();
  });

  it("clears proxyId and sessionId for connecting to proxy_selecting", () => {
    cleanStorageForPhaseTransition("connecting", "proxy_selecting");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_proxyId");
    expect(Taro.removeStorageSync).toHaveBeenCalledWith("cc_sessionId");
  });
});
