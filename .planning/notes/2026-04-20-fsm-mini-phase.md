# FSM mini-phase 设计稿

**Date:** 2026-04-20
**Scope:** 新增 `apps/proxy/src/common/state-machine.ts`；只 migrate `terminal.ts` 的 `TerminalState`
**Non-goals:** SessionState / worker state 不动（等这轮跑完再判断 API 是否适配）；不引入 XState

## 为什么要做

CONCERNS.md L332-347 指出 `TerminalState` 8 处裸赋值、0 转换校验、无统一日志、无外部可观测通道。下游两个 HIGH 架构债（bridge state 第二维、reconnect spawn-budget 分桶）都依赖"可观测、可转移的状态"作为基建。不先落地 FSM，下游两项没有地方挂。

## API 形状

```typescript
// apps/proxy/src/common/state-machine.ts

export interface FSMDef<S extends string> {
  initial: S;
  // from-state → 允许转入的 to-state 列表
  transitions: Record<S, readonly S[]>;
  // 合法转换发生后触发，用于日志/观测，不应 throw
  onTransition?: (from: S, to: S) => void;
}

export interface FSM<S extends string> {
  current(): S;
  is(state: S): boolean;
  isIn(states: readonly S[]): boolean;
  canTransitionTo(to: S): boolean;
  // 非法转换抛 Error（bug 不该静默），调用方负责只在合法路径调用
  transitionTo(to: S): void;
}

export function createFSM<S extends string>(def: FSMDef<S>): FSM<S>;
```

预计 40-60 行实现 + 60-80 行单测，低于 CONCERNS.md 给的 80-120 上限。

### 设计取舍

- **为什么不是 XState**：2-3 个状态机的规模，XState 的 actor / context / event 模型是净负担。当 bridgeState 真的需要 actor-like 并发时再重评。
- **为什么 `transitionTo` 抛而不是返回 bool**：非法转换是 bug，不该可恢复。静默 no-op 会掩盖回归。
- **为什么没有 entry/exit actions**：当前 terminal.ts 的副作用都是内联控制流（clearInterval, socket.end, process.exit），塞进 FSM callback 会让"状态变迁"和"进程退出"耦合。先保持纯粹，需要时再加。
- **为什么不做 async transitions**：转换本身同步。async 编排（reconnect loop、ensureService 轮询）不是状态机的责任。
- **`onTransition` 不允许 throw**：如果 callback 抛异常会破坏状态机一致性。实现里不 try/catch（让 bug 立即暴露），但契约里写清楚 callback 只做日志/观测。

## Terminal.ts 迁移清单

当前 `terminal.ts` 的 8 处赋值 + 1 处读（CONCERNS.md L334 说 8 处，实际上 9 处）：

| 行号 | 当前 | 迁移后 |
|---|---|---|
| L124 | `let terminalState = TerminalState.INIT` | `const fsm = createFSM({ initial: INIT, transitions, onTransition })` |
| L125 | `terminalState = CONNECTING_SERVICE` | `fsm.transitionTo(CONNECTING_SERVICE)` |
| L184 | `terminalState !== RECONNECTING && terminalState !== EXITED` | `!fsm.isIn([RECONNECTING, EXITED])` |
| L185 | `terminalState = RECONNECTING` | `fsm.transitionTo(RECONNECTING)` |
| L227 | `terminalState = CREATING_SESSION` | `fsm.transitionTo(CREATING_SESSION)` |
| L242 | `terminalState = RUNNING` | `fsm.transitionTo(RUNNING)` |
| L246 | `terminalState = RUNNING` | `fsm.transitionTo(RUNNING)` |
| L261 | `terminalState = CREATING_SESSION` | `fsm.transitionTo(CREATING_SESSION)` |
| L334 | `terminalState = EXITED` | `fsm.transitionTo(EXITED)` |
| L353 | `terminalState = RUNNING` | `fsm.transitionTo(RUNNING)` |

### 转换表

```typescript
const TERMINAL_TRANSITIONS = {
  init: ["connecting_service"],
  connecting_service: ["creating_session", "exited"],
  creating_session: ["running", "reconnecting", "exited"],
  running: ["reconnecting", "exited"],
  reconnecting: ["creating_session", "running", "exited"],
  exited: [], // 终态
} as const;
```

- SIGTERM 可以在任意非 EXITED 状态转到 EXITED，这个要么在转换表里每行加 `"exited"`（已按此列），要么实现一个 `force` 逃生门。选前者，显式更好。
- RECONNECTING → RUNNING：sessionId 为空时的回落分支（L246）。

### onTransition

```typescript
const fsm = createFSM({
  initial: TerminalState.INIT,
  transitions: TERMINAL_TRANSITIONS,
  onTransition: (from, to) => log.info({ from, to }, "Terminal state transition"),
});
```

替换掉当前各处分散的 `log.info({...}, "Connected to existing service")` 等跟状态相关的日志。非状态相关的日志（如 "Remote input received"）保留原样。

## 顺手清的两处重复（同一 mini-phase，独立 commit）

CONCERNS.md L341 指出 `onSessionExit`（L333-346）和 SIGTERM handler（L357-368）的清理逻辑复制粘贴：

```typescript
if (idleCheckTimer) clearInterval(idleCheckTimer);
if (socket.writable && sessionId) {
  socket.end(serializeIpc({ type: "pty_deregister", sessionId }), () => {
    process.exit(code);
  });
} else {
  process.exit(code);
}
```

抽成 `cleanupAndExit(code: number): void` 内部 helper，两处都调。不是 FSM 职责，独立 commit。

## 测试策略

**新增 `state-machine.test.ts`** 覆盖：
- 合法转换 → `current()` 更新 + `onTransition` 被调用 `(from, to)`
- 非法转换 → throw，状态不变
- 终态的 transitions 为空 → 任何转换都抛
- `is() / isIn() / canTransitionTo()` 三个查询函数
- `onTransition` 可选（不传时不 crash）

**不新增 terminal.ts 测试**：现有 `terminal-data-flow.test.ts` 覆盖 tap 行为；FSM 是内部细节，外部行为不变。

**Smoke test**：本地起 proxy，跑一轮 `cc-anywhere` → reconnect → exit，看日志里的 state transition 序列是否完整。

## Commit 分拆（3 个）

1. **feat(common/state-machine): FSM helper (createFSM + onTransition)**
   只加 `state-machine.ts` + `state-machine.test.ts`，不动任何现有代码。
2. **refactor(terminal): TerminalState 走 FSM helper**
   替换 9 处赋值/读 + 移除各处分散的 state 日志，统一到 onTransition。
3. **refactor(terminal): cleanupAndExit 合并 onSessionExit 与 SIGTERM 重复**
   drive-by。

每个 commit 独立过 4 gate（format/lint/typecheck/knip）+ 474 测试。

## 风险 / 已知边界

- **非法转换抛异常可能在 SIGTERM 多次触发时炸**：当前 terminal 没有 SIGTERM 两次的处理；如果用户连按两次 Ctrl+C，第二次 SIGTERM 触发 EXITED→EXITED 会抛。需要在转换表里允许 `exited: ["exited"]` 做幂等，或在 SIGTERM handler 里 guard `if (!fsm.is(EXITED))`。选后者（更显式）。
- **后续 bridgeState 第二维要不要共用同一 FSM 实例**：不要。bridgeState 是正交维度（online/offline/unknown × running/reconnecting/...），应是第二个独立 FSM 实例，而不是把两维笛卡尔展开成一个巨型状态集。等下一 phase 做 bridgeState 时直接 `const bridgeFsm = createFSM(...)` 再加一个。

## 后续依赖

这个 mini-phase 完成后，下游两个 HIGH 债解锁：
- **bridgeState 第二维**：复用 `createFSM` 起第二个实例，暴露给 terminal 的 status line / stderr banner。
- **reconnect spawn-budget 分桶**：`consecutiveSpawnFailures` counter + 到达阈值时转到新状态 `DEGRADED`（只 tryConnect 不 spawn），也是 FSM 的自然建模。

两者都不在本 mini-phase 范围内。
