---
date: "2026-04-13 15:10"
promoted: false
---

# 状态机现状审计报告

## 一、全局问题

**核心矛盾**：三个模块的状态管理方式不一致。
- Client 有显式状态机（AppPhase），但绑定逻辑分散在 3 个地方
- Relay 完全没有状态机，靠 Map 里的 nullable ws 判断在不在线
- Proxy 的 SessionManager 有状态枚举，但 serve/terminal/RelayConnection 全是隐式状态

**协议层问题**：30 个消息类型中，绑定相关有 3 条路径（proxy_select、bind_by_session、重连恢复），做的是同一件事但保证级别不同——proxy_select 没有 ACK，bind_by_session 有。

---

## 二、各模块现状

### Proxy 侧

**RelayConnection** — 6 个隐式状态（INITIAL / CONNECTING / CONNECTED / SYNCED / DISCONNECTED / CLOSED），靠 ws + closed + reconnectAttempt 组合判断。消息队列无上限。

**SessionManager** — 有显式状态枚举（IDLE / WORKING / WAITING_APPROVAL / ERROR / TERMINATED），但：
- 从磁盘恢复时不重置 WAITING_APPROVAL，导致审批永远卡住
- JSON session 从不转为 WORKING，relay 看不到活动状态

**serve.ts** — 纯事件处理，5 个全局 Map（sessionManager, workerSockets, terminalSockets, frameCache, pendingToolApprovals），没有生命周期管理：
- frameCache 在 session 终止时不清理 → 内存泄漏 + 陈旧帧
- pendingToolApprovals 在 worker 断开时不清理 → 审批永远挂起
- 没有 worker 重试机制

**terminal.ts** — ad-hoc 重连逻辑（60 次循环，最长 5 分钟），关键竞态：
- pty_register 可能在 session_create_response 之前到达
- 重连时不验证返回的 sessionId 是否匹配

**FrameCache** — delta 帧到达时如果没有 full 基底，静默丢弃 → 屏幕空白

### Relay 侧

**Proxy 生命周期**：INIT → REGISTERED → OFFLINE → RECONNECTED/DELETED。没有宽限期超时——离线 proxy 永远不会被自动清理，内存无限增长。

**Client 生命周期**：UNREGISTERED → REGISTERED(new/restored) → BOUND。绑定通过 clientId 持久化，ws 断开只清空 ws 引用不删除绑定，重连自动恢复。

**Session 缓冲**：只追加不压缩，无上限。relay 重启后 buffer 从磁盘恢复，但 session→proxy 映射丢失，直到 proxy 重连并发 session_sync。

**双重通知**：proxy_offline 在两个地方发送（WebSocket close + proxy_disconnect），逻辑重复。

### Client 侧

**AppPhase 状态机**：connecting → proxy_selecting → session_browsing → chatting，加上 reconnecting 和 proxy_lost。

**绑定 3 条路径**：
1. proxy_select — 用户手动选择，无 ACK
2. bind_by_session — chat 页面自动绑定，有 ACK
3. 重连恢复 — phase-machine 用 selectedProxyId 重发 proxy_select，无 ACK

**Storage 与内存状态不同步**：cc_proxyId（Storage）和 RelayClient.boundProxyId（内存）可能不一致。useDidShow 直接 dispatch SET_PHASE 绕过 transitionToPhase，跳过 Storage 清理。

**Cold start 与手动导航竞态**：coldStartDone 标志在特定条件下才设置，用户可能在 cold start 执行前手动操作。

---

## 三、关键 Bug 清单（按严重度排序）

### Critical
1. **frameCache 内存泄漏** — session 终止时不 remove，陈旧帧永远留在内存
2. **pendingToolApprovals 泄漏** — worker 断开时不清理，审批永远挂起，Claude 卡死
3. **delta 帧无 full 基底** — 首帧是 delta 时缓存为空，用户看到空白屏幕

### High
4. **WAITING_APPROVAL 恢复后卡死** — 磁盘恢复 session 时不重置状态
5. **JSON session 永远 IDLE** — relay 无法感知 JSON worker 活动
6. **pty_register 竞态** — 可能在 session 创建前到达 serve
7. **proxy_select 无 ACK** — 客户端乐观更新，relay 可能拒绝但客户端不知道
8. **离线 proxy 永不清理** — relay 内存无限增长

### Medium
9. **消息队列无上限** — RelayConnection 和 SessionBuffer 都无限增长
10. **审批无超时** — relay 不可达时 Claude 永远等待
11. **terminal 重连无中断机制** — 最长挂 5 分钟

---

## 四、设计方向建议

### 需要回答的核心设计问题

1. **是否每个模块都需要显式状态机？** 还是只在 client 侧有就够了？
2. **绑定应该有几条路径？** proxy_select 和 bind_by_session 是否应该统一为一个？
3. **ACK 策略**：哪些操作需要 relay 确认？只要是改变绑定状态的都需要？
4. **清理策略**：离线 proxy 的宽限期多长？buffer 多大开始清理？
5. **恢复策略**：relay 重启后，session→proxy 映射是否应该持久化？
