// 应用级状态管理：连接状态、选中代理、客户端标识、AppPhase 状态机
import { createContext, useContext } from "react";
import Taro from "@tarojs/taro";

export type AppPhase =
  | "connecting"
  | "registering"
  | "reconnecting"
  | "proxy_selecting"
  | "session_browsing"
  | "chatting";

export interface AppState {
  phase: AppPhase;
  phaseBeforeDisconnect: AppPhase | null;
  connected: boolean;
  proxyOnline: boolean;
  selectedProxyId: string | null;
  selectedProxyName: string | null;
  clientId: string;
  relayUrl: string;
}

export type AppAction =
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "SET_PROXY"; proxyId: string | null; proxyName: string | null }
  | { type: "SET_PROXY_ONLINE"; online: boolean }
  | { type: "SET_RELAY_URL"; url: string }
  | { type: "SET_PHASE"; phase: AppPhase };

function loadClientId(): string {
  const stored = Taro.getStorageSync("cc_clientId") as string;
  if (stored) return stored;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  Taro.setStorageSync("cc_clientId", id);
  return id;
}

export const initialAppState: AppState = {
  phase: "connecting",
  phaseBeforeDisconnect: null,
  connected: false,
  proxyOnline: false,
  selectedProxyId: null,
  selectedProxyName: null,
  clientId: loadClientId(),
  relayUrl: "",
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_CONNECTED":
      return { ...state, connected: action.connected };
    case "SET_PROXY":
      return { ...state, selectedProxyId: action.proxyId, selectedProxyName: action.proxyName };
    case "SET_PROXY_ONLINE":
      return { ...state, proxyOnline: action.online };
    case "SET_RELAY_URL":
      return { ...state, relayUrl: action.url };
    case "SET_PHASE": {
      const next = action.phase;
      const phaseBeforeDisconnect =
        next === "reconnecting" ? state.phase : state.phaseBeforeDisconnect;
      return { ...state, phase: next, phaseBeforeDisconnect };
    }
    default:
      return state;
  }
}

export function cleanStorageForPhaseTransition(prev: AppPhase, next: AppPhase): void {
  if (next === "proxy_selecting") {
    Taro.removeStorageSync("cc_proxyId");
    Taro.removeStorageSync("cc_sessionId");
  }
  if (next === "session_browsing" && prev === "chatting") {
    Taro.removeStorageSync("cc_sessionId");
  }
}

export function transitionToPhase(
  prev: AppPhase,
  next: AppPhase,
  dispatch: React.Dispatch<AppAction>,
): void {
  cleanStorageForPhaseTransition(prev, next);
  dispatch({ type: "SET_PHASE", phase: next });
}

const AppStateContext = createContext<AppState>(initialAppState);
const AppDispatchContext = createContext<React.Dispatch<AppAction>>(() => {
  throw new Error("AppDispatchContext used outside AppProvider");
});

export const AppProvider = AppStateContext.Provider;
export const AppDispatchProvider = AppDispatchContext.Provider;

export function useAppState(): AppState {
  return useContext(AppStateContext);
}

export function useAppDispatch(): React.Dispatch<AppAction> {
  return useContext(AppDispatchContext);
}
