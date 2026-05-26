export type UnifiedTextDiffRowType = "context" | "remove" | "add";

export interface UnifiedTextDiffRow {
  type: UnifiedTextDiffRowType;
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

const MAX_LCS_PRODUCT = 120_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/gu, "\n").split("\n");
}

function appendRemovedRows(rows: UnifiedTextDiffRow[], lines: string[], oldStart: number): void {
  let oldLineNumber = oldStart;
  for (const line of lines) {
    rows.push({ type: "remove", text: line, oldLineNumber, newLineNumber: null });
    oldLineNumber += 1;
  }
}

function appendAddedRows(rows: UnifiedTextDiffRow[], lines: string[], newStart: number): void {
  let newLineNumber = newStart;
  for (const line of lines) {
    rows.push({ type: "add", text: line, oldLineNumber: null, newLineNumber });
    newLineNumber += 1;
  }
}

export function buildUnifiedTextDiff(oldText: string, newText: string): UnifiedTextDiffRow[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length === 0 && newLines.length === 0) return [];

  if (oldLines.length * newLines.length > MAX_LCS_PRODUCT) {
    const rows: UnifiedTextDiffRow[] = [];
    appendRemovedRows(rows, oldLines, 1);
    appendAddedRows(rows, newLines, 1);
    return rows;
  }

  const dp = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? dp[oldIndex + 1][newIndex + 1] + 1
          : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const rows: UnifiedTextDiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      rows.push({
        type: "context",
        text: oldLines[oldIndex],
        oldLineNumber,
        newLineNumber,
      });
      oldIndex += 1;
      newIndex += 1;
      oldLineNumber += 1;
      newLineNumber += 1;
    } else if (
      newIndex >= newLines.length ||
      (oldIndex < oldLines.length && dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1])
    ) {
      rows.push({
        type: "remove",
        text: oldLines[oldIndex],
        oldLineNumber,
        newLineNumber: null,
      });
      oldIndex += 1;
      oldLineNumber += 1;
    } else {
      rows.push({
        type: "add",
        text: newLines[newIndex],
        oldLineNumber: null,
        newLineNumber,
      });
      newIndex += 1;
      newLineNumber += 1;
    }
  }

  return rows;
}
