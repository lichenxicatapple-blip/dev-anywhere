// 鼠标拖拽选择文字时, 把光标拖到 PTY 容器边缘自动横向 / 纵向滚屏, 让选区可以
// 延伸到当前视窗外的内容。原生 terminal / 浏览器都有这个行为, xterm 内部不知道
// 我们外层套了一个可滚动 container, 所以自己实现:
//
//   1. 鼠标左键按下 (pointerType=mouse, button=0) 进入 drag-select 状态。
//   2. 每帧检查 pointer 是否落在 container 四边的 EDGE_PX 内, 落入即按"距离边缘越近
//      速度越快"线性插值修改 scrollLeft / scrollTop。
//   3. 仅在实际滚动那一帧给 host 派发一个 clientX/Y 不变的合成 mousemove,
//      让 xterm SelectionService 重算 cell-under-pointer 并把选区扩到新位置。
//      pointer 没动 + 不滚就不派发, 避免无害但密集的事件。
//   4. pointerup / pointercancel / 切到 touch 即停。

interface DragSelectOptions {
  container: HTMLElement;
  host: HTMLElement;
  edgePx?: number;
  maxSpeedPx?: number;
  // 测试注入: 默认 requestAnimationFrame / cancelAnimationFrame。jsdom 下走 setTimeout 桩。
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
}

// 暴露给 pty-render-debug.dumpDragSelectState 的诊断快照。
// dispatchTargetTag 区分: "xterm-screen" = 派发到 SelectionService 监听的元素;
// "host" = 没找到 .xterm-screen 走 fallback, 此时事件不冒泡到 SelectionService。
export interface DragSelectDebugSnapshot {
  dragging: boolean;
  pointerX: number;
  pointerY: number;
  dispatchCount: number;
  dispatchTargetTag: "xterm-screen" | "host" | "unknown";
  lastScrollDelta: { dx: number; dy: number } | null;
  lastDispatchedAt: number | null;
}

export interface DragSelectAutoscroll {
  dispose: () => void;
  getDebugSnapshot: () => DragSelectDebugSnapshot;
}

const DEFAULT_EDGE_PX = 28;
const DEFAULT_MAX_SPEED_PX = 14;

export function attachPtyDragSelectAutoscroll(opts: DragSelectOptions): DragSelectAutoscroll {
  const {
    container,
    host,
    edgePx = DEFAULT_EDGE_PX,
    maxSpeedPx = DEFAULT_MAX_SPEED_PX,
    requestFrame = (cb) => requestAnimationFrame(cb),
    cancelFrame = (id) => cancelAnimationFrame(id),
  } = opts;

  let dragging = false;
  let pointerX = 0;
  let pointerY = 0;
  // 这里手写 raf loop 而不是用 lib/raf-scheduler.ts: scheduler 是 debounce-once 语义
  // (多次 schedule 同一帧合并成一次), 这里需要的是连续帧 (tick 自己重排下一帧, 直到
  // pointerup 才停)。两种语义混到一个 API 里只会让 scheduler 更复杂。
  let frame: number | null = null;
  let dispatchCount = 0;
  let dispatchTargetTag: DragSelectDebugSnapshot["dispatchTargetTag"] = "unknown";
  let lastScrollDelta: DragSelectDebugSnapshot["lastScrollDelta"] = null;
  let lastDispatchedAt: number | null = null;

  // xterm SelectionService 把 mousemove listener 挂在 .xterm-screen 上, 那是 host
  // 的后代节点。dispatchEvent 只走 capture 向下 + bubble 向上, 在 host 派发的事件
  // 永远到不了 .xterm-screen, 选区不会扩。必须在 .xterm-screen 上派发。lazy 解析
  // 一次, attach 时 xterm 可能还没把 screen 渲出来。
  let cachedDispatchTarget: HTMLElement | null = null;
  const getDispatchTarget = (): HTMLElement => {
    if (cachedDispatchTarget && cachedDispatchTarget.isConnected) return cachedDispatchTarget;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    cachedDispatchTarget = screen ?? host;
    dispatchTargetTag = screen ? "xterm-screen" : "host";
    return cachedDispatchTarget;
  };

  const stop = (): void => {
    dragging = false;
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
  };

  const tick = (): void => {
    frame = null;
    if (!dragging) return;
    const rect = container.getBoundingClientRect();

    let dx = 0;
    const distLeft = pointerX - rect.left;
    const distRight = rect.right - pointerX;
    if (distLeft < edgePx && container.scrollLeft > 0) {
      const factor = Math.min(1, Math.max(0, 1 - distLeft / edgePx));
      dx = -Math.ceil(maxSpeedPx * factor);
    } else if (distRight < edgePx) {
      const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
      if (container.scrollLeft < maxScrollLeft) {
        const factor = Math.min(1, Math.max(0, 1 - distRight / edgePx));
        dx = Math.ceil(maxSpeedPx * factor);
      }
    }

    let dy = 0;
    const distTop = pointerY - rect.top;
    const distBottom = rect.bottom - pointerY;
    if (distTop < edgePx && container.scrollTop > 0) {
      const factor = Math.min(1, Math.max(0, 1 - distTop / edgePx));
      dy = -Math.ceil(maxSpeedPx * factor);
    } else if (distBottom < edgePx) {
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      if (container.scrollTop < maxScrollTop) {
        const factor = Math.min(1, Math.max(0, 1 - distBottom / edgePx));
        dy = Math.ceil(maxSpeedPx * factor);
      }
    }

    if (dx !== 0) container.scrollLeft += dx;
    if (dy !== 0) container.scrollTop += dy;

    if (dx !== 0 || dy !== 0) {
      // pointer 没动但 cell 下面的内容因为 scroll 改变了; 派发合成 mousemove
      // 让 xterm SelectionService 重算 cell-under-pointer 并扩选区。必须派发在
      // .xterm-screen 上 (xterm SelectionService listener 在该元素), 而不是父级 host。
      getDispatchTarget().dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: pointerX,
          clientY: pointerY,
          bubbles: true,
          cancelable: true,
        }),
      );
      dispatchCount += 1;
      lastScrollDelta = { dx, dy };
      lastDispatchedAt = Date.now();
    }

    frame = requestFrame(tick);
  };

  const onPointerDown = (event: PointerEvent): void => {
    // 仅处理鼠标左键拖拽。touch (pointerType=touch) / pen / 右键等不进入选区扩展模式,
    // 避免和移动端 usePtyTouchGesture 的滚动手势打架。
    if (event.pointerType !== "mouse") return;
    if (event.button !== 0) return;
    dragging = true;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (frame === null) frame = requestFrame(tick);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
  };

  // 监听 window: 用户拖出 container 后浏览器仍然把事件派给最初 capture 的元素,
  // 但用 window 兜底最稳, 不依赖 setPointerCapture (jsdom 不实现)。
  container.addEventListener("pointerdown", onPointerDown);
  globalThis.addEventListener?.("pointermove", onPointerMove);
  globalThis.addEventListener?.("pointerup", stop);
  globalThis.addEventListener?.("pointercancel", stop);
  globalThis.addEventListener?.("blur", stop);

  return {
    dispose() {
      stop();
      container.removeEventListener("pointerdown", onPointerDown);
      globalThis.removeEventListener?.("pointermove", onPointerMove);
      globalThis.removeEventListener?.("pointerup", stop);
      globalThis.removeEventListener?.("pointercancel", stop);
      globalThis.removeEventListener?.("blur", stop);
    },
    getDebugSnapshot(): DragSelectDebugSnapshot {
      return {
        dragging,
        pointerX,
        pointerY,
        dispatchCount,
        dispatchTargetTag,
        lastScrollDelta,
        lastDispatchedAt,
      };
    },
  };
}
