import type { RelayClient } from "./relay-client";

interface BindingContext {
  proxyId?: string;
  sessionId?: string;
}

interface BindingSuccess {
  proxyId: string;
}

interface BindingError {
  error: string;
}

type BindingResult = BindingSuccess | BindingError;

export function isBindingError(result: BindingResult): result is BindingError {
  return "error" in result;
}

// 统一绑定函数，4 个场景 1 条路径
export async function ensureBinding(
  relay: RelayClient,
  context: BindingContext,
): Promise<BindingResult> {
  let targetProxyId = context.proxyId;

  // 已绑定且 proxyId 匹配，直接返回
  if (targetProxyId && relay.getBoundProxyId() === targetProxyId) {
    return { proxyId: targetProxyId };
  }

  // 只有 sessionId 没有 proxyId：通过 proxy_list 匹配
  if (!targetProxyId && context.sessionId) {
    let proxies: Awaited<ReturnType<RelayClient["requestProxyList"]>>;
    try {
      proxies = await relay.requestProxyList();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const match = proxies.find((p) => p.sessions?.includes(context.sessionId!));
    if (!match) {
      return { error: `Session ${context.sessionId} not found on any proxy` };
    }
    targetProxyId = match.proxyId;
  }

  if (!targetProxyId) {
    return { error: "No proxy specified" };
  }

  // 统一走 proxy_select
  let ack: Awaited<ReturnType<RelayClient["selectProxy"]>>;
  try {
    ack = await relay.selectProxy(targetProxyId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!ack.success) {
    return { error: ack.error || "Proxy select failed" };
  }
  return { proxyId: targetProxyId };
}
