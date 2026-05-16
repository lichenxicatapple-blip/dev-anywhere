# 更新日志

本项目所有可见的变更都记录在这个文件里。每条聚焦用户可感知的影响；根因分析、commit hash、文件路径等实现细节请查 git log 与 PR 描述。

`1.0.0` 之前遵循语义化版本：minor 版本可能包含 breaking change，patch 版本只做兼容修复。

## [0.3.2] - 2026-05-16

### 可观测性

- PTY 跟随光标滚动诊断 trace 增补 raw input follow 的 scheduled/fire 事件、same-row skip 记录、`cursorDeltaRows` 与 `scrollDeltaToAnchor` 摘要和列，方便定位“输入后是否真的触发跟随、光标是否变化、离目标锚点差多少”。
- 发布脚本新增紧急发布模式 `--emergency` / `RELEASE_EMERGENCY=1`，保留 `release:check` 构建与打包门禁，但跳过耗时的 `release:smoke`，用于快速上线诊断类补丁。

## [0.3.1] - 2026-05-16

### 修复

- VPS 部署流程改为宿主机 nginx 统一占用公网 `80/443` 并反向代理 DEV Anywhere，Docker 内的 relay/web 仅绑定 `127.0.0.1` 本地端口，避免后续在同一 VPS 上新增服务时争抢公网端口。
- JSON 模式消息中的裸域名（如 `status.claude.com`）不再被误识别为可下载文件路径，避免显示下载图标或触发错误下载；裸域名现在作为网页链接渲染，移动端点按打开，桌面端需 Cmd/Ctrl+点击打开。
- JSON 模式工具审批通过后，会话立即从等待审批切回响应中状态，避免黄色状态灯带和 thinking 状态一直等到最终回复才更新。
- 移动端会话菜单的字号 stepper 改为紧凑布局，避免“聊天字号/终端字号”换行。
- 移动端会话菜单打开后，点按页面空白区域可正常关闭菜单。
- 移动端 PTY 支持长按进入终端选区、拖动选择跨行区间，并在选区旁显示复制按钮；JSON 模式继续使用浏览器原生文本选择。

## [0.3.0] - 2026-05-16

### 新增

- PTY 会话保活与快速切换。切换会话时保留近期 PTY 视图与终端实例, 回到会话可直接恢复 live 画面; 缓存按 LRU 汰换, 硬刷新进入 PTY 会话不再出现空白页。
- 会话重命名。会话菜单支持重命名, 用户命名后标题不再被 Claude/Codex 的终端标题覆盖; PTY 重连与 proxy 重启后仍保留用户命名, 侧边栏悬停继续展示原始工作目录。

### 变更

- 会话菜单统一图标、分组与字号步进器布局; “屏幕常亮”并入会话组, 设置页新增“语音识别及合成”入口并将版本信息移到底部。
- Back to bottom 按钮重新避让水平滚动条与移动端安全区域, 降低误触。

### 修复

- PTY 移动端软键盘收起/触控滚动时的高度跳变和底部轻微抖动进一步收敛。
- 图片路径点击下载失败时的提示补充路径上下文, 避免“文件不存在”无法定位。
- 重命名相关协议、store、侧边栏和审批状态广播补齐测试与端到端覆盖。

## [0.2.13] - 2026-05-16

### 修复

- PTY 滚动在 Claude `/compact` 等持续输出场景下的底部抖动、回看后轻微下滑被拉回底部、移动端触底继续滑动产生的 bounce 抖动。垂直滚动意图收口到 transition table / policy 层, 并补充 touch、软键盘、底部钳制、trace 诊断与桌面/移动端回归覆盖。
- 移动端 PTY 输入体验: 软键盘弹起时输入区域不再被遮挡, 控制键区压缩空白并加入 ESC, 方向键改为更易识别的专用背景。
- JSON 聊天模式工具审批卡宽度越界、助手回复中的独立蓝色光标行、审批等待状态未同步到侧边栏等 UI 状态问题。
- JSON 文件/图片引用改为消息正文内联动作链接, 移除底部重复附件兜底; 文件不存在 toast 现在包含路径上下文, 便于定位误点或缺失资源。
- JSON permission mode 真正作用到 worker control_request 仲裁: `bypassPermissions` 直接放行, `acceptEdits` 自动接受编辑类工具, `plan` 拒绝工具执行且不弹审批, `default/auto` 保持远程审批/Provider 判定语义。新增创建会话模式矩阵、provider args、worker spawn、真实 Claude JSON 行为 e2e 覆盖。
- 清理两个既有打包 warning: 根 `package.json` 重复 `test:unit` 脚本和字体 CSS 构建缺失提示。

## [0.2.12] - 2026-05-14

### 修复

- PTY 长会话 wheel 上回看时偶发被拉回底部 (v0.2.11 修了 `scrollToBottom` 不主动清 intent, 但 `onContainerScroll` 路径仍会清)。`onContainerScroll` 释放 intent 的 `verticalDelta > 0` 改为 `verticalDelta > atBottomThreshold` (默认 8px), 屏蔽浏览器 async scroll event 的 subpixel jitter (用户 wheel up 后 scroll event fire 时 `container.scrollTop` 可能比 wheel 写入值 ±1px, 被误判为"用户向下滚到底"清掉回看意图)。补 wheel + subpixel scroll 复现 unit 覆盖。

## [0.2.11] - 2026-05-14

### 修复

- PTY 远端持续输出 + 用户 wheel 上回看时, 在某次 `xterm.onData` (用户敲键盘 / xterm cursor query 自动响应 / bracketed paste 等) 之后视图被强行拉回底部。`scrollToBottom` 内部加默认 `respect intent` 守护——被动 caller (`rawInput` / `pendingFrame` / `relayout` / `termScroll`) 在用户回看 (intent=true) 时整段 no-op; 仅 BackToBottom 按钮等用户明示动作显式 `force: true` 才能压过 intent。把 invariant 收到 controller, 新加 caller 默认就对。

## [0.2.10] - 2026-05-14

### 可观测性

- PTY 滚动诊断 trace 稳态去重 v0.2.9 设计补漏。dedup 改 `Map<event, lastEntryRef>` 按事件名追踪 (v0.2.9 仅看 entries 末尾, cycle 内 8 条 unique events 轮流 fire 时永不命中); `scrollToBottom` 在已贴底 + intent=false + viewportY=maxYdisp 时整段 no-op (不 trace 不写 scrollTop 不写 host); 删 `pending-frame:follow/hold` (reason 已在 `scroll-to-bottom:start[pendingFrame]`)、`relayout:start/end` (子路径自带 trace)、`followCursor:skip cursorRow unchanged` 三类稳态噪音。补 dedup cycle 折叠 unit 覆盖。无功能变化。

## [0.2.9] - 2026-05-14

### 可观测性

- PTY 滚动诊断 trace 进一步加固。`?ptyScrollTrace=1` 现录 `vv:resize` / `vv:scroll` (visualViewport 软键盘 reflow)、`touchcancel`、`pending-sync-retry-fire`、`followCursor:hit/skip` (含 cursor 行 + scrollTop 转换); ring buffer 500 → 5000; 稳态相同 (event, scrollTop, viewportY, hostTop) 折叠为单行 + `+N` 计数, 用户输入 / vv / followCursor 等关键信号不参与去重; 新增 `vvHDelta` / `vvODelta` / `details` 列。无功能变化。

## [0.2.8] - 2026-05-14

### 可观测性

- PTY 滚动诊断 trace 增补。`?ptyScrollTrace=1` 现录 wheel 入口、intent 翻转、`scrollToBottom` caller 标签 (`pendingFrame` / `relayout` / `rawInput` / `viewExternal` / `backToBottomBtn` 等)、window 级 wheel sniffer (含 target 与是否 reach container)，focus 字段附加 `data-slot` / id / className 摘要。无功能变化。

## [0.2.7] - 2026-05-13

### 修复

- JSON 模式发消息后只显示思考气泡、无最终回复。`PreToolUse` hook 决策由 `defer` 改为 `ask`，让 claude CLI 通过 stdio control_request 触发 web 审批面板，不再以 `tool_deferred` 提前结束 turn。
- PTY 远端持续输出时向上滚动被自动跳回底部 (PC + 移动端)。`userHasVerticalScrollIntent` 释放改为方向感知，仅在用户主动向下滚抵达底部时清除；wheel 边界 clamp 时不再误重置 intent。
- 移动端新建会话 Dialog 自动 focus 首个 input 触发软键盘弹起、底部按钮被遮挡。阻止 Radix 默认 autofocus，focus 留在 trigger button。

## [0.2.6] - 2026-05-13

### 新增

- PTY 移动端控制条加 Ctrl+S 按键。

### 变更

- chat 异常态展示统一。auto-restore 落到死会话时静默退到 `/sessions` + toast；relay 断或开发机离线时 `ConnectionLostPanel` 浮在 chat 主体上层，重连后自然续上。
- 品牌图标主体留白调到接近 iOS 安全区惯例，PNG 全套同步重生。

### 修复

- 设置 → 版本页 Web 字段在 package.json 版本 bump 后仍显示旧版本。
- relay 短暂 hiccup 不再让 PTY 视图 unmount + 状态丢失。
- 用户主动从 chat 退出后冷启动不再被 auto-restore 拽回上次会话。
- PTY 横向滚动被光标拉回。新增 `userHasHorizontalScrollIntent`，跟纵向行为对称。

## [0.2.5] - 2026-05-13

### 修复

- 上传文件 / 粘贴图片到 PTY 后 CLI agent 看不到文件。文件统一落 `os.tmpdir()/dev-anywhere/`，跟 user repo 与 `.gitignore` 完全脱钩。
- 移动端 PTY / 聊天里 `@<path>` 链接误把中文文本框成下划线。路径主干字符集收紧到 ASCII 白名单。
- PTY 滚回底冻结。`notifyAtBottom` 加时间窗 guard，防 reconnect transient atBottom=true 错误清掉跨周期回看意图。
- vivo 等 OEM Android Chrome 点击文件 input 预申请相机权限。拆 "上传图片" 与 "上传文件" 双入口，accept 各自分明。
- WebSocket 重连竞态导致 send-on-CONNECTING 错误。listener 加 stale-ws guard。
- BackToBottom 触发 aria-hidden retain focus 警告。改用 `inert`。

### 变更

- 图片预览支持 wheel / pinch / drag 连续缩放 + 双击复位，移动端双指 pinch zoom + 单指 pan。
- 移动端 PTY 控制条扩到 2 行 6 列，加 Tab / ⇧Tab / ^T / ^B 按键，方向键按物理上下左右排列。
- 品牌图标 SVG glyph 占画面比例从 87.5% 缩到 ~75%，对齐 iOS 安全区惯例。

## [0.2.4] - 2026-05-12

### 修复

- 移动端 PTY 输出里的文件路径 / 图片路径触屏 tap 不触发预览。触屏设备 plain tap 直接触发，PC 仍要 cmd/ctrl+click。

### 变更

- E2E 测试体系治理：mock chaos 与 integration chaos 分子目录，移动端 L4 真 Android emulator + Chrome over CDP 跑业务 spec。新增 `docs/TESTING.md` 文档。

## [0.2.3] - 2026-05-11

### 变更

- 品牌图标重新设计：围绕 GitHub Octicon "agent" 字形 (云图 + chevron 提示符 + 下划线光标) 在原暗色渐变色板上重绘。
- `pnpm release vX.Y.Z` 在 gates 通过后自动 push commit + tag (无需 y/N 确认)；dry run 走 `RELEASE_SKIP_PUSH=1`。
- `pnpm build:icons` 改用 `@resvg/resvg-js`，不再依赖系统二进制。

## [0.2.2] - 2026-05-11

### 新增

- 开发机文件直接下载到用户浏览器：PTY cmd/ctrl+click 文件路径；图片预览加下载按钮；聊天消息中非图片文件路径渲染为下载链接。
- PTY 容器与 JSON 输入栏支持拖拽上传 + 附件 picker。
- 移动端键盘栏加 Ctrl+C 按钮，方向键支持长按自动 repeat。
- 图片预览支持 fit-to-window / actual-size 切换。
- PTY 自动横向滚动让光标始终可见；鼠标拖选超出容器边缘自动滚动。
- WebGL 渲染模型诊断 + `clearRenderModel`，canvas 睡眠唤醒乱码时可暴露 GPU 状态。

### 修复

- 本地 claude/codex 会话 ctrl+c×2 退出后不再卡在 web 列表。
- 中文输入法标点不再以错位前缀渲染。
- "正在终止会话" toast 不再在 optimistic 删除后继续显示。
- iOS PWA 从睡眠唤醒不再跳回 session 选择页；冷启动恢复最后的 chat route。
- PTY 图片预览改成 cmd/ctrl+click 才打开，跟下载链接一致。
- PTY 鼠标拖选跨行扩展能正常派合成事件。
- PTY 失焦时光标不再继续闪烁。
- 文件路径链接识别覆盖裸相对路径 (`README.md`) 和双扩展名 (`.tar.gz` / `.d.ts`)，同时不再误识别版本号。

### 变更

- Control message 错误码到 UI 前翻译成中文；原始 fs 错误字符串 (`ENOENT` / `EACCES`) 不再泄漏到用户面前。
- `relay_error` envelope 携带原始 `requestId`，路由失败立即 reject 不再挂到 30s timeout。
- 上传 + toast lifecycle 统一走 `uploadFileAndShowToast`。
- PTY 垂直滚动条空闲时隐藏，跟 macOS 原生行为一致。

### 可观测性

- `terminal-ipc` IPC 解析错误日志加 `err.cause` 与 200 字符 `linePreview`。
- 文件下载触发用 `console.debug` 记 ok/failed 事件 (sessionId / path / size / errorCode / durationMs)。
- `__devAnywherePtyRenderDebug.dumpState` 改返回 JSON，DevTools 失焦不再阻塞抓取。

## [0.2.1] - 2026-05-11

### 修复

- PTY 空白渲染 (长会话偶发 viewport 上半区一片黑)。`computePtyHostLayout` 的 cold-start "从底部填充" padding 只在 `bufferLength <= rows` 时启用。

## [0.2.0] - 2026-05-11

### 修复

- claude/codex stream-json 输出里 CJK 与 emoji 字符不再因多字节序列跨 stdout chunk 被截断成 `?`。
- JSON 会话不再在模型完成后卡在 `WORKING`：proxy 等 stdout 排空后 (1s fallback) 再发 exit 信号。
- iOS Safari 地址栏收起后 PTY 不再保留过时的行列几何。
- 重连快照重放不再把上一个恢复窗口的帧泄漏到新窗口。
- Control message 路由严格用 relay 绑定的 proxy ID，客户端 `proxyId` 字段不再能改路由。
- Hosted-PTY 子进程退出时该会话仍 pending 的工具审批请求会被 deny，不再变成孤儿。
- proxy daemon 启动遇到损坏的 session 持久化文件不再 abort，退化为空状态加 warning。
- `~/.dev-anywhere/config.json` / proxy-id / sequence 文件改原子写 (tmp + rename)；`config.json` 权限改 `0o600`。
- sequence-counter 持久化不再每次 envelope 同步落盘。
- 持续乱序投递下 PTY 恢复 buffer 加上限。
- 已终止 session 不再触发新事件。

### 新增

- relay `/proxy` 与 `/client` upgrade 端点 + proxy 的 relay-incoming 路径加 `MAX_JSON_MESSAGE_SIZE` (1 MB) 上限。
- relay 加 `ALLOWED_ORIGINS` 环境变量 (CSWSH 防御)，默认行为不变。

### 可观测性

- proxy 与 relay 的 WebSocket close handler log `code` / `reason`，区分 ECONNREFUSED / ETIMEDOUT / 优雅关闭。
- 新增 `docs/known-issues/pty-blank-render.md` 与 `docs/known-issues/pty-garbling.md` 诊断 playbook。

## [0.1.9] - 2026-05-10

### 修复

- relay client-token preflight (`/auth/client`) 与 admin client-token 拉取 (`/admin/client-token`) 挂在 `/api/` 下，避开 nginx SPA fallback。

### 新增

- web 快捷菜单加 "发送 Ctrl+B" 与 "发送 Ctrl+O"。

## [0.1.8] - 2026-05-10

### 新增

- `dev-anywhere relay token [--relay <name>]` 显示已配置 relay 的活跃 client token。
- web 快捷菜单加 "发送 Shift+Tab" 切换 Claude CLI 权限模式。
- `LOG_LEVEL` env 与 `logLevel` config 字段控制 proxy 日志 verbosity。
- 文档：`docs/CONFIG.md` (运维端旋钮目录) 与 `docs/DEV.md` (内部管线参考)。
- 当前 PTY 视图诊断全局：`window.__devAnywherePtyDebug()` 与 `window.__devAnywherePtyTerminal()`。

### 修复

- web PTY 视图在 `onContextLoss` 时重新加载 WebGL addon，从 GPU context loss 恢复。
- `dev-anywhere -v` 与其它无效调用不再 crash 在 `sonic-boom is not ready yet`。
- 选中侧栏行的渐变干净 fade 到右边。
- 桌面端 web 鉴权失败显示为整屏空状态。
- 错误的 `?relayToken=...` 不再覆写 localStorage 已有的有效 token。

### 变更

- `~/.dev-anywhere/config.json` 加载时校验，顶层字段拼错给清晰的 field-level 错误。
- 本地开发脚本 (`dev-restart` / `dev-health` / `dev-chaos` / `mobile-smoke`) 通过 URL 匹配自动选 profile/relay。

## [0.1.4] - 2026-05-09

### 修复

- PTY 图片预览链接的 hover 与点击范围按终端显示列对齐，路径前出现 CJK 等宽字符也能正确命中。

## [0.1.3] - 2026-05-09

### 新增

- web 客户端可从 JSON 消息与 PTY 终端输出预览显式的本地图片路径；额外的绝对根可通过 `previewRoots` 配置。

### 修复

- 图片预览 loading 用可见的 skeleton 过渡。
- 浏览器解码失败时给明确错误，不再卡 loading。
- 图片预览操作栏聚焦于复制本地路径，移除 "在新标签页打开" 冗余动作。
- 移动端图片预览以全屏图层打开，不再被桌面 dialog 缩放压扁视口。
- 会话 overflow 菜单字号 stepper 跟其它菜单项视觉对齐。

### 安全

- 图片预览拒绝缺失 session、不在允许根下的路径、目录、非图片 payload、不支持格式、>10 MB 的文件。

## [0.1.2] - 2026-05-09

### 新增

- chat 与 PTY 页 overflow 菜单加每会话屏幕常亮 (screen wake lock) 开关。

### 修复

- 剪贴板图片粘贴在可能的情况下存到当前 session 工作目录，并往项目 `.gitignore` 追加 `.dev-anywhere/`。
- 离开 chat 页 / 切换 session / 解析导航后的 pending wake lock 请求都会释放。
- 移动端 PTY 辅助控制在系统软键盘收起时跟着隐藏。
- 移动端 PTY back-to-bottom 控件靠近右边缘，桌面端仍避开终端滚动条。

## [0.1.1] - 2026-05-09

### 变更

- proxy 配置改为显式的 `profiles` + `relays` + `--relay <name>` 命令；旧的 `defaultEnv` / `envs` 形式被拒绝。
- 本地 web 开发要求显式 relay target，例如 `pnpm dev:web -- --relay cloud --port 5174`。

### 修复

- 本地开发可跑隔离 proxy profile，本地 relay 测试不再被迫打断已连云的 proxy。
- vite dev server 可指向 local / cloud / 自定义 relay 后端。
- 公网 web 客户端在打开 relay WebSocket 前显式提示输入 client token。
- chat 与终端字号菜单改成对齐的紧凑 stepper 布局。
- 活跃 relay 校验不再把临时的 `verify-proxy` entry 留在公网 proxy 列表。
- proxy 优雅断开清掉 relay 资源，不再保留 offline proxy 记录。

## [0.1.0] - 2026-05-09

### 新增

- Claude Code 与 Codex 会话的本地 proxy CLI。
- WebSocket relay server：proxy/client 注册 / 路由 / 健康检查 / 可选 token 鉴权。
- React web/PWA 客户端：会话选择 / 聊天渲染 / hosted PTY 控制 / 重连恢复 / 移动端布局。
- relay / chat / session / control / system / tool 消息的共享协议 schema。
- npm 包与 Docker image 的 release workflow。
- 双语开源 README / 部署指南 / PWA 指南 / 脚本指南 / 公开截图素材。
- JSON / PTY 会话的剪贴板图片粘贴。
- 公网 web/PWA 部署的 relay client token 支持。
- release 烟雾门禁覆盖桌面 / 移动 / PTY / 剪贴板 / 真 provider / chaos 场景。

### 变更

- 桌面端 chat 与终端字号默认改 16px。
- PTY/JSON 会话仍在产出输出时，会话活跃度持续刷新。
- 长会话标题与历史标题通过 hover title 暴露完整文本。
- 公开示例与测试 fixture 不再包含私有项目名或机器路径。

### 修复

- PTY raw input 保留 IME 转换后的标点 (中文逗号 / 句号等)。
- Hosted PTY provider exit chaos 不再重复标点输入。
- 慢速剪贴板图片上传始终归属到粘贴发起的那个会话。

### 安全

- 文档强调生产环境必须配置 proxy 与 client 双 relay token。
- 剪贴板图片上传拒绝不支持格式 / 超大 payload / 无效 session 路径。
