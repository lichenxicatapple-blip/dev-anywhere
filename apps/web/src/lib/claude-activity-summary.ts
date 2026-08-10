import type { ChatActivityDetail } from "./chat-activity-detail";
export { summarizeToolActivity as summarizeClaudeToolActivity } from "@dev-anywhere/shared";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asOriginalText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type ClaudeToolActivityDetail = ChatActivityDetail;

function patchKindLabel(kind: unknown): string {
  switch (kind) {
    case "add":
      return "新增";
    case "delete":
      return "删除";
    case "update":
      return "更新";
    default:
      return "变更";
  }
}

function detail(title: string, value: unknown): ClaudeToolActivityDetail | null {
  const content = asOriginalText(value);
  return content ? { title, content } : null;
}

function detailContent(oldContent: string, newContent: string): string {
  if (!oldContent) return newContent;
  if (!newContent) return oldContent;
  return `${oldContent}\n${newContent}`;
}

function replacementDetail(
  title: string,
  oldValue: unknown,
  newValue: unknown,
): ClaudeToolActivityDetail | null {
  const oldContent = asOriginalText(oldValue);
  const newContent = asOriginalText(newValue);
  if (!oldContent && !newContent) return null;
  return {
    kind: "diff",
    title,
    content: detailContent(oldContent, newContent),
    oldContent,
    newContent,
  };
}

function parseUnifiedDiffContent(diff: string): { oldContent: string; newContent: string } | null {
  const lines = diff.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inHunk = false;
  let sawContent = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline")) continue;

    const marker = line[0];
    const text = line.slice(1);
    if (marker === " ") {
      oldLines.push(text);
      newLines.push(text);
      sawContent = true;
    } else if (marker === "-") {
      oldLines.push(text);
      sawContent = true;
    } else if (marker === "+") {
      newLines.push(text);
      sawContent = true;
    }
  }

  if (!sawContent) return null;
  return { oldContent: oldLines.join("\n"), newContent: newLines.join("\n") };
}

function patchDiffDetail(title: string, diff: string, kind: unknown): ClaudeToolActivityDetail {
  const parsed = parseUnifiedDiffContent(diff);
  if (!parsed) {
    if (kind === "add") {
      return {
        kind: "diff",
        title,
        content: diff,
        oldContent: "",
        newContent: diff,
      };
    }
    if (kind === "delete") {
      return {
        kind: "diff",
        title,
        content: diff,
        oldContent: diff,
        newContent: "",
      };
    }
    return { title, content: diff };
  }
  return {
    kind: "diff",
    title,
    content: diff,
    oldContent: parsed.oldContent,
    newContent: parsed.newContent,
  };
}

function compactDetails(
  details: Array<ClaudeToolActivityDetail | null>,
): ClaudeToolActivityDetail[] {
  return details.filter((item): item is ClaudeToolActivityDetail => item !== null);
}

export function getClaudeToolActivityDetails(
  toolName: string,
  input: Record<string, unknown>,
): ClaudeToolActivityDetail[] {
  switch (toolName) {
    case "Write":
      return compactDetails([replacementDetail("新增内容", "", input.content)]);
    case "Edit":
      return compactDetails([replacementDetail("变更预览", input.old_string, input.new_string)]);
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      return edits.flatMap((editInput, index) => {
        const edit = editInput && typeof editInput === "object" ? editInput : {};
        const record = edit as Record<string, unknown>;
        return compactDetails([
          replacementDetail(`第 ${index + 1} 处变更`, record.old_string, record.new_string),
        ]);
      });
    }
    case "NotebookEdit":
      return compactDetails([detail("新的单元格内容", input.new_source)]);
    case "Patch": {
      const changes = Array.isArray(input.changes) ? input.changes : [];
      const changeDetails = changes.flatMap((changeInput) => {
        const change = changeInput && typeof changeInput === "object" ? changeInput : {};
        const record = change as Record<string, unknown>;
        const diff = asOriginalText(record.diff);
        if (!diff) return [];
        const path = asString(record.path);
        const title = path
          ? `${patchKindLabel(record.kind)}：${path}`
          : patchKindLabel(record.kind);
        return [patchDiffDetail(title, diff, record.kind)];
      });
      if (changeDetails.length > 0) return changeDetails;
      return compactDetails([detail("补丁内容", input.content)]);
    }
    default:
      return [];
  }
}
