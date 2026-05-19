import type { VoiceSummaryReason } from "@dev-anywhere/shared";

const FALLBACKS: Record<VoiceSummaryReason, string> = {
  code: "这条回复包含代码，我先概括：它给出了一段实现或配置，请查看屏幕确认细节。",
  table: "这条回复包含表格，我先概括主要结论，请查看屏幕确认具体行列。",
  diff: "这条回复包含代码变更，我先概括：请查看屏幕确认具体修改。",
  log: "这条回复包含日志，我先概括关键状态，请查看屏幕确认原始输出。",
  stack_trace: "这条回复包含错误堆栈，我先概括问题方向，请查看屏幕确认调用位置。",
  long_list: "这条回复包含较长列表，我先概括结构，请查看屏幕确认每一项。",
  long_text: "这条回复内容较长，我先概括重点，请查看屏幕确认完整细节。",
  mixed: "这条回复包含不适合直接朗读的内容，我先概括重点，请查看屏幕确认细节。",
};

export function fallbackSpeechSummary(reason: VoiceSummaryReason): string {
  return FALLBACKS[reason];
}
