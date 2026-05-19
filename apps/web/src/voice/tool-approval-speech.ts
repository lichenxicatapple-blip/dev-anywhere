interface ToolApprovalLike {
  toolName: string;
  input: Record<string, unknown>;
}

const PATH_KEYS = ["file_path", "path", "filename", "cwd"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const DESTRUCTIVE_PATTERN =
  /\b(rm\s+-rf|sudo\s+rm|dd\s+if=|mkfs|chmod\s+-R|chown\s+-R|git\s+clean|>\s*\/|truncate)\b/i;

function stringValue(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function interestingKeys(input: Record<string, unknown>): string[] {
  const ignored = new Set([...PATH_KEYS, ...COMMAND_KEYS]);
  return Object.keys(input)
    .filter((key) => !ignored.has(key))
    .slice(0, 3);
}

export function describeToolApprovalForSpeech(approval: ToolApprovalLike): string {
  const command = stringValue(approval.input, COMMAND_KEYS);
  const path = stringValue(approval.input, PATH_KEYS);
  if (command) {
    const warning = DESTRUCTIVE_PATTERN.test(command) ? "看起来可能会删除或覆盖内容。" : "";
    return `工具 ${approval.toolName} 请求执行命令：${command}。${warning}`.trim();
  }
  if (path) {
    const keys = interestingKeys(approval.input);
    const suffix = keys.length > 0 ? `参数包括 ${keys.join("、")}。` : "";
    return `工具 ${approval.toolName} 请求操作路径：${path}。${suffix}`.trim();
  }
  const keys = interestingKeys(approval.input);
  if (keys.length > 0) {
    return `工具 ${approval.toolName} 请求执行操作。参数包括 ${keys.join("、")}。`;
  }
  return `工具 ${approval.toolName} 请求执行操作。`;
}
