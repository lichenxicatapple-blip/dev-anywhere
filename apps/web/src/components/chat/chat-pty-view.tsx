// PTY 模式 Chat 视图: 自包含 xterm + 内联 status 条 + follow-to-bottom
// 工具审批: PTY 模式不做结构化审批 UI (xterm 原生 TUI 已完成交互), 仅由 chat.tsx 顶部 hint bar 提示
// 滚动交由浏览器原生: 外层 .pty-terminal (overflow-auto) 做 scrollable, spacer 撑出 buffer.length*cellH,
// xterm 挂在 position:sticky 的 host. scroll 事件 -> term.scrollToLine(ydisp), term.onScroll -> 同步 scrollTop.
// canvas 比容器高时 (autoscale off 手机竖屏常见), sticky release 阶段自然暴露 canvas 底部, 代替老 pinBottom.
// 好处: touch/wheel/fling/momentum/edge bounce 全部走浏览器合成线程, 无 JS jank, 和原生 app 手感一致.
//
// 冷启动贴底: Claude Code TUI 纯 append 模式, 启动初期只画前 N 行, canvas 下半是 PTY 空白行.
// updateSpacer 扫出 canvasLastY, 给 host paddingTop = (rows-1-canvasLastY)*cellH 把 canvas 推到 host 底部,
// host overflow:hidden 裁掉 canvas 超出 host 底的空白部分. host.height 保持 rows*cellH 让 sticky release 机制照常工作.
// scrollTop=max 时 sticky release → host 底贴 container 底 → canvas 有效内容贴 container 底.
// 累积到 canvasLastY=rows-1 后 paddingTop=0, 回到原状态无任何视觉影响.
//
// follow 语义与 JSON 模式对齐: 在底时 onRender 自动 scrollTop=scrollHeight 追随;
// 离底时置 newFramesWhileAway 红点, 用户点按钮或自然滚回即清零.
import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { createXtermTerminal } from "@/lib/create-xterm";
import { attachPtyFitController } from "@/lib/pty-fit-controller";
import { attachXtermRawInput } from "@/lib/pty-input";
import { attachPtyResizeController } from "@/lib/pty-resize-controller";
import { attachPtyScrollController } from "@/lib/pty-scroll-controller";
import type { PtyScrollState } from "@/lib/pty-scroll-controller";
import { attachPtyTerminalController } from "@/lib/pty-terminal-controller";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
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
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const ptyAutoscale = useAppStore((s) => s.ptyAutoscale);
  const webOwnsPtyGeometry = ptyOwner === "proxy-hosted";
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
      createTerminal: createXtermTerminal,
      attachRawInput: attachXtermRawInput,
      onTerminalReady: (term) => {
        terminalRef.current = term as Terminal;
      },
      onFrameWritten: () => {
        pendingNewFrameRef.current = true;
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
    ptyAutoscale,
    containerEl,
    follow.handleAtBottomChange,
    follow.hasNewFramesWhileAwayRef,
    follow.setHasNewFramesWhileAway,
  ]);

  useEffect(() => {
    if (!connection.ready) return;
    const container = containerEl;
    const term = terminalRef.current;
    if (!container || !term) return;

    const controller = attachPtyFitController({
      container,
      term,
      enabled: ptyAutoscale,
      onRelayout: () => relayoutPtyRef.current(),
    });
    return () => controller.dispose();
  }, [connection.ready, ptyAutoscale, containerEl]);

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
  }, [connection.ready, webOwnsPtyGeometry, ptyAutoscale, containerEl, sessionId]);

  return (
    <div className="flex flex-col h-full relative" data-slot="chat-pty-view">
      <div
        ref={setContainerEl}
        className="flex-1 min-h-0 overflow-auto overscroll-contain bg-[#1E1E1E] px-3 pt-2"
        style={{ paddingBottom: scrollState.horizontalScrollable ? 32 : 8 }}
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
