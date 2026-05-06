// OSC 0: 窗口标题 -- ESC ] 0 ; <title> BEL/ST
// OSC 9: 通知 -- ESC ] 9 ; <text> BEL/ST
// 每次调用创建新的 regex 实例避免 g flag 导致的 lastIndex 状态泄漏
// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /\x1b\](\d+);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

export type PtySemanticState = "working" | "turn_complete" | "approval_wait" | "mid_pause";

interface PtyStateEvent {
  state: PtySemanticState;
  title?: string;
  tool?: string;
}

// 待删除旧路径：从 PTY 原始数据中提取 OSC 语义信号。
// 删除条件见 ARCHITECTURE-GOVERNANCE.md「删除债务登记」：
// hook PermissionRequest 覆盖 PTY Claude 审批后，删除审批主流程依赖。
// OSC 9 优先级高于 OSC 0，无匹配时返回 null
export function extractOscSignals(rawData: string): PtyStateEvent | null {
  const regex = new RegExp(OSC_PATTERN.source, OSC_PATTERN.flags);
  const matches: Array<{ code: number; text: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawData)) !== null) {
    matches.push({ code: parseInt(match[1], 10), text: match[2] });
  }

  if (matches.length === 0) return null;

  // OSC 9 优先级更高，包含具体的语义信号
  const osc9 = matches.find((m) => m.code === 9);
  if (osc9) {
    if (osc9.text.includes("waiting for your input")) {
      return { state: "turn_complete" };
    }
    if (osc9.text.includes("needs your permission")) {
      const toolMatch = osc9.text.match(/permission.*?:\s*(\S+)/);
      return { state: "approval_wait", tool: toolMatch?.[1] };
    }
  }

  // 仅有 OSC 0（标题/spinner 变化）时视为 MID_PAUSE
  const osc0 = matches.find((m) => m.code === 0);
  if (osc0 && !osc9) {
    return { state: "mid_pause", title: osc0.text };
  }

  return null;
}
