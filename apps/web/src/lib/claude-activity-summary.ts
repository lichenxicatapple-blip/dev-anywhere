const SECRET_VALUE_PATTERN =
  /((?:authorization|api[_-]?key|token|password|secret)\s*[:=]\s*)(?:bearer\s+)?[^\s'"]+/giu;
const SECRET_FLAG_PATTERN = /(--(?:api-key|token|password|secret)(?:=|\s+))[^\s'"]+/giu;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function compact(value: string, max = 140): string {
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function redact(value: string): string {
  return value
    .replace(SECRET_VALUE_PATTERN, "$1[redacted]")
    .replace(SECRET_FLAG_PATTERN, "$1[redacted]");
}

function filePath(input: Record<string, unknown>): string {
  return asString(input.file_path) || asString(input.path);
}

export function summarizeClaudeToolActivity(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Bash": {
      const command = compact(redact(asString(input.command)));
      return command ? `运行命令：${command}` : "运行命令";
    }
    case "Read": {
      const path = filePath(input);
      return path ? `读取文件：${path}` : "读取文件";
    }
    case "Write": {
      const path = filePath(input);
      return path ? `写入文件：${path}` : "写入文件";
    }
    case "Edit":
    case "MultiEdit": {
      const path = filePath(input);
      return path ? `编辑文件：${path}` : "编辑文件";
    }
    case "LS": {
      const path = filePath(input);
      return path ? `列出目录：${path}` : "列出目录";
    }
    case "Grep": {
      const pattern = compact(redact(asString(input.pattern)), 80);
      const path = filePath(input);
      if (pattern && path) return `搜索：${pattern} in ${path}`;
      return pattern ? `搜索：${pattern}` : "搜索文本";
    }
    case "Glob": {
      const pattern = compact(redact(asString(input.pattern)), 80);
      return pattern ? `查找文件：${pattern}` : "查找文件";
    }
    case "WebFetch": {
      const url = compact(redact(asString(input.url)), 100);
      return url ? `读取网页：${url}` : "读取网页";
    }
    case "WebSearch": {
      const query = compact(redact(asString(input.query)), 100);
      return query ? `网页搜索：${query}` : "网页搜索";
    }
    case "TodoWrite":
      return "更新任务列表";
    default:
      return `使用工具：${toolName}`;
  }
}
