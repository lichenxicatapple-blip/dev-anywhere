// e2e 测试专用入口: 在 dev build 下把 store/helper 挂到 window.__ccTest,
// 避免 Playwright page.evaluate 通过 vite dev-server URL 动态 import 源码
// production build 时 import.meta.env.DEV 为 false, 整个函数空跑, 不会污染线上
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { toast } from "@/components/toast";

interface CCTestHooks {
  chat: {
    addUserMessage: (sessionId: string, message: ChatMessage) => void;
    appendAssistantText: (sessionId: string, text: string) => void;
    markTurnComplete: (sessionId: string) => void;
  };
  session: {
    setPtyTitle: (sessionId: string, title: string) => void;
  };
  pty: {
    serialize: (sessionId: string) => string;
  };
  toast: (message: string) => void;
}

declare global {
  interface Window {
    __ccTest?: CCTestHooks;
  }
}

export function installTestHooks(): void {
  if (!import.meta.env.DEV) return;
  const ptySerializers = new Map<string, () => string>();
  window.__ccTest = {
    chat: {
      addUserMessage: (sid, msg) => useChatStore.getState().addUserMessage(sid, msg),
      appendAssistantText: (sid, text) => useChatStore.getState().appendAssistantText(sid, text),
      markTurnComplete: (sid) => useChatStore.getState().markTurnComplete(sid),
    },
    session: {
      setPtyTitle: (sid, title) => useSessionStore.getState().setPtyTitle(sid, title),
    },
    pty: {
      serialize: (sid) => ptySerializers.get(sid)?.() ?? "",
    },
    toast: (msg) => {
      toast(msg);
    },
  };
  window.__ccTestPtySerializers = ptySerializers;
}

declare global {
  interface Window {
    __ccTestPtySerializers?: Map<string, () => string>;
  }
}

export function registerPtySerializer(sessionId: string, serialize: (() => string) | null): void {
  if (!import.meta.env.DEV) return;
  const serializers = window.__ccTestPtySerializers;
  if (!serializers) return;
  if (serialize) serializers.set(sessionId, serialize);
  else serializers.delete(sessionId);
}
