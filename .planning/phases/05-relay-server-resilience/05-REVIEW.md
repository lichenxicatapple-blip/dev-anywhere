---
status: issues_found
phase: 05-relay-server-resilience
depth: standard
files_reviewed: 19
findings:
  critical: 1
  warning: 3
  info: 1
  total: 5
---

# Phase 05 Code Review: relay-server-resilience

## Critical

### C1: MemoryMessageQueue 无上限，可致无界内存增长

**Confidence: 95**
**File:** `apps/proxy/src/message-queue.ts`, `apps/proxy/src/relay-connection.ts:131-138`

`MemoryMessageQueue.enqueue` 无 maxSize 保护。当 relay 断连时，proxy 的 `send()` 路径将所有 envelope 持续压入队列。如果断连期间 Claude 正在流式输出（密集的 `assistant_message` / `thinking` 帧），队列会无限膨胀，直到 OOM。

`SessionBuffer` 有 1000 条上限并做 FIFO 淘汰，`MemoryMessageQueue` 没有。两者设计不对称。

修复方向：给 `MemoryMessageQueue` 增加 `maxSize` 参数，超出时丢弃旧消息并记录警告日志。

## Warning

### W1: compressOnResult 在 user_input 被 FIFO 淘汰后错误压缩跨 turn 数据

**Confidence: 85**
**File:** `apps/relay/src/buffer-compressor.ts:31-37`

`compressOnResult` 寻找最近的 `user_input` 作为 turn 边界。若当前 turn 的 `user_input` 因 FIFO 淘汰已不在 buffer 中，`turnStart` 回落到 0，导致从 buffer 起始位置到 `resultIdx` 之间的所有 `assistant_message`/`thinking` 消息被误删。

修复方向：当未找到 `user_input` 时，`turnStart` 应设为 `resultIdx`（不删除任何内容），而非 0。

### W2: handleReplayRequest 发送 gap_unrecoverable 前缺少 readyState 检查

**Confidence: 82**
**File:** `apps/relay/src/router.ts:141-148`

消息发送循环逐帧检查 `clientWs.readyState === WebSocket.OPEN`，但循环结束后追加的 `gap_unrecoverable` 没有同等保护。大量消息回放期间若 WebSocket 关闭，追加的 `clientWs.send` 会向已关闭的 socket 写数据。

修复：在发送 `gap_unrecoverable` 前添加 readyState 检查。

### W3: proxy_offline schema 中 proxyId 未添加 .min(1) 约束

**Confidence: 80**
**File:** `packages/shared/src/schemas/relay-control.ts:54`

所有其他包含 `proxyId` 的消息类型均用 `z.string().min(1)` 防止空字符串，唯独 `proxy_offline` 使用 `z.string()`。Schema 层面不一致。

修复：改为 `proxyId: z.string().min(1)`。

## Info

### I1: relay-connection.test.ts 中关于 close() 的断言意图与实现不符

**Confidence: 80**
**File:** `apps/proxy/src/__tests__/relay-connection.test.ts:123`

测试通过只因 `getProxy` 在宽限期下返回 `undefined`（`ws` 为 null），但 proxy 状态仍保留在 registry 中。测试意图是"proxy 被移除"，实际行为是"进入宽限期"。断言碰巧正确但会误导维护。

## Summary

核心逻辑（grace period 竞态保护、重连取消定时器、clientId 绑定持久化、seq 范围查询）正确，无明显竞态条件。Zod schema 覆盖完整，测试用例覆盖主要路径。C1（无界队列）是最需要优先处理的问题。
