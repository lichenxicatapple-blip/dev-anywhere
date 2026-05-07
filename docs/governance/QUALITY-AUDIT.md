# DEV Anywhere 质量专项审计报告

更新时间：2026-05-07

## 结论

项目已经具备“初步能用”的主链路，但还没有达到“可发布可信”的质量水平。当前最值得投入的不是继续堆 UI 小修，而是建立三条质量主线：

1. 协议和状态单一事实来源：防止 session、pty_state、agent_status、审批队列之间再次状态分裂。
2. 可控混沌测试：系统性验证 relay/proxy/web/provider 在断线、重连、乱序、进程退出、审批中刷新时的行为。
3. 测试用例革命：删除或重写只锁文案/样式/实现细节的低质测试，把测试预算集中到真实不变量。

## 风险分级

### P0：发布前必须处理

| 编号     | 问题                                                                                       | 证据                                                                                                                                                                                            | 风险                                                                                      | 建议                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| QA-P0-01 | Web 对 relay 请求没有超时/取消机制，部分 Promise 可永久悬挂。                              | `RelayClient.requestProxyList()` 和 `selectProxy()` 只等待对应响应，不设 timeout，也不监听连接关闭；见 `apps/web/src/services/relay-client.ts:63`、`apps/web/src/services/relay-client.ts:85`。 | relay/proxy 断线、响应丢失或乱序时，UI 可能卡在创建/绑定/选择状态，用户只能刷新。         | 给 relay request 建统一 `requestId + timeout + abort on disconnect` 层；禁止业务组件直接等待裸 `proxy_select_response`。       |
| QA-P0-02 | relay 恢复协议名义上有 seq/replay，但实现已变成“relay 无状态 + proxy 重推”，两套概念并存。 | 审计时发现 `client_register` 携带 sessions seq、`proxy_register_response.sessions` 存在、`replay_request` 固定返回 `gap_unrecoverable`。                                                        | 后续维护者会误以为 relay 支持增量恢复；chaos 下可能出现“以为能恢复但实际只能重拉”的误判。 | 已砍掉假 replay 语义，明确 relay 只做在线路由；恢复统一走 proxy 的 snapshot/session_list/agent_status/pending_approvals 重推。 |
| QA-P0-03 | E2E 测试已经落后于当前 UI 文案，会误报或被长期跳过。                                       | `functional-walkthrough.spec.ts` 仍查找 `交互模式`、`JSON`、`PTY`；当前 UI 已改为 `会话模式`、`聊天模式`、`终端模式`；见 `apps/web/e2e/functional-walkthrough.spec.ts:45`。                     | 最关键的人类路径测试无法稳定守护新建会话、PTY raw input、审批、终止等核心链路。           | 先修 E2E 语义选择器，减少文案耦合；把它提升为发布前必跑 smoke。                                                                |

### P1：下一轮优先治理

| 编号     | 问题                                                                                        | 证据                                                                                                                                                                 | 风险                                                                | 建议                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| QA-P1-01 | session 展示状态仍是多源合成，虽然集中在 `resolveSessionDisplayState`，但缺少跨源冲突审计。 | `session.state`、`ptyState.state`、`agentStatus.phase`、`hasPendingApproval` 同时参与展示；见 `apps/web/src/lib/session-display-state.ts:14`。                       | 再次出现“列表空闲、banner 等审批”这类分裂时，测试不一定抓得到。     | 定义 display state 优先级表和冲突日志；新增矩阵测试：每个 provider/mode/state 输入组合只有一个输出。               |
| QA-P1-02 | PTY 审批识别仍依赖屏幕文案和 OSC 混合推断。                                                 | `HostedPtyRegistry.snapshot()` 和 `handleData()` 调用 `hasPtyApprovalPrompt()` 扫当前输出/序列化屏幕；见 `apps/proxy/src/serve/hosted-pty-registry.ts:181`、`:223`。 | Claude/Codex 文案变化、国际化、屏幕滚动位置变化都可能误判等待审批。 | 抽象 provider-specific approval detector，文案匹配只能作为弱信号；强信号优先来自 provider hook/permission broker。 |
| QA-P1-03 | JSON session create 失败路径可能残留 worker 进程。                                          | 审计时发现 `workerRegistry.spawn()` 先启动进程；20 次连接失败后只返回 `Worker failed to start`，没有显式 kill pending worker。                                       | 异常启动或 socket 建立失败时可能留下孤儿进程/目录，污染后续排查。   | 已在 create 超时路径补 pending cleanup：终止 worker、清 session dir、撤销 hook binding、清审批/状态。              |
| QA-P1-04 | relay/proxy 控制消息缺少 requestId，广播响应与请求无法精确配对。                            | `proxy_select_response`、`dir_list_response`、`session_create_response` 没有 requestId；见 shared relay-control schema。                                             | 多个并发创建/目录请求/选择 proxy 时，Web 只能按 type 抢第一个响应。 | 为 client->proxy 请求统一加 `requestId`，响应必须 echo；兼容期可以短，但旧名不用长期保留。                         |
| QA-P1-05 | Hook 输出协议对 provider 版本敏感，需要专门 contract tests。                                | Claude/Codex hook forwarder 自行生成 JSON/TOML/command output；见 `apps/proxy/src/providers/claude.ts`、`apps/proxy/src/providers/codex.ts`。                        | provider 升级后可能再次出现 “hook returned invalid JSON output”。   | 已补 Claude/Codex 中性 hook 响应 contract：非决策生命周期 hook 输出空 stdout，避免 provider 误判非法 JSON。        |

### P2：可以排队但不应遗忘

| 编号     | 问题                                                                  | 证据                                                   | 风险                                 | 建议                                                     |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------- |
| QA-P2-01 | 文档和注释仍混用 Proxy/PTY/JSON 等内部词，UI 已治理但工程语义未统一。 | `rg` 仍能在 web comments/debug page 中看到大量内部词。 | 对新人理解成本高，但不直接影响用户。 | 下一轮文档治理时统一术语表：用户词、协议词、代码词分层。 |
| QA-P2-02 | 本地脚本已改善，但 dev-health 文案仍有旧 UI 提示。                    | `scripts/dev-health.sh` 仍提示“交互模式 PTY”。         | 人工验证时会误导。                   | 脚本和 LOCAL-SMOKE 跟随 UI 文案更新。                    |

## 测试用例革命

### 保留并强化的测试类型

| 类型                         | 价值                                                 | 代表                                                                                     |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 协议 schema/builders 测试    | 防止 shared 契约漂移。                               | `packages/shared/src/schemas/**`                                                         |
| 状态机和生命周期测试         | 守住 mode/provider/session 关键转换。                | `session-manager.test.ts`、`session-display-state.test.ts`                               |
| PTY 核心算法测试             | resize、scroll、recovery、raw input 都是高风险代码。 | `pty-recovery.test.ts`、`pty-session-transport.test.ts`、`pty-scroll-controller.test.ts` |
| relay/proxy 真实进程集成测试 | 能覆盖 WebSocket、进程重启、真实端口。               | `relay-resilience.test.ts`                                                               |

### 应删除或重写的低质测试

| 测试                                               | 问题                                                                 | 处理                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/web/e2e/smoke.spec.ts`                       | 只断言 body 可见，几乎不提供质量信号；注释也写着“后续 plan 会替换”。 | 删除，或并入真正 smoke：能连 fake relay、展示会话、打开 chat。       |
| `apps/web/e2e/toast.spec.ts`                       | 主要测试 Sonner portal 是否挂载，和核心产品风险弱相关。              | 降级为组件级测试，E2E 预算留给真实链路。                             |
| `apps/web/src/__tests__/unit/theme-tokens.test.ts` | 大量读源码字符串和 CSS token，易因设计微调制造噪声。                 | 已删除；设计风险交给字体、xterm theme、Markdown 表格和后续截图测试。 |
| `apps/web/e2e/functional-walkthrough.spec.ts`      | 价值高，但现在耦合文案且已过期。                                     | 重写为语义路径测试：用 data-slot/role，不绑 PTY/JSON 文案。          |

### 需要新增的高质量测试

1. Web request timeout contract：`selectProxy`、`session_create`、`dir_list_request` 在响应缺失/WS close 时必须解锁 UI。
2. Display state matrix：session/pty_state/agent_status/pending approvals 输入组合覆盖 Claude/Codex、PTY/JSON。
3. Hosted PTY lifecycle：创建失败、子进程退出、终止、刷新后 subscribe snapshot 的资源清理。
4. Approval contract：hook request、worker request、pending replay、allow/deny、duplicate request、session cleanup。
5. Provider hook fixtures：Claude/Codex 各 hook event 的 stdout 是否符合 provider 期望。

## 代码风格与可维护性审计

这里的“风格”不是缩进和分号。Prettier、ESLint、strict TypeScript 已经存在，提交 hook 也会跑格式、lint、typecheck、knip。真正影响质量的是模块边界、错误模型、文件粒度、命名一致性和注释可信度。

### 当前做得好的部分

| 项                                        | 评价                                                                      | 证据                                               |
| ----------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| TypeScript 基础质量                       | `strict`、`isolatedModules`、project references 已开启。                  | `tsconfig.base.json`                               |
| 进程边界有 lint 约束                      | terminal/serve/worker/common/ipc 之间有 `no-restricted-imports`。         | `eslint.config.js`                                 |
| 日志有 run-specific 文件和 latest symlink | 日志已不是单文件无限追加。                                                | `packages/shared/src/logger.ts`                    |
| 领域算法有拆分趋势                        | PTY scroll/recovery/input、provider、hook、permission 已经不是全塞进 UI。 | `apps/web/src/lib/pty-*`、`apps/proxy/src/serve/*` |

### 需要治理的代码风格问题

| 编号         | 问题                                                            | 证据                                                                                                                                                                                                                                                                       | 风险                                                             | 建议                                                                                                      |
| ------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| STYLE-P1-01  | `apps/proxy/src/serve.ts` 已完成入口拆分，但 relay 装配仍偏重。 | 本轮已把会话广播、服务文件清理、本地 terminal IPC、provider hook runtime 搬到 `serve/session-broadcast.ts`、`serve/service-files.ts`、`serve/terminal-ipc.ts`、`serve/provider-hook-runtime.ts`；`serve.ts` 从约 800 行降到约 275 行。                                     | 后续 relay/runtime/session wiring 继续增长时仍可能回到入口膨胀。 | 暂不硬拆 relay 装配；除非能形成清晰生命周期边界，否则保持在入口可见。                                     |
| STYLE-P1-01b | `RelayRouter` 已完成第一轮协议域拆分。                          | 本轮把资源请求、输入路由、权限决策、session create、历史消息请求拆到 `relay-resource-handlers.ts`、`relay-input-handlers.ts`、`relay-permission-handlers.ts`、`relay-session-create-handler.ts`、`relay-history-handlers.ts`；`relay-router.ts` 从约 729 行降到约 282 行。 | session create 仍是副作用密集边界，后续变更仍需重点测试。        | 暂停继续按 handler 小拆；后续若治理 session create，应围绕 JSON create / hosted PTY create 的事务边界拆。 |
| STYLE-P1-02  | 业务代码里仍有未接入功能占位，会制造“能点但不可用”的产品噪声。  | ChatHeader 的重命名/复制占位已删除；后续仍需防止未接协议的入口进入主 UI。                                                                                                                                                                                                  | 用户误触后创建错误会话，或误以为功能坏了。                       | 未实现功能不要展示；或者接完整协议。                                                                      |
| STYLE-P1-03  | request/response 没有统一错误模型，很多地方靠字符串判断。       | Web 里 `phase-machine` 用 `includes("not found")` / `includes("not online")` 映射 UI 文案。                                                                                                                                                                                | 错误文案一改，UI 行为就变。多语言/品牌文案也会污染协议层。       | shared 定义 `error.code`，UI 只映射 code，不解析 message。                                                |
| STYLE-P1-04  | 注释中残留阶段编号/历史计划词，降低可信度。                     | 本轮已清理 Playwright 配置中的历史 Plan 编号、message queue 的“预留”说法、thinking 注释中的“后续”施工痕迹；仍需继续扫描。                                                                                                                                                  | 新人会把历史施工记录误读成当前架构约束。                         | 注释只保留“为什么”，删除计划编号、临时施工痕迹。                                                          |
| STYLE-P1-05  | 测试里 `as unknown as` mock 较多，类型质量被测试层绕开。        | 本轮已为 proxy unit 测试建立 `test-fakes.ts`，集中封装 RelayConnection、WorkerRegistry、Socket、SessionManager、JsonObserver、ChildProcess、terminal stream、Logger 等边界 fake；高频测试文件不再散落这些双重 cast。                                                       | 测试可能没有跟真实接口同步，重构时给出假安全感。                 | 新增边界 fake 必须优先进入 `test-fakes.ts`，测试文件只表达行为断言。                                      |
| STYLE-P2-01  | 部分 UI 测试读取源码字符串断言 class/token。                    | `theme-tokens.test.ts` 已删除；设计风险交给字体、xterm theme、Markdown 表格和后续截图测试。                                                                                                                                                                                | 改实现细节会炸测试，但用户行为没变。                             | 设计契约测试应尽量渲染组件或截图，不读源码。                                                              |
| STYLE-P2-02  | 内部术语和用户术语混用仍存在。                                  | UI 已改成“电脑/终端/聊天”，代码注释和 debug page 仍大量出现 Proxy/PTY/JSON。                                                                                                                                                                                               | 不影响运行，但会拖慢维护。                                       | 建术语表：用户文案、协议字段、代码模块名三层分别约束。                                                    |

### 风格治理准则

1. 文件超过 400 行需要有明确理由；超过 600 行默认进入拆分候选。
2. 业务组件不得发裸协议请求并等待裸 type response；必须走 typed request client。
3. UI 不解析英文错误字符串；协议错误必须有 code。
4. 未实现功能不进入主 UI；占位 toast 不算功能。
5. 注释不记录“当时怎么施工”，只记录“现在为什么这样设计”。
6. 测试禁止为了方便滥用 `as unknown as`；高频 fake 必须封装。

## Chaos Monkey 方案

### 原则

Chaos Monkey 不是随机把系统搞坏，而是验证不变量：

- UI 不永久卡住。
- 会话状态不分裂。
- hosted PTY 终止必须清理。
- local-terminal 只能 detach，不能误杀本地 CLI。
- 审批中刷新后必须能恢复或明确显示不可恢复。
- relay/proxy 断线后必须能恢复到可解释状态。

### 第一版 harness

建议放在 `apps/web/e2e/chaos.spec.ts` 和 `apps/proxy/src/__tests__/integration/chaos-*.test.ts`：

| 场景                                  | 注入点                                                     | 期望                                                 |
| ------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| relay close during `session_create`   | FakeRelay 不返回 response 或主动 close                     | 创建按钮解锁，toast 明确失败。                       |
| `proxy_select_response` 丢失          | FakeRelay drop response                                    | 选择电脑不永久 pending。                             |
| `session_list` 和 `agent_status` 乱序 | FakeRelay 先发 stale agent_status 再发 session_list        | 不显示不存在 session 的状态。                        |
| PTY subscribe snapshot 超时           | 不返回 `session_snapshot`                                  | 显示终端暂未响应，允许重试。                         |
| 审批中刷新                            | pending_approvals_push / pty_state / agent_status 分别缺失 | UI 状态符合优先级表，不出现空闲+等待审批分裂。       |
| hosted PTY 子进程退出                 | proxy integration fake pty exit                            | session 从列表移除或显示终止，无残留 input surface。 |

## 建议执行顺序

1. 修复过期 E2E，删除最低价值 smoke/toast E2E。
2. 给 Web relay request 层加 requestId/timeout/close cleanup。
3. 固化 display state matrix，并在 UI 只消费一个 display state。
4. 做第一版 chaos harness，先覆盖 Web + FakeRelay。
5. 再做 proxy/relay 进程级 chaos，覆盖真实 WebSocket 和子进程生命周期。

## 本轮未直接修改的问题

本报告是第一轮审计，不直接重构代码。原因是当前风险横跨 shared/relay/proxy/web/test，多点同时改容易再次形成补丁堆。下一轮应按 P0 顺序逐项落地，每项都配套测试删改。

## 执行记录

### 2026-05-07 第一轮

已完成：

- `RelayClient` 增加统一等待层：`proxy_list_request`、`proxy_select`、`dir_create_request` 已具备 timeout 和断线失败返回，不再永久悬挂。
- `proxy_list`、`proxy_select`、`dir_create`、`session_create` 补齐 `requestId`，Web 只消费同一个请求对应的响应。
- 新建会话补齐“目录不存在 -> 创建目录 -> 继续创建会话”的用户路径。
- `functional-walkthrough` 更新到当前 UI 文案和终止确认流程，并新增缺失目录创建 E2E。
- `create-session-dialog` 组件测试覆盖缺失目录创建和重试。
- `RelayClient` 单测覆盖正常响应、超时、断线发送失败、目录创建响应匹配。
- `session-display-state` 增加状态优先级矩阵测试，锁定断线/终止 > 审批 > 工作 > 空闲。
- relay 删除假 `replay_request` / `gap_unrecoverable` / per-session seq 水位协议，重连恢复统一改为 proxy-driven snapshot。
- JSON session 创建失败路径补齐 pending cleanup，worker 连接超时后会终止 pending worker、清理 session 目录和 hook/审批/状态残留。
- provider hook 中性响应改为空 stdout，避免 Claude 对 `SessionStart` / `UserPromptSubmit` / `Stop` 报 invalid JSON；补充 hook contract 测试。
- 删除低价值 E2E：`smoke.spec.ts`、`toast.spec.ts`。

仍未完成：

- request/response 还没有全量 `requestId` 配对；历史、资源、目录列表等非阻塞请求仍待后续统一。
- `theme-tokens.test.ts` 已清理；后续还需继续审查源码字符串/实现细节类测试。
- proxy 进程级 chaos 还未落地。
