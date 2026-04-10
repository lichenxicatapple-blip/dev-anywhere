# Test Suite Cleanup Plan

> Created: 2026-04-09
> Status: pending
> Trigger: 516 tests / 35 files 全绿，但审计发现大量注水、重复、关键路径裸奔

## Problem Statement

测试体系呈现"虚假繁荣"：数量膨胀但安全网有洞。

| 指标 | 现状 |
|------|------|
| 测试文件 | 35 |
| 测试用例 | 516 |
| 语句覆盖率 | 83.5% |
| 注水用例（估算） | ~120-150 |
| control-messages.ts 覆盖率 | **9.7%**（serve 核心消息路由） |
| frame-pusher.ts 直接测试 | **0%**（terminal + replay-e2e 共用模块） |
| terminal-frame-renderer.ts 覆盖率 | **59.7%**（手机端核心场景未覆盖） |
| ipc-protocol.ts worker 路径覆盖率 | **0%**（approval 流程） |

## Phase 1: Delete (pure waste)

### 1.1 Delete `send-pty-snapshot.test.ts`
- **Path**: `apps/proxy/src/__tests__/send-pty-snapshot.test.ts`
- **Reason**: Empty placeholder `it("placeholder - file scheduled for deletion", () => {})`
- **Impact**: -1 test, -1 file

### 1.2 Delete `message-queue.test.ts`
- **Path**: `apps/proxy/src/__tests__/message-queue.test.ts`
- **Reason**: 5 tests verifying array push/pop/length. `MemoryMessageQueue` is a trivial array wrapper with zero conditional logic. These tests assert JS array semantics, not business behavior.
- **Impact**: -5 tests, -1 file

### 1.3 Delete `session-resume.test.ts`
- **Path**: `apps/proxy/src/__tests__/session-resume.test.ts`
- **Reason**: 
  - 9 "source-code grep" tests: `readFileSync("../serve.ts")` then `expect(source).toContain("tool_approve")`. Tests source text, not runtime behavior. Code moves to a different function? Still passes. Logic breaks? Still passes.
  - 3 WorkerMessage schema enumeration tests: redundant with ipc-protocol.test.ts
- **Impact**: -12 tests, -1 file

### 1.4 Trim `tool-approval.test.ts` ToolWhitelist block
- **Path**: `apps/proxy/src/__tests__/tool-approval.test.ts` L65-91
- **Reason**: L65 ("auto-approves when in whitelist") and L76 ("addToWhitelist causes auto-approve") are identical tests on `Set.add + Set.has`. Keep L71 (not-in-whitelist) and L83 (clear).
- **Impact**: -2 tests

**Phase 1 total: -20 tests, -3 files**

---

## Phase 2: Consolidate (eliminate duplication)

### 2a. Terminal test files: 3 files → 1 file

**Files involved:**
- `apps/proxy/src/__tests__/terminal-tracker.test.ts` (6 tests) — **DELETE**
- `apps/proxy/src/__tests__/terminal-grid.test.ts` (11+6=17 tests) — **DELETE**
- `apps/proxy/src/__tests__/terminal-data-flow.test.ts` (18 tests) — **KEEP as target**

**Duplication evidence:**

| Behavior | tracker | grid | data-flow | Action |
|----------|---------|------|-----------|--------|
| hasGridChanged true | L38 | L98 | L88 (within 5fps test) | Keep data-flow |
| hasGridChanged false | L45 | L104 | L101 (within 5fps test) | Keep data-flow |
| ANSI fg color | L22 (partial) | L40 | L42 | Keep data-flow |
| ANSI bg color | — | L62 | — | Merge into data-flow |
| bold attribute | L22 (partial) | L53 | L56 | Keep data-flow |
| lineId stability | — | L165 | L182 | Keep data-flow |
| scrollback 10000 | L51 | — | L239 | Keep data-flow |
| extractLines evicted | — | L144 | L234 | Keep data-flow |
| CJK wide chars | — | L82 | — | **Migrate** to data-flow |
| span merging | — | L27 | — | **Migrate** to data-flow |
| resize | L31 | — | — | Drop (trivial) |
| SeqCounter smoke | — | — | L269 | Keep |

**Action:**
1. Migrate CJK wide char test and span merge test from `terminal-grid.test.ts` to `terminal-data-flow.test.ts`
2. Delete `terminal-tracker.test.ts`
3. Delete `terminal-grid.test.ts`

**Impact: -18 tests (duplicates), -2 files**

### 2b. IPC schema enumeration → `it.each`

**File**: `apps/proxy/src/__tests__/ipc-protocol.test.ts` L120-256

14 consecutive tests each calling `IpcMessageSchema.safeParse({ type: "X" })` where X is a different message type. This is testing Zod's discriminated union, not business logic.

**Action:** Convert to single `it.each` parametric test + keep the 1 rejection test.

```typescript
const validMessages = [
  { type: "session_create_request", name: "s", mode: "pty" },
  { type: "heartbeat" },
  // ... all variants
];
it.each(validMessages)("validates $type", (msg) => {
  expect(IpcMessageSchema.safeParse(msg).success).toBe(true);
});

it("rejects unknown message type", () => { ... });
```

**Impact: 14 → 2, -12 tests**

### 2c. Shared schema tests: passthrough → `it.each`

**Directory**: `packages/shared/src/schemas/__tests__/` (6 files, 147 tests)

74 tests follow pattern: `parse(validInput)` → `expect(result).toEqual(validInput)`. This asserts Zod returns input unchanged — guaranteed by Zod's design.

**Action per file:**
- Collect all "accepts valid X" inputs into an array
- Replace with 1 `it.each` parametric test
- Keep all 53 rejection tests unchanged
- Keep 20 non-trivial assertion tests unchanged

| File | Before | After (est.) |
|------|--------|-------------|
| relay-control.test.ts | 45 | ~25 |
| envelope.test.ts | 37 | ~22 |
| tool.test.ts | 22 | ~14 |
| chat.test.ts | 20 | ~12 |
| session.test.ts | 20 | ~12 |
| system.test.ts | 18 | ~11 |
| **Total** | **147** | **~96** |

**Impact: ~-51 tests (passthrough → parametric)**

Note: `it.each` 中每个参数仍会在 vitest 中被计为一个独立用例，但结构上明确表达了"这些是同一类断言的参数变体"，可读性和维护成本大幅改善。实际 vitest 报告的用例数减少取决于具体拆分方式。核心目标是消除逐个复制粘贴的 test block。

### 2d. Relay test helper extraction

**Files**: 5 relay test files under `apps/relay/src/__tests__/`

| Helper | Duplicated in | Lines each |
|--------|--------------|------------|
| waitForOpen | 5 files | 9 |
| waitForMessage | 5 files | 5 |
| collectMessages | 4 files | 19 |
| getPort | 4 files | 6 |
| settle | 4 files | 1 |
| makeEnvelope | 3 files (variants) | 7-9 |

**Action:**
1. Create `apps/relay/src/__tests__/helpers.ts`
2. Export unified helpers with configurable timeout defaults
3. Replace all inline definitions in 5 test files with imports

**Impact: -0 tests, -~90 lines of copy-pasted code**

### 2e. 集成测试与单元测试目录分离

当前所有测试混在 `__tests__/` 下，无法区分哪些需要启动真实服务器/WebSocket、哪些是纯内存单元测试。分离后可以独立运行、独立控制超时、CI 中分阶段执行。

**目录结构：**
```
apps/proxy/src/__tests__/
  unit/           # 纯内存，无外部依赖
  integration/    # 启动真实服务/网络/磁盘 I/O
  helpers.ts      # 共享 test utilities
  fixtures/       # 测试数据（保持原位）

apps/relay/src/__tests__/
  unit/
  integration/
  helpers.ts      # 2d 提取的 relay helpers
```

**文件分类：**

proxy 集成测试（移入 `integration/`）：
- `terminal-e2e.test.ts` — 真实 fixture + TerminalTracker + Renderer 全链路
- `relay-connection.test.ts` — 启动真实 relay server + WebSocket

proxy 单元测试（移入 `unit/`）：
- `ipc-protocol.test.ts`, `terminal-data-flow.test.ts`, `session-manager.test.ts`
- `json-session.test.ts`, `pty-manager.test.ts`, `tool-approval.test.ts`
- `file-watcher.test.ts`, `session-history.test.ts`, `command-discovery.test.ts`
- `osc-extractor.test.ts`, `line-buffer.test.ts`, `seq-counter` (in data-flow)

relay 集成测试（移入 `integration/`）：
- `server.test.ts` — 真实 relay + WebSocket
- `client-register.test.ts` — 真实 relay + 多 client
- `message-routing.test.ts` — 真实 relay + proxy/client 路由
- `relay-resilience.test.ts` — 断连/重连/grace period
- `replay.test.ts` — seq gap replay

relay 单元测试（移入 `unit/`）：
- `session-buffer.test.ts`, `registry.test.ts`, `router.test.ts`
- `buffer-store.test.ts` — 虽有磁盘 I/O 但测的是单模块持久化逻辑，归为 unit

**vitest 配置变更：**

每个 app 的 `vitest.config.ts` 增加 include 规则，根配置增加 npm scripts：

```typescript
// apps/proxy/vitest.config.ts
export default defineConfig({
  test: {
    name: "proxy",
    root: __dirname,
    include: ["src/__tests__/**/*.test.ts"],
  },
});
```

```jsonc
// package.json scripts
{
  "test": "vitest run",
  "test:unit": "vitest run --exclude '**/integration/**'",
  "test:integration": "vitest run --include '**/integration/**'"
}
```

**Impact: 0 tests changed, clear separation for CI and local development**

**Phase 2 total: ~-80 tests, -2 files, -90 lines duplication, unit/integration 分离**

---

## Phase 3: Fill critical coverage gaps

### 3a. `control-messages.ts` (9.7% → 80%+)

**Path**: `apps/proxy/src/handlers/control-messages.ts`
**New test**: `apps/proxy/src/__tests__/control-messages.test.ts`

| Handler | Test scenarios | Est. cases |
|---------|---------------|------------|
| handleDirListRequest | Normal listing, path traversal defense (`../` injection), nonexistent path error | 3 |
| handleSessionHistoryRequest | Normal return, empty directory | 2 |
| handleTerminalLinesRequest | Forward to tracker, sessionId mismatch no-crash | 2 |
| pushCommandList | Normal push, 6-hour refresh timer | 2 |
| pushFileTree | Normal push | 1 |
| reinitializeOnReconnect | Re-pushes state on reconnect | 1 |
| cleanup | Clears timers and state | 1 |

**Priority: HIGH** — path traversal defense at L29-35 is a security boundary with zero test coverage.

**Impact: +12 tests**

### 3b. `frame-pusher.ts` (0% direct → 90%+)

**Path**: `apps/proxy/src/frame-pusher.ts`
**New test**: `apps/proxy/src/__tests__/frame-pusher.test.ts`

| Scenario | Behavior | Est. cases |
|----------|----------|------------|
| First frame | mode: "full", contains complete grid | 1 |
| Subsequent with changes | mode: "delta", only changed lines | 1 |
| Subsequent no changes | sendFrame not called | 1 |
| hasGridChanged returns false | sendFrame not called | 1 |
| start/stop lifecycle | start begins 200ms interval, stop clears it | 2 |
| linesEqual edge cases | Different length, different fg/bg/bold/text | 3 |
| Rapid frame switching | Alternating changed/unchanged frames produce correct full→delta sequence | 1 |

**Priority: HIGH** — shared core module between terminal.ts and replay-e2e.ts.

**Impact: +10 tests**

### 3c. `terminal-frame-renderer.ts` (59.7% → 85%+)

**Path**: `apps/proxy/src/terminal-frame-renderer.ts`
**Existing test** (in terminal-e2e.test.ts) covers happy paths. Need dedicated test for branch coverage.
**New test**: `apps/proxy/src/__tests__/terminal-frame-renderer.test.ts`

| Scenario | Behavior | Est. cases |
|----------|----------|------------|
| getMissingRange: cache fully covers request | Return null | 1 |
| getMissingRange: partial cache hit | Return narrowed range | 1 |
| getMissingRange: no cache | Return full requested range | 1 |
| getCachedLines: cross-cache boundary | Correctly splice | 1 |
| applyLinesResponse: overlapping region | Dedup without data loss | 1 |
| applyLinesResponse: gap in cache | Mark gap, don't crash | 1 |
| renderViewportToTerminal: ANSI format | Output fg/bg/bold correctly | 1 |
| clearCache | Reset all state, cacheSize = 0 | 1 |

**Priority: MEDIUM** — mobile client core scrollback scenario.

**Impact: +8 tests**

### 3d. `ipc-protocol.ts` worker 通信路径 (0% → 80%+)

**Path**: `apps/proxy/src/ipc-protocol.ts` L124-219 (WorkerMessage 相关)
**New test**: 扩展 `apps/proxy/src/__tests__/ipc-protocol.test.ts`

问题陈述中标注 worker path 覆盖率为 0%，Phase 1 又要删掉 `session-resume.test.ts`（唯一"覆盖"该路径的源码 grep 测试），必须补上真实的运行时测试。

| Scenario | Behavior | Est. cases |
|----------|----------|------------|
| serializeWorkerMsg round-trip | serialize → parse → 结构一致 | 1 |
| createWorkerReader stream parsing | 通过 PassThrough 流发送 worker 消息，验证回调接收正确 | 1 |
| createWorkerReader split across chunks | 消息跨 data event 边界时仍能正确解析 | 1 |
| createWorkerReader invalid JSON | 不崩溃，跳过坏消息继续处理后续 | 1 |
| WorkerMessageSchema contract | `it.each` 覆盖所有 11 个 worker 消息类型 + 1 个 rejection | 2 |

**Priority: HIGH** — serve ↔ session-worker 的 approval 流程依赖此路径，删除 session-resume.test.ts 后无任何覆盖。

**Impact: +6 tests**

---

## Expected Outcome

| Metric | Before | After |
|--------|--------|-------|
| Test files | 35 | **~28** (-7) |
| Test cases | 516 | **~350-380** |
| Waste tests | ~120-150 | **~0** |
| control-messages.ts coverage | 9.7% | **80%+** |
| frame-pusher.ts direct coverage | 0% | **90%+** |
| terminal-frame-renderer.ts coverage | 59.7% | **85%+** |
| ipc-protocol.ts worker path coverage | 0% | **80%+** |
| Duplicated helper code | ~90 lines | **0** |
| Copy-pasted test blocks | ~80+ | **0** |

**Net effect: fewer tests, better coverage, every test protects real production behavior.**

---

## Execution Order

Phase 1 (Delete) and Phase 2 (Consolidate) can be done in one pass — low risk, pure cleanup.
Phase 3 (Fill gaps) should follow, ideally one PR per sub-item (3a/3b/3c/3d).

## Principles Going Forward

1. **Schema 测试用 `it.each` 合约形式** — 每个 protocol surface 保留一个 `it.each` 合约测试 + 全部 rejection 测试。禁止逐个复制粘贴 test block 枚举变体。
2. **禁止源码 grep 测试** — `readFileSync` 读源文件然后 `toContain` 字符串不是测试。要验证接线关系，写一个走运行时路径的集成测试。
3. **禁止纯 stdlib 包装器测试** — 如果实现是对标准库数据结构的薄包装且无条件分支，不需要独立测试文件。当包装器引入领域逻辑（如 maxSize 淘汰）时再补测试。
4. **同一 failure mode 只测一次** — 如果单元测试和集成测试的 failure mode 相同（同方法、同输入、同断言），只保留更高层级的那个。failure mode 不同时（如集成测试能暴露组装问题）两者都保留。
5. **安全边界覆盖率优先** — 路径遍历、输入校验、auth 流程是不可协商的覆盖要求。
6. **禁止 mock 遮蔽关键集成点** — 对 spawn/PTY 等外部进程的 mock 测试可以存在，但不能作为该路径的唯一覆盖。关键集成点必须有至少一个不 mock 的测试。
