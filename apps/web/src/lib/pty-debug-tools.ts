// PTY 调试入口。挂在 window.__devAnywherePtyDebugTools 上,开发者控制台直接调用。

import type { DragSelectDebugSnapshot } from "./pty-drag-select-autoscroll";

const TRACE_STORAGE_KEY = "dev_anywhere_pty_trace";

interface ActiveTerminalHandle {
  getDragSelectSnapshot?: () => DragSelectDebugSnapshot | null;
}

interface PtyDebugToolsApi {
  isTraceEnabled(): boolean;
  setTrace(enabled: boolean): void;
  registerTerminal(id: string, handle: ActiveTerminalHandle): () => void;
  // 拖右边缘时容器滚了但选区没扩 -> 拿这个分流:
  //   dispatchCount=0 -> autoscroll 模块没派发,排查 pointer / dragging 状态
  //   dispatchCount>0 + tag=host -> .xterm-screen 没找到,派发不到 SelectionService
  //   dispatchCount>0 + tag=xterm-screen -> 派发到位,xterm SelectionService 没扩
  dumpDragSelectState(): Array<{ id: string; snapshot: DragSelectDebugSnapshot }>;
  listTerminals(): string[];
}

function readTrace(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TRACE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const activeTerminals = new Map<string, ActiveTerminalHandle>();

const debugToolsApi: PtyDebugToolsApi = {
  isTraceEnabled: readTrace,
  setTrace(enabled) {
    try {
      if (enabled) {
        window.localStorage.setItem(TRACE_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(TRACE_STORAGE_KEY);
      }
    } catch {
      // localStorage 不可用时只影响持久化，不影响本次运行。
    }
    console.info(`[ptyDebug] trace ${enabled ? "ON" : "OFF"}`);
  },
  registerTerminal(id, handle) {
    activeTerminals.set(id, handle);
    return () => {
      const current = activeTerminals.get(id);
      if (current === handle) activeTerminals.delete(id);
    };
  },
  dumpDragSelectState() {
    const out: Array<{ id: string; snapshot: DragSelectDebugSnapshot }> = [];
    for (const [id, handle] of activeTerminals) {
      const snapshot = handle.getDragSelectSnapshot?.();
      if (!snapshot) continue;
      out.push({ id, snapshot });
    }
    console.group(`[ptyDebug] drag-select snapshots (${out.length})`);
    for (const { id, snapshot } of out) {
      console.log(id, snapshot);
    }
    console.groupEnd();
    return out;
  },
  listTerminals() {
    return Array.from(activeTerminals.keys());
  },
};

declare global {
  var __devAnywherePtyDebugTools: PtyDebugToolsApi | undefined;
}

export function installPtyDebugTools(): PtyDebugToolsApi {
  if (typeof window !== "undefined" && !window.__devAnywherePtyDebugTools) {
    window.__devAnywherePtyDebugTools = debugToolsApi;
    console.info("[ptyDebug] installed. Try __devAnywherePtyDebugTools.dumpDragSelectState()");
  }
  return debugToolsApi;
}

export function getPtyDebugTools(): PtyDebugToolsApi {
  return debugToolsApi;
}
