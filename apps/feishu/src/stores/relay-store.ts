// RelayClient 实例的全局存取，避免从 app.tsx 导出（Taro 入口文件不支持普通 ESM 导出）
import { createContext, useContext } from "react";
import type { RelayClient } from "@/services/relay-client";

const RelayClientContext = createContext<RelayClient | null>(null);

export const RelayClientProvider = RelayClientContext.Provider;

export function useRelayClient(): RelayClient | null {
  return useContext(RelayClientContext);
}
