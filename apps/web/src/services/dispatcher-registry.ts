import { relayClientRef } from "@/hooks/use-relay-setup";
import type { InboundMessage, RelayClient } from "./relay-client";

// 各 dispatcher（chat / session / resource 等）共用的注册模板：拿到 relayClient 单例 → 调
// onMessage 挂 handler → 返回 dispose 函数。无 relay 时 warn 一行后 return no-op，避免调用
// 顺序无关导致的运行时崩溃。

export function registerDispatcher(
  name: string,
  buildHandler: (relay: RelayClient) => (msg: InboundMessage) => void,
): () => void {
  const relay = relayClientRef;
  if (!relay) {
    console.warn(`${name} called before relayClient bound; skipping`);
    return () => {};
  }
  return relay.onMessage(buildHandler(relay));
}
