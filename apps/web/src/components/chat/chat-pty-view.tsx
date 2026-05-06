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
import { attachXtermRawInput } from "@/lib/pty-input";
import { PtyRecoveryController } from "@/lib/pty-recovery";
import { attachPtyScrollController } from "@/lib/pty-scroll-controller";
import type { PtyScrollState } from "@/lib/pty-scroll-controller";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { BackToBottom } from "./back-to-bottom";
import { PtyScrollbar } from "./pty-scrollbar";

interface ChatPtyViewProps {
  sessionId: string;
}

export function ChatPtyView({ sessionId }: ChatPtyViewProps) {
  // containerEl 用 state 是为了让 scroll controller 在 DOM 挂载后初始化
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const xtermHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const scrollToBottomRef = useRef<() => void>(() => {});
  const scrollToRatioRef = useRef<(ratio: number) => void>(() => {});
  const [ready, setReady] = useState(false);
  const [showConnectingOverlay, setShowConnectingOverlay] = useState(false);
  const [subscribeExhausted, setSubscribeExhausted] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newFramesWhileAway, setNewFramesWhileAway] = useState(false);
  const [scrollState, setScrollState] = useState<PtyScrollState>({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollable: false,
  });
  const newFramesWhileAwayRef = useRef(newFramesWhileAway);
  useEffect(() => {
    newFramesWhileAwayRef.current = newFramesWhileAway;
  }, [newFramesWhileAway]);
  // xterm.onRender 会在用户 scroll 触发 ydisp 变化时也跑 (canvas 重绘),
  // 不做来源区分会把"scroll 触发的 render"误判为"新帧到达" → 红点虚亮 / scroll 被 follow 拉回.
  // 用 ref flag 标记 "真的有新帧到达", subscribeBinary 收到数据时 set, onRender 消费后清零.
  const pendingNewFrameRef = useRef(false);
  useEffect(() => {
    if (ready) {
      setShowConnectingOverlay(false);
      return;
    }
    const t = setTimeout(() => setShowConnectingOverlay(true), 300);
    return () => clearTimeout(t);
  }, [ready]);
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const ptyAutoscale = useAppStore((s) => s.ptyAutoscale);
  useEffect(() => {
    if (!connected || !proxyOnline) return;
    const host = xtermHostRef.current;
    if (!host) return;
    let disposeFn: (() => void) | null = null;
    let disposeRawInput: (() => void) | null = null;
    let removeFocusHandler: (() => void) | null = null;
    let unsubBinary: (() => void) | null = null;
    let unsubSnapshot: (() => void) | null = null;
    let cleanupRetry: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const result = await createXtermTerminal(host);
      if (cancelled) {
        result.dispose();
        return;
      }
      terminalRef.current = result.terminal;
      disposeFn = result.dispose;
      disposeRawInput = attachXtermRawInput(result.terminal, sessionId).dispose;

      const focusTerminal = (): void => result.terminal.focus();
      host.addEventListener("pointerdown", focusTerminal, { passive: true });
      removeFocusHandler = () => host.removeEventListener("pointerdown", focusTerminal);

      const recovery = new PtyRecoveryController();

      const ws = wsManagerRef;
      const relay = relayClientRef;
      if (!ws || !relay) return;

      unsubBinary = ws.subscribeBinary(sessionId, (data) => {
        const term = terminalRef.current;
        if (!term) return;
        const result = recovery.handleBinaryFrame(data, term);
        if (result.written) {
          pendingNewFrameRef.current = true;
        }
      });

      const RETRY_DELAY_MS = 3000;
      const MAX_RETRIES = 3;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let retryCount = 0;

      const clearRetry = (): void => {
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      };

      const requestSnapshot = (): void => {
        const requestId = recovery.startSnapshotRequest();
        ws.send(JSON.stringify({ type: "session_subscribe", sessionId, requestId }));
      };

      const scheduleSnapshotRetry = (): void => {
        requestSnapshot();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (cancelled || recovery.hasAppliedSnapshot()) return;
          if (retryCount >= MAX_RETRIES) {
            setSubscribeExhausted(true);
            return;
          }
          retryCount += 1;
          scheduleSnapshotRetry();
        }, RETRY_DELAY_MS);
      };

      const startSnapshotSubscribe = (): void => {
        if (cancelled) return;
        clearRetry();
        retryCount = 0;
        setSubscribeExhausted(false);
        scheduleSnapshotRetry();
      };

      unsubSnapshot = relay.onMessage((msg) => {
        const m = msg as Record<string, unknown>;
        if (m.sessionId !== sessionId) return;
        if (m.type === "terminal_resize") {
          terminalRef.current?.resize(m.cols as number, m.rows as number);
          startSnapshotSubscribe();
          return;
        }
        if (m.type !== "session_snapshot") return;
        const term = terminalRef.current;
        if (!term) return;
        const result = recovery.applySnapshot(
          {
            requestId: m.requestId as string | undefined,
            cols: m.cols as number,
            rows: m.rows as number,
            data: m.data as string,
          },
          term,
        );
        if (!result.applied) {
          return;
        }
        if (result.replayedFrames > 0) {
          pendingNewFrameRef.current = true;
        }
        clearRetry();
        requestAnimationFrame(() => {
          setReady(true);
          setSubscribeExhausted(false);
        });
      });

      startSnapshotSubscribe();

      cleanupRetry = clearRetry;
    })();

    return () => {
      cancelled = true;
      cleanupRetry?.();
      unsubBinary?.();
      unsubSnapshot?.();
      removeFocusHandler?.();
      disposeRawInput?.();
      disposeFn?.();
      terminalRef.current = null;
    };
  }, [sessionId, connected, proxyOnline, retryNonce]);

  useEffect(() => {
    if (!ready) return;
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
      hasNewFramesWhileAway: () => newFramesWhileAwayRef.current,
      setNewFramesWhileAway,
      onAtBottomChange: (value) => {
        setIsAtBottom(value);
        if (value) setNewFramesWhileAway(false);
      },
      onScrollStateChange: setScrollState,
    });
    scrollToBottomRef.current = controller.scrollToBottom;
    scrollToRatioRef.current = controller.scrollToRatio;
    return () => {
      controller.dispose();
      scrollToBottomRef.current = () => {};
      scrollToRatioRef.current = () => {};
    };
  }, [ready, ptyAutoscale, containerEl]);

  // autoscale fontSize: 按容器尺寸反推字号, 让 xterm 的 cell 铺满视口.
  // cols/rows 保持 snapshot 原值, 字号变会带动 cellH 变, 驱动 spacer 重算.
  useEffect(() => {
    if (!ready) return;
    const host = xtermHostRef.current;
    const container = containerEl;
    const term = terminalRef.current;
    if (!host || !container || !term) return;

    if (!ptyAutoscale) {
      if (term.options.fontSize !== 14) {
        term.options.fontSize = 14;
      }
      return;
    }

    const fit = (): void => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      const { cols, rows } = term;
      if (!w || !h || !cols || !rows) return;
      const byWidth = w / cols / 0.6;
      const byHeight = h / rows / 1.2;
      const next = Math.max(8, Math.min(16, Math.floor(Math.min(byWidth, byHeight))));
      if (term.options.fontSize !== next) {
        term.options.fontSize = next;
      }
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(container);
    return () => ro.disconnect();
  }, [ready, ptyAutoscale, containerEl]);

  return (
    <div className="flex flex-col h-full relative" data-slot="chat-pty-view">
      <div
        ref={setContainerEl}
        className="flex-1 min-h-0 overflow-auto overscroll-contain bg-[#1E1E1E]"
        data-slot="pty-terminal"
      >
        <div ref={spacerRef} style={{ position: "relative" }} data-slot="pty-spacer">
          <div
            ref={xtermHostRef}
            style={{
              position: "sticky",
              top: 0,
              left: 0,
              overflow: "hidden",
              boxSizing: "border-box",
            }}
            data-slot="pty-host"
          />
        </div>
      </div>
      <BackToBottom
        visible={!isAtBottom}
        hasNewMessages={newFramesWhileAway}
        onClick={() => {
          scrollToBottomRef.current();
          setNewFramesWhileAway(false);
        }}
      />
      <PtyScrollbar
        state={scrollState}
        onScrollRatio={(ratio) => scrollToRatioRef.current(ratio)}
      />
      {showConnectingOverlay && !subscribeExhausted && (
        <div
          className="absolute top-0 left-0 right-0 h-8 flex items-center justify-center bg-card/60 text-xs text-muted-foreground"
          data-slot="pty-connecting"
        >
          PTY 正在连接...
        </div>
      )}
      {subscribeExhausted && (
        <div
          className="absolute top-0 left-0 right-0 h-10 flex items-center justify-center gap-3 bg-destructive/10 text-xs text-destructive"
          data-slot="pty-subscribe-failed"
          role="alert"
        >
          <span>PTY 订阅未响应，请重试</span>
          <button
            type="button"
            onClick={() => {
              setReady(false);
              setSubscribeExhausted(false);
              setRetryNonce((n) => n + 1);
            }}
            className="rounded-sm border border-destructive/40 px-2 py-0.5 text-destructive hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
}
