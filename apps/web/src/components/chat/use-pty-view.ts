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
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
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
import { toast } from "@/components/toast";
import { createRafScheduler } from "@/lib/raf-scheduler";
import type { RafScheduler } from "@/lib/raf-scheduler";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import type { PtyScrollDebugProbe } from "@/lib/pty-scroll-debug-snapshot";
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
import { useImagePreview } from "./image-preview";
import { usePtyConnectionState } from "./use-pty-connection-state";
import { usePtyFocusState } from "./use-pty-focus-state";
import { usePtyFollowState } from "./use-pty-follow-state";
import {
  usePtySelectionController,
  type PtySelectionHandleKind,
  type PtySelectionHandleMetrics,
  type PtySelectionHandles,
} from "./use-pty-selection-controller";
import { usePtyScrollTraceEnabled } from "./use-pty-scroll-trace-enabled";
import { useTerminalPaste } from "./use-terminal-paste";

interface UsePtyViewOptions {
  sessionId: string;
  ptyOwner?: "local-terminal" | "proxy-hosted";
  active?: boolean;
  containerEl: HTMLDivElement | null;
  spacerRef: RefObject<HTMLDivElement | null>;
  xtermHostRef: RefObject<HTMLDivElement | null>;
}

interface PointerHandlers {
  onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancelCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onTouchStartCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchMoveCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchEndCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchCancelCapture: (event: React.TouchEvent<HTMLDivElement>) => void;
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void;
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
  pasteMobileClipboard: () => void;
  handleTerminalContainerMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  handlePasteCapture: (event: ClipboardEvent<HTMLDivElement>) => void;
  pointerHandlers: PointerHandlers;
  focusHandlers: FocusHandlers;
  ptySelectionToolbar: { left: number; top: number } | null;
  ptySelectionHandles: PtySelectionHandles | null;
  ptySelectionDownloadPath: string | null;
  ptySelectionHandleMetrics: PtySelectionHandleMetrics;
  copyPtySelection: () => void;
  downloadPtySelection: () => void;
  handlePtySelectionHandlePointerDown: (
    kind: PtySelectionHandleKind,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  handlePtySelectionHandleTouchStart: (
    kind: PtySelectionHandleKind,
    event: ReactTouchEvent<HTMLElement>,
  ) => void;
  isPtyDragOver: boolean;
  handlePtyDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  handlePtyDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  handlePtyDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
}

interface ScrollControllerHandle {
  relayout: () => void;
  scrollToBottom: (reason?: string, opts?: { force?: boolean }) => void;
  restorePageResume: (opts: { wasFollowing: boolean }) => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  traceRawInputFollowScheduled: (source?: string) => void;
  traceRawInputFollowFire: () => void;
  getDebugProbe: () => PtyScrollDebugProbe;
}

interface TerminalControllerHandle {
  flushOutput: () => void;
  setOutputPaused: (value: boolean) => void;
}

export function usePtyView(options: UsePtyViewOptions): UsePtyViewResult {
  const { sessionId, ptyOwner, active = true, containerEl, spacerRef, xtermHostRef } = options;

  // === sub-hooks (各自管自己的 state，互不依赖) ===
  const connection = usePtyConnectionState();
  const follow = usePtyFollowState();
  const traceEnabled = usePtyScrollTraceEnabled();
  const { openImagePreview } = useImagePreview();

  // === 私有 ref（仅供 hook 内部使用，不暴露给 JSX）===
  const terminalRef = useRef<Terminal | null>(null);
  const terminalControllerRef = useRef<TerminalControllerHandle | null>(null);
  const scrollControllerRef = useRef<ScrollControllerHandle | null>(null);
  const activeRef = useRef(active);
  const readyRef = useRef(false);
  const pendingNewFrameRef = useRef(false);
  const userHasVerticalScrollIntentRef = useRef(false);
  const lastFrameWriteAtRef = useRef<number | null>(null);
  const relayoutSchedulerRef = useRef<RafScheduler | null>(null);
  const rawInputFollowSchedulerRef = useRef<RafScheduler | null>(null);
  const pendingRawInputFollowRef = useRef<{ reason: string; force: boolean } | null>(null);
  const keyboardFollowStateRef = useRef({ keyboardOpen: false, controlsVisible: false });
  const ptySelectionActiveRef = useRef(false);
  const pageResumePendingRef = useRef(false);
  const pageResumeWasFollowingRef = useRef(true);
  const pageResumeFrameRef = useRef<number | null>(null);
  const mobileLayoutDebugRef = useRef({
    keyboardOffset: 0,
    hasSeenSoftKeyboard: false,
    showMobilePtyControls: false,
    touchEditingSurface: false,
    ptyInputFocused: false,
    containerPaddingBottom: 0,
  });
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
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    readyRef.current = connection.ready;
  }, [connection.ready]);

  const canAcceptInput = useCallback((): boolean => {
    return activeRef.current && readyRef.current;
  }, []);

  useEffect(() => {
    if (keyboardOffset > 0) setHasSeenSoftKeyboard(true);
  }, [keyboardOffset]);
  const softKeyboardOpenOrUnknown = !hasSeenSoftKeyboard || keyboardOffset > 0;

  const focus = usePtyFocusState({ containerEl, xtermHostRef, terminalRef });
  const { ptyInputFocused, suppressPtyFocus, handleFocusCapture, handleBlurCapture } = focus;
  const showMobilePtyControls = touchEditingSurface && ptyInputFocused && softKeyboardOpenOrUnknown;

  mobileLayoutDebugRef.current = {
    keyboardOffset,
    hasSeenSoftKeyboard,
    showMobilePtyControls,
    touchEditingSurface,
    ptyInputFocused,
    containerPaddingBottom: mobileLayoutDebugRef.current.containerPaddingBottom,
  };

  const clearNewFramesWhileAway = follow.clearNewFramesWhileAway;

  // === scheduler（首次访问 lazy 创建，组件卸载时清理）===
  if (!relayoutSchedulerRef.current) {
    relayoutSchedulerRef.current = createRafScheduler(() => {
      scrollControllerRef.current?.relayout();
    });
  }
  if (!rawInputFollowSchedulerRef.current) {
    rawInputFollowSchedulerRef.current = createRafScheduler(() => {
      const pending = pendingRawInputFollowRef.current ?? { reason: "rawInput", force: false };
      pendingRawInputFollowRef.current = null;
      scrollControllerRef.current?.traceRawInputFollowFire();
      scrollControllerRef.current?.scrollToBottom(
        pending.reason,
        pending.force ? { force: true } : undefined,
      );
      clearNewFramesWhileAway();
    });
  }

  useEffect(() => {
    return () => {
      relayoutSchedulerRef.current?.dispose();
      rawInputFollowSchedulerRef.current?.dispose();
      if (pageResumeFrameRef.current !== null) {
        cancelAnimationFrame(pageResumeFrameRef.current);
        pageResumeFrameRef.current = null;
      }
      relayoutSchedulerRef.current = null;
      rawInputFollowSchedulerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cancelPendingFrame = (): void => {
      if (pageResumeFrameRef.current === null) return;
      cancelAnimationFrame(pageResumeFrameRef.current);
      pageResumeFrameRef.current = null;
    };

    const rememberHiddenState = (): void => {
      pageResumePendingRef.current = true;
      pageResumeWasFollowingRef.current = !userHasVerticalScrollIntentRef.current;
      cancelPendingFrame();
    };

    const scheduleResumeRestore = (): void => {
      if (!pageResumePendingRef.current || document.visibilityState === "hidden") return;
      const wasFollowing = pageResumeWasFollowingRef.current;
      cancelPendingFrame();
      pageResumeFrameRef.current = requestAnimationFrame(() => {
        pageResumeFrameRef.current = requestAnimationFrame(() => {
          pageResumeFrameRef.current = null;
          const scroll = scrollControllerRef.current;
          if (!scroll) return;
          scroll.restorePageResume({ wasFollowing });
          if (wasFollowing) clearNewFramesWhileAway();
          pageResumePendingRef.current = false;
        });
      });
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        rememberHiddenState();
        return;
      }
      scheduleResumeRestore();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", rememberHiddenState);
    window.addEventListener("pageshow", scheduleResumeRestore);
    window.addEventListener("focus", scheduleResumeRestore);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", rememberHiddenState);
      window.removeEventListener("pageshow", scheduleResumeRestore);
      window.removeEventListener("focus", scheduleResumeRestore);
      cancelPendingFrame();
    };
  }, [clearNewFramesWhileAway]);

  const scheduleRawInputFollow = useCallback(
    (source: string = "rawInput", opts?: { force?: boolean }): void => {
      const previous = pendingRawInputFollowRef.current;
      const force = previous?.force === true || opts?.force === true;
      pendingRawInputFollowRef.current = {
        reason: opts?.force === true || !previous ? source : previous.reason,
        force,
      };
      scrollControllerRef.current?.traceRawInputFollowScheduled(source);
      rawInputFollowSchedulerRef.current?.schedule();
    },
    [],
  );

  const downloadPtyPath = useCallback(
    (path: string): void => {
      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }
      const toastId = toast.loading(`下载 ${path} ...`);
      void triggerFileDownload({ relay, sessionId, path })
        .then((result) => {
          if (result.ok) toast.success(`已下载 ${path}`, { id: toastId });
          else toast.error(result.error, { id: toastId });
        })
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : String(err), { id: toastId });
        });
    },
    [sessionId],
  );

  const selection = usePtySelectionController({
    terminalRef,
    xtermHostRef,
    scrollControllerRef,
    containerEl,
    scrollState,
    keyboardOffset,
    ptyFontSize,
    suppressPtyFocus,
    onDownloadPath: downloadPtyPath,
  });
  ptySelectionActiveRef.current = selection.ptySelectionHandles !== null;

  const handleTerminalPasteCapture = useTerminalPaste({
    sessionId,
    terminalRef,
    onAfterPaste: () => scheduleRawInputFollow("paste"),
  });
  const handlePasteCapture = useCallback(
    (event: ClipboardEvent<HTMLDivElement>): void => {
      if (!canAcceptInput()) {
        event.preventDefault();
        return;
      }
      handleTerminalPasteCapture(event);
    },
    [canAcceptInput, handleTerminalPasteCapture],
  );

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
      if (!canAcceptInput()) return;
      const relay = relayClientRef;
      if (!relay) {
        toast.error("请先连接开发机");
        return;
      }
      const path = await uploadFileAndShowToast({ relay, sessionId, file });
      if (path) sendRemoteInputRaw(sessionId, `@${path} `);
    },
    [canAcceptInput, sessionId],
  );

  const handleTerminalContainerMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      if (!canAcceptInput()) {
        event.preventDefault();
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest(".xterm")) return;
      // 空白 spacer 区域不是 xterm DOM。浏览器默认 mousedown 会把焦点从 xterm
      // helper textarea 移到 body，导致后续方向键 / Enter 不再进入 PTY。
      event.preventDefault();
      terminalRef.current?.focus();
    },
    [canAcceptInput],
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
      scheduleRawInputFollow("rawInput");
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
      isInputEnabled: canAcceptInput,
      canFocus: canAcceptInput,
      onTerminalReady: (term) => {
        const xterm = term as Terminal;
        terminalRef.current = xterm;
        const imageLinkRegistration = registerImagePreviewLinkProvider(xterm, openImagePreview);
        imageLinkDispose = imageLinkRegistration.dispose;
        registerPtyLinkProvider(sessionId, "image-preview", imageLinkRegistration.provider);
        const fileDownloadLinkRegistration = registerFileDownloadLinkProvider(
          xterm,
          downloadPtyPath,
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
          onTouchBoundaryPrevent: suppressPtyFocus,
        });
        scrollControllerRef.current = scrollCtrl;
        scrollDispose = scrollCtrl.dispose;

        registerPtyDebugSnapshotProvider(() => {
          const rectOf = (el: Element | null) => {
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return {
              top: rect.top,
              bottom: rect.bottom,
              height: rect.height,
              left: rect.left,
              right: rect.right,
              width: rect.width,
            };
          };
          const controls = document.querySelector('[data-slot="pty-mobile-controls"]');
          const chatRoot = document.querySelector("[data-keyboard-offset]");
          const visualViewport = window.visualViewport;
          const controlsRect = rectOf(controls);
          const visualBottom = visualViewport?.height ?? window.innerHeight;
          return {
            ...buildPtyScrollDebugSnapshot(scrollCtrl.getDebugProbe, {
              container,
              spacer,
              host,
              term: xterm,
            }),
            mobileLayout: {
              ...mobileLayoutDebugRef.current,
              window: {
                innerHeight: window.innerHeight,
                outerHeight: window.outerHeight,
                documentClientHeight: document.documentElement.clientHeight,
              },
              visualViewport: visualViewport
                ? {
                    height: visualViewport.height,
                    width: visualViewport.width,
                    offsetTop: visualViewport.offsetTop,
                    pageTop: visualViewport.pageTop,
                    scale: visualViewport.scale,
                  }
                : null,
              chatRoot: {
                dataKeyboardOffset: chatRoot?.getAttribute("data-keyboard-offset") ?? null,
                rect: rectOf(chatRoot),
              },
              ptyViewRect: rectOf(container.parentElement),
              containerRect: rectOf(container),
              controlsRect,
              controlsOverflowBelowVisualViewport:
                controlsRect === null ? null : controlsRect.bottom - visualBottom,
              activeElement:
                document.activeElement instanceof HTMLElement
                  ? {
                      tag: document.activeElement.tagName,
                      ariaLabel: document.activeElement.getAttribute("aria-label"),
                      slot: document.activeElement
                        .closest("[data-slot]")
                        ?.getAttribute("data-slot"),
                    }
                  : null,
            },
            frame: {
              lastWriteAt: lastFrameWriteAtRef.current,
              pendingNewFrame: pendingNewFrameRef.current,
            },
          };
        });

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
    canAcceptInput,
    downloadPtyPath,
    openImagePreview,
    suppressPtyFocus,
    scheduleRawInputFollow,
    webOwnsPtyGeometry,
  ]);

  // === font-size effect：依赖 ptyFontSize 单独触发 ===
  useEffect(() => {
    const term = terminalRef.current;
    const scroll = scrollControllerRef.current;
    if (!term || !scroll) return;
    applyPtyFontSize(term, ptyFontSize, scroll.relayout);
  }, [ptyFontSize]);

  useEffect(() => {
    if (!active || !connection.ready || touchEditingSurface) return;
    const id = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [active, connection.ready, touchEditingSurface]);

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
      if (!canAcceptInput()) return;
      sendRemoteInputRaw(sessionId, data);
      scheduleRawInputFollow("mobileControl", { force: true });
      terminalRef.current?.focus();
    },
    [canAcceptInput, scheduleRawInputFollow, sessionId],
  );

  const pasteMobileClipboard = useCallback((): void => {
    if (!canAcceptInput()) return;
    const readText = navigator.clipboard?.readText?.bind(navigator.clipboard);
    if (!window.isSecureContext || !readText) {
      toast.error("无法读取剪贴板");
      terminalRef.current?.focus();
      return;
    }

    void readText()
      .then((text) => {
        if (!text) return;
        sendRemoteInputRaw(sessionId, text);
        scheduleRawInputFollow("paste");
      })
      .catch((err: unknown) => {
        const message = err instanceof Error && err.message ? err.message : "无法读取剪贴板";
        toast.error(message);
      })
      .finally(() => terminalRef.current?.focus());
  }, [canAcceptInput, scheduleRawInputFollow, sessionId]);

  // 移动端 PTY 控制条 2 行高: container py-1.5 (12) + 2 × h-11 (88) + grid gap-1 (4)
  // + border-t (1) ≈ 105px, 留 7px buffer 对齐 BackToBottom 7rem 偏移。
  const containerPaddingBottom = showMobilePtyControls
    ? 112
    : scrollState.horizontalScrollable
      ? 32
      : 8;
  mobileLayoutDebugRef.current.containerPaddingBottom = containerPaddingBottom;

  useEffect(() => {
    if (ptySelectionActiveRef.current) scrollControllerRef.current?.relayout();
    else relayoutSchedulerRef.current?.schedule();
    const keyboardOpen = keyboardOffset > 0;
    const previous = keyboardFollowStateRef.current;
    const shouldForceKeyboardFollow =
      showMobilePtyControls &&
      keyboardOpen &&
      (!previous.keyboardOpen || !previous.controlsVisible);
    keyboardFollowStateRef.current = {
      keyboardOpen,
      controlsVisible: showMobilePtyControls,
    };
    if (showMobilePtyControls) {
      if (ptySelectionActiveRef.current) {
        clearNewFramesWhileAway();
      } else if (shouldForceKeyboardFollow) {
        scrollControllerRef.current?.scrollToBottom("keyboardOffset", { force: true });
        clearNewFramesWhileAway();
      } else if (!keyboardOpen) {
        scheduleRawInputFollow("keyboardOffset");
      }
    }
  }, [
    keyboardOffset,
    showMobilePtyControls,
    containerPaddingBottom,
    clearNewFramesWhileAway,
    scheduleRawInputFollow,
  ]);

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
    pasteMobileClipboard,
    handleTerminalContainerMouseDown,
    handlePasteCapture,
    pointerHandlers: selection.pointerHandlers,
    focusHandlers,
    ptySelectionToolbar: selection.ptySelectionToolbar,
    ptySelectionHandles: selection.ptySelectionHandles,
    ptySelectionDownloadPath: selection.ptySelectionDownloadPath,
    ptySelectionHandleMetrics: selection.ptySelectionHandleMetrics,
    copyPtySelection: selection.copyPtySelection,
    downloadPtySelection: selection.downloadPtySelection,
    handlePtySelectionHandlePointerDown: selection.handlePtySelectionHandlePointerDown,
    handlePtySelectionHandleTouchStart: selection.handlePtySelectionHandleTouchStart,
    isPtyDragOver,
    handlePtyDragOver,
    handlePtyDragLeave,
    handlePtyDrop,
  };
}
