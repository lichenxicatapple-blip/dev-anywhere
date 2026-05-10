import { providerValues, type ProviderId } from "@dev-anywhere/shared";

// hook 入站 payload 解析的两个零依赖工具，hook-server 和 hook-event-router 共用。
// 都按容错语义工作：解析失败返回中性默认值（null / 空对象 / "unknown"）而非抛错，
// 让上层 dispatch 层决定是否拒绝。

// payload 任意 unknown 收窄到 Record；不是 object / 是数组时返回空对象。
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// provider 字符串收窄到 ProviderId；不在白名单返回 null。复用 shared 端的 providerValues 避免漂移。
export function asProvider(value: unknown): ProviderId | null {
  return (providerValues as readonly string[]).includes(value as string)
    ? (value as ProviderId)
    : null;
}

// 从 hook payload 提取 toolName，兼容 camelCase（toolName）和 snake_case（tool_name）。
export function toolNameFromPayload(payload: Record<string, unknown>): string {
  return typeof payload.toolName === "string"
    ? payload.toolName
    : typeof payload.tool_name === "string"
      ? payload.tool_name
      : "unknown";
}

// 从 hook payload 提取 input/tool_input 子结构，统一为 Record。
export function toolInputFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return asRecord(payload.input ?? payload.tool_input);
}
