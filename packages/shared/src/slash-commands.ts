export function isCompactCommandText(text: string): boolean {
  return /^\/compact(?:\s|$)/.test(text.trimStart());
}
