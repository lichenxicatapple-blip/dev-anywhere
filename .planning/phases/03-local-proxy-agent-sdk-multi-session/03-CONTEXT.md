# Phase 3: Local Proxy - Agent SDK & Multi-Session - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

在 Phase 2 的 PTY 透明代理基础上，新增 Agent SDK 驱动的结构化会话模式，并实现多会话并行管理。PTY 模式服务本地终端用户，SDK 模式服务远程控制（飞书小程序）。SessionManager 统一管理所有会话的生命周期，包括状态跟踪、优雅终止和孤儿进程清理。不包含 relay 连接、消息桥接或飞书 UI。

</domain>

<decisions>
## Implementation Decisions

### Agent SDK 与 PTY 共存架构
- **D-01:** PTY 会话和 SDK 会话运行独立的 claude 子进程，不共享进程。PTY 用 node-pty spawn claude（Phase 2 已实现），SDK 用 `@anthropic-ai/claude-agent-sdk` 的 ClaudeClient 以 headless 模式启动 claude。
- **D-02:** 两种会话通过统一的 SessionManager 管理，对外暴露一致的会话操作接口（创建、查询、终止），内部按 mode 分发到不同的实现。
- **D-03:** Phase 2 的 tap 点保持不变。PTY 会话的数据仍经过 tap，为 Phase 4 relay 旁路预留。SDK 会话的数据通过 Agent SDK 的结构化事件流直接提供，不经过 tap。

### SessionManager 多会话管理
- **D-04:** SessionManager 维护 `Map<sessionId, Session>` 内存数据结构。Session 接口包含：id（nanoid 生成）、mode（"pty" | "sdk"）、state（复用 `@cc-anywhere/shared` 的 SessionState 枚举）、进程引用、createdAt 时间戳、可选的 name 字段。
- **D-05:** 会话状态机遵循 shared 包已定义的状态：idle -> working -> waiting_approval -> idle（循环），任意状态 -> error，任意状态 -> terminated。
- **D-06:** 每个会话独立运作，会话间不共享任何状态。一个会话的创建、终止或崩溃不影响其他会话。

### 会话接口暴露方式
- **D-07:** Phase 3 只暴露程序化 TypeScript API（SessionManager 类方法），不添加 CLI 子命令或 HTTP 端点。下游消费者是 Phase 4 的 relay server 代码，不是终端用户。
- **D-08:** API 包括：createSession(mode, options?)、listSessions()、getSession(id)、terminateSession(id)、terminateAll()。返回类型与 shared 包的 Session schema 对齐。

### 孤儿进程清理
- **D-09:** SessionManager 启动时注册 30 秒间隔的 reaper 定时器。reaper 遍历所有已跟踪的会话，通过 `kill(pid, 0)` 检测子进程是否存活。
- **D-10:** 检测到已死的子进程时，reaper 将会话状态标记为 terminated 并从活跃会话 map 中移除，释放相关资源。
- **D-11:** SessionManager 销毁时（process exit），先 terminateAll() 发送 SIGTERM 给所有子进程，等待短暂超时后对仍存活的进程发送 SIGKILL。

### SDK 会话 tool approval 初始策略
- **D-12:** SDK 会话实现 Agent SDK 的 canUseTool callback 接口。Phase 3 的默认策略为全部拒绝（deny），确保安全。
- **D-13:** canUseTool callback 设计为可注入的策略函数，Phase 7 将替换为远程审批流程（通过 relay 发送审批请求到飞书小程序）。

### Claude's Discretion
- Agent SDK ClaudeClient 的具体初始化配置（model、systemPrompt 等参数）
- Session 接口的精确 TypeScript 类型设计
- reaper 的超时和重试参数
- SDK 会话的错误恢复和重试策略

### Folded Todos
- **审视 vitest config 是否需要每个包单独配置** — 随着 Phase 3 为 proxy 包添加更多测试文件，评估当前每包独立 vitest.config.ts 的方案是否合理。低优先级，不阻塞主线开发。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Agent SDK
- `.planning/research/STACK.md` -- Agent SDK 版本（^0.2.90）、dual-mode 架构推荐、ClaudeClient API 模式
- `.planning/research/ARCHITECTURE.md` -- 三层架构设计、proxy 层职责、PTY 与 SDK 双通道关系

### Protocol & Session Schemas
- `packages/shared/src/schemas/session.ts` -- Session CRUD 消息 schema（SessionCreate/List/Switch/Terminate/Status）
- `packages/shared/src/constants/session.ts` -- SessionState 枚举定义（idle/working/waiting_approval/error/terminated）
- `packages/shared/src/schemas/tool.ts` -- Tool approval 消息 schema（tool_use_request/approve/deny/result）

### Existing Proxy Code
- `apps/proxy/src/pty-manager.ts` -- Phase 2 的 PtyManager 实现，是 PTY 会话模式的基础
- `apps/proxy/src/tap.ts` -- DataTap 接口，Phase 3 需保持兼容
- `apps/proxy/src/index.ts` -- 当前入口点，Phase 3 需重构为支持多会话

### Research
- `.planning/research/PITFALLS.md` -- 进程清理、信号处理、WebSocket 连接管理的已知陷阱
- `.planning/research/SUMMARY.md` -- 综合研究结论，包含 Agent SDK 使用建议

### Project Context
- `.planning/PROJECT.md` -- 核心价值和约束
- `.planning/REQUIREMENTS.md` -- PROXY-02（双通道并行）、PROXY-03（多会话管理）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PtyManager` (apps/proxy/src/pty-manager.ts): PTY 会话的完整实现，包括 spawn、stdin/stdout 管道、resize、信号处理、cleanup。Phase 3 的 PTY 模式会话直接复用此类。
- `DataTap` (apps/proxy/src/tap.ts): 数据旁路接口，SDK 会话不使用此接口但需保持兼容。
- `SessionState` (packages/shared/src/constants/session.ts): 会话状态枚举已定义，SessionManager 直接使用。
- Session schemas (packages/shared/src/schemas/session.ts): CRUD 消息类型已定义，API 返回值可对齐这些 schema。

### Established Patterns
- ESM + TypeScript (`"type": "module"`) 全项目统一
- tsup 构建 + vitest 测试
- 包间严格单向依赖：shared 无依赖，proxy 依赖 shared
- zod schema -> infer TypeScript 类型的模式

### Integration Points
- `apps/proxy/src/index.ts` — 当前是单会话 PTY 启动，需重构为 SessionManager 驱动的多会话入口
- `apps/proxy/package.json` — 需添加 `@anthropic-ai/claude-agent-sdk` 和 `nanoid` 依赖
- Phase 4 relay 将调用 SessionManager API 进行远程会话管理

</code_context>

<specifics>
## Specific Ideas

- Agent SDK 研究推荐 dual-mode 架构：PTY 用于本地透明体验，Agent SDK 用于结构化远程控制，两者共存互不干扰
- cc-connect 项目的多会话进程管理实现可参考（Go 实现，但生命周期管理思路通用）
- Phase 2 的 PtyManager 已通过 102 个测试验证，Phase 3 应保持其稳定性不引入回归
- Agent SDK v0.2.x 变动较快，需 pin 确切版本并在 SessionManager 中封装 SDK 调用，降低升级影响面

</specifics>

<deferred>
## Deferred Ideas

- Relay 连接和消息桥接 — Phase 4 (RELAY-01)
- 断线重连和消息队列缓存 — Phase 5 (RELAY-02)
- 飞书小程序 UI — Phase 6 (FEISHU-01)
- 远程 tool approval 审批流程 — Phase 7 (FEISHU-02)
- 终端和手机双表面同步 — Phase 7 (PROXY-04)

### Reviewed Todos (not folded)
None — the only matching todo was folded into scope.

</deferred>

---

*Phase: 03-local-proxy-agent-sdk-multi-session*
*Context gathered: 2026-04-03*
