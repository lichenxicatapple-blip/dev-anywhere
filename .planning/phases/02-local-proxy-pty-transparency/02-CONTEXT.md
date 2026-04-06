# Phase 2: Local Proxy - PTY Transparency - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

实现透明的 CLI 包装器，使 `cc-anywhere` 与直接运行 `claude` 在终端行为上完全不可区分。包括 PTY 分配、stdin/stdout/stderr 透传、ANSI 转义保真、信号转发、窗口大小同步、进程生命周期管理。不包含远程控制、stream-json 集成或多会话管理。

</domain>

<decisions>
## Implementation Decisions

### CLI 调用设计
- **D-01:** `cc-anywhere` 作为全局可执行文件名，通过 package.json `bin` 字段注册
- **D-02:** 所有命令行参数直接透传给 `claude`，cc-anywhere 自身不消费任何 claude 的参数
- **D-03:** cc-anywhere 自身的配置参数（如 relay 地址）通过环境变量传递，不与 claude 参数冲突

### PTY 生命周期
- **D-04:** 使用 node-pty 创建伪终端分配并在其中 spawn claude 进程
- **D-05:** claude 进程退出时，cc-anywhere 以相同的 exit code 退出
- **D-06:** claude 进程异常崩溃时，cc-anywhere 输出错误信息到 stderr 并以非零 exit code 退出
- **D-07:** cc-anywhere 退出时确保 claude 子进程被正确终止，防止孤儿进程

### 信号转发
- **D-08:** Ctrl+C (SIGINT) 和 Ctrl+D (EOF) 通过 PTY stdin 写入控制字符实现，而非 OS 信号
- **D-09:** SIGWINCH（终端窗口大小变化）通过 node-pty 的 resize() API 同步到 claude 进程
- **D-10:** SIGTSTP (Ctrl+Z) 等作业控制信号正常通过 PTY 传递

### 输出架构
- **D-11:** Phase 2 采用纯透传架构，stdout/stderr 数据从 PTY 直接写入到宿主终端
- **D-12:** 数据流经过一个 tap 点（Phase 2 中为 noop），为 Phase 3-4 的 relay 旁路预留接入位置，不引入额外抽象层

### Claude's Discretion
- node-pty 的具体配置参数（shell、env 传递策略）
- 错误信息的具体格式

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### node-pty
- `.planning/research/STACK.md` -- node-pty 版本、API 模式、构建要求
- `.planning/research/PITFALLS.md` -- node-pty 原生模块构建问题、平台差异

### Architecture
- `.planning/research/ARCHITECTURE.md` -- 三层架构设计，proxy 层职责定义
- `.planning/research/SUMMARY.md` -- 研究综合，PTY 透传方案的技术选型依据

### Protocol (from Phase 1)
- `packages/shared/src/schemas/envelope.ts` -- MessageEnvelope schema（Phase 2 不直接使用，但架构需兼容）

### Project Context
- `.planning/PROJECT.md` -- 核心价值：终端体验完全透明
- `.planning/REQUIREMENTS.md` -- PROXY-01: 本地终端体验与直接使用 claude 完全一致
- `CLAUDE.md` -- 技术栈约束和 node-pty 版本要求

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@cc-anywhere/shared` -- Phase 1 产出的共享协议库，Phase 2 暂不直接使用 schema，但 proxy 包已依赖它
- `apps/proxy/src/index.ts` -- 当前只有类型检查占位代码，将被 PTY 逻辑替换

### Established Patterns
- ESM + TypeScript (`"type": "module"`) -- 所有代码遵循此模式
- tsup 构建 -- proxy 使用 tsup 打包
- vitest 测试 -- 测试框架已配置

### Integration Points
- `apps/proxy/package.json` -- 需要添加 node-pty 依赖和 bin 入口
- `apps/proxy/src/index.ts` -- 主入口，将承载 PTY spawn 和数据管道逻辑
- Phase 3 将在此基础上添加 stream-json 并行通道和多会话管理

</code_context>

<specifics>
## Specific Ideas

- node-pty 是 Microsoft 维护的库，VS Code 终端使用的同一方案，对 ANSI 转义和终端行为的支持最完善
- 参考 CLAUDE.md 中的约束："本地代理必须对 Claude Code 原生终端体验完全透明，用户回到电脑操作时不能有任何干扰"
- cc-connect 项目的进程管理实现可作为参考（Go 实现，但生命周期管理思路通用）

</specifics>

<deferred>
## Deferred Ideas

- 多会话管理 -- Phase 3 (PROXY-03)
- stream-json 结构化控制通道 -- Phase 3 (PROXY-02)
- relay 连接和消息桥接 -- Phase 4 (RELAY-01)
- 终端和手机双表面同步 -- Phase 7 (PROXY-04)

</deferred>

---

*Phase: 02-local-proxy-pty-transparency*
*Context gathered: 2026-04-03*
