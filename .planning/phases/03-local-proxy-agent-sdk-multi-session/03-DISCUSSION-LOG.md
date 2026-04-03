# Phase 3: Proxy Service & Multi-Session - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-03 ~ 2026-04-04
**Phase:** 03-local-proxy-agent-sdk-multi-session
**Areas discussed:** 整体架构、Agent SDK vs stream-json、多会话管理模型、PTY 归属、飞书可见性、会话模式
**Mode:** Interactive (user-driven architecture redesign)

---

## 整体架构

**起因：** auto 模式生成的初版 CONTEXT.md 采用"独立进程 + Agent SDK"方案。用户提出关键需求：飞书必须能看到所有 cc-anywhere 实例，包括终端启动的会话。

| Option | Description | Selected |
|--------|-------------|----------|
| 独立进程（原方案） | 每个 cc-anywhere 终端实例是独立进程，SessionManager 只管 SDK 会话 | |
| 服务 + 瘦客户端 | 中心服务进程管理所有会话，CLI 变成瘦客户端 | * |

**User's choice:** 服务 + 瘦客户端
**Notes:** 用户明确表示"飞书能够统一管理所有 cc anywhere 的实例"是刚需，因为会随时在手机和电脑之间切换工作。

---

## Agent SDK vs claude --stream-json

**起因：** 参考 cc-connect 源码发现它不用 Agent SDK，直接用 `claude --stream-json` 与 Claude Code 通信。

| Option | Description | Selected |
|--------|-------------|----------|
| Agent SDK | @anthropic-ai/claude-agent-sdk，官方 SDK | |
| claude --stream-json | 直接调用 claude CLI 的 JSON 流式协议 | * |

**User's choice:** claude --stream-json
**Notes:** cc-connect 验证过的成熟方案，少一个不稳定依赖（Agent SDK v0.2.x）。用户本地测试确认 stream-json 通过子进程 pipe 正常输出结构化 JSON 事件。必须加 --verbose flag，否则 pipe 模式报错。

---

## PTY 归属：服务端还是客户端

**起因：** 如果 PTY 在服务端管理，终端 I/O 需要经过 IPC 多一跳。

| Option | Description | Selected |
|--------|-------------|----------|
| PTY 在服务端（类 tmux） | 终端关了会话还活着，但每次按键多一跳 IPC | |
| PTY 在客户端 | 零延迟，服务只做注册和观察，终端关了会话就结束 | * |

**User's choice:** PTY 在客户端
**Notes:** 用户场景是"电脑开着终端跑任务，掏手机看进度"，电脑一定是开着的。终端关了会话结束是合理行为。

---

## 飞书发起的 JSON 会话

| Option | Description | Selected |
|--------|-------------|----------|
| 不支持 | 飞书只能观察终端会话，不能自己创建 | |
| 支持 | 飞书可以创建 headless JSON 会话，服务进程管理生命周期 | * |

**User's choice:** 支持，但要注意生命周期管理
**Notes:** 用户认为"支持临时干点活也不错"，但要求允许从手机主动关闭，避免 JSON 会话一直挂着浪费资源。

---

## stream-json 本地验证

通过 `reference/test-stream-json.mjs` 脚本验证：
- `claude --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --verbose` 通过子进程 pipe 正常工作
- stdout 输出结构化 JSON 事件：system（init/hook）、assistant（thinking/text）、result（完成状态/token/费用）
- `--verbose` 是 pipe 模式下的必要 flag
- 超长 JSON 行可能被 data 事件分片，需要行缓冲
- 进程退出码 143 是测试脚本 kill 造成的（128 + SIGTERM），非异常

## Claude's Discretion

- Unix socket 路径和权限设计
- 服务自动拉起实现细节
- IPC 消息格式细节
- reaper 参数

## Deferred Ideas

- Relay 连接 — Phase 4
- 飞书 UI 和远程创建 JSON 会话 — Phase 6
- 远程 tool approval — Phase 7
- JSON 会话空闲超时 — Phase 6 或 Phase 10
