interface ToolApprovalLike {
  toolName: string;
  input: Record<string, unknown>;
}

const PATH_KEYS = ["file_path", "path", "filename", "cwd"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const SEARCH_KEYS = ["query", "queries", "search"];

function stringValue(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function interestingKeys(input: Record<string, unknown>): string[] {
  const ignored = new Set([...PATH_KEYS, ...COMMAND_KEYS, ...SEARCH_KEYS]);
  return Object.keys(input)
    .filter((key) => !ignored.has(key))
    .slice(0, 3);
}

function compactPath(value: string): string {
  const parts = value.split(/[\\/]+/u).filter(Boolean);
  return parts.slice(-2).join("/") || value;
}

function compactText(value: string, maxLength = 56): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function resultCount(input: Record<string, unknown>): string | null {
  const value = input.num ?? input.count ?? input.limit ?? input.max_results;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return `，最多返回 ${value} 条`;
  }
  if (typeof value === "string" && value.trim()) {
    return `，最多返回 ${value.trim()} 条`;
  }
  return null;
}

export function describeToolApprovalForSpeech(approval: ToolApprovalLike): string {
  const command = stringValue(approval.input, COMMAND_KEYS);
  const path = stringValue(approval.input, PATH_KEYS);
  const query = stringValue(approval.input, SEARCH_KEYS);
  if (query) {
    return `工具 ${approval.toolName} 请求搜索：${compactText(query)}${resultCount(approval.input) ?? ""}。`;
  }
  if (/search/i.test(approval.toolName)) {
    return `工具 ${approval.toolName} 请求搜索资料。`;
  }
  if (command) {
    return `工具 ${approval.toolName} 请求执行命令。`;
  }
  if (path) {
    return `工具 ${approval.toolName} 请求操作 ${compactPath(path)}。`;
  }
  const keys = interestingKeys(approval.input);
  if (keys.length > 0) {
    return `工具 ${approval.toolName} 请求执行操作。`;
  }
  return `工具 ${approval.toolName} 请求执行操作。`;
}
