---
phases: [1, 2, 3, 4, 5]
reviewers: [gemini, codex]
reviewed_at: 2026-04-07T00:00:00Z
plans_reviewed:
  - 01-01-PLAN.md
  - 01-02-PLAN.md
  - 02-01-PLAN.md
  - 02-02-PLAN.md
  - 03-01-PLAN.md
  - 03-02-PLAN.md
  - 03-03-PLAN.md
  - 04-01-PLAN.md
  - 04-02-PLAN.md
  - 04-03-PLAN.md
  - 05-01-PLAN.md
  - 05-02-PLAN.md
  - 05-03-PLAN.md
---

# Cross-AI Plan Review -- Phases 1-5

## Gemini Review

这是对 **CC Anywhere** 项目 1-5 阶段（共 13 个实施计划）的深度评审报告。

### 1. 总体评价

该 5 阶段计划展现了极高的工程专业性，体现了从"透明原型"到"生产级弹性架构"的清晰演进思路。方案核心选择了 **PTY (本地透明) + JSON (远程受控)** 的双通道设计，精准抓取了 Claude Code 的交互特性。Phase 5 的重连协议与消息重放机制设计得非常扎实，能够有效应对移动网络环境下的不稳定性。整体架构平衡了开发效率（TypeScript 单一语言栈）与系统稳定性，是一个高质量且具备落地可行性的技术蓝图。

### 2. 架构亮点

- **双模驱动 (PTY + Stream-JSON)**：既保留了本地终端的极致体验，又通过结构化数据为移动端/机器人交互提供了编程基础，这是该方案最成功的设计点。
- **Service-Client 守护架构**：将复杂的会话管理与 PTY 逻辑下沉到长期运行的 Service 进程，使 CLI 客户端保持轻量，并解决了断开连接后会话存续的问题。
- **基于 Zod 的协议驱动开发**：单一事实来源的 Schema 定义确保了全栈（Proxy/Relay/Feishu）的类型一致性，大幅降低了联调成本。
- **完备的弹性机制**：Phase 5 引入的指数退避重连、带抖动的重试、会话快照压缩以及 30 分钟宽限期，针对移动端场景做了深度优化。
- **无状态 Relay 路由**：Relay 只负责校验和转发，不涉及复杂的业务逻辑，有利于横向扩展和容器化部署。

### 3. 架构担忧

- **PTY 会话不可恢复性 (HIGH)**：虽然 Phase 5 实现了 Relay 侧的消息重放，但如果 Local Proxy 进程崩溃或重启，底层的 node-pty 子进程会随之消失。即便 Client 重新连接，由于 PTY 状态已丢失（Claude 进程已不存在），重放的消息仅具有"回放"意义，无法恢复交互。建议在 Phase 3 中明确 Proxy 如何处理自身重启后的状态恢复，或确认"Proxy 存活"是会话存续的硬前提。
- **Relay 公网暴露安全风险 (HIGH)**：计划提到 Phase 1-5 不包含鉴权。但 Phase 4 将 Relay 部署在公网。任何人都可以通过 WebSocket 连接到 /proxy 注册成为一个新的 Proxy ID，或连接到 /client 并尝试猜测 Proxy ID 进行控制。建议即便不实现完整的用户系统，也应在 Phase 4 引入一个简单的环境变量 RELAY_SECRET 作为鉴权令牌。
- **Relay 内存压力 (MEDIUM)**：每个会话缓存 1000 条消息。若有大量并发会话且输出频繁，Relay 的内存消耗会迅速上升，尤其是未压缩的消息。
- **Unix Socket 权限与残留 (LOW)**：在多用户环境下，如果 Service 异常退出未清理 Socket 文件，Client 再次启动可能会失败。

### 4. 分阶段反馈

- **Phase 1 (Monorepo & Protocol)**：非常标准。Schema 分类（chat/tool/session/system）覆盖全面。
- **Phase 2 (PTY Core)**：Resize 防抖 (50ms) 和信号处理（128+N）显示了对终端交互细节的深刻理解。
- **Phase 3 (Service & Multi-Session)**：引入 LineBuffer 处理 NDJSON 是正确的方法。JsonSession 的工具审批策略设计（默认 deny-all）体现了安全性考量。
- **Phase 4 (Relay & Deployment)**：Taro Spike 的前置验证非常明智，规避了技术栈不兼容风险。部署脚本选择了常见的 Nginx + Docker 组合，易于维护。
- **Phase 5 (Resilience)**：这是整个方案的灵魂。3-way 握手协议 (restored/proxy_offline/new) 处理了客户端重连的所有关键状态分支。

### 5. 缺失的边缘情况

1. 如果 claude 进程意外输出了非 UTF-8 的二进制数据，node-pty 和 LineBuffer 是否会崩溃？
2. WebSocket 在 Relay 转发大消息时，是否会阻塞其他小消息的转发？
3. 如果两个不同的移动端 Client 尝试同时连接同一个 ProxyID，RelayRegistry 如何处理抢占？

### 6. 安全性建议

- 建议在 Nginx 层对 /proxy 路径限制 IP 访问
- 确保 Proxy ID 的生成不包含路径字符，防止路径穿越攻击

### 7. 优化建议

- 在 Phase 5 的 client_register_response 中增加 server_time 或 heartbeat_interval，让移动端能感知网络延迟
- 在 Phase 3 增加 inspect-sessions 命令方便调试
- 如果 Buffer 导致 Relay 压力过大，可考虑 Phase 5 之后引入 Redis 存储

### 8. 风险评估

**风险等级：LOW**。虽然有 PTY 恢复和安全两个高优先级隐患，但在当前 1-5 阶段的"开发/实验"语境下可接受。技术方案非常详尽，核心开发工作量可控。

**评审结论：** 该计划可以立即进入执行阶段。建议在 Phase 4 启动时同步添加最基础的 RELAY_SECRET 鉴权。

---

## Codex Review

### Overall Assessment

The 5-phase plan is coherent and mostly well-sequenced: it builds shared protocol foundations first, proves local PTY transparency, then introduces the daemon/service split, relay transport, and finally resilience semantics. The core architecture choices are sound for the product goal, especially the separation between local terminal transparency and remote programmatic control. The main risks are protocol semantics around sequencing/replay/compression, security being deferred while public relay deployment is introduced, and operational complexity arriving before observability and failure-mode testing are fully specified.

### Architecture Strengths

- Clear separation of concerns: shared protocol, local proxy, relay, and Feishu client are split into packages with a reasonable dependency direction.
- PTY transparency is treated as a first-class requirement rather than an afterthought, including resize, signals, raw mode, and manual verification.
- The daemon/client architecture is a good fit for multi-session management and remote bridging.
- Zod schemas and discriminated unions provide a strong basis for cross-package protocol correctness.
- Resilience features are introduced after the base relay path, which keeps Phase 4 from becoming too large.
- Grace-period reconnect, sequence numbers, replay, and buffering directly map to the "no lost context" value proposition.
- Human verification checkpoints are appropriate for PTY behavior and Feishu mini-program WebSocket support.

### Architecture Concerns

- **HIGH:** Authentication is deferred, but Phase 4 includes public relay deployment. Even before full auth, the relay needs minimal access controls, origin validation, proxy/client pairing secrets, and rate limits.
- **HIGH:** Sequence-number ownership is underspecified. Phase 1 builders have auto-incrementing seq counters, while Phase 5 replay depends on reliable per-session ordering. The plans should define whether seq is global, per-session, per-source, relay-assigned, or proxy-assigned.
- **HIGH:** Buffer compression can conflict with replay correctness. Snapshot/result compression may discard data needed to reconstruct terminal state or stream history unless message types define explicit checkpoint semantics and replay invariants.
- **MEDIUM:** "Relay as stateless router" conflicts with Phase 5 per-session buffers, grace timers, proxy state, and client bindings. The architecture should rename this to "business-logic-light stateful router".
- **MEDIUM:** The dual PTY plus stream-json model may create divergent state unless the relationship between a user-visible PTY session and a JSON session is formalized.
- **MEDIUM:** Message builders with a process-local auto-increment counter are risky in a multi-process daemon, relay, and reconnect scenario. May produce duplicate or non-monotonic seq values after restart.
- **MEDIUM:** The Feishu plan only validates WebSocket viability, but later plans depend on client reconnect semantics. No explicit Feishu-side protocol/client state plan yet.
- **LOW:** Docker/CentOS/certbot deployment may be too specific for Phase 4 unless the target environment is fixed.
- **LOW:** Socket permissions 0o600 may need directory permissions too.

### Per-Phase Feedback

**Phase 1:** Strong foundation. The monorepo and shared schema plans are appropriate, but the protocol should define sequencing semantics, version compatibility rules, and envelope ownership before downstream packages depend on it.

**Phase 2:** Well-scoped and focused on PTY transparency. The plan should also define fallback behavior when claude is missing, exits immediately, or stdin/stdout are not TTYs.

**Phase 3:** Ambitious but logically placed. The plan should clarify whether PTY sessions and JSON sessions share lifecycle, persistence, identifiers, and state transitions.

**Phase 4:** Directionally solid. The Taro spike is a good risk-reduction step. The concern is public deployment before minimal security.

**Phase 5:** Targets the right problems. Highest-risk parts are replay correctness, compression correctness, and the exact state machine during partial disconnects.

### Missing Edge Cases

- Relay receives duplicate messages after proxy reconnect and queue drain.
- Client reconnects with lastSeq greater than relay buffer head or greater than latest known seq.
- Proxy reconnects with same proxyId while old socket is still half-open.
- Multiple clients bind to the same proxy/session: should this be allowed, rejected, or broadcast?
- Relay restart loses all buffers and bindings. Client behavior unspecified.
- Local daemon restart while relay still believes the proxy is in grace period.
- Clock skew if timestamps are used for ordering, expiry, or debugging.
- Backpressure when remote client is slow but PTY/JSON stream is fast.
- Large tool outputs, binary-like terminal output, ANSI escape-heavy output, and partial UTF-8 sequences.
- claude --stream-json emits malformed, partial, or unexpected JSON lines.
- Approval prompts while the remote client is disconnected.
- User resizes terminal rapidly while relay/client is disconnected.
- Process orphaning if the CLI client dies but daemon/service remains.
- Relay buffer reaches 1000 messages before a snapshot exists.
- Grace period expires while queued proxy messages still exist locally.

### Security Considerations

- Add at least pre-auth pairing tokens or shared secrets before public relay deployment.
- Validate WebSocket Origin, requested path, message size, and rate per connection.
- Do not expose /status with sensitive proxy/session/client IDs unless protected or redacted.
- Treat proxyId, clientId, and sessionId as untrusted input; prevent ID spoofing and binding hijacks.
- Limit message payload sizes to prevent memory exhaustion.
- Avoid logging raw terminal data, prompts, tool outputs, or secrets by default.
- Secure Unix socket runtime directories, not just socket file mode.
- Add replay/gap APIs that cannot retrieve another client's buffered session data.

### Suggestions

- Define sequence semantics explicitly: scope, owner, monotonicity, restart behavior, duplicate handling, and replay invariants.
- Split message ordering from message identity: consider messageId plus per-session seq.
- Add a minimal pairing/auth layer before public relay deployment.
- Rename or reframe the relay as a stateful transient transport once buffers and grace timers are introduced.
- Add protocol compatibility tests across packages using shared fixtures.
- Add state-machine diagrams for proxy, relay, client binding, and session lifecycle.
- First implement Phase 5 replay without compression, then add compression after invariant tests pass.
- Specify behavior for multiple clients per session before implementing registry maps.
- Add payload-size limits, queue caps, and backpressure behavior to the relay and proxy plans.
- Add structured operational logs with redaction rules and correlation IDs.
- Add recovery tests for relay restart, proxy restart, client reconnect, duplicate delivery, and unrecoverable gaps.

### Risk Assessment

**Overall risk: MEDIUM-HIGH**. The plan is architecturally plausible and well decomposed, but it touches difficult areas: terminal transparency, long-lived process control, mobile WebSocket behavior, reconnect/replay correctness, and public relay exposure. The largest risks are state consistency, security boundaries, and operational behavior under disconnects, restarts, slow clients, and replay gaps.

---

## Consensus Summary

### Agreed Strengths

Both reviewers highlight:
1. **PTY + Stream-JSON dual mode** is the strongest design decision -- preserves local UX while enabling remote control
2. **Zod-based protocol-driven development** ensures cross-package type safety and reduces integration risk
3. **Service-Client daemon architecture** is appropriate for multi-session management
4. **Phase 5 resilience design** (3-way reconnect, grace period, buffering) directly serves the core value proposition
5. **Taro spike in Phase 4** is a smart risk-reduction move
6. **Human verification checkpoints** are correctly placed for behaviors that can't be unit-tested

### Agreed Concerns

Both reviewers raised these issues independently:
1. **PUBLIC RELAY WITHOUT AUTH (HIGH)** -- Both flag this as the top security concern. Phase 4 deploys relay publicly but authentication is deferred. Consensus: add at least RELAY_SECRET or pairing token before public deployment.
2. **SEQUENCE NUMBER SEMANTICS (HIGH)** -- Codex specifically calls out that seq ownership (global vs per-session vs per-source) is underspecified. Gemini implicitly touches this via replay concerns. This needs resolution before Phase 5 replay can be trusted.
3. **BUFFER COMPRESSION vs REPLAY CORRECTNESS (HIGH)** -- Codex explicitly flags that compression may discard data needed for replay. Gemini acknowledges this less directly. Consensus: implement replay without compression first, add compression after invariant tests pass.
4. **PTY SESSION UNRECOVERABILITY (HIGH from Gemini, implicit from Codex)** -- If proxy crashes, PTY state is lost. This should be documented as an explicit architectural constraint rather than left ambiguous.
5. **RELAY MEMORY PRESSURE (MEDIUM)** -- 1000 messages per session without payload size limits. Both suggest adding explicit memory budgeting.
6. **MULTIPLE CLIENTS PER PROXY (MEDIUM)** -- Codex asks explicitly about concurrent client behavior. Gemini also raises this.

### Divergent Views

| Topic | Gemini | Codex |
|-------|--------|-------|
| Overall Risk | LOW | MEDIUM-HIGH |
| Relay Classification | "Stateless router" (accepted) | Should rename to "stateful transient transport" |
| PTY/JSON Relationship | Not flagged | Should formalize whether PTY and JSON sessions share lifecycle |
| Deployment Specificity | Accepted Docker/CentOS/Nginx | May be too specific, could distract from relay correctness |
| Actionability | "Ready to execute immediately" | Needs sequencing fixes and semantic clarifications first |

The risk divergence is notable: Gemini evaluates in the context of a personal/dev tool and finds risk acceptable; Codex evaluates against production engineering standards and finds more gaps. Both perspectives are valid depending on the deployment context.
