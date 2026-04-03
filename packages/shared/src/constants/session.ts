// 会话状态枚举
export const SessionState = {
  IDLE: "idle",
  WORKING: "working",
  WAITING_APPROVAL: "waiting_approval",
  ERROR: "error",
  TERMINATED: "terminated",
} as const;

export type SessionState = (typeof SessionState)[keyof typeof SessionState];
