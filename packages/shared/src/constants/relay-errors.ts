// relay 实际发出的 6 个错误码。schema 侧 RelayControlSchema.relay_error.code 用 z.enum 收紧，
// handler 侧用这个常量引用避免裸字面量拼错。
export const RelayErrorCode = {
  NOT_REGISTERED: "NOT_REGISTERED",
  NOT_BOUND: "NOT_BOUND",
  PROXY_OFFLINE: "PROXY_OFFLINE",
  INVALID_MESSAGE: "INVALID_MESSAGE",
  UNSUPPORTED: "UNSUPPORTED",
  INVALID_RANGE: "INVALID_RANGE",
} as const;

export type RelayErrorCode = (typeof RelayErrorCode)[keyof typeof RelayErrorCode];
