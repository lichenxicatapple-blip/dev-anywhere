import type { ChatMessage } from "@/stores/chat-store";

interface ChatMessageSizeEstimateOptions {
  fontSize: number;
  touchEditingSurface: boolean;
}

const ARTICLE_PADDING_Y = 16;
const BUBBLE_PADDING_Y = 16;
const MIN_HEIGHT = 56;

export function estimateChatMessageHeight(
  message: ChatMessage | undefined,
  options: ChatMessageSizeEstimateOptions,
): number {
  const fontSize = Math.max(12, options.fontSize || 16);
  const text = message?.text ?? "";
  const bubbleWidth = estimateBubbleWidth(
    message?.role ?? "assistant",
    options.touchEditingSurface,
  );
  const visualLineWidth = Math.max(12, bubbleWidth / fontSize);
  const visualLines = estimateVisualLines(text, visualLineWidth);
  const markdownExtra = estimateMarkdownBlockExtra(text, fontSize);
  const toolExtra = (message?.toolCalls.length ?? 0) * Math.max(56, fontSize * 3.5);
  const partialExtra = message?.isPartial ? fontSize * 0.5 : 0;

  const lineHeight = fontSize * 1.55;
  const estimate =
    ARTICLE_PADDING_Y +
    BUBBLE_PADDING_Y +
    visualLines * lineHeight +
    markdownExtra +
    toolExtra +
    partialExtra;

  return Math.max(MIN_HEIGHT, Math.round(estimate));
}

function estimateBubbleWidth(role: ChatMessage["role"], touchEditingSurface: boolean): number {
  if (touchEditingSurface) return role === "user" ? 280 : 310;
  return role === "user" ? 720 : 900;
}

function estimateVisualLines(text: string, visualLineWidth: number): number {
  const segments = text.length > 0 ? text.split("\n") : [""];
  return segments.reduce((total, segment) => {
    const width = estimateTextVisualWidth(segment);
    return total + Math.max(1, Math.ceil(width / visualLineWidth));
  }, 0);
}

function estimateTextVisualWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (/\s/u.test(char)) {
      width += 0.35;
    } else if (/[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/u.test(char)) {
      width += 1;
    } else {
      width += 0.55;
    }
  }
  return width;
}

function estimateMarkdownBlockExtra(text: string, fontSize: number): number {
  const lines = text.split("\n");
  let extra = 0;
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      extra += fontSize * 0.9;
      continue;
    }
    if (inFence) extra += fontSize * 0.15;
    if (/^\s*\|.*\|\s*$/u.test(line)) extra += fontSize * 0.35;
  }
  return extra;
}
