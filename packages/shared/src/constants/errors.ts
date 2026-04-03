// 统一错误码定义，所有错误通过 error 类型消息传递
export const ErrorCode = {
  UNKNOWN: "UNKNOWN",
  AUTH_FAILED: "AUTH_FAILED",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_TERMINATED: "SESSION_TERMINATED",
  INVALID_MESSAGE: "INVALID_MESSAGE",
  RATE_LIMIT: "RATE_LIMIT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
