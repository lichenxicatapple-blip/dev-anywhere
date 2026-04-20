// 工具调用参数摘要，用于 ToolApprovalCard 和 ToolCallCard 的参数预览

interface ToolSummary {
  type: "edit" | "bash" | "write" | "generic";
  summary: string;
  details: unknown;
}

const MAX_SUMMARY_LENGTH = 80;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): ToolSummary {
  const name = toolName.toLowerCase();

  if (name === "edit" || name === "edit_file") {
    return {
      type: "edit",
      summary: (input.file_path as string) || "unknown file",
      details: { old_string: input.old_string, new_string: input.new_string },
    };
  }

  if (name === "bash" || name === "execute") {
    const cmd = String(input.command || "");
    return {
      type: "bash",
      summary: truncate(cmd, MAX_SUMMARY_LENGTH),
      details: input,
    };
  }

  if (name === "write" || name === "write_file") {
    return {
      type: "write",
      summary: (input.file_path as string) || "unknown file",
      details: { content: String(input.content || "").slice(0, 200) },
    };
  }

  const json = JSON.stringify(input);
  return {
    type: "generic",
    summary: truncate(json, MAX_SUMMARY_LENGTH),
    details: input,
  };
}
