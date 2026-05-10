// 把 CSS px 字符串转成数字。空串 / NaN / 非数走 0，避免下游 NaN 传播。
export function parsePx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
