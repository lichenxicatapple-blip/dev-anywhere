import { homedir } from "node:os";

const ANSI_OSC_RE = new RegExp(String.raw`\x1b\][^\x07]*(?:\x07|\x1b\\)`, "g");
const ANSI_CSI_RE = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_CHARSET_RE = new RegExp(String.raw`\x1b[()][A-Za-z0-9]`, "g");
const ACTIVE_WRITER_RE =
  /\bthread\s+([A-Za-z0-9][A-Za-z0-9_-]{7,127})\s+already has an active writer\b/i;
const DIAGNOSTIC_LINE_RE =
  /\b(error|failed|failure|fatal|invalid value|permission denied|not found|active writer|timed? ?out|timeout|not writable|unavailable|refused|denied|closed|exited)\b/i;
const MAX_DIAGNOSTIC_LINES = 8;
const MAX_DIAGNOSTIC_LINE_CHARS = 512;
const MAX_DIAGNOSTIC_CHARS = 2_048;

export interface CodexActiveWriterError {
  threadId: string;
}

export function classifyCodexActiveWriterError(output: string): CodexActiveWriterError | null {
  const match = ACTIVE_WRITER_RE.exec(stripTerminalControl(output));
  return match ? { threadId: match[1] } : null;
}

export function codexActiveWriterMessage(pid?: number): string {
  const processDetail = pid ? `（PID ${pid}）` : "";
  return (
    `另一个 Codex 进程正在使用此会话${processDetail}。` +
    "它可能来自本机终端、Codex App 或另一条 DEV Anywhere 会话。" +
    "请先回到或结束原会话后再重试；DEV Anywhere 不会自动终止该进程。"
  );
}

/**
 * 只保留小段明确的错误行，并移除常见凭据与用户主目录。终端启动输出可能包含
 * 用户输入，因此没有错误关键字时宁可不写日志，也不回退到任意末尾文本。
 */
export function sanitizeProviderErrorTail(output: string): string {
  const home = homedir();
  const lines = stripTerminalControl(output)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && DIAGNOSTIC_LINE_RE.test(line))
    .slice(-MAX_DIAGNOSTIC_LINES)
    .map((line) => redactDiagnosticLine(line, home));
  return lines.join("\n").slice(-MAX_DIAGNOSTIC_CHARS);
}

function stripTerminalControl(output: string): string {
  return output
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_CHARSET_RE, "")
    .replace(/[^\t\n\r\x20-\x7e\u0080-\uffff]/g, "");
}

function redactDiagnosticLine(line: string, home: string): string {
  let redacted = line;
  if (home) redacted = redacted.split(home).join("~");
  redacted = redacted
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/[^\s:/@]+:)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, "$1[REDACTED]");
  return redacted.slice(0, MAX_DIAGNOSTIC_LINE_CHARS);
}
