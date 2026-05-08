// e2e 测试专用入口: 在 dev build 下把 store/helper 挂到 window.__ccTest,
// 避免 Playwright page.evaluate 通过 vite dev-server URL 动态 import 源码
// production build 时 import.meta.env.DEV 为 false, 整个函数空跑, 不会污染线上
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { toast } from "@/components/toast";
import type { Terminal } from "@xterm/xterm";

interface CCTestHooks {
  chat: {
    addUserMessage: (sessionId: string, message: ChatMessage) => void;
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

declare global {
  interface Window {
    __ccTest?: CCTestHooks;
  }
}

export function installTestHooks(): void {
  if (!import.meta.env.DEV) return;
  const ptySerializers = new Map<string, () => string>();
  const ptyTerminals = new Map<string, Terminal>();
  window.__ccTest = {
    chat: {
      addUserMessage: (sid, msg) => useChatStore.getState().addUserMessage(sid, msg),
      appendAssistantText: (sid, text) => useChatStore.getState().appendAssistantText(sid, text),
      markTurnComplete: (sid) => useChatStore.getState().markTurnComplete(sid),
      loadHistory: (sid, messages) => useChatStore.getState().loadHistory(sid, messages),
    },
    session: {
      setPtyTitle: (sid, title) => useSessionStore.getState().setPtyTitle(sid, title),
    },
    pty: {
      serialize: (sid) => ptySerializers.get(sid)?.() ?? "",
      metrics: (sid) => {
        const term = ptyTerminals.get(sid);
        const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
        if (!term || !screen) return null;
        return {
          fontSize: term.options.fontSize,
          cols: term.cols,
          rows: term.rows,
          screenWidth: screen.clientWidth,
          screenHeight: screen.clientHeight,
        };
      },
    },
    toast: (msg) => {
      toast(msg);
    },
  };
  window.__ccTestPtySerializers = ptySerializers;
  window.__ccTestPtyTerminals = ptyTerminals;
}

declare global {
  interface Window {
    __ccTestPtySerializers?: Map<string, () => string>;
    __ccTestPtyTerminals?: Map<string, Terminal>;
  }
}

export function registerPtySerializer(sessionId: string, serialize: (() => string) | null): void {
  if (!import.meta.env.DEV) return;
  const serializers = window.__ccTestPtySerializers;
  if (!serializers) return;
  if (serialize) serializers.set(sessionId, serialize);
  else serializers.delete(sessionId);
}

export function registerPtyTerminal(sessionId: string, terminal: Terminal | null): void {
  if (!import.meta.env.DEV) return;
  const terminals = window.__ccTestPtyTerminals;
  if (!terminals) return;
  if (terminal) terminals.set(sessionId, terminal);
  else terminals.delete(sessionId);
}
