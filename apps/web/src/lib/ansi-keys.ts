// remote_input_raw 发送路径：xterm onData、Header Ctrl+C 等终端级输入共用
// 语义按键不再走预烤 ANSI 常量表；面板/Tab 等特色功能由菜单承载。
import { wsManagerRef } from "@/hooks/use-relay-setup";
import { beginPtyInputLatencyTrace, finishPtyInputLatencySend } from "./pty-input-latency-trace";

export function sendRemoteInputRaw(sessionId: string, data: string): void {
  if (!sessionId || !data) return;
  const trace = beginPtyInputLatencyTrace(sessionId, data);
  const ws = wsManagerRef;
  if (!ws) {
    finishPtyInputLatencySend(trace, {
      sent: false,
      queueWhenDisconnected: false,
      details: "no-ws-manager",
    });
    return;
  }
  const payload: Record<string, unknown> = {
    type: "remote_input_raw",
    sessionId,
    data,
  };
  if (trace) payload.traceId = trace.inputId;
  const sent = ws.send(JSON.stringify(payload), { queueWhenDisconnected: true });
  finishPtyInputLatencySend(trace, {
    sent,
    queueWhenDisconnected: true,
    details: sent ? "sent-open-socket" : "queued-or-dropped",
  });
}
