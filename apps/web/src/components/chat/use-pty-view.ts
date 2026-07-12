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
import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { createXtermTerminal } from "@/lib/create-xterm";
import { applyPtyFontSize } from "@/lib/pty-font-size-controller";
import { attachPtyDragSelectAutoscroll } from "@/lib/pty-drag-select-autoscroll";
import { attachXtermRawInput } from "@/lib/pty-input";
import { attachPtyResizeController } from "@/lib/pty-resize-controller";
import { attachPtyScrollController, type PtyScrollState } from "@/lib/pty-scroll-controller";
import { attachPtyTerminalController } from "@/lib/pty-terminal-controller";
import { registerImagePreviewLinkProvider } from "@/lib/xterm-image-preview-links";
import { registerFileDownloadLinkProvider } from "@/lib/xterm-file-download-links";
import { activateXtermLinkAtPoint, hasXtermLinkAtPoint } from "@/lib/xterm-touch-link-activation";
import { triggerFileDownload } from "@/lib/file-download-trigger";
import { uploadFileAndShowToast } from "@/lib/file-upload-payload";
import { toast } from "@/components/toast";
import { createRafScheduler } from "@/lib/raf-scheduler";
import type { RafScheduler } from "@/lib/raf-scheduler";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore, type InputModePreference } from "@/stores/app-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVisualViewportInsets } from "@/hooks/use-visual-viewport";
import { sendRemoteInputRaw } from "@/lib/ansi-keys";
import type { PtyScrollDebugProbe } from "@/lib/pty-scroll-debug-snapshot";
import {
  registerPtyDebugSnapshotProvider,
  registerPtyTerminalWindowAccessor,
  unregisterPtyDebugSnapshotProvider,
  unregisterPtyTerminalWindowAccessor,
} from "@/lib/pty-debug-snapshot";
import { buildPtyScrollDebugSnapshot } from "@/lib/pty-scroll-debug-snapshot";
import { serializeTerminalBuffer } from "@/lib/pty-serialize-buffer";
import { registerPtyLinkProvider, registerPtySerializer, registerPtyTerminal } from "@/test-hooks";
import { useImagePreview } from "./image-preview";
import { usePtyConnectionState } from "./use-pty-connection-state";
import { usePtyFocusState } from "./use-pty-focus-state";
import { usePtyFollowState } from "./use-pty-follow-state";
import {
  usePtySelectionController,
  type PtySelectionPathAction,
  type PtySelectionHandleKind,
  type PtySelectionHandleMetrics,
  type PtySelectionHandles,
} from "./use-pty-selection-controller";
import { usePtyScrollTraceEnabled } from "./use-pty-scroll-trace-enabled";
import { useTerminalPaste } from "./use-terminal-paste";

interface UsePtyViewOptions {
  sessionId: string;
  sessionKind?: "agent" | "terminal";
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
  softKeyboardEditingSurface: boolean;
  physicalKeyboardMode: boolean;
  keyboardOffset: number;
  mobileControlsBottomInset: number;
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
  ptySelectionPathAction: PtySelectionPathAction | null;
  ptySelectionHandleMetrics: PtySelectionHandleMetrics;
  copyPtySelection: () => void;
  openPtySelectionPathAction: () => void;
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
  preparePageResumeRestore: () => void;
  restorePageResume: () => void;
  scrollToRatio: (ratio: number) => void;
  scrollToXRatio: (ratio: number) => void;
  resetHorizontalScroll: (reason?: string) => void;
  markHorizontalScrollIntent: (reason?: string) => void;
  traceRawInputFollowScheduled: (source?: string) => void;
  traceRawInputFollowFire: () => void;
  getDebugProbe: () => PtyScrollDebugProbe;
}

interface TerminalControllerHandle {
  flushOutput: () => void;
  setOutputPaused: (value: boolean) => void;
}

interface MobilePtyControlsVisibilityInput {
  softKeyboardEditingSurface: boolean;
  ptyInputFocused: boolean;
  keyboardOpen: boolean;
}

interface PtyKeyboardFollowInput {
  controlsVisible: boolean;
  keyboardOpen: boolean;
  previous: {
    controlsVisible: boolean;
    keyboardOpen: boolean;
  };
}

interface PtyPhysicalKeyboardModeInput {
  inputModePreference: InputModePreference;
  detectedPhysicalKeyboard: boolean;
}

interface PhysicalKeyboardActivityInput {
  active: boolean;
  touchEditingSurface: boolean;
  key: string;
  code: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  targetAcceptsPtyInput?: boolean;
}

interface PtyContainerPaddingInput {
  showMobilePtyControls: boolean;
  horizontalScrollable: boolean;
}

const HARDWARE_KEYBOARD_CONTROL_KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Delete",
  "Home",
  "End",
]);

export function shouldShowMobilePtyControlsForState({
  softKeyboardEditingSurface,
  ptyInputFocused,
  keyboardOpen,
}: MobilePtyControlsVisibilityInput): boolean {
  return softKeyboardEditingSurface && ptyInputFocused && keyboardOpen;
}

export function shouldForcePtyKeyboardFollow({
  controlsVisible,
  keyboardOpen,
  previous,
}: PtyKeyboardFollowInput): boolean {
  if (!controlsVisible) return false;
  return !previous.controlsVisible || (keyboardOpen && !previous.keyboardOpen);
}

export function resolvePtyPhysicalKeyboardMode({
  inputModePreference,
  detectedPhysicalKeyboard,
}: PtyPhysicalKeyboardModeInput): boolean {
  if (inputModePreference === "hardware") return true;
  if (inputModePreference === "touch") return false;
  return detectedPhysicalKeyboard;
}

export function shouldTreatKeydownAsPhysicalKeyboardActivity({
  active,
  touchEditingSurface,
  key,
  code,
  altKey = false,
  ctrlKey = false,
  metaKey = false,
  isComposing = false,
  targetAcceptsPtyInput = true,
}: PhysicalKeyboardActivityInput): boolean {
  if (!active || !touchEditingSurface || !targetAcceptsPtyInput) return false;
  if (isComposing) return false;
  if (altKey || ctrlKey || metaKey) return false;
  if (!code || code === "Unidentified") return false;
  if (key.length === 1) return true;
  if (key === "Unidentified" || key === "Process" || key === "Dead") return false;
  return HARDWARE_KEYBOARD_CONTROL_KEYS.has(key);
}

const MOBILE_PTY_CONTROLS_PADDING_PX = 112;
const PHYSICAL_KEY_EVENT_CORRELATION_MS = 750;

export function resolvePtyContainerPaddingBottom({
  showMobilePtyControls,
  horizontalScrollable,
}: PtyContainerPaddingInput): number {
  if (showMobilePtyControls) return MOBILE_PTY_CONTROLS_PADDING_PX;
  return horizontalScrollable ? 32 : 8;
}

function rawInputForPhysicalKeyboardEvent(event: KeyboardEvent): string | null {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key.length === 1) return event.key;
  if (event.key === "Enter") return "\r";
  if (event.key === "Backspace") return "\x7f";
  if (event.key === "Tab") return event.shiftKey ? "\x1b[Z" : "\t";
  if (event.key === "Escape") return "\x1b";
  if (event.key === "ArrowUp") return "\x1b[A";
  if (event.key === "ArrowDown") return "\x1b[B";
  if (event.key === "ArrowRight") return "\x1b[C";
  if (event.key === "ArrowLeft") return "\x1b[D";
  if (event.key === "Delete") return "\x1b[3~";
  if (event.key === "Home") return "\x1b[H";
  if (event.key === "End") return "\x1b[F";
  return null;
}

export function usePtyView(options: UsePtyViewOptions): UsePtyViewResult {
  const {
    sessionId,
    sessionKind,
    ptyOwner,
    active = true,
    containerEl,
    spacerRef,
    xtermHostRef,
  } = options;

  // === sub-hooks (各自管自己的 state，互不依赖) ===
  const connection = usePtyConnectionState();
  const follow = usePtyFollowState();
  const traceEnabled = usePtyScrollTraceEnabled();
  const { openImagePreview } = useImagePreview();

  // === 私有 ref（仅供 hook 内部使用，不暴露给 JSX）===
  const terminalRef = useRef<Terminal | null>(null);
  const ptyTouchLinkProvidersRef = useRef<ILinkProvider[]>([]);
  const terminalControllerRef = useRef<TerminalControllerHandle | null>(null);
  const scrollControllerRef = useRef<ScrollControllerHandle | null>(null);
  const activeRef = useRef(active);
  const previousActiveRef = useRef(active);
  const readyRef = useRef(false);
  const pendingNewFrameRef = useRef(false);
  const userHasVerticalScrollIntentRef = useRef(false);
  const lastFrameWriteAtRef = useRef<number | null>(null);
  const relayoutSchedulerRef = useRef<RafScheduler | null>(null);
  const rawInputFollowSchedulerRef = useRef<RafScheduler | null>(null);
  const pendingRawInputFollowRef = useRef<{ reason: string; force: boolean } | null>(null);
  const keyboardFollowStateRef = useRef({ keyboardOpen: false, controlsVisible: false });
  const softKeyboardLayoutActiveRef = useRef(false);
  const softKeyboardOffsetRef = useRef(0);
  const physicalKeyboardModeRef = useRef(false);
  const lastPhysicalKeydownAtRef = useRef<number | null>(null);
  const ptySelectionActiveRef = useRef(false);
  const pageResumePendingRef = useRef(false);
  const pageResumeFrameRef = useRef<number | null>(null);
  const mobileLayoutDebugRef = useRef({
    keyboardOffset: 0,
    hasSeenSoftKeyboard: false,
    showMobilePtyControls: false,
    touchEditingSurface: false,
    ptyInputFocused: false,
    containerPaddingBottom: 0,
    mobileControlsBottomInset: 0,
  });
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
  const inputModePreference = useAppStore((s) => s.inputModePreference);
  const adaptiveInputModality = useAppStore((s) => s.adaptiveInputModality);
  const setAdaptiveInputModality = useAppStore((s) => s.setAdaptiveInputModality);
  const detectedPhysicalKeyboard = adaptiveInputModality === "hardware";
  const webOwnsPtyGeometry = ptyOwner === "proxy-hosted" || sessionKind === "terminal";
  const touchEditingSurface = useMediaQuery("(pointer: coarse), (hover: none)");
  const { bottomOffset: detectedKeyboardOffset, layoutBottomInset } = useVisualViewportInsets();
  const forceHardwareInput = inputModePreference === "hardware";
  const physicalKeyboardMode = resolvePtyPhysicalKeyboardMode({
    inputModePreference,
    detectedPhysicalKeyboard,
  });
  const softKeyboardEditingSurface = touchEditingSurface && !physicalKeyboardMode;
  const keyboardOffset = physicalKeyboardMode ? 0 : detectedKeyboardOffset;
  const keyboardOpen = keyboardOffset > 0;
  const mobileControlsBottomInset = physicalKeyboardMode ? 0 : layoutBottomInset;
  softKeyboardOffsetRef.current = detectedKeyboardOffset;
  physicalKeyboardModeRef.current = physicalKeyboardMode;

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
  const focus = usePtyFocusState({ containerEl, xtermHostRef, terminalRef });
  const {
    ptyInputFocused,
    suppressPtyFocus,
    focusPtyInput,
    handleFocusCapture,
    handleBlurCapture,
  } = focus;
  const showMobilePtyControls = shouldShowMobilePtyControlsForState({
    softKeyboardEditingSurface,
    ptyInputFocused,
    keyboardOpen,
  });
  softKeyboardLayoutActiveRef.current =
    softKeyboardEditingSurface && (showMobilePtyControls || keyboardOffset > 0);

  mobileLayoutDebugRef.current = {
    keyboardOffset,
    hasSeenSoftKeyboard,
    showMobilePtyControls,
    touchEditingSurface,
    ptyInputFocused,
    containerPaddingBottom: mobileLayoutDebugRef.current.containerPaddingBottom,
    mobileControlsBottomInset,
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

  const cancelPendingResumeFrame = useCallback((): void => {
    if (pageResumeFrameRef.current === null) return;
    cancelAnimationFrame(pageResumeFrameRef.current);
    pageResumeFrameRef.current = null;
  }, []);

  const rememberHiddenPtyState = useCallback((): void => {
    pageResumePendingRef.current = true;
    cancelPendingResumeFrame();
  }, [cancelPendingResumeFrame]);

  const scheduleResumeRestore = useCallback((): void => {
    if (!pageResumePendingRef.current || document.visibilityState === "hidden") return;
    scrollControllerRef.current?.preparePageResumeRestore();
    cancelPendingResumeFrame();
    pageResumeFrameRef.current = requestAnimationFrame(() => {
      pageResumeFrameRef.current = requestAnimationFrame(() => {
        pageResumeFrameRef.current = null;
        const scroll = scrollControllerRef.current;
        if (!scroll) return;
        scroll.restorePageResume();
        clearNewFramesWhileAway();
        pageResumePendingRef.current = false;
      });
    });
  }, [cancelPendingResumeFrame, clearNewFramesWhileAway]);

  useEffect(() => {
    return () => {
      relayoutSchedulerRef.current?.dispose();
      rawInputFollowSchedulerRef.current?.dispose();
      cancelPendingResumeFrame();
      relayoutSchedulerRef.current = null;
      rawInputFollowSchedulerRef.current = null;
    };
  }, [cancelPendingResumeFrame]);

  useEffect(() => {
    const rememberHiddenState = (): void => {
      rememberHiddenPtyState();
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
      cancelPendingResumeFrame();
    };
  }, [cancelPendingResumeFrame, rememberHiddenPtyState, scheduleResumeRestore]);

  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    if (wasActive === active) return;
    if (!active) {
      rememberHiddenPtyState();
      return;
    }
    scheduleResumeRestore();
  }, [active, rememberHiddenPtyState, scheduleResumeRestore]);

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

  const resumePtyOutputForLocalInput = useCallback((): void => {
    terminalControllerRef.current?.setOutputPaused(false);
    terminalControllerRef.current?.flushOutput();
  }, []);

  const resetHorizontalScrollAfterLineSubmit = useCallback((data: string, reason: string): void => {
    if (!data.includes("\r") && !data.includes("\n")) return;
    scrollControllerRef.current?.resetHorizontalScroll(reason);
  }, []);

  const getPtyPlainEnterBehavior = useCallback((): "submit" | "linefeed" => {
    return physicalKeyboardModeRef.current ? "submit" : "linefeed";
  }, []);

  const isPtyPhysicalKeyboardMode = useCallback((): boolean => {
    return physicalKeyboardModeRef.current;
  }, []);

  useEffect(() => {
    if (!active || inputModePreference !== "auto" || !touchEditingSurface) return;

    const targetAcceptsPtyInput = (target: EventTarget | null): boolean => {
      const host = xtermHostRef.current;
      const container = containerEl;
      if (!(target instanceof Node)) return target === window;
      if (host?.contains(target)) return true;
      if (target === document.body || target === document.documentElement) return true;
      if (!container?.contains(target)) return false;
      if (!(target instanceof HTMLElement)) return true;
      return (
        target.closest(
          'a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="textbox"]',
        ) === null
      );
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !shouldTreatKeydownAsPhysicalKeyboardActivity({
          active: activeRef.current,
          touchEditingSurface,
          key: event.key,
          code: event.code,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          isComposing: event.isComposing,
          targetAcceptsPtyInput: targetAcceptsPtyInput(event.target),
        })
      ) {
        return;
      }

      lastPhysicalKeydownAtRef.current = performance.now();
      setAdaptiveInputModality("hardware");
      physicalKeyboardModeRef.current = true;
      terminalRef.current?.focus();

      const host = xtermHostRef.current;
      if (event.target instanceof Node && host?.contains(event.target)) return;
      const raw = rawInputForPhysicalKeyboardEvent(event);
      if (!raw || !canAcceptInput()) return;
      event.preventDefault();
      event.stopPropagation();
      sendRemoteInputRaw(sessionId, raw);
      resumePtyOutputForLocalInput();
      scheduleRawInputFollow("physicalKeyboard");
      resetHorizontalScrollAfterLineSubmit(raw, "physicalKeyboardEnter");
    };

    const onBeforeInput = (event: InputEvent): void => {
      if (adaptiveInputModality !== "hardware") return;
      if (!targetAcceptsPtyInput(event.target) || softKeyboardOffsetRef.current <= 0) return;
      const lastPhysicalKeydownAt = lastPhysicalKeydownAtRef.current;
      if (
        lastPhysicalKeydownAt !== null &&
        performance.now() - lastPhysicalKeydownAt <= PHYSICAL_KEY_EVENT_CORRELATION_MS
      ) {
        return;
      }
      setAdaptiveInputModality("touch");
      physicalKeyboardModeRef.current = false;
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("beforeinput", onBeforeInput, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("beforeinput", onBeforeInput, true);
    };
  }, [
    active,
    adaptiveInputModality,
    canAcceptInput,
    containerEl,
    inputModePreference,
    resetHorizontalScrollAfterLineSubmit,
    resumePtyOutputForLocalInput,
    scheduleRawInputFollow,
    sessionId,
    setAdaptiveInputModality,
    touchEditingSurface,
    xtermHostRef,
  ]);

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
          if (result.ok) toast.success(`已开始下载 ${path}`, { id: toastId });
          else toast.error(result.error, { id: toastId });
        })
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : String(err), { id: toastId });
        });
    },
    [sessionId],
  );

  const handlePtyTap = useCallback((point: { clientX: number; clientY: number }): boolean => {
    const term = terminalRef.current;
    if (!term) return false;
    return activateXtermLinkAtPoint(term, ptyTouchLinkProvidersRef.current, point);
  }, []);

  const isPtyTapCandidate = useCallback((point: { clientX: number; clientY: number }): boolean => {
    const term = terminalRef.current;
    if (!term) return false;
    return hasXtermLinkAtPoint(term, ptyTouchLinkProvidersRef.current, point);
  }, []);

  const selection = usePtySelectionController({
    sessionId,
    terminalRef,
    xtermHostRef,
    scrollControllerRef,
    containerEl,
    scrollState,
    keyboardOffset,
    ptyFontSize,
    suppressPtyFocus,
    focusPtyInput,
    onTap: handlePtyTap,
    isTapCandidate: isPtyTapCandidate,
    onDownloadPath: downloadPtyPath,
    onPreviewPath: openImagePreview,
  });
  ptySelectionActiveRef.current = selection.ptySelectionHandles !== null;

  const handleTerminalPasteCapture = useTerminalPaste({
    sessionId,
    terminalRef,
    onAfterPaste: () => {
      resumePtyOutputForLocalInput();
      scheduleRawInputFollow("paste");
    },
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
      if (path) {
        sendRemoteInputRaw(sessionId, `@${path} `);
        resumePtyOutputForLocalInput();
        scheduleRawInputFollow("dropUpload");
      }
    },
    [canAcceptInput, resumePtyOutputForLocalInput, scheduleRawInputFollow, sessionId],
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

    const onRawInput = (data: string): void => {
      resumePtyOutputForLocalInput();
      scheduleRawInputFollow("rawInput");
      resetHorizontalScrollAfterLineSubmit(data, "rawInputEnter");
    };

    const termCtrl = attachPtyTerminalController({
      host,
      sessionId,
      ws,
      relay,
      // 软键盘场景进入会话时不自动聚焦 xterm helper textarea, 否则 Android/iOS 立刻起
      // IME 把视口压成一半, 用户还没看清当前 PTY 内容键盘已遮；强制实体键盘时保留 RAF auto-focus。
      // 用户想敲字仍可点 PTY 区域 (handleTerminalContainerMouseDown / pointerdown 都挂了
      // terminal.focus)。
      scheduleAutoFocus: softKeyboardEditingSurface ? () => {} : undefined,
      createTerminal: async (terminalHost) => {
        const result = await createXtermTerminal(terminalHost, {
          fontSize: useAppStore.getState().ptyFontSize,
        });
        return result;
      },
      attachRawInput: (term, rawSessionId, rawOptions) =>
        attachXtermRawInput(term, rawSessionId, {
          ...rawOptions,
          getPlainEnterBehavior: getPtyPlainEnterBehavior,
          isPhysicalKeyboardMode: isPtyPhysicalKeyboardMode,
          physicalKeyboardMode: forceHardwareInput,
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
        ptyTouchLinkProvidersRef.current = [
          imageLinkRegistration.provider,
          fileDownloadLinkRegistration.provider,
        ];
        registerPtySerializer(sessionId, () => serializeTerminalBuffer(xterm));
        registerPtyTerminal(sessionId, xterm);
        registerPtyTerminalWindowAccessor(() => terminalRef.current);

        const shouldRestorePageResumeOnAttach = pageResumePendingRef.current;
        if (shouldRestorePageResumeOnAttach) {
          userHasVerticalScrollIntentRef.current = false;
        }

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
          initialUserHasVerticalScrollIntent: shouldRestorePageResumeOnAttach
            ? false
            : userHasVerticalScrollIntentRef.current,
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
        if (shouldRestorePageResumeOnAttach) {
          scrollCtrl.restorePageResume();
          clearNewFramesWhileAway();
          pageResumePendingRef.current = false;
        }

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

        const dragSelect = attachPtyDragSelectAutoscroll({
          container,
          host,
          onHorizontalScrollIntent: (reason) =>
            scrollControllerRef.current?.markHorizontalScrollIntent(reason),
        });
        dragSelectDispose = dragSelect.dispose;

        if (webOwnsPtyGeometry) {
          const resizeCtrl = attachPtyResizeController({
            container,
            term: xterm,
            onResize: (cols, rows) => {
              relay.sendControl({ type: "terminal_resize_request", sessionId, cols, rows });
            },
            onRelayout: () => scrollControllerRef.current?.relayout(),
            preserveRows: () => softKeyboardLayoutActiveRef.current,
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
      scrollDispose?.();
      unregisterPtyDebugSnapshotProvider();
      imageLinkDispose?.();
      fileDownloadLinkDispose?.();
      registerPtyLinkProvider(sessionId, "image-preview", null);
      registerPtyLinkProvider(sessionId, "file-download", null);
      ptyTouchLinkProvidersRef.current = [];
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
    canAcceptInput,
    forceHardwareInput,
    getPtyPlainEnterBehavior,
    isPtyPhysicalKeyboardMode,
    downloadPtyPath,
    openImagePreview,
    suppressPtyFocus,
    scheduleRawInputFollow,
    resetHorizontalScrollAfterLineSubmit,
    resumePtyOutputForLocalInput,
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
    if (!active || !connection.ready || softKeyboardEditingSurface) return;
    const id = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [active, connection.ready, softKeyboardEditingSurface]);

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
      resetHorizontalScrollAfterLineSubmit(data, "mobileControlEnter");
      terminalRef.current?.focus();
    },
    [canAcceptInput, resetHorizontalScrollAfterLineSubmit, scheduleRawInputFollow, sessionId],
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
        const term = terminalRef.current;
        if (term) {
          // Let xterm apply bracketed paste mode and newline normalization, matching desktop paste.
          term.paste(text);
          return;
        }
        sendRemoteInputRaw(sessionId, text);
        resumePtyOutputForLocalInput();
        scheduleRawInputFollow("paste");
        resetHorizontalScrollAfterLineSubmit(text, "pasteEnter");
      })
      .catch((err: unknown) => {
        const message = err instanceof Error && err.message ? err.message : "无法读取剪贴板";
        toast.error(message);
      })
      .finally(() => terminalRef.current?.focus());
  }, [
    canAcceptInput,
    resetHorizontalScrollAfterLineSubmit,
    resumePtyOutputForLocalInput,
    scheduleRawInputFollow,
    sessionId,
  ]);

  // 移动端 PTY 控制条 2 行高: container py-1.5 (12) + 2 × h-11 (88) + grid gap-1 (4)
  // + border-t (1) ≈ 105px, 留 7px buffer 对齐 BackToBottom 7rem 偏移。
  const containerPaddingBottom = resolvePtyContainerPaddingBottom({
    showMobilePtyControls,
    horizontalScrollable: scrollState.horizontalScrollable,
  });
  mobileLayoutDebugRef.current.containerPaddingBottom = containerPaddingBottom;

  useEffect(() => {
    if (ptySelectionActiveRef.current) scrollControllerRef.current?.relayout();
    else relayoutSchedulerRef.current?.schedule();
    const previous = keyboardFollowStateRef.current;
    const shouldForceKeyboardFollow = shouldForcePtyKeyboardFollow({
      controlsVisible: showMobilePtyControls,
      keyboardOpen,
      previous,
    });
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
    keyboardOpen,
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
    keyboardOffset,
    physicalKeyboardMode,
    softKeyboardEditingSurface,
    mobileControlsBottomInset,
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
    ptySelectionPathAction: selection.ptySelectionPathAction,
    ptySelectionHandleMetrics: selection.ptySelectionHandleMetrics,
    copyPtySelection: selection.copyPtySelection,
    openPtySelectionPathAction: selection.openPtySelectionPathAction,
    handlePtySelectionHandlePointerDown: selection.handlePtySelectionHandlePointerDown,
    handlePtySelectionHandleTouchStart: selection.handlePtySelectionHandleTouchStart,
    isPtyDragOver,
    handlePtyDragOver,
    handlePtyDragLeave,
    handlePtyDrop,
  };
}
