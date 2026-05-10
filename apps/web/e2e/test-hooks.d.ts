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
    loadHistory: (
      sessionId: string,
      messages: Array<{ role: "user" | "assistant"; text: string; timestamp?: number }>,
    ) => void;
  };
  session: {
    setPtyTitle: (sessionId: string, title: string) => void;
  };
  pty: {
    serialize: (sessionId: string) => string;
    metrics: (sessionId: string) => {
      fontSize: number | undefined;
      cols: number;
      rows: number;
      screenWidth: number;
      screenHeight: number;
    } | null;
  };
  toast: (message: string) => void;
}

interface DevAnywherePtyScrollTraceEntry {
  event?: string;
}

declare global {
  interface Window {
    __ccTest?: CCTestHooks;
    __ccTestPtyTerminals?: Map<
      string,
      {
        buffer: {
          active: {
            viewportY: number;
            baseY: number;
          };
        };
      }
    >;
    __ptySmoke: {
      sent: string[];
      socket: {
        emitPty: (data: string) => void;
        emitPtyWithSeq: (data: string, outputSeq: number) => void;
        emitResize: (cols: number, rows: number) => void;
        emitJson: (payload: unknown) => void;
      } | null;
      sendPty: (data: string) => void;
      sendPtyWithSeq: (data: string, outputSeq: number) => void;
      resize: (cols: number, rows: number) => void;
      setPtyState: (state: "working" | "turn_complete" | "approval_wait") => void;
    };
    __devAnywherePtyScrollTrace?: DevAnywherePtyScrollTraceEntry[];
  }
}

export {};
