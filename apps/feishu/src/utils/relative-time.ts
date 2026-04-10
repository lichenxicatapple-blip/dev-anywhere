// 相对时间格式化，将时间戳转换为人类可读的相对时间描述

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (seconds < 3600) return `${minutes} ${minutes === 1 ? "min" : "mins"} ago`;
  const hours = Math.floor(seconds / 3600);
  if (seconds < 86400) return `${hours} ${hours === 1 ? "hr" : "hrs"} ago`;
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
