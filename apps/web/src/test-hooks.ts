// e2e 测试专用入口: 在 dev build 下把 store/helper 挂到 window.__ccTest,
// 避免 Playwright page.evaluate 通过 vite dev-server URL 动态 import 源码
// production build 时 import.meta.env.DEV 为 false, 整个函数空跑, 不会污染线上
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { toast } from "@/components/toast";
import type { ILinkProvider, Terminal } from "@xterm/xterm";

// PTY xterm link provider 在真实浏览器里需要鼠标精确落到字符 cell 才会激活,
// e2e 通过此 hook 直接调 provideLinks → activate, 绕过坐标投影。
export type PtyLinkKind = "image-preview" | "file-download";

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
    getSelection: (sessionId: string) => string;
    activateLink: (
      sessionId: string,
      kind: PtyLinkKind,
      needle: string,
      modifier: "meta" | "ctrl" | "none",
    ) => { triggered: boolean; text?: string; lineNumber?: number };
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
  const ptyLinkProviders = new Map<string, ILinkProvider>();
  const linkKey = (sid: string, kind: PtyLinkKind): string => `${sid}/${kind}`;
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
      // drag-select autoscroll e2e 用: 取 xterm 当前选区文字, 验证选区是否真延伸
      // 到屏外内容上(光 scrollLeft 动了不够, 那只能证明容器滚了)。
      getSelection: (sid) => ptyTerminals.get(sid)?.getSelection() ?? "",
      activateLink: (sid, kind, needle, modifier) => {
        const provider = ptyLinkProviders.get(linkKey(sid, kind));
        const term = ptyTerminals.get(sid);
        if (!provider || !term) return { triggered: false };
        const buffer = term.buffer.active;
        for (let i = 0; i < buffer.length; i += 1) {
          const line = buffer.getLine(i)?.translateToString(true) ?? "";
          if (!line.includes(needle)) continue;
          let triggered = false;
          let text: string | undefined;
          // bufferLineNumber 是 1-based, getLine(i) 是 0-based, 因此传 i+1。
          provider.provideLinks(i + 1, (links) => {
            const link = links?.[0];
            if (!link) return;
            text = link.text;
            // 构造仅含修饰键的合成 MouseEvent: link provider 内部只读 metaKey / ctrlKey,
            // 其它字段 (clientX/Y / button) 与命中判定无关, 因此用 partial cast 即可。
            const event = {
              metaKey: modifier === "meta",
              ctrlKey: modifier === "ctrl",
            } as unknown as MouseEvent;
            link.activate(event, link.text);
            triggered = true;
          });
          return { triggered, text, lineNumber: i + 1 };
        }
        return { triggered: false };
      },
    },
    toast: (msg) => {
      toast(msg);
    },
  };
  window.__ccTestPtySerializers = ptySerializers;
  window.__ccTestPtyTerminals = ptyTerminals;
  window.__ccTestPtyLinkProviders = ptyLinkProviders;
}

declare global {
  interface Window {
    __ccTestPtySerializers?: Map<string, () => string>;
    __ccTestPtyTerminals?: Map<string, Terminal>;
    __ccTestPtyLinkProviders?: Map<string, ILinkProvider>;
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

export function registerPtyLinkProvider(
  sessionId: string,
  kind: PtyLinkKind,
  provider: ILinkProvider | null,
): void {
  if (!import.meta.env.DEV) return;
  const providers = window.__ccTestPtyLinkProviders;
  if (!providers) return;
  const key = `${sessionId}/${kind}`;
  if (provider) providers.set(key, provider);
  else providers.delete(key);
}
