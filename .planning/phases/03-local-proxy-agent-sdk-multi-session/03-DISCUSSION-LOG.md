# Phase 3: Local Proxy - Agent SDK & Multi-Session - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-03
**Phase:** 03-local-proxy-agent-sdk-multi-session
**Areas discussed:** Agent SDK 与 PTY 共存架构, SessionManager 多会话管理, 会话接口暴露方式, 孤儿进程清理, SDK tool approval 初始策略
**Mode:** --auto (all decisions auto-selected)

---

## Agent SDK 与 PTY 共存架构

| Option | Description | Selected |
|--------|-------------|----------|
| 独立进程 | PTY 和 SDK 各 spawn 独立 claude 子进程，SessionManager 统一管理 | * |
| 共享进程 | 一个 claude 进程同时提供 PTY 和 SDK 两条通道 | |
| SDK-only | 放弃 PTY，全部用 Agent SDK 驱动 | |

**User's choice:** [auto] 独立进程 (recommended default)
**Notes:** Agent SDK 有自己的进程生命周期管理，强行共享进程增加不必要的复杂度。PTY 模式已在 Phase 2 验证通过。

---

## SessionManager 多会话管理

| Option | Description | Selected |
|--------|-------------|----------|
| 内存 Map | Map<sessionId, Session>，nanoid 生成 ID，复用 shared 包 SessionState | * |
| 持久化存储 | SQLite/文件系统持久化会话数据 | |
| Redis | 外部 Redis 管理会话状态 | |

**User's choice:** [auto] 内存 Map (recommended default)
**Notes:** Phase 3 为本地代理，内存管理足够。持久化可在后续 phase 按需添加。

---

## 会话接口暴露方式

| Option | Description | Selected |
|--------|-------------|----------|
| 程序化 API | TypeScript 类方法，下游 relay 代码直接调用 | * |
| CLI 子命令 | cc-anywhere session list/create/terminate | |
| HTTP API | 本地 HTTP 端点管理会话 | |

**User's choice:** [auto] 程序化 API (recommended default)
**Notes:** Phase 3 的消费者是 Phase 4 relay server 代码，不是终端用户。CLI 子命令和 HTTP 端点在下游 phase 按需添加。

---

## 孤儿进程清理

| Option | Description | Selected |
|--------|-------------|----------|
| 30s reaper | setInterval 30s，kill(0) 检测存活，SIGTERM -> SIGKILL 梯度清理 | * |
| 事件驱动 | 仅依赖进程 exit 事件，不做定时扫描 | |
| 外部 watchdog | 独立进程监控 | |

**User's choice:** [auto] 30s reaper (recommended default)
**Notes:** 定时扫描作为兜底，事件驱动的 exit 回调仍然是主要清理路径。reaper 只捕获漏网之鱼。

---

## SDK Tool Approval 初始策略

| Option | Description | Selected |
|--------|-------------|----------|
| 默认 deny | canUseTool 全部拒绝，安全第一 | * |
| 默认 allow | canUseTool 全部允许 | |
| 白名单 | 预定义安全工具列表，其余 deny | |

**User's choice:** [auto] 默认 deny (recommended default)
**Notes:** Phase 7 将实现远程审批流程替换此默认策略。callback 设计为可注入策略函数。

---

## Claude's Discretion

- Agent SDK ClaudeClient 初始化配置
- Session 接口精确 TypeScript 类型
- reaper 超时和重试参数
- SDK 会话错误恢复策略

## Deferred Ideas

- Relay 连接 — Phase 4
- 远程 tool approval — Phase 7
- 双表面同步 — Phase 7
