# DEV Anywhere Code Audit - 2026-05-30

## Scope

本次审查基于当前最新代码工作树，重点看三类问题：

1. 架构是否合理，尤其是 proxy/relay/web 三端职责边界。
2. 代码质量，包括坏味道、重复逻辑、魔法阈值、可读性和状态管理复杂度。
3. 测试质量，包括低价值实现细节断言、历史补丁式测试、异步测试稳定性。

UI 也按代码审查处理：不只看视觉效果，还看组件职责、主题所有权、响应式风险、可维护性。

## Verification

初始审查时已运行：

- `pnpm run lint`：通过。
- `pnpm run typecheck`：通过。
- `pnpm run knip`：通过。
- `pnpm run test:unit`：通过。
  - `packages/shared`: 141 passed.
  - `apps/web`: 843 passed.
  - `apps/relay`: 194 passed.
  - `apps/proxy`: 599 passed, 1 skipped.

修复完成后已运行当前完整 gate：

- `pnpm run quality:check`：通过。
  - `pnpm format:check`: passed.
  - `pnpm lint`: passed.
  - `pnpm typecheck`: passed.
  - `pnpm knip`: passed.
  - `pnpm test:unit`: passed.
    - `packages/shared`: 141 passed.
    - `apps/web`: 860 passed.
    - `apps/relay`: 194 passed.
    - `apps/proxy`: 613 passed, 1 skipped.

## Initial Executive Summary

初始评价：**可用，但核心交互链路的复杂度已经偏高**。普通 CRUD/配置功能问题不大，真正的风险集中在：

- Codex JSON app-server session 的启动 ready 语义不完整。
- PTY scroll/input/render 相关代码长期以补丁叠补丁方式演进，状态面过大。
- Provider event mapping、relay routing、UI settings/create-session 仍有明显集中式模块。
- 测试覆盖不少，但部分测试锁住 className、历史事故形状和固定 sleep，未来重构成本高。

健康分数：

| Dimension          |     Score | 说明                                                           |
| ------------------ | --------: | -------------------------------------------------------------- |
| Architecture       |       2/4 | 功能边界存在，但关键 runtime/PTY/UI orchestration 仍偏集中。   |
| Code Quality       |       3/4 | 静态检查已清干净，局部仍有 magic threshold 和命令式 DOM。      |
| UI Maintainability |       2/4 | 主题和组件职责需要再收敛，设置页/创建页偏重。                  |
| Test Quality       |       3/4 | 覆盖量足，但部分断言价值会随实现变化快速下降。                 |
| Operability        |       2/4 | 有诊断工具和日志，但 Codex startup failure 仍不够可解释。      |
| **Total**          | **12/20** | **Initial state: acceptable, but key paths needed hardening.** |

## Remediation Summary

本报告列出的 F-01 到 F-07 已在本轮修复并验证：

- F-01 Codex app-server startup ready/failure semantics: fixed.
- F-02 PTY scroll thresholds and decision model extraction: fixed.
- F-03 provider event mapper split: fixed.
- F-04 settings/create-session UI decomposition and relay reconnect path: fixed.
- F-05 PTY terminal theme ownership naming and comments: fixed.
- F-06 low-value implementation-detail/sleep tests: fixed.
- F-07 release quality gate now includes unit tests: fixed.

## Changes Already Made In This Pass

这些是审查过程中直接处理掉的低风险问题：

- Relay `session_sync` 改为替换 proxy 的完整 session 集合，避免 stale session 残留。
  - Code: `apps/relay/src/registry.ts:155`, `apps/relay/src/handlers/proxy.ts:174`
  - Test: `apps/relay/src/__tests__/unit/registry.test.ts:135`
- Web session store 在替换/删除 session 时同步清理 `ptyTitles`。
  - Code: `apps/web/src/stores/session-store.ts:47`
  - Test: `apps/web/src/stores/session-store.test.ts:67`
- Hosted PTY startup output preview 的 ANSI 清理正则改成构造式 RegExp，解决 lint `no-control-regex`。
  - Code: `apps/proxy/src/serve/hosted-pty-registry.ts:45`
- `scripts/tools/emu-debug.mjs` 纳入 `package.json` 脚本，并改用 Node 22+ global `WebSocket`，去掉隐式 `ws` 依赖。
  - Code: `package.json:25`, `scripts/tools/emu-debug.mjs:56`
- 清理了一批 `knip` 发现的未使用 export/type，让死代码面下降。

## Findings

### F-01 [P1] Codex app-server session 的 ready 语义会误报

Category: Architecture / Operability / Runtime correctness

Evidence:

- `apps/proxy/src/worker/codex-app-server-session.ts:109`
  - `start()` spawn 子进程后调用 `void this.initializeThread()`，没有等待初始化完成。
- `apps/proxy/src/session-worker.ts:253`
  - `session.start()` 返回 pid 后立即 `sendToServe({ type: "worker_ready", pid })`。
- `apps/proxy/src/worker/codex-app-server-session.ts:173`
  - `initializeThread()` 如果 `initialize`、`thread/start`、`thread/resume` 失败，没有把失败转成 session create failure。
- `apps/proxy/src/worker/codex-app-server-session.ts:204`
  - `request()` 写入 pending promise 后没有 timeout，也没有 child exit 时统一 reject。

Concrete failure path:

1. Codex app-server 子进程已经 spawn，所以 worker 发出 `worker_ready`。
2. 但 JSON-RPC `initialize` 或 `thread/start` 卡住、失败、或 app-server 很快退出。
3. Serve/relay/web 认为 session 已创建，前端导航到 PTY/JSON session。
4. 用户看到“终端连接已断开”或空 session；输入时 `threadReady` / pending request 可能一直悬挂。

Impact:

- 创建 Codex 会话失败时，用户得到的是连接层症状，不是 provider startup 失败原因。
- 这会让线上排查误判成 proxy/relay 网络问题。
- 和近期“创建 Codex 会话一直失败 / 终端连接已断开”的体验高度相关。

Recommended fix:

- 把 worker ready 拆成两层：
  - `process_ready`: 子进程/socket ready。
  - `provider_ready`: `initialize` + `thread/start|resume` 完成并拿到 `threadId`。
- `CodexAppServerSession.start()` 应返回 `Promise<{ pid, threadId }>` 或明确提供 `awaitReady()`。
- `request()` 加 timeout，默认 10s-15s；timeout 需要带 method/id/stderr preview。
- child exit/error 时 reject 所有 pending requests，并把 stderr preview 回传给 session create handler。
- `RelaySessionCreateHandler` 应把 provider startup error 作为 `session_create_result.error` 返回，而不是让 UI 等 socket 断开。

Acceptance criteria:

- 单测：fake app-server 不响应 `initialize`，创建会话返回明确 timeout 错误。
- 单测：fake app-server `thread/start` 前退出，pending request 被 reject。
- 单测：`worker_ready` 不等于 `session_create_result.success`。
- UI toast 能显示 `Codex 初始化失败：...` 这类具体错误。

Status:

- Fixed in `apps/proxy/src/worker/codex-app-server-session.ts`: app-server request timeout、exit-time pending rejection、`waitUntilReady()` 和 thread id 校验。
- Fixed in `apps/proxy/src/session-worker.ts` / `apps/proxy/src/serve/worker-registry.ts` / `apps/proxy/src/serve/relay-session-create-handler.ts`: Codex JSON session create now waits for provider-ready before success, and returns `WORKER_START_FAILED` on ready failure.
- Verified with `pnpm vitest run apps/proxy/src/__tests__/unit/codex-app-server-session.test.ts apps/proxy/src/__tests__/unit/relay-router-input.test.ts apps/proxy/src/__tests__/unit/worker-registry-disconnect.test.ts`.

### F-02 [P1] PTY scroll/input/render 控制器已经过度集中

Category: Architecture / UI Runtime / Maintainability

Evidence:

- `apps/web/src/lib/pty-scroll-controller.ts:78`
  - 文件顶部聚集多组 magic threshold，例如 horizontal intent、raw input layout drift、touch jump threshold。
- `apps/web/src/lib/pty-scroll-controller.ts:131`
  - 单个 controller 内维护大量 mutable state：syncing、verticalIntent、pending scroll、touch state、follow state 等。
- `apps/web/src/lib/pty-scroll-controller.ts:1598`
  - 同一模块绑定 wheel/touch/scroll/visualViewport/window sniffer/xterm onScroll/onRender/ResizeObserver。
- `apps/web/src/components/chat/use-pty-view.ts:1`
  - 注释已经说明该 hook 集中 terminal/scroll/resize/font-size/debug/link provider 等横切关注点。
- `apps/web/src/components/chat/use-pty-view.ts:87`
  - `UsePtyViewResult` 暴露 scroll、focus、selection、drag/drop、mobile input、debug 等大量接口。

Concrete problem:

当前设计让这些行为共享一组状态面：

- 用户手动滚动 vs 程序 follow cursor。
- iOS soft keyboard visualViewport resize。
- xterm render/onScroll。
- touch selection/autoscroll。
- raw input 后 follow bottom。
- debug trace/snapshot。

任一补丁都可能改变另一个路径的时序。过去的黑条、跳变、浅色残留、iPad 输入问题，本质上都在这片复杂状态区附近。

Recommended fix:

分三层拆：

1. `pty-scroll-model.ts`
   - 纯函数 reducer，只接收事件和几何快照，输出下一状态 + effect intent。
   - 不碰 DOM、不碰 xterm、不碰 visualViewport。
2. `pty-scroll-dom-adapter.ts`
   - 负责监听 DOM/xterm/visualViewport，把事件转换为 model input。
   - 负责执行 model 输出的 scrollTop/style 写入。
3. `pty-scroll-trace-adapter.ts`
   - 只负责采样和序列化诊断，不参与控制流。

Immediate cleanup before full split:

- 把所有阈值集中到 `PTY_SCROLL_CONFIG`，每个阈值旁边写“保护哪个场景”。
- 给 `syncContainerScroll`、`followCursorY`、`finishTouchGesture` 建立更窄的单元测试边界。
- 禁止新逻辑直接塞进 controller 顶层状态，除非能写出对应 invariant。

Acceptance criteria:

- PTY controller 里不再直接同时处理 visualViewport trace 和 scroll state transition。
- 事故测试从“复刻历史代码形状”转成“断言 invariant”：
  - host coverage >= 0.99。
  - programmatic scroll 不会标记 user intent。
  - touch review 时不会被 raw input follow 抢回底部。

Status:

- Fixed in `apps/web/src/lib/pty-scroll-config.ts`: scroll/touch/raw-input 阈值集中命名。
- Fixed in `apps/web/src/lib/pty-scroll-model.ts`: `followCursorY`、touch end/cancel、touch movement、vertical/horizontal touch expectation 的关键决策抽为纯模型。
- Fixed in `apps/web/src/lib/pty-scroll-trace-adapter.ts`: visualViewport trace、window wheel sniffer、trace snapshot assembly 从 controller 移出，只作为诊断边界。
- Fixed in `apps/web/src/lib/pty-scroll-dom-adapter.ts`: DOM/xterm listener binding 和 ResizeObserver 从 controller 移出，controller 保留状态转换和副作用编排。
- Fixed in `apps/web/src/lib/pty-touch-scroll-handler.ts` and `apps/web/src/lib/pty-touch-scroll-state.ts`: touch lifecycle, gesture lock, touch end/cancel release, and touch session state moved out of the main controller.
- Fixed in `apps/web/src/lib/pty-horizontal-scroll-model.ts`: horizontal scroll intent, recent-input window, native drift threshold, and programmatic follow suppression moved into a pure model.
- Fixed in `apps/web/src/lib/pty-container-scroll-model.ts`: external/programmatic/user container scroll source classification moved into a pure model.
- Verified with `pnpm vitest run apps/web/src/lib/pty-container-scroll-model.test.ts apps/web/src/lib/pty-touch-scroll-handler.test.ts apps/web/src/lib/pty-horizontal-scroll-model.test.ts apps/web/src/lib/pty-touch-scroll-state.test.ts apps/web/src/lib/pty-scroll-model.test.ts apps/web/src/lib/pty-scroll-controller.test.ts`.

### F-03 [P2] Provider event mapping 和 runtime side effect 混在一起

Category: Architecture / Testability

Evidence:

- `apps/proxy/src/serve/worker-registry.ts:416`
  - `forwardEvent()` 在 `WorkerRegistry` 里解析 Claude stream-json schema，并直接发送 relay envelope。
- `apps/proxy/src/serve/worker-registry.ts:564`
  - 同一个 class 继续解析 Codex app-server JSON-RPC notification。
- `apps/proxy/src/serve/relay-router.ts:33`
  - `RelayRouterDeps` 注入面很宽：session manager、worker registry、control handlers、relay、hosted PTY、permission、hooks、agent status、provider env 等。

Concrete problem:

`WorkerRegistry` 同时知道：

- provider event schema。
- internal envelope schema。
- compact/result lifecycle。
- relay send side effect。
- session activity touch。

这会导致 provider 协议变化时，很难只测“event A 应该映射成 envelope B”。必须绕过一堆 runtime 依赖。

Recommended fix:

- 新建纯 mapper：
  - `claude-stream-event-mapper.ts`
  - `codex-app-server-event-mapper.ts`
- mapper 输入 provider event，输出 `Array<RelayEnvelope | ControlMessage | DropReason>`。
- `WorkerRegistry` 只做：
  - parse line。
  - 调 mapper。
  - send output。
  - update activity/status。

Acceptance criteria:

- Claude text/thinking/tool_use/tool_result/result 的映射测试不需要 mock `WorkerRegistry`。
- Codex `item/started`、`item/completed`、`turn/completed` 的测试只测 mapper。
- 新 provider 加入时不需要修改 `WorkerRegistry.forwardEvent()` 主分支。

Status:

- Fixed in `apps/proxy/src/serve/claude-stream-event-mapper.ts` and `apps/proxy/src/serve/codex-app-server-event-mapper.ts`: provider event mapping moved behind pure mappers.
- Fixed in `apps/proxy/src/serve/worker-registry.ts`: registry now parses, delegates to mapper, sends mapped outputs, and keeps runtime side effects localized.
- Verified with `pnpm vitest run apps/proxy/src/__tests__/unit/claude-stream-event-mapper.test.ts apps/proxy/src/__tests__/unit/codex-app-server-event-mapper.test.ts apps/proxy/src/__tests__/unit/worker-registry-compact.test.ts apps/proxy/src/__tests__/unit/worker-registry-codex-events.test.ts apps/proxy/src/__tests__/unit/stream-json-fixtures.test.ts`.

### F-04 [P2] Settings 和 Create Session UI 组件职责过重

Category: UI Maintainability / Responsive Design

Evidence:

- `apps/web/src/components/shell/settings-dialog.tsx:146`
  - 用 `document.querySelector` + RAF 操作焦点和滚动。
- `apps/web/src/components/shell/settings-dialog.tsx:257`
  - 一个 settings dialog 同时包含服务、外观、交互、诊断、关于等 section。
- `apps/web/src/components/shell/settings-dialog.tsx:408`
  - Relay token 保存/清除后直接 `window.location.reload()`。
- `apps/web/src/components/session/create-session-dialog.tsx:92`
  - provider、mode、permission、cwd、cwd picker、CLI path editor、submit 状态全部在同一组件。
- `apps/web/src/components/session/create-session-dialog.tsx:184`
  - submit path 同时做校验、relay request、store mutation、toast、navigation、missing cwd recovery。

Concrete problem:

这些 UI 不是“视觉复杂”，而是行为复杂：

- 设置项增减会影响滚动和焦点。
- token 更新通过 reload 回避状态同步，未来 PWA/mobile 下容易显得粗暴。
- 创建 session 的 provider 可用性、CLI path 编辑、目录创建、本体 submit 混在一起，失败路径难测。

Recommended fix:

- `settings-dialog.tsx`
  - 拆 `SettingsMainView`、`RelayTokenView`、`VoiceSettingsView`、`VersionView`。
  - 用 ref/Radix focus API 替代全局 querySelector。
  - Relay token 保存后调用 reconnect action，而不是 full reload。
- `create-session-dialog.tsx`
  - 抽 `useCreateSessionForm()` 管 form state。
  - 抽 `useAgentCliStatus()` 管 provider availability 和 CLI path save。
  - `submitSessionCreate()` 只返回 result，不直接决定 UI 全部副作用。

Acceptance criteria:

- Settings 主组件不超过“视图路由 + dialog shell”的职责。
- Relay token 保存不会刷新页面。
- Create session submit 的成功、missing cwd、provider disabled、relay offline 都有独立单测。

Status:

- Fixed in `apps/web/src/components/shell/settings-dialog.tsx`: 主函数只保留 dialog shell、view routing、focus/health 副作用；菜单和版本页拆成 `SettingsMainView` / `SettingsVersionView`；Relay token 改为保存后 `reconnectRelayClient()`。
- Fixed in `apps/web/src/components/session/create-session-submit.ts`: create-session 校验、provider availability、missing cwd、成功 session payload/route 统一返回 result。
- Fixed in `apps/web/src/components/session/agent-cli-picker.tsx`: Agent CLI 选择和路径编辑 UI 从主 dialog 拆出。
- Verified with `pnpm vitest run apps/web/src/components/shell/settings-dialog.test.tsx apps/web/src/components/session/create-session-submit.test.ts apps/web/src/components/session/create-session-dialog.test.tsx`.

### F-05 [P2] PTY 外壳颜色和 ANSI 颜色表的所有权仍不够清晰

Category: Theming / UI Policy

Evidence:

- `apps/web/src/app.css:809`
  - `[data-slot="pty-terminal"]` 强制 dark background/foreground。
- `apps/web/src/app.css:814`
  - `.xterm` / `.xterm-viewport` / `.xterm-screen` 使用 `!important` dark background。
- `apps/web/src/lib/create-xterm.ts:23`
  - xterm options 直接注入固定深色 terminal profile。
- `apps/web/src/lib/xterm-theme.ts:3`
  - xterm 的默认前景/背景/光标，以及 ANSI 16 色表，现在分别声明 `XTERM_TERMINAL_PROFILE` / `XTERM_ANSI16_COLOR_PROFILE`。

Concrete problem:

之前尝试过 PTY 浅色主题，后来决定“PTY 渲染啥样就显示啥样”。这里的“显示啥样”仍然需要区分两件事：

- 终端外壳颜色：xterm 容器、viewport、screen 的背景，主要避免透明区域漏出 app 背景。
- ANSI 颜色表：远端进程如果输出 `\x1b[31m` 这种“红色”索引，终端模拟器必须把索引映射成具体 RGB；这不是兼容补丁，而是终端 profile 的基本职责。
- remote process 也可能自己输出 24-bit truecolor 或 ANSI background；这类内容应按远端输出渲染。

当线上看到“浅色块/深色块”时，很难第一眼判断是：

- app CSS。
- xterm 默认前景/背景或 ANSI 16 色表。
- remote TUI ANSI output。
- WebGL renderer 缓存。

Recommended fix:

- 明确命名，例如：
  - `terminalContainerTheme = fixed-dark-shell`
  - `ansi16ColorProfile = vscode-dark-plus`
  - `appTheme = light|dark|system`
- 在 `xterm-theme.ts` 注释里写清：ANSI 16 色表是终端 profile，不跟随 app theme；远端输出 truecolor 时由远端颜色优先。
- CSS 只负责 terminal container shell，不负责模拟 remote content。
- 如果继续保留 `!important`，必须写明是覆盖 xterm 默认 CSS，不是浅色兼容残留。

Acceptance criteria:

- 搜 `pty-terminal` 和 `xtermFixedDarkTheme` 能看到唯一的主题策略说明。
- 新人读 `create-xterm.ts` 能知道为什么浅色模式下 PTY 仍是 dark。
- 不再出现“为了 app 浅色模式去改 xterm ANSI palette”的模糊入口。

Status:

- Fixed in `apps/web/src/lib/xterm-theme.ts`: terminal profile 命名为 `fixed-dark`, ANSI 16 色表命名为 `vscode-dark-plus`, 注释明确二者不跟随 app theme。
- Fixed in `apps/web/src/app.css`: PTY shell 背景注释明确只覆盖 xterm/container 缝隙，不模拟 remote content。
- Verified with `pnpm vitest run apps/web/src/lib/xterm-theme.test.ts apps/web/src/lib/create-xterm.test.ts`.

### F-06 [P2] 测试覆盖多，但有实现细节和历史事故固化

Category: Test Quality

Evidence:

- `apps/web/src/components/chat/message-bubble.test.tsx:24`
  - 直接断言 `className` 包含布局 class。
- `apps/web/src/components/chat/message-bubble.test.tsx:271`
  - diff row 颜色通过 `bg-emerald` class 判断。
- `apps/web/src/components/chat/markdown-view.test.tsx:24`
  - XSS suite 里混入 theme class 断言。
- `apps/web/src/lib/pty-scroll-controller.test.ts:1206`
  - 历史事故场景测试很详细，但长期看会绑定当前实现模型。
- `apps/proxy/src/__tests__/unit/json-session.test.ts:113`
  - 使用 `setTimeout(50)` 等待异步事件。
- `apps/relay/src/__tests__/integration/server.test.ts:65`
  - 注册后固定 sleep。

Concrete problem:

这些测试短期很有用，但会产生两类成本：

- UI className 调整会打碎行为无关测试。
- 异步 sleep 测试在慢机器/CI 上偶发失败，或在快路径下浪费时间。
- 历史事故测试越积越多时，重构 PTY model 很难判断哪些是产品 invariant，哪些只是当时实现形状。

Recommended fix:

- UI 单测优先断言 role、可见文本、交互结果、ARIA state。
- class/token 断言只保留在极少数 design-token contract test。
- `setTimeout` 改成：
  - 等待具体 message。
  - fake timers。
  - explicit event promise。
- PTY 历史测试做一次分类：
  - `invariants`: 必须长期保留。
  - `incident-regression`: bug 修完两三个版本后可合并成 invariant。

Acceptance criteria:

- `message-bubble.test.tsx` 不再因为 Tailwind class rename 大面积失败。
- relay/proxy websocket 测试没有注册完成后固定 sleep。
- PTY 测试文件按 invariant 分组，而不是按事故时间线堆叠。

Status:

- Fixed in `apps/web/src/components/chat/message-bubble.test.tsx`: role/alignment/status/diff 断言改用 stable data attributes 和可见行为，不再断言 Tailwind class。
- Fixed in `apps/web/src/components/chat/markdown-view.test.tsx`: XSS/markdown 行为测试不再混入 theme class 断言，改用 `data-slot` / `data-wrap` / `data-overflow` contract。
- Fixed in `apps/proxy/src/__tests__/unit/json-session.test.ts` and `apps/relay/src/__tests__/integration/server.test.ts`: 固定 sleep 改成等待事件、stdin 写入或 registry 状态。
- Verified with `pnpm vitest run apps/web/src/components/chat/message-bubble.test.tsx apps/web/src/components/chat/markdown-view.test.tsx apps/proxy/src/__tests__/unit/json-session.test.ts apps/relay/src/__tests__/integration/server.test.ts`.

### F-07 [P3] Tooling 已经能抓到有用信号，应该纳入常规 gate

Category: Code Quality / Process

Evidence:

- 本次审查前 `knip` 能发现 unused script/export/type。
- 本次审查前 lint 能抓到 ANSI control regex 写法。
- 修复后 `lint`、`typecheck`、`knip`、`test:unit` 均通过。

Concrete problem:

这些不是“洁癖项”。在最近大量 PTY/theme/debug 迭代后，无用 export 和脚本会让排查时误读代码路径，以为某个诊断/兼容层仍在使用。

Recommended fix:

- 发布前 gate 至少包含：
  - `pnpm run lint`
  - `pnpm run typecheck`
  - `pnpm run knip`
  - `pnpm run test:unit`
- 如果 `knip` 因 Node 版本敏感，固定用 Node 22 跑。

Acceptance criteria:

- `docs/SCRIPTS.md` 或 release checklist 明确 knip 是常规检查。
- 新增 debug script 必须进 `package.json` 或明确放入 ignore。

Status:

- Fixed in `scripts/quality/check.sh`: `quality:check` now runs `pnpm test:unit` alongside format, lint, typecheck, and knip.
- Fixed in `docs/SCRIPTS.md`: `pnpm quality:check` documented as the regular pre-release static/unit gate, including `knip`.
- `tools:emu-debug` is listed in `package.json`, so the debug script is an intentional entry point.
- Verified with `pnpm run quality:check`.

## Remediated Work Items

### Patch 1: Codex startup hardening

Status: completed.

Files:

- `apps/proxy/src/worker/codex-app-server-session.ts`
- `apps/proxy/src/session-worker.ts`
- `apps/proxy/src/serve/worker-registry.ts`
- `apps/proxy/src/serve/relay-session-create-handler.ts`

Delivered:

- request timeout。
- child exit rejects pending requests。
- provider-ready wait path。
- create session failure returns useful error instead of surfacing only as disconnected terminal。

Verification:

- `pnpm vitest run apps/proxy/src/__tests__/unit/codex-app-server-session.test.ts apps/proxy/src/__tests__/unit/relay-router-input.test.ts apps/proxy/src/__tests__/unit/worker-registry-disconnect.test.ts`
- Covered no response, early exit, invalid thread start response, and create-session ready wait behavior.

### Patch 2: PTY scroll model extraction

Status: completed.

Files:

- `apps/web/src/lib/pty-scroll-controller.ts`
- `apps/web/src/lib/pty-scroll-model.ts`
- `apps/web/src/lib/pty-scroll-config.ts`
- `apps/web/src/lib/pty-scroll-trace-adapter.ts`
- `apps/web/src/lib/pty-scroll-dom-adapter.ts`
- `apps/web/src/lib/pty-touch-scroll-handler.ts`
- `apps/web/src/lib/pty-touch-scroll-state.ts`
- `apps/web/src/lib/pty-horizontal-scroll-model.ts`
- `apps/web/src/lib/pty-container-scroll-model.ts`

Delivered:

- named config for scroll/touch/raw-input thresholds。
- pure model for cursor-follow, touch finish, touch movement, and touch expectation decisions。
- visualViewport/window wheel trace moved behind a trace adapter。
- DOM/xterm event binding and ResizeObserver moved behind a DOM adapter。
- touch lifecycle and gesture lock moved behind a touch handler/state boundary。
- horizontal scroll intent detection moved into a pure model。
- container scroll source classification moved into a pure model。
- controller now delegates model, adapter, touch, horizontal-intent, and container-scroll source concerns instead of owning every edge directly。

Verification:

- `pnpm vitest run apps/web/src/lib/pty-container-scroll-model.test.ts apps/web/src/lib/pty-touch-scroll-handler.test.ts apps/web/src/lib/pty-horizontal-scroll-model.test.ts apps/web/src/lib/pty-touch-scroll-state.test.ts apps/web/src/lib/pty-scroll-model.test.ts apps/web/src/lib/pty-scroll-controller.test.ts`

### Patch 3: Provider event mapper split

Status: completed.

Files:

- `apps/proxy/src/serve/worker-registry.ts`
- `apps/proxy/src/serve/claude-stream-event-mapper.ts`
- `apps/proxy/src/serve/codex-app-server-event-mapper.ts`

Delivered:

- Claude mapper。
- Codex app-server mapper。
- WorkerRegistry keeps runtime side effects while protocol mapping is testable in isolation。

Verification:

- `pnpm vitest run apps/proxy/src/__tests__/unit/claude-stream-event-mapper.test.ts apps/proxy/src/__tests__/unit/codex-app-server-event-mapper.test.ts apps/proxy/src/__tests__/unit/worker-registry-compact.test.ts apps/proxy/src/__tests__/unit/worker-registry-codex-events.test.ts apps/proxy/src/__tests__/unit/stream-json-fixtures.test.ts`

### Patch 4: Settings/Create Session UI decomposition

Status: completed.

Files:

- `apps/web/src/components/shell/settings-dialog.tsx`
- `apps/web/src/components/session/create-session-dialog.tsx`
- `apps/web/src/components/session/create-session-submit.ts`
- `apps/web/src/components/session/agent-cli-picker.tsx`

Delivered:

- split settings main/version views。
- removed global querySelector focus handling。
- replaced relay token full reload with reconnect path。
- extracted create-session submit model and Agent CLI picker。

Verification:

- `pnpm vitest run apps/web/src/components/shell/settings-dialog.test.tsx apps/web/src/components/session/create-session-submit.test.ts apps/web/src/components/session/create-session-dialog.test.tsx`

### Patch 5: Test quality cleanup

Status: completed.

Files:

- `apps/web/src/components/chat/message-bubble.test.tsx`
- `apps/web/src/components/chat/markdown-view.test.tsx`
- `apps/proxy/src/__tests__/unit/json-session.test.ts`
- `apps/relay/src/__tests__/integration/server.test.ts`

Delivered:

- reduced Tailwind class assertions in behavior tests。
- replaced fixed sleep with explicit event/state waits。
- added stable component data attributes where a small contract is useful。

Verification:

- `pnpm vitest run apps/web/src/components/chat/message-bubble.test.tsx apps/web/src/components/chat/markdown-view.test.tsx apps/proxy/src/__tests__/unit/json-session.test.ts apps/relay/src/__tests__/integration/server.test.ts`

### Patch 6: Terminal theme ownership clarification

Status: completed.

Files:

- `apps/web/src/lib/xterm-theme.ts`
- `apps/web/src/lib/create-xterm.ts`
- `apps/web/src/app.css`

Delivered:

- xterm terminal shell profile named `fixed-dark`。
- ANSI 16-color profile named `vscode-dark-plus`。
- comments clarify that app theme does not recolor PTY output; remote truecolor/background output remains owned by the remote process。

Verification:

- `pnpm vitest run apps/web/src/lib/xterm-theme.test.ts apps/web/src/lib/create-xterm.test.ts`

### Patch 7: Quality gate hardening

Status: completed.

Files:

- `scripts/quality/check.sh`
- `docs/SCRIPTS.md`
- `package.json`

Delivered:

- `pnpm quality:check` now includes `pnpm test:unit`。
- release script docs now describe format, lint, typecheck, knip, and unit tests as the regular pre-release gate。
- emulator debug script is an intentional package script entry。

Verification:

- `pnpm run quality:check`

## Positive Findings

- 项目已有比较完整的 unit test 覆盖，尤其是 PTY 历史事故覆盖不算少。
- `docs/known-issues/` 的 PTY 现场 playbook 是对的方向，后续复杂问题不应该靠猜。
- Provider/relay/session 类型整体比纯字符串拼接好，已经有 schema/adapter 基础，适合继续拆 mapper。
- 近期引入的 emulator debug script 有价值；这类工具应该保留，但必须进正式脚本入口和检查体系。

## Final Assessment

初始审查指出的问题已经按优先级处理完。PTY scroll controller 的高风险状态面已经拆分：trace、DOM/xterm listener、touch lifecycle、horizontal intent、container scroll source classification、cursor/touch decision model 都有独立边界和测试。当前不再存在“单个 controller 同时拥有所有事故补丁状态”的主要风险。

以当前修复范围看，发布前 gate 已覆盖格式、lint、typecheck、knip 和完整 unit suite。
