import {
  attachPtySessionTransport,
  type PtyRelayLike,
  type PtyWebSocketLike,
} from "./pty-session-transport";
import type { PtyRenderTarget } from "./pty-recovery";

type Disposable = { dispose: () => void };

interface CreatedTerminal {
  terminal: PtyControlledTerminal;
  dispose: () => void;
}

interface PtyControlledTerminal extends PtyRenderTarget {
  focus: () => void;
  onData: (handler: (data: string) => void) => Disposable;
}

// 故意收窄到 controller 真正会用到的字段，避免把 PtySessionTransportOptions
// 的全部 13 个字段（retryDelayMs / scheduleFrameFlush / 各种 telemetry 钩子）
// 都泄露到 controller 接口表面。测试 mock 只需要满足这个最小契约。
type PtyTransportAttacher = (opts: {
  sessionId: string;
  ws: PtyWebSocketLike;
  relay: PtyRelayLike;
  target: PtyRenderTarget;
  onFramePending?: () => void;
  onFrameWritten?: () => void;
  onReady?: () => void;
  onSubscribeStarted?: () => void;
  onSubscribeDelayed?: () => void;
}) => {
  dispose: () => void;
  pause?: () => void;
  resume?: () => void;
};

interface PtyTerminalControllerOptions {
  host: HTMLDivElement;
  sessionId: string;
  ws: PtyWebSocketLike;
  relay: PtyRelayLike;
  createTerminal: (host: HTMLDivElement) => Promise<CreatedTerminal>;
  attachRawInput: (
    term: PtyControlledTerminal,
    sessionId: string,
    options?: { onRawInput?: (data: string) => void; isInputEnabled?: () => boolean },
  ) => Disposable;
  attachTransport?: PtyTransportAttacher;
  // 默认 requestAnimationFrame——首屏挂载完后下一帧 focus，让 xterm helper textarea 有时间附上。
  // 测试可注入同步调用避免依赖 fake timers。
  scheduleAutoFocus?: (callback: () => void) => void;
  onTerminalReady?: (term: PtyControlledTerminal) => void;
  onFramePending?: () => void;
  onFrameWritten?: () => void;
  onRawInput?: (data: string) => void;
  isInputEnabled?: () => boolean;
  canFocus?: () => boolean;
  onReady?: () => void;
  onSubscribeStarted?: () => void;
  onSubscribeDelayed?: () => void;
  connectTransportInitially?: boolean;
  // createTerminal 等异步初始化失败时的回调；调用方可借此弹 toast / 切错误态。
  // 不提供则错误仅记到 console.error，UI 静默无感知。
  onError?: (err: unknown) => void;
}

interface PtyTerminalController {
  dispose: () => void;
  setTransportActive: (active: boolean) => void;
}

export function attachPtyTerminalController(
  options: PtyTerminalControllerOptions,
): PtyTerminalController {
  const {
    host,
    sessionId,
    ws,
    relay,
    createTerminal,
    attachRawInput,
    attachTransport = attachPtySessionTransport,
    scheduleAutoFocus = (callback) => requestAnimationFrame(callback),
    onTerminalReady,
    onFramePending,
    onFrameWritten,
    onRawInput,
    isInputEnabled,
    canFocus = () => true,
    onReady,
    onSubscribeStarted,
    onSubscribeDelayed,
    connectTransportInitially = true,
    onError,
  } = options;

  let disposed = false;
  let disposeTerminal: (() => void) | null = null;
  let disposeRawInput: (() => void) | null = null;
  let transport: ReturnType<PtyTransportAttacher> | null = null;
  let terminal: PtyControlledTerminal | null = null;
  let transportDesiredActive = connectTransportInitially;
  let removeFocusHandler: (() => void) | null = null;

  const reconcileTransport = (): void => {
    if (disposed || !terminal) return;
    if (!transportDesiredActive) {
      if (transport?.pause) {
        transport.pause();
      } else {
        // Backward-compatible fallback for injected transports that only implement dispose.
        transport?.dispose();
        transport = null;
      }
      return;
    }
    if (transport) {
      transport.resume?.();
      return;
    }
    transport = attachTransport({
      sessionId,
      ws,
      relay,
      target: terminal,
      onFramePending,
      onFrameWritten,
      onReady,
      onSubscribeStarted,
      onSubscribeDelayed,
    });
  };

  void (async () => {
    try {
      const result = await createTerminal(host);
      if (disposed) {
        result.dispose();
        return;
      }

      disposeTerminal = result.dispose;
      terminal = result.terminal;
      disposeRawInput = attachRawInput(result.terminal, sessionId, {
        onRawInput,
        ...(isInputEnabled ? { isInputEnabled } : {}),
      }).dispose;

      const focusTerminal = (event?: PointerEvent): void => {
        // Cmd/Ctrl-click is a link action, not an intent to resume terminal input. Focusing
        // xterm's hidden textarea here can make the browser reveal the live cursor at the bottom.
        if (event?.metaKey || event?.ctrlKey) return;
        if (canFocus()) result.terminal.focus();
      };
      host.addEventListener("pointerdown", focusTerminal, { passive: true });
      removeFocusHandler = () => host.removeEventListener("pointerdown", focusTerminal);
      onTerminalReady?.(result.terminal);
      scheduleAutoFocus(() => {
        if (!disposed) focusTerminal();
      });

      reconcileTransport();
    } catch (err) {
      // createTerminal / attachTransport 抛出会让用户看到空白终端无任何提示。
      // 至少把错误抛给上层（toast / 错误态）+ 控制台，避免静默失败。
      console.error("[pty-terminal-controller] initialization failed", err);
      onError?.(err);
    }
  })();

  return {
    setTransportActive: (active) => {
      transportDesiredActive = active;
      reconcileTransport();
    },
    dispose: () => {
      disposed = true;
      transportDesiredActive = false;
      transport?.dispose();
      transport = null;
      removeFocusHandler?.();
      disposeRawInput?.();
      disposeTerminal?.();
      terminal = null;
    },
  };
}
