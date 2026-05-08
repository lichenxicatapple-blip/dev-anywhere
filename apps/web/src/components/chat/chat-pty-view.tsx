// PTY 模式保留 provider 原生 TUI，Web 只负责滚动和输入转发。
// 浏览器滚动容器映射到 xterm viewportY；当真实 PTY 屏幕比 Web 可视区矮时，
// scroll spacer 仍保证底部位置能映射到 xterm baseY，而不是伪造额外终端行。
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { Terminal } from "@xterm/xterm";
import { createXtermTerminal } from "@/lib/create-xterm";
import { applyPtyFontSize } from "@/lib/pty-font-size-controller";
import { attachXtermRawInput } from "@/lib/pty-input";
import { attachPtyResizeController } from "@/lib/pty-resize-controller";
import { attachPtyScrollController } from "@/lib/pty-scroll-controller";
import type { PtyScrollState } from "@/lib/pty-scroll-controller";
import { attachPtyTerminalController } from "@/lib/pty-terminal-controller";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { registerPtySerializer, registerPtyTerminal } from "@/test-hooks";
import { BackToBottom } from "./back-to-bottom";
import { PtyConnectionOverlay } from "./pty-connection-overlay";
import { PtyHorizontalScrollbar, PtyScrollbar } from "./pty-scrollbar";
import { usePtyConnectionState } from "./use-pty-connection-state";
import { usePtyFollowState } from "./use-pty-follow-state";

interface ChatPtyViewProps {
  sessionId: string;
  ptyOwner?: "local-terminal" | "proxy-hosted";
}

export function ChatPtyView({ sessionId, ptyOwner }: ChatPtyViewProps) {
  // containerEl 用 state 是为了让 scroll controller 在 DOM 挂载后初始化
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const xtermHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const relayoutPtyRef = useRef<() => void>(() => {});
  const scrollToBottomRef = useRef<() => void>(() => {});
  const scrollToRatioRef = useRef<(ratio: number) => void>(() => {});
  const scrollToXRatioRef = useRef<(ratio: number) => void>(() => {});
  const connection = usePtyConnectionState();
  const follow = usePtyFollowState();
  const clearNewFramesWhileAway = follow.clearNewFramesWhileAway;
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
  // xterm.onRender 会在用户 scroll 触发 ydisp 变化时也跑 (canvas 重绘),
  // 不做来源区分会把"scroll 触发的 render"误判为"新帧到达" → 红点虚亮 / scroll 被 follow 拉回.
  // 用 ref flag 标记 "真的有新帧到达", subscribeBinary 收到数据时 set, onRender 消费后清零.
  const pendingNewFrameRef = useRef(false);
  const userHasVerticalScrollIntentRef = useRef(false);
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const ptyFontSize = useAppStore((s) => s.ptyFontSize);
  const webOwnsPtyGeometry = ptyOwner === "proxy-hosted";

  function handleTerminalContainerMouseDown(event: MouseEvent<HTMLDivElement>): void {
    const target = event.target;
    if (target instanceof Element && target.closest(".xterm")) return;
    // 空白 spacer 区域不是 xterm DOM。浏览器默认 mousedown 会把焦点从
    // xterm helper textarea 移到 body，导致后续方向键/Enter 不再进入 PTY。
    event.preventDefault();
    terminalRef.current?.focus();
  }

  useEffect(() => {
    if (!connected || !proxyOnline) return;
    const host = xtermHostRef.current;
    const ws = wsManagerRef;
    const relay = relayClientRef;
    if (!host || !ws || !relay) return;
    const controller = attachPtyTerminalController({
      host,
      sessionId,
      ws,
      relay,
      createTerminal: (container) =>
        createXtermTerminal(container, { fontSize: useAppStore.getState().ptyFontSize }),
      attachRawInput: attachXtermRawInput,
      onTerminalReady: (term) => {
        terminalRef.current = term as Terminal;
        registerPtySerializer(sessionId, () => serializeTerminalBuffer(term as Terminal));
        registerPtyTerminal(sessionId, term as Terminal);
      },
      onFrameWritten: () => {
        pendingNewFrameRef.current = true;
        requestAnimationFrame(() => {
          relayoutPtyRef.current();
        });
      },
      onRawInput: () => {
        requestAnimationFrame(() => {
          scrollToBottomRef.current();
          clearNewFramesWhileAway();
        });
      },
      ...connection.transport,
    });

    return () => {
      controller.dispose();
      registerPtySerializer(sessionId, null);
      registerPtyTerminal(sessionId, null);
      terminalRef.current = null;
    };
  }, [
    sessionId,
    connected,
    proxyOnline,
    connection.retryNonce,
    connection.transport,
    clearNewFramesWhileAway,
  ]);

  useEffect(() => {
    if (!connection.ready) return;
    const container = containerEl;
    const spacer = spacerRef.current;
    const host = xtermHostRef.current;
    const term = terminalRef.current;
    if (!container || !spacer || !host || !term) return;

    const controller = attachPtyScrollController({
      container,
      spacer,
      host,
      term,
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
      },
    });
    relayoutPtyRef.current = controller.relayout;
    scrollToBottomRef.current = controller.scrollToBottom;
    scrollToRatioRef.current = controller.scrollToRatio;
    scrollToXRatioRef.current = controller.scrollToXRatio;
    return () => {
      controller.dispose();
      relayoutPtyRef.current = () => {};
      scrollToBottomRef.current = () => {};
      scrollToRatioRef.current = () => {};
      scrollToXRatioRef.current = () => {};
    };
  }, [
    connection.ready,
    containerEl,
    follow.handleAtBottomChange,
    follow.hasNewFramesWhileAwayRef,
    follow.setHasNewFramesWhileAway,
  ]);

  useEffect(() => {
    if (!connection.ready) return;
    const term = terminalRef.current;
    if (!term) return;

    applyPtyFontSize(term, ptyFontSize, () => relayoutPtyRef.current());
  }, [connection.ready, ptyFontSize]);

  useEffect(() => {
    if (!connection.ready || !webOwnsPtyGeometry) return;
    const container = containerEl;
    const term = terminalRef.current;
    const relay = relayClientRef;
    if (!container || !term || !relay) return;

    const controller = attachPtyResizeController({
      container,
      term,
      onResize: (cols, rows) => {
        relay.sendControl({ type: "terminal_resize_request", sessionId, cols, rows });
      },
      onRelayout: () => relayoutPtyRef.current(),
    });
    return () => controller.dispose();
  }, [connection.ready, webOwnsPtyGeometry, ptyFontSize, containerEl, sessionId]);

  return (
    <div className="flex flex-col h-full relative" data-slot="chat-pty-view">
      <div
        ref={setContainerEl}
        className="flex-1 min-h-0 overflow-auto overscroll-contain bg-[#1E1E1E] px-3 pt-2"
        style={{ paddingBottom: scrollState.horizontalScrollable ? 32 : 8 }}
        onMouseDownCapture={handleTerminalContainerMouseDown}
        data-slot="pty-terminal"
      >
        <div ref={spacerRef} style={{ position: "relative" }} data-slot="pty-spacer">
          <div
            ref={xtermHostRef}
            style={{
              position: "sticky",
              top: 0,
              overflow: "hidden",
              boxSizing: "border-box",
            }}
            data-slot="pty-host"
          />
        </div>
      </div>
      <BackToBottom
        visible={!follow.isAtBottom}
        hasNewMessages={follow.hasNewFramesWhileAway}
        onClick={() => {
          scrollToBottomRef.current();
          follow.clearNewFramesWhileAway();
        }}
      />
      <PtyScrollbar
        state={scrollState}
        onScrollRatio={(ratio) => scrollToRatioRef.current(ratio)}
      />
      <PtyHorizontalScrollbar
        state={scrollState}
        onScrollRatio={(ratio) => scrollToXRatioRef.current(ratio)}
      />
      <PtyConnectionOverlay {...connection.overlay} />
    </div>
  );
}

function serializeTerminalBuffer(term: Terminal): string {
  const activeBuffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < activeBuffer.length; i += 1) {
    lines.push(activeBuffer.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}
