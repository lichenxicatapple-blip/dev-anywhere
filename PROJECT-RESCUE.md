# Dev Anywhere 项目救援计划

最后更新：2026-05-06

## 目的

这份文档是 Dev Anywhere 的救援边界。它的作用是阻止项目继续变成历史补丁堆，把它重新收敛成一个小而可上线的产品。

当前产品名确定为 **Dev Anywhere**，详见 `NAMING-MIGRATION.md`。新定位不是只服务 Claude Code，而是 **本地 AI CLI 透明代理 + 可选远程镜像**。首批支持 Claude Code 和 Codex；用户的日常入口应该是 `dev-anywhere` 透明代理命令，体验上尽量等价于原始 CLI（例如 `claude [args...]` 或 `codex [args...]`），但额外把本地会话桥接到 relay/web。

目标不是逐行照搬 LinkShell，也不是推翻当前产品路线。当前产品形态大方向可以保留：本地代理、relay、web/PWA 这一条路是成立的。救援重点应该放在技术差异上：为什么 LinkShell 的同类能力更稳、更容易扩展、更少靠 UI 和 PTY 兜底。

## 当前判断

Dev Anywhere 不是失败项目。它有真实资产：

- TypeScript monorepo，包含 `apps/proxy`、`apps/relay`、`apps/web` 和 `packages/shared`。
- 已经跑通的 proxy / relay / web 架构，包含 PTY 和 JSON 两条会话路径。
- xterm.js 集成、PWA 构建产物、共享 schema、relay/proxy 测试和部署材料。
- 当前基线已经恢复为绿色：unit tests、typecheck、lint 和 build 都已经通过。

项目不健康的地方主要在技术实现层：

- 当前路线可以继续：本地代理、relay 和 web/PWA 都是有价值的。真正的问题是底层能力分层不清，PTY、协议、审批、状态和恢复互相缠在一起。
- 源码可读性被规划编号和历史上下文污染过。这个问题已经开始修，但代码里仍然有一些旧架构决策散落在注释、命名和模块边界里。
- 公网部署安全不完整。`/client` token 鉴权已经补上，但 health/debug 端点、配对语义和部署默认值还需要正式审查。
- 协议边界混乱。有些消息既像 control message，又像 envelope；有些 control payload 还伪装了 envelope 字段。
- AI CLI 语义状态来源不够可靠。现在更多依赖 PTY 输出、OSC 信号、JSON 模式或 UI 状态拼接，缺少 LinkShell 那种独立 hook/status/permission 通道。
- `apps/proxy/src/serve.ts` 仍然集中了承载过多逻辑：路由、解析、生命周期、状态变更都挤在一起。
- 一些功能处于半死不活状态：生产路由里的调试页、无入口 store 字段、孤立的 file watcher、残留 UI 路径、不完整的 resume 语义。

## 技术差异

详细审计见 `TECH-DIFF-LINKSHELL.md`。本节只保留救援计划需要的摘要。

LinkShell 值得参考的重点不是产品形态，而是这些技术分层：

| 维度             | 当前项目                                                                                            | LinkShell 做法                                                                       | 救援判断                                   |
| ---------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| AI CLI 状态来源  | 主要靠 PTY 输出、OSC signal、JSON stream 或 UI/store 推断                                           | 本地 hook server 接收工具事件、权限请求、状态变化，转成 `terminal.status` 等协议消息 | 这是最大技术差异，必须优先补               |
| Provider adapter | Claude Code 逻辑散在 PTY、JSON session、history、command discovery 中；Codex 尚未形成同等级 adapter | provider 负责启动、hook 注入、事件归一化、权限桥接                                   | 应建立 Claude/Codex provider adapter 边界  |
| 权限审批         | JSON session 有 approval request 路径，PTY 路径语义不完整                                           | `PermissionRequest` hook 阻塞 HTTP 响应，远端 allow/deny 后再返回 CLI                | PTY 审批不应靠屏幕或 UI 猜测               |
| 状态协议         | 有 `pty_state`、session state、relay control 等多套状态                                             | `terminal.status` 承载 phase、tool、topPermission、permissionResolution、seq         | 应收敛出 AI CLI status channel             |
| Relay 职责       | relay 透传控制消息，但部分状态/列表语义混在 control message 里                                      | gateway 透传 envelope，同时缓存 last status 给新客户端 replay                        | relay 应少理解业务，但要支持 status replay |
| 恢复模型         | resume / ack / ring-buffer 语义还没定清楚                                                           | terminal status、snapshot、history/replay 各自职责更清晰                             | 先定义不同消息的恢复级别                   |
| PTY 责任         | PTY 承担终端显示、状态提示、部分语义识别                                                            | PTY 负责输入输出，hook 负责语义事件                                                  | PTY 专项应降级为显示质量和交互兼容问题     |
| PTY 远端输入     | Web 主入口是聊天式 `InputBar`，Enter 后把整段文本写入 PTY                                           | Web 发 `terminal.input` 原始输入，gateway 转 host，host 直接 `pty.write(data)`       | 必须补逐键 raw input，聊天框只能是辅助入口 |
| 渲染层治理       | chat view、PTY view、status line、store、dispatcher 职责交叠                                        | 状态、终端、timeline 的输入源更清楚                                                  | 需要单独治理，不能继续补丁式修 UI          |
| 架构治理         | provider、proxy service、relay、shared、web 边界持续漂移                                            | 模块 owner 和协议方向更明确                                                          | 需要单独治理，禁止继续跨层补丁             |

### Hook 机制为什么关键

LinkShell 的 hook 机制比当前实现高明的地方，在于它没有试图从终端字符流里反推 AI CLI 状态。它在本机开一个只监听 `127.0.0.1` 的 hook server，然后把 Claude Code / Codex 的 hook 配置合并到用户配置中。

本项目不能默认照搬“修改用户全局配置”的做法。透明代理应该尽量不触碰用户已有的 `~/.claude`、`~/.codex`，除非用户显式执行 setup 并确认。

技术要点：

- 优先研究进程级或会话级 hook 注入方式，例如 provider CLI 参数、环境变量、临时配置目录或项目局部配置。
- 会话级注入必须保留用户自己的设置来源，只追加 hook/status/permission 需要的临时覆盖，不能替换用户已有 settings/config。
- 如果 provider 只能通过全局配置启用 hook，全局写入必须是显式 opt-in，并且提供 dry-run、备份、回滚和状态检查。
- Claude Code hook 的全局写入目标可能是 `~/.claude/settings.json`，但只能作为 fallback。
- Codex hook 的全局写入目标可能是 `~/.codex/hooks.json` 和 `~/.codex/config.toml`，但只能作为 fallback。
- 每个 PTY/session 使用 marker，hook server 拒绝不属于当前会话的事件。
- `PreToolUse`、`PostToolUse`、`Stop`、`SessionStart`、`UserPromptSubmit` 等事件归一化为状态。
- `PermissionRequest` 不立即返回，而是挂起 HTTP 请求，等待 Web/PWA 返回 allow/deny。
- 权限请求有 pending map、timeout、drain 和 resolution result，避免远端 UI 以为审批成功但本地 CLI 没收到。

这条控制通道应该和 PTY 字节流并行存在。PTY 负责透明输入输出；hook/status/permission 负责语义事件。这样才能同时支持“透明代理”和“远程镜像”。

## 救援原则

1. 技术差异先于产品重述。当前路线可以保留，优先补 LinkShell 已验证的关键技术分层。
2. 项目名、package 名和二进制名优先定案；项目尚未上线，不保留旧名兼容包袱。
3. 没有书面边界，不做功能开发。
4. 源码注释和测试名不能依赖规划编号。
5. 每次清理都必须降低后续理解成本，或移除真实部署风险。
6. 优先删除死路径，不保留投机性的未来钩子。
7. 保留已经能工作的 proxy / relay / web 资产，除非有明确替代方案和测试路径。
8. 公网部署安全优先于 UI 打磨。
9. 架构边界不清楚时，先写治理规则再重写代码。
10. 大重构必须等 MVP 边界锁定后再做。

## 命名优先级

项目改名是第一优先级。旧名 `CC Anywhere` 已经不适合新定位，因为产品不再只围绕 Claude Code，而是要成为 Claude Code、Codex 等本地 AI CLI 的透明代理和远程镜像层。

命名迁移细节见 `NAMING-MIGRATION.md`。新产品名确定为 **Dev Anywhere**，主命令为 `dev-anywhere`。

命名专项已确定这些决策：

- 产品名：Dev Anywhere。
- npm package 名：`dev-anywhere`、`@dev-anywhere/*`。
- 主二进制命令名：`dev-anywhere`。
- 旧 `cc-anywhere` 命名的删除范围。
- 新配置目录 `~/.dev-anywhere` 和旧 `~/.cc-anywhere` 清理策略。
- 新环境变量前缀 `DEV_ANYWHERE_` 和旧前缀清理策略。
- 仓库名、文档名、部署产物名的迁移顺序。

命名约束：

- 不能绑定 Claude Code 或 Codex 任一 provider。
- 听起来应该像透明代理、会话桥接或远程镜像，而不是单一 terminal viewer。
- CLI 命令要短、可记、可读，不应和主流命令冲突。
- 项目尚未上线，不保留旧命令 alias；旧名只作为本地开发残留清理对象。

## 目标 MVP

救援后的 MVP 应该是：

1. 用户把原来的 `claude [args...]` 或 `codex [args...]` 换成透明代理入口。
2. 本地终端行为尽量保持透明：stdin/stdout、TTY 行为、Ctrl+C、窗口大小变化不被破坏。
3. 如果本地 service 未启动，新主命令可以自动拉起；如果未初始化，给出清晰引导。
4. relay/web 是附加镜像能力：本地 AI CLI 使用必须始终优先，即使 relay 掉线也不影响本地会话。
5. Web/PWA client 通过 token 或配对流程连接后，可以查看终端输出、发送输入、看到连接状态。
6. 工具审批在受支持模式下可用；不支持的模式必须明确禁用。
7. 短暂断线不会悄悄制造过期或误导性的 UI。
8. 公网 relay 部署有清楚的鉴权、TLS 反代说明和安全默认值。

明确不属于 MVP：

- 原生移动 App。
- Claude Code / Codex 之外的更多 Agent 支持。
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

### 工作流 0：技术差异审计

状态：最高优先级，进行中。

已完成：

- 第一版 `TECH-DIFF-LINKSHELL.md` 已创建，明确了必须追赶、可以清理/重写、不建议照搬三类差异。

目标：

- 逐项对比当前项目和 LinkShell 的底层技术差异。
- 把差异拆成可实现模块，而不是停留在“参考 LinkShell”。
- 先补会影响架构方向的差异：hook/status/permission、provider adapter、relay replay、PTY 职责边界。

任务：

- 画出当前项目 PTY、JSON session、relay、web store、approval 的数据流。
- 画出 LinkShell hook server、provider hook config、terminal status、permission decision 的数据流。
- 明确哪些能力应该直接移植思想，哪些不适合本项目。
- 输出第一轮技术改造顺序。

验证：

- 每个技术差异都有当前代码位置、LinkShell 参考位置、目标模块和测试方式。
- 不再用“产品体验更好”替代技术分析。

### 工作流 1：命名和迁移边界

状态：高优先级，进行中。

已完成：

- 第一版 `NAMING-MIGRATION.md` 已创建。
- 新产品名确定为 Dev Anywhere。
- 新主命令确定为 `dev-anywhere`。
- 新配置目录确定为 `~/.dev-anywhere`。
- 新环境变量前缀确定为 `DEV_ANYWHERE_`。
- 第一轮源码级迁移已完成：package、bin、workspace import、运行时路径、env、Docker、发布 workflow、Web/PWA 文案已切到新名。
- 明确不保留旧名兼容，不新增旧 bin alias，不读取旧环境变量。
- 明确 provider 历史 fixture 不做机械替换。

目标：

- 决定新产品名、package 名和主二进制名。
- 定义旧 `cc-anywhere` 命名的删除范围。
- 定义配置目录、环境变量、文档、部署产物和日志路径的迁移边界。
- 后续只剩仓库目录名、远端 repo 名、域名和发布账号层面的外部迁移。

任务：

- 补充检查 Homebrew formula 和域名冲突。
- 决定第一轮 package、bin、repo/docs 的同步迁移范围。
- 写清楚旧配置目录和旧环境变量如何清理，不做长期兼容。
- 执行外部迁移：仓库目录名、GitHub repo、域名、npm 发布权限和部署目标。

验证：

- 本地 `pnpm build` 后，新命令能输出版本和 help。
- 旧 `cc-anywhere` 命名不再出现在新文档、新 bin 和新 package 中。
- 文档里的产品名、命令名和 provider 范围一致。

### 工作流 2：架构治理

状态：高优先级，进行中。

已完成：

- 第一版 `ARCHITECTURE-GOVERNANCE.md` 已创建。
- 模块 owner、协议消息分类、状态来源规则、provider adapter contract、hook 注入策略和 review checklist 已写入。

目标：

- 防止救援过程继续变成补丁堆。
- 明确 provider adapter、hook server、permission broker、session lifecycle、relay transport、web dispatcher、render store 的所有权。
- 明确每类协议消息的方向、owner、replay/drop/ack 语义。
- 为清理和重写建立准入规则。

任务：

- 按 `ARCHITECTURE-GOVERNANCE.md` 创建第一轮 provider adapter contract。
- 按治理边界拆出 hook server 和 permission broker。
- 定义 `serve.ts` 拆分落点：启动装配留在入口，路由/hook/permission/session lifecycle 拆出。
- 在代码 review 中拦截新增跨层依赖、重复状态源、无 owner 协议消息。

验证：

- 后续新增模块都能归入一个 owner。
- 后续新增协议消息都能说明方向、owner、是否可 replay、是否可丢、是否需要 ack。
- 清理/重写任务必须同时写删除旧路径和测试方式。

### 工作流 3：安全和基线

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

### 工作流 4：可读性和死代码

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

### 工作流 5：Provider Adapter 和 Hook 通道

目标：

- 明确 Claude Code / Codex provider adapter 的技术边界。
- 明确 provider adapter 包含四件事：启动命令、参数透传、hook/status/permission 桥接、非侵入式配置注入。
- 配置、状态和排障要可见。
- 保留现有 `serve` 子命令作为辅助运维入口，而不是主用户路径。

任务：

- 梳理并文档化现有命令关系，作为改名时的删除/迁移清单。
- 决定新产品名、package 名和二进制名；项目未上线，不保留旧名 alias。
- 确认 Claude Code provider 的参数透传语义。
- 增加或确认 Codex provider 的启动、PTY 透明代理、参数透传和退出码语义。
- 设计 provider hook adapter：优先寻找不修改全局配置的 hook 注入方式。
- 如果必须写全局配置，Claude Code 的 `~/.claude/settings.json`、Codex 的 `~/.codex/hooks.json` / `config.toml` 只能走显式 setup，不能在普通会话启动时隐式修改。
- 为任何配置写入提供 dry-run、备份、回滚和 doctor 检查。
- 设计本地 hook server：只监听 `127.0.0.1`，用 session marker 拒绝非当前 PTY 的 hook event。
- 将 `PreToolUse`、`PostToolUse`、`Stop`、`SessionStart`、`UserPromptSubmit` 归一化为 terminal status。
- 将 `PermissionRequest` 作为阻塞请求处理，Web/PWA 决策返回后再响应 CLI。
- 未初始化时，决定是只提示新命令的 init，还是提供交互式 setup。
- service 未启动时，确认新主命令自动启动 service 的行为稳定且可观测。
- 增加或更新类似 `<new-bin> doctor` 的诊断命令。
- 让 `serve status`、`serve stop`、日志位置变得明确。
- 审查 `ensureService` 和 daemon 启动诊断，确保启动失败显示真实原因，而不是泛泛的 timeout。

验证：

- 本地 build/install package。
- 用新命令的 `--version`、`serve status`、`serve start/stop` 做 smoke。
- 用 mock Claude 和 mock Codex 跑透明代理 smoke，验证 stdin/stdout、Ctrl+C、resize、退出码。
- 用 mock hook event 验证 tool status、permission request、allow/deny、timeout 和退出清理。
- 验证启动失败会打印可行动的 stderr。

### 工作流 6：Web/PWA 生产形态

目标：

- 第一屏就是可用 app。
- 移除内部调试面。
- 连接和鉴权状态清楚可见。
- 渲染层职责清楚：PTY 渲染、PTY raw input、agent status、chat/tool timeline 各自有稳定输入源。

任务：

- 制定渲染层治理边界：`chat-pty-view` 只管 xterm/bytes/snapshot/resize/raw input，`status-line` 只消费 status channel，`chat-json-view` 只管 timeline。
- PTY 远端输入改为逐键 raw input 模型；聊天式 `InputBar` 在 PTY 模式只保留为批量粘贴/发送辅助入口。
- 清理组件内直接解析 relay raw message 的路径，统一走 dispatcher -> store。
- 删除没有协议来源或 UI 入口的 store 字段。
- 增加明确的 unauthenticated / invalid-token UI 状态。
- 保留 proxy selection、session list、chat 作为主路由流。
- gate dev pages。
- 修正缺失字体托管方案，或者停止在生产构建中引用缺失的 Sarasa CSS。
- 如果 gate debug pages 后 bundle 仍然过大，再做 chunk split / lazy load。

验证：

- Web package build。
- Playwright smoke 覆盖 session list 和 chat shell。
- 手动浏览器 smoke，连接本地 relay。

### 工作流 7：协议和恢复

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

1. 完成技术差异审计：当前项目数据流 vs LinkShell hook/status/permission 数据流。
2. 完成架构治理文档：模块边界、协议消息分类、重写准入规则。
3. 完成命名专项：候选名、冲突检查、package/bin/config/env 改名和旧名清理策略。
4. 补 provider adapter 设计：Claude Code / Codex 的启动、参数透传、hook/status/permission 桥接。

这些步骤的目的不是重定产品路线，而是先修正技术分层。PTY 渲染、安全端点、web dead state 仍然要做，但不能再压过 hook/status/permission 这条主技术差异。

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
