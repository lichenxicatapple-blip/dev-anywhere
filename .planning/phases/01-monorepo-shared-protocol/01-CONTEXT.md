# Phase 1: Monorepo & Shared Protocol - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

搭建 pnpm monorepo 项目脚手架，定义 zod 消息协议 schema 作为所有组件的共享契约。Phase 1 不含任何业务逻辑，只产出可编译、可测试的项目骨架和协议定义。

</domain>

<decisions>
## Implementation Decisions

### 消息协议设计
- **D-01:** 消息类型按功能分为四大类：
  - chat: user_input, assistant_message, thinking
  - tool: tool_use_request, tool_approve, tool_deny, tool_result
  - session: session_create, session_list, session_switch, session_terminate, session_status
  - system: heartbeat, error, auth, sync_request, sync_response
- **D-02:** MessageEnvelope 带元数据：seq（序列号）、sessionId、type、payload、timestamp、source（proxy/client）、version
- **D-03:** 流式输出粒度为 stream-json 事件级，每个 JSON event 作为一条完整消息发送到小程序，不做 token 级流式
- **D-04:** 统一错误消息类型，所有错误通过 error 类型消息传递，包含错误码和描述
- **D-05:** 认证采用配对码方案：首次连接时本地代理生成 6 位配对码（5 分钟有效），用户在飞书小程序输入后建立绑定，双方获得长期 token 用于后续自动认证，无需重复配对

### Monorepo 结构
- **D-06:** 采用 apps/ + packages/ 分离布局：apps/{proxy,relay,feishu} 为可部署应用，packages/shared 为共享库
- **D-07:** npm scope 使用 @cc-anywhere/*（如 @cc-anywhere/shared、@cc-anywhere/proxy）

### 构建与开发工具
- **D-08:** 构建工具使用 tsup，测试框架使用 vitest
- **D-09:** Lint 使用 ESLint，格式化使用 Prettier

### shared 包内容与依赖
- **D-10:** shared 包包含：zod schema 定义、TypeScript 类型导出（从 zod infer）、消息构造器函数、序列号生成器、常量定义（错误码枚举、会话状态枚举）。不包含 WebSocket 连接逻辑、持久化逻辑、业务逻辑。
- **D-11:** 包间严格单向依赖：shared 无依赖，proxy/relay/feishu 只依赖 shared，三者互不依赖。如 relay 有类型需要 feishu 用，提升到 shared。

### Zod Schema 组织
- **D-12:** packages/shared/src/ 下按职责分目录：schemas/（按消息类别拆文件：envelope.ts、chat.ts、tool.ts、session.ts、system.ts）、types/（从 zod infer 的 TS 类型）、builders/（消息构造器）、constants/（错误码、会话状态枚举）

### Claude's Discretion
- 无（所有设计决策已确定）

</decisions>

<specifics>
## Specific Ideas

- cc-connect 项目 (https://github.com/chenhg5/cc-connect) 可作为消息协议和会话管理的参考实现
- `claude --stream-json` 的 JSON event 类型是协议设计的核心参考，消息类型应与 stream-json 事件模型对齐
- 研究发现飞书小程序限制 1-2 个 WebSocket 并发连接，协议需支持单连接多会话复用

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### stream-json
- `.planning/research/STACK.md` -- stream-json 事件类型定义
- `.planning/research/ARCHITECTURE.md` -- 三层架构设计、组件边界、数据流方向

### Protocol Design
- `.planning/research/SUMMARY.md` -- 研究综合，包含消息协议设计建议和飞书约束
- `.planning/research/PITFALLS.md` -- WebSocket 消息排序、UTF-8 截断、重连等协议层陷阱

### Project Context
- `.planning/PROJECT.md` -- 项目核心价值和约束
- `.planning/REQUIREMENTS.md` -- 所有 v1 需求，协议需覆盖每条需求涉及的消息类型

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- 无（greenfield 项目）

### Established Patterns
- 无（首个 phase，所有模式从这里建立）

### Integration Points
- 本 phase 产出的 shared 包是所有后续 phase 的依赖基础
- zod schema 定义的消息类型将被 proxy、relay、feishu 三个应用直接 import 使用

</code_context>

<deferred>
## Deferred Ideas

- 飞书小程序通知能力（用户离开后任务完成时通知，回到电脑后自动屏蔽通知） -- Phase 10 (UX-03)

</deferred>

---

*Phase: 01-monorepo-shared-protocol*
*Context gathered: 2026-04-03*
