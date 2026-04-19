// e2e 专用 window 类型声明: 镜像 src/test-hooks.ts 的 CCTestHooks 形状
// 两边 tsconfig 分属不同 project, declare global 不会冲突, 保持 src 边界干净
interface CCTestChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  isPartial: boolean;
  timestamp: number;
  toolCalls: unknown[];
}

interface CCTestHooks {
  chat: {
    addUserMessage: (sessionId: string, message: CCTestChatMessage) => void;
    appendAssistantText: (sessionId: string, text: string) => void;
    markTurnComplete: (sessionId: string) => void;
  };
  session: {
    setPtyTitle: (sessionId: string, title: string) => void;
  };
  toast: (message: string) => void;
}

declare global {
  interface Window {
    __ccTest?: CCTestHooks;
  }
}

export {};
