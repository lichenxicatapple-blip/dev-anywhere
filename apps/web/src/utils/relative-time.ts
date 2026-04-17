// 时间戳格式化：<24h 走相对时间（"2 分钟前"），≥24h 走绝对时间（"4 月 17 日 14:32"）
// 文案契约见 10-UI-SPEC.md Copywriting Contract "Time format" 行
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m} 分钟前`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h} 小时前`;
  }
  // 绝对时间："4 月 17 日 14:32"
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month} 月 ${day} 日 ${hh}:${mm}`;
}
