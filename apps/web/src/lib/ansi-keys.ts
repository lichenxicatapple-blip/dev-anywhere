// remote_input_raw 发送路径：xterm onData、Header Ctrl+C 等终端级输入共用
// 语义按键不再走预烤 ANSI 常量表；面板/Tab 等特色功能由菜单承载。
import { wsManagerRef } from "@/hooks/use-relay-setup";

export function sendRemoteInputRaw(sessionId: string, data: string): void {
  if (!sessionId || !data) return;
  const ws = wsManagerRef;
  if (!ws) return;
  ws.send(
    JSON.stringify({
      type: "remote_input_raw",
      sessionId,
      data,
    }),
  );
}
