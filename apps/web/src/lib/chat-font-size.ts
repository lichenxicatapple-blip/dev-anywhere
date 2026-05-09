export const MIN_CHAT_FONT_SIZE = 8;
export const MAX_CHAT_FONT_SIZE = 24;
export const MOBILE_CHAT_CONTENT_FONT_SIZE_MIN = 16;
export const DEFAULT_TERMINAL_FONT_SIZE = 16;
export const DEFAULT_CHAT_CONTENT_FONT_SIZE = 16;

export function getEffectiveChatContentFontSize(
  fontSize: number,
  touchEditingSurface: boolean,
): number {
  return touchEditingSurface ? Math.max(fontSize, MOBILE_CHAT_CONTENT_FONT_SIZE_MIN) : fontSize;
}
