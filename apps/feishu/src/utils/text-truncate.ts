// 文本截断工具，用于会话标题生成和长文本显示

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

// 从第一条用户消息生成会话标题，截取前 20 个字符
export function generateSessionTitle(firstUserMessage: string | undefined): string {
  if (!firstUserMessage) return "New Session";
  return truncateText(firstUserMessage, 20);
}
