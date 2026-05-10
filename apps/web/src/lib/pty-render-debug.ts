// PTY 渲染层调试入口。挂在 window.__devAnywherePtyRenderDebug 上，开发者控制台直接调用。
//
// 主要面向两类问题：
//   1. CJK / 高频颜色场景下 xterm WebGL atlas 出现 cell 叠字（鼠标选中后正常） →
//      用 setRenderer("dom") 切回 DOM renderer 验证，是的话锁定 atlas 是嫌疑。
//   2. 渲染管线里 frame 顺序 / 重放 / dispose 之类不易复现的 bug →
//      setTrace(true) 打开 verbose log，bug 复现后 dumpState() 一键存证据。
//
// 故意不做成 React state：任何挂上 React 状态的开关都会污染 fast-refresh 与
// production build。这里只用 localStorage + 全局对象，刷新后保持选择。

const RENDERER_STORAGE_KEY = "dev_anywhere_pty_renderer";
const TRACE_STORAGE_KEY = "dev_anywhere_pty_trace";

export type PtyRendererKind = "webgl" | "dom";

const VALID_RENDERERS: readonly PtyRendererKind[] = ["webgl", "dom"];

interface ActiveTerminalHandle {
  // 调用 xterm 的 refresh(0, rows-1) 强制重绘整屏，绕过 atlas 缓存。
  refresh: () => void;
  // 取当前 xterm 屏幕完整 serialize 内容（含 ANSI），用来粘到 issue 里。
  serialize: () => string;
  // session/terminal 元信息，dump 时一并打印
  describe: () => Record<string, unknown>;
}

export interface PtyDebugApi {
  getRenderer(): PtyRendererKind;
  setRenderer(kind: PtyRendererKind): void;
  isTraceEnabled(): boolean;
  setTrace(enabled: boolean): void;
  registerTerminal(id: string, handle: ActiveTerminalHandle): () => void;
  forceRedraw(): number;
  dumpState(): void;
  listTerminals(): string[];
}

function readRenderer(): PtyRendererKind {
  if (typeof window === "undefined") return "webgl";
  try {
    const raw = window.localStorage.getItem(RENDERER_STORAGE_KEY);
    if (raw && (VALID_RENDERERS as readonly string[]).includes(raw)) {
      return raw as PtyRendererKind;
    }
  } catch {
    // localStorage 不可用（隐身模式 / 异常 origin），按默认走
  }
  return "webgl";
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

const debugApi: PtyDebugApi = {
  getRenderer: readRenderer,
  setRenderer(kind) {
    if (!(VALID_RENDERERS as readonly string[]).includes(kind)) {
      console.warn(`[ptyDebug] unknown renderer ${kind}; expected one of`, VALID_RENDERERS);
      return;
    }
    try {
      window.localStorage.setItem(RENDERER_STORAGE_KEY, kind);
    } catch {
      // 写入失败也继续——下次刷新会回到默认，但当前 console 操作仍可见
    }
    console.info(
      `[ptyDebug] renderer => ${kind}. Reload the page (or recreate the PTY view) for it to take effect.`,
    );
  },
  isTraceEnabled: readTrace,
  setTrace(enabled) {
    try {
      if (enabled) {
        window.localStorage.setItem(TRACE_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(TRACE_STORAGE_KEY);
      }
    } catch {
      // 同上
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
  forceRedraw() {
    let count = 0;
    for (const handle of activeTerminals.values()) {
      try {
        handle.refresh();
        count++;
      } catch (err) {
        console.warn("[ptyDebug] refresh failed", err);
      }
    }
    console.info(`[ptyDebug] forced redraw on ${count} terminal(s)`);
    return count;
  },
  dumpState() {
    const dumps: Array<{ id: string; meta: Record<string, unknown>; serialized: string }> = [];
    for (const [id, handle] of activeTerminals) {
      try {
        dumps.push({
          id,
          meta: handle.describe(),
          serialized: handle.serialize(),
        });
      } catch (err) {
        dumps.push({
          id,
          meta: { error: err instanceof Error ? err.message : String(err) },
          serialized: "",
        });
      }
    }
    console.groupCollapsed(`[ptyDebug] dump ${dumps.length} terminal(s)`);
    for (const dump of dumps) {
      console.groupCollapsed(`terminal ${dump.id}`);
      console.log(dump.meta);
      console.log(dump.serialized);
      console.groupEnd();
    }
    console.groupEnd();
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard
        .writeText(JSON.stringify(dumps, null, 2))
        .then(() => console.info("[ptyDebug] dump copied to clipboard"))
        .catch((err: unknown) => {
          console.warn("[ptyDebug] clipboard write failed", err);
        });
    }
  },
  listTerminals() {
    return Array.from(activeTerminals.keys());
  },
};

declare global {
  // eslint-disable-next-line no-var
  var __devAnywherePtyRenderDebug: PtyDebugApi | undefined;
}

export function installPtyRenderDebug(): PtyDebugApi {
  if (typeof window !== "undefined" && !window.__devAnywherePtyRenderDebug) {
    window.__devAnywherePtyRenderDebug = debugApi;
    console.info(
      "[ptyDebug] installed. Try __devAnywherePtyRenderDebug.setRenderer('dom') / __devAnywherePtyRenderDebug.forceRedraw() / __devAnywherePtyRenderDebug.dumpState()",
    );
  }
  return debugApi;
}

export function getPtyDebug(): PtyDebugApi {
  return debugApi;
}
