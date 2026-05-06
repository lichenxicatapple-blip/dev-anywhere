# CC Anywhere 项目救援计划

最后更新：2026-05-06

## 目的

这份文档是 CC Anywhere 的救援边界。它的作用是阻止项目继续变成历史补丁堆，把它重新收敛成一个小而可上线的产品。

目标不是逐行照搬 LinkShell，而是吸收它的产品化经验：清晰的用户路径、安全的公网部署、可靠的本地 CLI 行为，以及不需要读规划历史也能跑起来的文档。

## 当前判断

CC Anywhere 不是失败项目。它有真实资产：

- TypeScript monorepo，包含 `apps/proxy`、`apps/relay`、`apps/web` 和 `packages/shared`。
- 已经跑通的 proxy / relay / web 架构，包含 PTY 和 JSON 两条会话路径。
- xterm.js 集成、PWA 构建产物、共享 schema、relay/proxy 测试和部署材料。
- 当前基线已经恢复为绿色：unit tests、typecheck、lint 和 build 都已经通过。

项目不健康的地方主要在这些方面：

- 产品形态不清晰。它同时想做透明 Claude Code proxy、Web PWA、relay server、session manager、审批 UI 和未来通知系统。
- 源码可读性被规划编号和历史上下文污染过。这个问题已经开始修，但代码里仍然有一些旧架构决策散落在注释、命名和模块边界里。
- 公网部署安全不完整。`/client` token 鉴权已经补上，但 health/debug 端点、配对语义和部署默认值还需要正式审查。
- 协议边界混乱。有些消息既像 control message，又像 envelope；有些 control payload 还伪装了 envelope 字段。
- `apps/proxy/src/serve.ts` 仍然集中了承载过多逻辑：路由、解析、生命周期、状态变更都挤在一起。
- 一些功能处于半死不活状态：生产路由里的调试页、无入口 store 字段、孤立的 file watcher、残留 UI 路径、不完整的 resume 语义。

## 从 LinkShell 吸收什么

LinkShell 更强的地方，是它有完整用户旅程：

- `linkshell start --daemon --provider claude` 是明确的主入口。
- 默认内置 gateway，独立公网 gateway 是高级部署路径。
- 配对流程是显式、面向用户的。
- mobile/web client 围绕连接、终端展示、输入和恢复做成了产品路径。
- 文档、安装、发布产物、排障说明都是产品的一部分，而不是事后补丁。

CC Anywhere 应该吸收这些思路，但不一定照搬技术栈：

- 本地侧应该有一个明确命令启动。
- 公网 relay 默认必须安全，或者在不安全时明确报警。
- 配对和鉴权必须让用户能理解。
- Web/PWA 应先成为可用主客户端，再加高级能力。
- 调试工具只能出现在开发环境。

## 救援原则

1. 没有书面边界，不做功能开发。
2. 源码注释和测试名不能依赖规划编号。
3. 每次清理都必须降低后续理解成本，或移除真实部署风险。
4. 优先删除死路径，不保留投机性的未来钩子。
5. 保留已经能工作的 proxy / relay / web 资产，除非有明确替代方案和测试路径。
6. 公网部署安全优先于 UI 打磨。
7. 大重构必须等 MVP 边界锁定后再做。

## 目标 MVP

救援后的 MVP 应该是：

1. 用户运行一个本地 CLI 命令，启动或接入 Claude Code 会话。
2. 本地 proxy 连接到 relay。
3. Web/PWA client 通过 token 或配对流程连接。
4. 用户可以查看终端输出、发送输入、用 Ctrl+C 中断，并看到连接状态。
5. 工具审批在受支持模式下可用；不支持的模式必须明确禁用。
6. 短暂断线不会悄悄制造过期或误导性的 UI。
7. 公网 relay 部署有清楚的鉴权、TLS 反代说明和安全默认值。

明确不属于 MVP：

- 原生移动 App。
- Claude Code 之外的多 Agent 支持。
- 完整 OAuth / 用户账户系统。
- 多人协作。
- Push notification。
- 语音输入/输出。
- 完整历史终端 replay UI。
- Redis 或多实例 relay 扩展。

## 保留、删除、延后重写

### 保留

- Monorepo 结构。
- shared schema 包。
- relay / proxy 分层。
- React web/PWA 方向。
- xterm.js 终端渲染。
- 现有 unit / integration 测试基础设施。
- 现有部署脚本，但要经过安全和文档审查。

### 删除或只在开发环境开放

- 生产环境访问调试路由：`/pty-test`、`/tokens`、`/markdown-test`。
- 没有用户流程的死 UI state 和组件。
- 孤立的 file watcher / 目录列表实现，除非它们被接入当前 picker。
- 源码和测试名里的历史规划引用。现在 lint 已经对 `apps/` 和 `packages/` 做了防回归检查。
- 把旧 Feishu/Taro 里程碑描述成当前状态的文档。

### 延后重写

- `apps/proxy/src/serve.ts` 的 router / lifecycle 拆分。
- `session_list` 和 envelope-shaped control messages 的协议命名清理。
- resume / ack / ring-buffer 模型。
- 静态 client token 之外的正式配对流程。
- terminal reconnect 状态模型。

这些重写都重要，但如果在 MVP 形态固定前就做，会重复当前项目的问题。

## 工作流

### 工作流 1：安全和基线

状态：已开始。

目标：

- 保持 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test:unit` 全绿。
- 阻止源码和测试文件再次出现不透明规划编号。
- 公网 relay 部署时，`/client` 可以要求 token 鉴权。
- 文档中明确 `RELAY_PROXY_TOKEN` 和 `RELAY_CLIENT_TOKEN`。

已完成：

- dev child process 启动改为 `node --import tsx`。
- approval request 单测不再写真实用户目录 `~/.cc-anywhere`。
- `/client` 可以通过 `RELAY_CLIENT_TOKEN` 保护。
- `apps/` 和 `packages/` 内源码/测试规划编号已经清理。
- `pnpm lint` 已包含 `scripts/check-source-comment-refs.mjs`。

下一步：

- 审查未鉴权 HTTP 端点：`/status`、`/api/proxies`、`/api/clients`。
- 对敏感 HTTP 端点增加生产警告或鉴权。
- 确认 Docker/env 示例同时设置两个 relay token。

### 工作流 2：可读性和死代码

目标：

- 源码不依赖 `.planning` 上下文也能读懂。
- 删除死功能和误导性功能。
- 阻止开发调试页进入生产环境。

任务：

- 用 `import.meta.env.DEV` gate 调试路由。
- 审查 `QuotePreviewBar` 和 quoted-message state；如果仍然没有入口，就删除。
- 审查 `tool_result`、tool-call store methods、dispatcher handlers；要么补 proxy emission，要么删除死路径。
- 如果真正生效的是 server-side whitelist，就删除 `ToolApprovalCard` 里误导性的 localStorage whitelist。
- 删除仍未使用的 store 字段，例如 `command-store.lastUpdated`。
- 在 FileWatcher 和当前 `scanDir` 之间做选择，只保留一条路径。

验证：

- Unit tests。
- Web build。
- 针对路由可用性和 chat page 加一个小范围 e2e smoke。

### 工作流 3：产品入口

目标：

- 本地命令流程要像产品，而不是开发测试入口。
- 配置、状态和排障要可见。

任务：

- 定义主命令。候选：`cc-anywhere start --daemon --provider claude`。
- 决定 MVP 是否始终使用外部 relay，还是 proxy 可启动内置 relay 用于 LAN/dev 模式。
- 增加或更新类似 `cc-anywhere doctor` 的诊断命令。
- 让 `status`、`stop`、日志位置变得明确。
- 审查 `ensureService` 和 daemon 启动诊断，确保启动失败显示真实原因，而不是泛泛的 timeout。

验证：

- 本地 build/install package。
- 用安全 provider（例如 shell/custom command）跑 start/status/stop smoke。
- 验证启动失败会打印可行动的 stderr。

### 工作流 4：Web/PWA 生产形态

目标：

- 第一屏就是可用 app。
- 移除内部调试面。
- 连接和鉴权状态清楚可见。

任务：

- 增加明确的 unauthenticated / invalid-token UI 状态。
- 保留 proxy selection、session list、chat 作为主路由流。
- gate dev pages。
- 修正缺失字体托管方案，或者停止在生产构建中引用缺失的 Sarasa CSS。
- 如果 gate debug pages 后 bundle 仍然过大，再做 chunk split / lazy load。

验证：

- `pnpm --filter @cc-anywhere/web build`。
- Playwright smoke 覆盖 session list 和 chat shell。
- 手动浏览器 smoke，连接本地 relay。

### 工作流 5：协议和恢复

目标：

- 在继续加功能前降低协议歧义。
- 断线行为必须真实、可恢复、不误导用户。

任务：

- 重命名或 strict-parse 冲突的 control/envelope 类型。
- 停止在 control messages 上伪造 envelope 字段。
- 每条 session 路径只保留一个 seq owner。
- terminal/proxy reconnect 耗尽时必须让用户可见。
- 明确定义 PTY 和 JSON sessions 各自的 recovery 语义。

验证：

- Shared schema tests。
- Relay routing tests。
- Proxy session lifecycle tests。
- 手动断线/重连 smoke。

## 立即下一步

接下来三轮实现建议是：

1. Gate web debug routes，并验证生产 bundle 行为。
2. 审查并删除最小的 dead web state 路径。
3. 保护或隐藏敏感 relay HTTP status endpoints。

这些步骤刻意比协议大重构更小。它们能先降低噪声和风险，同时保持项目可发布。

## 提交和验证策略

每一轮都应该以这些动作收尾：

- 一个聚焦提交。
- `pnpm format:check`。
- `pnpm lint`。
- `pnpm typecheck`。
- 最小相关测试。
- 修改 shared behavior 或 stores 时跑 `pnpm test:unit`。

不要把 cleanup、产品行为、协议重构塞进同一个提交。

## 当前救援日志

- `7080e17` 修复 dev child process 启动和 seq test isolation。
- `90b7de3` 给 relay `/client` 增加可选 client token auth。
- `fb5b8a1` 清理源码/测试中的不透明规划编号，并增加 lint guard。
