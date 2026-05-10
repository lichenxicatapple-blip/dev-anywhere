// PTY 闲置检测：每 IDLE_CHECK_INTERVAL_MS 抽一次，发现自上次输出已超过 IDLE_THRESHOLD_MS
// 且当前局部状态仍是 working 时，把状态翻到 turn_complete 并触发 emit。
//
// 抽出来主要好处：terminal.ts / hosted-pty-registry.ts 都跑同样的 working→turn_complete
// 退化逻辑，未来若把 hosted 也接入这个 checker，就只剩一份实现。

interface IdleCheckerOptions {
  // 检测周期
  intervalMs: number;
  // 超过这个时长无新输出即触发 turn_complete
  thresholdMs: number;
  // 读取最近一次 PTY 输出时间戳；返回 0 表示已经走过 turn_complete 不要重复触发
  getLastOutputTime: () => number;
  // 用于"重置最近输出时间到 0"，保证下次再触发前必须有真实新输出
  setLastOutputTime: (value: number) => void;
  // 读当前局部 PTY 状态
  getCurrentState: () => "working" | "turn_complete" | "approval_wait" | "mid_pause";
  // 仅在 currentState === "working" 时触发；onIdle 内部决定具体怎么落地（emit IPC / 改 state）
  onIdle: () => void;
}

export interface IdleChecker {
  start(): void;
  stop(): void;
}

export function createIdleChecker(options: IdleCheckerOptions): IdleChecker {
  let timer: NodeJS.Timeout | null = null;

  const tick = (): void => {
    const last = options.getLastOutputTime();
    if (last <= 0) return;
    if (Date.now() - last <= options.thresholdMs) return;
    options.setLastOutputTime(0);
    if (options.getCurrentState() !== "working") return;
    options.onIdle();
  };

  return {
    start(): void {
      if (timer) clearInterval(timer);
      timer = setInterval(tick, options.intervalMs);
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
