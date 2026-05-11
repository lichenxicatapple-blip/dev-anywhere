// PTY 渲染层调试入口。挂在 window.__devAnywherePtyRenderDebug 上,开发者控制台直接调用。
//
// 当前嫌疑:webgl renderer 的 diff-only model 与 buffer 状态脱钩——某些 cell
// "以为没变"被跳过,留着上一帧的渲染。两步分流:
//   1. dumpRenderDiff() 复现时按一下,逐 cell 比 model.cells vs buffer.active。
//      mismatch 非 0 -> model desync 假设确认。
//   2. mismatch 为 0 但仍肉眼错位 -> setRenderer("dom") + reload 看 bug 是否消失,
//      区分 "WebGL 推送/着色阶段" 还是 "xterm 上游"。
//
// 故意不做成 React state:任何挂上 React 状态的开关都会污染 fast-refresh 与
// production build。这里只用 localStorage + 全局对象,刷新后保持选择。

import type { RenderDiffReport } from "./pty-render-state-probe";

const RENDERER_STORAGE_KEY = "dev_anywhere_pty_renderer";
const TRACE_STORAGE_KEY = "dev_anywhere_pty_trace";

export type PtyRendererKind = "webgl" | "dom";

const VALID_RENDERERS: readonly PtyRendererKind[] = ["webgl", "dom"];

interface ActiveTerminalHandle {
  // 读 webgl renderer 内部 model.cells 与 buffer.active 真实状态做逐 cell diff。
  // 见 pty-render-state-probe.ts。webgl addon 不可用 / probe 失败时返回 null。
  dumpRenderDiff?: () => RenderDiffReport | null;
  // 强清 webgl renderer 内部 model + 触发 refresh,把所有 cell 当成 dirty 全量重画。
  // 诊断工具:出现错位时按一下,屏幕修复 -> 坐实 diff-only model desync 假设。
  // 返回 true 表示成功执行,false 表示 webgl addon / probe 失败。
  clearRenderModel?: () => boolean;
}

interface PtyDebugApi {
  getRenderer(): PtyRendererKind;
  setRenderer(kind: PtyRendererKind): void;
  isTraceEnabled(): boolean;
  setTrace(enabled: boolean): void;
  registerTerminal(id: string, handle: ActiveTerminalHandle): () => void;
  // 触发所有已注册终端做 model vs buffer diff,把 mismatch 列表打到 console + 返回。
  // 用于复现错位时按一下,定位是 model desync 还是 GPU 推送层异常。
  dumpRenderDiff(): RenderDiffReport[];
  // 强清所有已注册终端的 webgl renderer model + refresh。
  // 诊断流程:复现 -> dumpRenderDiff() 看 mismatch -> clearRenderModel() 看是否
  // 修复 -> dumpRenderDiff() 再看一次确认 mismatch 归零。
  clearRenderModel(): number;
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
    // localStorage 不可用(隐身模式 / 异常 origin),按默认走
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
      // 写入失败也继续——下次刷新会回到默认,但当前 console 操作仍可见
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
  dumpRenderDiff() {
    const reports: RenderDiffReport[] = [];
    for (const [id, handle] of activeTerminals) {
      if (!handle.dumpRenderDiff) {
        console.info(`[ptyDebug] terminal ${id} has no render diff probe (DOM renderer?)`);
        continue;
      }
      try {
        const report = handle.dumpRenderDiff();
        if (!report) {
          console.warn(`[ptyDebug] terminal ${id} render diff probe failed`);
          continue;
        }
        reports.push(report);
        console.group(
          `[ptyDebug] render diff ${id}: ${report.mismatchCount}/${report.totalCells} mismatches, ${report.skippedCombined} combined skipped` +
            (report.truncated ? " (truncated)" : ""),
        );
        console.log(`viewportY=${report.viewportY} cols=${report.cols} rows=${report.rows}`);
        if (report.mismatches.length > 0) {
          console.table(report.mismatches.slice(0, 50));
        }
        console.groupEnd();
      } catch (err) {
        console.warn(`[ptyDebug] render diff ${id} threw`, err);
      }
    }
    return reports;
  },
  clearRenderModel() {
    let count = 0;
    for (const [id, handle] of activeTerminals) {
      if (!handle.clearRenderModel) {
        console.info(`[ptyDebug] terminal ${id} has no clear-model probe (DOM renderer?)`);
        continue;
      }
      try {
        if (handle.clearRenderModel()) count++;
      } catch (err) {
        console.warn(`[ptyDebug] clearRenderModel ${id} threw`, err);
      }
    }
    console.info(`[ptyDebug] cleared model on ${count} terminal(s)`);
    return count;
  },
  listTerminals() {
    return Array.from(activeTerminals.keys());
  },
};

declare global {
  var __devAnywherePtyRenderDebug: PtyDebugApi | undefined;
}

export function installPtyRenderDebug(): PtyDebugApi {
  if (typeof window !== "undefined" && !window.__devAnywherePtyRenderDebug) {
    window.__devAnywherePtyRenderDebug = debugApi;
    console.info(
      "[ptyDebug] installed. Try __devAnywherePtyRenderDebug.dumpRenderDiff() / .clearRenderModel() / .setRenderer('dom')",
    );
  }
  return debugApi;
}

export function getPtyDebug(): PtyDebugApi {
  return debugApi;
}
