// InputBar 纯辅助函数: 字符串状态机与布尔判断, 无 UI 依赖

type PickerMode = "none" | "slash" | "file";

export function computeSendDisabled(
  isWorking: boolean,
  pendingApprovals: Array<{ status: string }>,
): boolean {
  if (isWorking) return true;
  if (pendingApprovals.some((a) => a.status === "pending")) return true;
  return false;
}

// @ 触发的判定: @ 在句首或前一个字符是空格, 且 @ 后不含空格
function hasValidAt(val: string): boolean {
  const idx = val.lastIndexOf("@");
  if (idx < 0) return false;
  if (idx > 0 && val[idx - 1] !== " ") return false;
  const afterAt = val.slice(idx + 1);
  return !afterAt.includes(" ");
}

export function detectPickerMode(val: string): PickerMode {
  if (!val) return "none";
  if (hasValidAt(val)) return "file";
  if (val.startsWith("/") && !val.slice(1).includes(" ")) return "slash";
  return "none";
}

// 退格删除已插入的原子片段 (slash / @<路径>) 时清理残留, 返回清理后文本
export function cleanupDeletedMention(
  val: string,
  prev: string,
  insertedMentions: string[],
): { cleaned: string; removedMention: string | null } {
  if (val.length >= prev.length || insertedMentions.length === 0) {
    return { cleaned: val, removedMention: null };
  }
  for (const mention of insertedMentions) {
    if (prev.includes(mention) && !val.includes(mention)) {
      let cleaned = val;
      for (let len = mention.length - 1; len > 0; len--) {
        const fragment = mention.slice(0, len);
        if (cleaned.endsWith(fragment)) {
          cleaned = cleaned.slice(0, -fragment.length);
          if (cleaned.endsWith(" ")) cleaned = cleaned.slice(0, -1);
          break;
        }
      }
      return { cleaned, removedMention: mention };
    }
  }
  return { cleaned: val, removedMention: null };
}
