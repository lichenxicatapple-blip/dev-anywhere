// 应用级状态管理：连接状态、选中代理、客户端标识
import { createContext, useContext } from "react";
import Taro from "@tarojs/taro";

export interface AppState {
  connected: boolean;
  selectedProxyId: string | null;
  selectedProxyName: string | null;
  clientId: string;
  relayUrl: string;
}

export type AppAction =
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "SET_PROXY"; proxyId: string | null; proxyName: string | null }
  | { type: "SET_RELAY_URL"; url: string };

function loadClientId(): string {
  const stored = Taro.getStorageSync("cc_clientId") as string;
  if (stored) return stored;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  Taro.setStorageSync("cc_clientId", id);
  return id;
}

export const initialAppState: AppState = {
  connected: false,
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
    case "SET_RELAY_URL":
      return { ...state, relayUrl: action.url };
    default:
      return state;
  }
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
