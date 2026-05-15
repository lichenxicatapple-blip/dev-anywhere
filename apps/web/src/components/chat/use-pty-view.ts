// PTY 视图编排 hook：把 4 个 controller（terminal / scroll / resize / font-size）
// 的 bringup 顺序、命令式句柄、调试注册、image preview link provider 等横切关注点
// 集中到这里，让 chat-pty-view.tsx 退化为纯 JSX shell。
//
// 关键设计：单一 effect 在 attachPtyTerminalController 的 onTerminalReady 回调里
// 就近挂 scroll/resize/debug——typed handshake（term 直接作为入参传入），跨 effect
// 没有隐式 ref 协议。font-size effect 因为依赖 store 状态独立 trigger 单独保留。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from "react";
import type { Terminal } from "@xterm/xterm";
import { createXtermTerminal } from "@/lib/create-xterm";
import { applyPtyFontSize } from "@/lib/pty-font-size-controller";
import {
  attachPtyDragSelectAutoscroll,
  type DragSelectDebugSnapshot,
} from "@/lib/pty-drag-select-autoscroll";
import { attachXtermRawInput } from "@/lib/pty-input";
import { attachPtyResizeController } from "@/lib/pty-resize-controller";
import { attachPtyScrollController, type PtyScrollState } from "@/lib/pty-scroll-controller";
import { attachPtyTerminalController } from "@/lib/pty-terminal-controller";
import { registerImagePreviewLinkProvider } from "@/lib/xterm-image-preview-links";
import { registerFileDownloadLinkProvider } from "@/lib/xterm-file-download-links";
import { triggerFileDownload } from "@/lib/file-download-trigger";
import { uploadFileAndShowToast } from "@/lib/file-upload-payload";
import { createRafScheduler } from "@/lib/raf-scheduler";
import type { RafScheduler } from "@/lib/raf-scheduler";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import {
  registerPtyDebugSnapshotProvider,
  registerPtyTerminalWindowAccessor,
  unregisterPtyDebugSnapshotProvider,
  unregisterPtyTerminalWindowAccessor,
} from "@/lib/pty-debug-snapshot";
import { buildPtyScrollDebugSnapshot } from "@/lib/pty-scroll-debug-snapshot";
import { getPtyDebug } from "@/lib/pty-render-debug";
import {
  clearRenderModel,
  diffModelAgainstBuffer,
  probeWebglRenderModel,
} from "@/lib/pty-render-state-probe";
import { serializeTerminalBuffer } from "@/lib/pty-serialize-buffer";
import { registerPtyLinkProvider, registerPtySerializer, registerPtyTerminal } from "@/test-hooks";
import { toast } from "@/components/toast";
import { useImagePreview } from "./image-preview";
import { usePtyConnectionState } from "./use-pty-connection-state";
import { usePtyFocusState } from "./use-pty-focus-state";
import { usePtyFollowState } from "./use-pty-follow-state";
import { usePtyScrollTraceEnabled } from "./use-pty-scroll-trace-enabled";
import { usePtyTouchGesture } from "./use-pty-touch-gesture";
import { useTerminalPaste } from "./use-terminal-paste";

interface UsePtyViewOptions {
  sessionId: string;
  ptyOwner?: "local-terminal" | "proxy-hosted";
  containerEl: HTMLDivElement | null;
  spacerRef: RefObject<HTMLDivElement | null>;
  xtermHostRef: RefObject<HTMLDivElement | null>;
}

interface PointerHandlers {
  onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancelCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
}

interface FocusHandlers {
  onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => void;
  onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => void;
}

interface UsePtyViewResult {
  scrollState: PtyScrollState;
  isAtBottom: boolean;
  hasNewFramesWhileAway: boolean;
  ptyInputFocused: boolean;
  showMobilePtyControls: boolean;
  touchEditingSurface: boolean;
  connectionOverlay: { connecting: boolean; subscribeDelayed: boolean };
  containerPaddingBottom: number;
  traceEnabled: boolean;
  scrollToBottom: (reason?: string, opts?: { force?: boolean }) => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  clearNewFramesWhileAway: () => void;
  sendMobileInput: (data: string) => void;
  handleTerminalContainerMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  handlePasteCapture: (event: ClipboardEvent<HTMLDivElement>) => void;
  pointerHandlers: PointerHandlers;
  focusHandlers: FocusHandlers;
  isPtyDragOver: boolean;
  handlePtyDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  handlePtyDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  handlePtyDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
}

interface ScrollControllerHandle {
  relayout: () => void;
  scrollToBottom: (reason?: string, opts?: { force?: boolean }) => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
}

interface TerminalControllerHandle {
  flushOutput: () => void;
  setOutputPaused: (value: boolean) => void;
}

export function usePtyView(options: UsePtyViewOptions): UsePtyViewResult {
  const { sessionId, ptyOwner, containerEl, spacerRef, xtermHostRef } = options;

  // === sub-hooks (各自管自己的 state，互不依赖) ===
  const connection = usePtyConnectionState();
  const follow = usePtyFollowState();
  const traceEnabled = usePtyScrollTraceEnabled();
  const { openImagePreview } = useImagePreview();

  // === 私有 ref（仅供 hook 内部使用，不暴露给 JSX）===
  const terminalRef = useRef<Terminal | null>(null);
  const terminalControllerRef = useRef<TerminalControllerHandle | null>(null);
  const scrollControllerRef = useRef<ScrollControllerHandle | null>(null);
  const pendingNewFrameRef = useRef(false);
  const userHasVerticalScrollIntentRef = useRef(false);
  const lastFrameWriteAtRef = useRef<number | null>(null);
  const relayoutSchedulerRef = useRef<RafScheduler | null>(null);
  const rawInputFollowSchedulerRef = useRef<RafScheduler | null>(null);
  // attachPtyDragSelectAutoscroll 在 onTerminalReady 内部 attach 而 registerTerminal
  // 在它之前发生, 用 ref 把 snapshot 取数函数传给 debug API。
  const dragSelectSnapshotRef = useRef<(() => DragSelectDebugSnapshot) | null>(null);

  // === 视图层状态 ===
  const [scrollState, setScrollState] = useState<PtyScrollState>({
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientHeight: 0,
    clientWidth: 0,
    scrollable: false,
    horizontalScrollable: false,
  });
  const [hasSeenSoftKeyboard, setHasSeenSoftKeyboard] = useState(false);

  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const ptyFontSize = useAppStore((s) => s.ptyFontSize);
  const webOwnsPtyGeometry = ptyOwner === "proxy-hosted";
  const touchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const ptyPlainEnterBehavior = touchEditingSurface ? "linefeed" : "submit";
  const keyboardOffset = useVisualViewportBottomOffset();

  useEffect(() => {
    if (keyboardOffset > 0) setHasSeenSoftKeyboard(true);
  }, [keyboardOffset]);
  const softKeyboardOpenOrUnknown = !hasSeenSoftKeyboard || keyboardOffset > 0;

  const focus = usePtyFocusState({ containerEl, xtermHostRef, terminalRef });
  const { ptyInputFocused, suppressPtyFocus, handleFocusCapture, handleBlurCapture } = focus;
  const showMobilePtyControls = touchEditingSurface && ptyInputFocused && softKeyboardOpenOrUnknown;

  const clearNewFramesWhileAway = follow.clearNewFramesWhileAway;

  // === scheduler（首次访问 lazy 创建，组件卸载时清理）===
  if (!relayoutSchedulerRef.current) {
    relayoutSchedulerRef.current = createRafScheduler(() => {
      scrollControllerRef.current?.relayout();
    });
  }
  if (!rawInputFollowSchedulerRef.current) {
    rawInputFollowSchedulerRef.current = createRafScheduler(() => {
      scrollControllerRef.current?.scrollToBottom("rawInput");
      clearNewFramesWhileAway();
    });
  }

  useEffect(() => {
    return () => {
      relayoutSchedulerRef.current?.dispose();
      rawInputFollowSchedulerRef.current?.dispose();
      relayoutSchedulerRef.current = null;
      rawInputFollowSchedulerRef.current = null;
    };
  }, []);

  const touchGestureHandlers = usePtyTouchGesture({ terminalRef, suppressPtyFocus });

  const handlePasteCapture = useTerminalPaste({
    sessionId,
    terminalRef,
    onAfterPaste: () => rawInputFollowSchedulerRef.current?.schedule(),
  });

  // 拖拽任意文件到终端容器: 上传后把 "@<path> " 写到 PTY stdin, 与 chat-header
  // upload menu 同样形状。dragover 必须 preventDefault 否则浏览器拒绝触发 drop。
  const [isPtyDragOver, setIsPtyDragOver] = useState(false);
  const handlePtyDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsPtyDragOver((current) => (current ? current : true));
  }, []);
  const handlePtyDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsPtyDragOver(false);
  }, []);
  const handlePtyDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>): Promise<void> => {
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      event.preventDefault();
      setIsPtyDragOver(false);
      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }
      const path = await uploadFileAndShowToast({ relay, sessionId, file });
      if (path) sendRemoteInputRaw(sessionId, `@${path} `);
    },
    [sessionId],
  );

  const handleTerminalContainerMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(".xterm")) return;
      // 空白 spacer 区域不是 xterm DOM。浏览器默认 mousedown 会把焦点从 xterm
      // helper textarea 移到 body，导致后续方向键 / Enter 不再进入 PTY。
      event.preventDefault();
      terminalRef.current?.focus();
    },
    [],
  );

  // === controller graph：单 effect 编排 terminal / scroll / resize ===
  // attachPtyTerminalController 的 onTerminalReady 是 typed handshake：term 在 callback
  // 入参里直接给到，不再依赖 React 重渲染让下游 effect 通过 ref 读到。所有 terminal
  // 衍生 wiring（image link / debug 注册 / scroll-controller / resize-controller）
  // 都在这个 callback 内一并挂载。reconnect 时 termCtrl/scrollCtrl 一起重建——靠
  // userHasVerticalScrollIntentRef 跨周期保留用户回看意图，且 scroll-controller 内部
  // 对 wasAtBottom 的判定已修正（updateSpacer 之后再读 scrollHeight），不会因 spacer
  // 几何 stale 误判 atBottom 而清掉 intent。
  useEffect(() => {
    if (!connected || !proxyOnline) return;
    const host = xtermHostRef.current;
    const ws = wsManagerRef;
    const relay = relayClientRef;
    const container = containerEl;
    const spacer = spacerRef.current;
    if (!host || !ws || !relay || !container || !spacer) return;

    let imageLinkDispose: (() => void) | null = null;
    let fileDownloadLinkDispose: (() => void) | null = null;
    let ptyDebugDeregister: (() => void) | null = null;
    let scrollDispose: (() => void) | null = null;
    let resizeDispose: (() => void) | null = null;
    let dragSelectDispose: (() => void) | null = null;

    const onFramePending = (): void => {
      pendingNewFrameRef.current = true;
      if (userHasVerticalScrollIntentRef.current && !follow.hasNewFramesWhileAwayRef.current) {
        follow.setHasNewFramesWhileAway(true);
      }
    };

    const onFrameWritten = (): void => {
      lastFrameWriteAtRef.current = performance.now();
      relayoutSchedulerRef.current?.schedule();
    };

    const onRawInput = (): void => {
      rawInputFollowSchedulerRef.current?.schedule();
    };

    let getWebglAddon: (() => Parameters<typeof probeWebglRenderModel>[0] | null) | null = null;

    const termCtrl = attachPtyTerminalController({
      host,
      sessionId,
      ws,
      relay,
      // 触屏设备进入会话时不自动聚焦 xterm helper textarea, 否则 Android/iOS 立刻起 IME 把
      // 视口压成一半, 用户还没看清当前 PTY 内容键盘已遮; 桌面保留 RAF auto-focus。
      // 用户想敲字仍可点 PTY 区域 (handleTerminalContainerMouseDown / pointerdown 都挂了
      // terminal.focus)。
      scheduleAutoFocus: touchEditingSurface ? () => {} : undefined,
      createTerminal: async (terminalHost) => {
        const result = await createXtermTerminal(terminalHost, {
          fontSize: useAppStore.getState().ptyFontSize,
        });
        // 暴露给后续 onTerminalReady 注册 dumpRenderDiff——靠形状探测拿 model.cells。
        getWebglAddon = () => result.getWebglAddon();
        return result;
      },
      attachRawInput: (term, rawSessionId, rawOptions) =>
        attachXtermRawInput(term, rawSessionId, {
          ...rawOptions,
          plainEnterBehavior: ptyPlainEnterBehavior,
        }),
      onTerminalReady: (term) => {
        const xterm = term as Terminal;
        terminalRef.current = xterm;
        const imageLinkRegistration = registerImagePreviewLinkProvider(xterm, openImagePreview);
        imageLinkDispose = imageLinkRegistration.dispose;
        registerPtyLinkProvider(sessionId, "image-preview", imageLinkRegistration.provider);
        const fileDownloadLinkRegistration = registerFileDownloadLinkProvider(
          xterm,
          async (path) => {
            const toastId = toast.loading(`下载 ${path} ...`);
            try {
              const result = await triggerFileDownload({ relay, sessionId, path });
              if (result.ok) toast.success(`已下载 ${path}`, { id: toastId });
              else toast.error(result.error, { id: toastId });
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err), { id: toastId });
            }
          },
        );
        fileDownloadLinkDispose = fileDownloadLinkRegistration.dispose;
        registerPtyLinkProvider(sessionId, "file-download", fileDownloadLinkRegistration.provider);
        registerPtySerializer(sessionId, () => serializeTerminalBuffer(xterm));
        registerPtyTerminal(sessionId, xterm);
        registerPtyTerminalWindowAccessor(() => terminalRef.current);
        ptyDebugDeregister = getPtyDebug().registerTerminal(sessionId, {
          dumpRenderDiff: () => {
            const addon = getWebglAddon?.();
            if (!addon) return null;
            const probed = probeWebglRenderModel(addon, xterm.cols, xterm.rows);
            if (!probed) return null;
            return diffModelAgainstBuffer(xterm, probed);
          },
          clearRenderModel: () => {
            const addon = getWebglAddon?.();
            if (!addon) return false;
            const probed = probeWebglRenderModel(addon, xterm.cols, xterm.rows);
            if (!probed) return false;
            clearRenderModel(probed);
            xterm.refresh(0, xterm.rows - 1);
            return true;
          },
          getDragSelectSnapshot: () => dragSelectSnapshotRef.current?.() ?? null,
        });

        const scrollCtrl = attachPtyScrollController({
          container,
          spacer,
          host,
          term: xterm,
          hasNewFrame: () => pendingNewFrameRef.current,
          consumeNewFrame: () => {
            pendingNewFrameRef.current = false;
          },
          hasNewFramesWhileAway: () => follow.hasNewFramesWhileAwayRef.current,
          setNewFramesWhileAway: follow.setHasNewFramesWhileAway,
          onAtBottomChange: follow.handleAtBottomChange,
          onScrollStateChange: setScrollState,
          initialUserHasVerticalScrollIntent: userHasVerticalScrollIntentRef.current,
          onUserVerticalScrollIntentChange: (value) => {
            userHasVerticalScrollIntentRef.current = value;
            terminalControllerRef.current?.setOutputPaused(value);
            if (!value) terminalControllerRef.current?.flushOutput();
          },
          onTouchReviewStart: suppressPtyFocus,
        });
        scrollControllerRef.current = scrollCtrl;
        scrollDispose = scrollCtrl.dispose;

        registerPtyDebugSnapshotProvider(() => ({
          ...buildPtyScrollDebugSnapshot(scrollCtrl.getDebugProbe, {
            container,
            spacer,
            host,
            term: xterm,
          }),
          frame: {
            lastWriteAt: lastFrameWriteAtRef.current,
            pendingNewFrame: pendingNewFrameRef.current,
          },
        }));

        const dragSelect = attachPtyDragSelectAutoscroll({ container, host });
        dragSelectDispose = dragSelect.dispose;
        dragSelectSnapshotRef.current = dragSelect.getDebugSnapshot;

        if (webOwnsPtyGeometry) {
          const resizeCtrl = attachPtyResizeController({
            container,
            term: xterm,
            onResize: (cols, rows) => {
              relay.sendControl({ type: "terminal_resize_request", sessionId, cols, rows });
            },
            onRelayout: () => scrollControllerRef.current?.relayout(),
          });
          resizeDispose = resizeCtrl.dispose;
        }
      },
      onFramePending,
      onFrameWritten,
      onRawInput,
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`终端初始化失败：${message}`);
      },
      ...connection.transport,
    });
    terminalControllerRef.current = termCtrl;

    return () => {
      resizeDispose?.();
      dragSelectDispose?.();
      dragSelectSnapshotRef.current = null;
      scrollDispose?.();
      unregisterPtyDebugSnapshotProvider();
      imageLinkDispose?.();
      fileDownloadLinkDispose?.();
      registerPtyLinkProvider(sessionId, "image-preview", null);
      registerPtyLinkProvider(sessionId, "file-download", null);
      ptyDebugDeregister?.();
      registerPtySerializer(sessionId, null);
      registerPtyTerminal(sessionId, null);
      unregisterPtyTerminalWindowAccessor();
      termCtrl.dispose();
      terminalRef.current = null;
      scrollControllerRef.current = null;
      terminalControllerRef.current = null;
    };
    // 故意只列 follow.handleAtBottomChange / .hasNewFramesWhileAwayRef /
    // .setHasNewFramesWhileAway 三个子字段而不是整个 follow 对象。
    //
    // usePtyFollowState 每次都返回一个新对象字面量, follow 的 === 引用每次父级
    // re-render 都不相等; 真把 follow 列进 deps 会让本 effect 每次父 render 都
    // tear down + rebuild xterm Terminal / scroll-controller / resize-controller,
    // 极贵且闪屏。
    //
    // 子字段反过来是 useCallback / RefObject / useState setter, React 保证引用
    // 稳定, 列子字段才是真正的"effect 何时该重跑"。lint 规则机械化, 不识别这种
    // sub-field stability 模式, 因此 disable。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionId,
    connected,
    proxyOnline,
    containerEl,
    spacerRef,
    xtermHostRef,
    connection.transport,
    follow.handleAtBottomChange,
    follow.hasNewFramesWhileAwayRef,
    follow.setHasNewFramesWhileAway,
    ptyPlainEnterBehavior,
    openImagePreview,
    suppressPtyFocus,
    webOwnsPtyGeometry,
  ]);

  // === font-size effect：依赖 ptyFontSize 单独触发 ===
  useEffect(() => {
    const term = terminalRef.current;
    const scroll = scrollControllerRef.current;
    if (!term || !scroll) return;
    applyPtyFontSize(term, ptyFontSize, scroll.relayout);
  }, [ptyFontSize]);

  // === 暴露给 JSX 的命令式句柄（稳定 useCallback，内部读 ref 拿当前 controller）===
  // reason 默认 "viewExternal" — 当 BackToBottom 按钮等明确入口外调时, caller 可传具体 label。
  const scrollToBottom = useCallback(
    (reason: string = "viewExternal", opts?: { force?: boolean }): void => {
      scrollControllerRef.current?.scrollToBottom(reason, opts);
    },
    [],
  );
  const scrollToRatio = useCallback((ratio: number): void => {
    scrollControllerRef.current?.scrollToRatio(ratio);
  }, []);
  const scrollToXRatio = useCallback((ratio: number): void => {
    scrollControllerRef.current?.scrollToXRatio(ratio);
  }, []);

  const sendMobileInput = useCallback(
    (data: string): void => {
      sendRemoteInputRaw(sessionId, data);
      rawInputFollowSchedulerRef.current?.schedule();
      terminalRef.current?.focus();
    },
    [sessionId],
  );

  // 移动端 PTY 控制条 2 行高: container py-1.5 (12) + 2 × h-11 (88) + grid gap-1 (4)
  // + border-t (1) ≈ 105px, 留 7px buffer 对齐 BackToBottom 7rem 偏移。
  const containerPaddingBottom = showMobilePtyControls
    ? 112
    : scrollState.horizontalScrollable
      ? 32
      : 8;

  useEffect(() => {
    relayoutSchedulerRef.current?.schedule();
    if (showMobilePtyControls) {
      rawInputFollowSchedulerRef.current?.schedule();
    }
  }, [keyboardOffset, showMobilePtyControls, containerPaddingBottom]);

  const focusHandlers = useMemo<FocusHandlers>(
    () => ({
      onFocusCapture: handleFocusCapture,
      onBlurCapture: handleBlurCapture,
    }),
    [handleFocusCapture, handleBlurCapture],
  );

  return {
    scrollState,
    isAtBottom: follow.isAtBottom,
    hasNewFramesWhileAway: follow.hasNewFramesWhileAway,
    ptyInputFocused,
    showMobilePtyControls,
    touchEditingSurface,
    connectionOverlay: connection.overlay,
    containerPaddingBottom,
    traceEnabled,
    scrollToBottom,
    scrollToRatio,
    scrollToXRatio,
    clearNewFramesWhileAway,
    sendMobileInput,
    handleTerminalContainerMouseDown,
    handlePasteCapture,
    pointerHandlers: touchGestureHandlers,
    focusHandlers,
    isPtyDragOver,
    handlePtyDragOver,
    handlePtyDragLeave,
    handlePtyDrop,
  };
}
