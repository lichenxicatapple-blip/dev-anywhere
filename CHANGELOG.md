# 更新日志

本项目所有可见的变更都记录在这个文件里。

`1.0.0` 之前遵循语义化版本：minor 版本可能包含 breaking change，patch 版本只做兼容修复。

## [0.2.7] - 2026-05-13

### 修复

- JSON 模式发消息后只显示思考气泡, 无最终回复 (claude tool 调用场景全部受影响): `PreToolUse` hook 一直返回 `permissionDecision: "defer"`, claude CLI 2.1.140 在 `--output-format stream-json --input-format stream-json` 非交互模式下看到 `defer` 不再 fallback 到 `--permission-prompt-tool stdio` 路径, 直接以 `stop_reason: "tool_deferred"` 结束 turn — `result.result` 为空字符串, web 端只收到 `assistant_tool_use` + `turn_result`, 无最终 `assistant_message`, UI 思考气泡消失后没有任何回复, 刷新也看不到 (历史里本来就没有 assistant 文本)。改为返回 `permissionDecision: "ask"`, claude 通过 stdio 发 `control_request` (subtype=can_use_tool), 由 worker `handleControlRequest` → `approvalStrategy` → `forwardToRelay` → web 审批面板, 跟现有 broker 路径接上。`PreToolUse` hook 退回纯观察通道职责 (forward agent_status phase=tool_use), 决策权交给 stdio control 流 (commit TBD).
- PTY 远端持续输出时用户向上滚动会被自动跳回底部 (PC + 移动端同症): longHost 模式 (host > viewport, 长会话 / 高 rows / 小字号默认走) 下 `isAtBottom = cursorInViewport`, 与几何 scrollTop 解耦。用户小幅 wheel up 后 cursor 仍在 viewport → atBottom 保持 true, `notifyAtBottom` 旧逻辑误判为"已回到底"立刻清掉刚 set 的 `userHasVerticalScrollIntent`, 下一帧 `handlePendingNewFrame` 见 !intent 触发 `scrollToBottom`。改为方向感知释放: `notifyAtBottom` 只通知 atBottom 变化, intent 释放下沉到 `scrollByWheelDelta` / `onContainerScroll` / `onTouchEnd`, 仅当用户主动向下滚 (`next > previous`) 抵达 atBottom 时清。`scrollByWheelDelta` 增加 clamp guard: 边界处 scrollTop 未实际变化时不重置 intent, 避免在底反复 wheel down 重新 pause output 导致后续帧无法 flush (commit TBD).

### 变更

- 新建会话 Dialog mobile 端阻止 Radix 默认 autofocus 首个 input。之前打开 dialog 立刻 focus "名称" 触发系统软键盘弹起, visual viewport 被键盘吃掉 ~300px, dialog 下半 (Agent CLI / 权限模式 / 创建按钮) 落在键盘下方, 用户在 emu Chrome 实际触屏上按不到。`DialogContent` 加 `onOpenAutoFocus={preventDefault}`, focus 留在 trigger button, ESC 仍可关闭, Tab 链路正常 (commit TBD).

### 工具

- `pty-scroll-controller.test.ts` 加 longHost wheel up 不清 intent + wheel down 到底清 intent 两条单测; `e2e/pc/pty-scroll.spec.ts` 加 longHost (rows=60 强制 host > viewport) wheel up + 远端持续输出 deterministic 复现, 3x repeat 全过, 跟 `pty-scrollback-resume` (滚回底冻结) 互不干扰.
- `e2e/mobile/error-states.spec.ts` 长 CLI 路径 spec 的 "指定路径" button click 改用 `evaluate(btn => btn.click())` 调 native click, 不走 playwright 的 visual viewport actionability。emu Chrome 默认显示底部工具栏, visual viewport (~428px) 远小于 layout viewport (~789px), dialog 底部按钮在 layout 内但 visual viewport 之外, playwright force=true 也拒绝在 visual viewport 之外 dispatch click。dialog UX 验证 (横向溢出) 跟 emu Chrome chrome bar 占空间这层无关问题剥离 (commit TBD).

## [0.2.6] - 2026-05-13

### 新增

- PTY 移动端控制条加 Ctrl+S (^S, `\x13`). 占原右上空位 (上排末列), ↑↓←→ 十字布局不动 (commit 9b515a91).

### 变更

- chat 异常态展示统一. auto-restore 落到已死 session 时静默退到 `/sessions` + toast "上次会话已结束", 不让用户停在 TerminatedSessionPanel 上多点一次. 区分 "AppShell 把我拽来" (sessionStorage `dev-anywhere:restored-target` 一次性消费) vs "用户手敲 URL / 直接 refresh" — 后者保留 TerminatedSessionPanel, 不静默重定向. 同时 chat 主体在 relay 断 / 开发机离线 时被 `ConnectionLostPanel` 替代 (mode-aware 文案: "中继连接已中断" / "开发机未连接"), 之前是 chat 主体一片空仅靠 4px 色带 StatusLine 提示, 信息密度太低 (commit 7bf329c9).
- 品牌图标主体再缩小. SVG glyph scale 24 → 22, translate `(64 77)` → `(80 115)`. 左右 padding 64px → 80px (12.5% → 15.6%, 更接近 iOS 产品图标安全区习惯), 云朵 bbox (不含 cursor 下划线) 垂直居中到 canvas 几何中心, 上下 padding 严格对称 (146px). PNG 全套 (favicon / apple-touch / maskable / pwa 64-512) 同步重生 (commit 2de7d4cc).

### 修复

- 设置 → 版本页 Web 字段在 package.json 版本 bump 后仍显示旧版本: `__APP_VERSION__` 是 vite `define` 启动时静态注入, dev server 不重启不会重新计算. 改为 `settings-dialog.tsx` 直接 `import packageInfo from "../../../package.json" with { type: "json" }`, 走 vite 模块依赖图 + HMR, package.json 改一次就跟着变 (commit e9bd93dd).
- ConnectionLostPanel 替代 chat 主体导致 PTY 视图 unmount: relay 短暂 hiccup 时 `ChatPtyView` 不渲染 → xterm 实例销毁 + BackToBottom hasNewMessages 等组件状态丢失, 重连后用户期待续上的状态没了. 改为 panel `absolute inset-0 z-30` 浮在 chat 主体上层, chat 主体保留 mounted, 重连后 panel 消失自然续上. websocket-chaos.spec.ts "force-follow PTY output after reconnect" 红回绿 (commit f427316f).
- 用户主动从 chat 退到 `/sessions` 或顶层后, `dev-anywhere:last-chat-route` 仍留在 localStorage, PWA 冷启 / 关 tab 重开会被 auto-restore 拽回上一个 chat, 与用户主动离开的意图相反. AppShell 加 `wasChatRouteRef` 跟踪 isChatRoute transition, true → false 时清掉 last-chat-route. mount 起步 false 不算 transition, route-restore 冷启动仍能用 lastRoute 恢复 (commit cbb9f2ab).
- PTY 横向滚动被光标拉回: 横向溢出场景 (长行 + 短宽视窗), 用户主动横向滚到光标视窗外后, 任意一次 PTY 输出 / cursor blink 触发 onRender → `followCursorX` 无条件 snap scrollLeft 回光标位置, 用户感受到"无形力量"。`followCursorY` 早就有 `userHasVerticalScrollIntent` 兜底, 横向缺这条对称机制。加 `userHasHorizontalScrollIntent` + `pendingFollowCursorScrollLeft` + `lastSeenScrollLeft`, `onContainerScroll` 区分用户主动滚 vs followCursorX 自己写, 用户 intent 设了之后 followCursorX 不再 snap; 看到光标 in viewport (用户滚回光标可见范围) 时清掉 intent 重新 engage (commit 029b95c9).

### 工具

- e2e helpers `setProxyOnline(online)`: 通过 fake-relay 同步 proxy 在线状态 (推 `proxy_offline` / `proxy_online` 事件 + 后续 `proxy_list_response` 在线字段也跟随), 让 chat 异常态 spec 可重现 — 之前只推事件、后续 list 还报 online:true 会让 phase-machine 把 proxyOnline 又翻回 true (commit 7bf329c9).
- e2e 新增覆盖 chat 异常态: PC `chat-presentation.spec.ts` 6 条 (auto-restore 死会话静默退 / 仍活的不跳 / 用户主动 URL 不静默 / 主动离开 chat 后冷启不拽回 / relay 断 / proxy 离线) + L4 真机 `chat-presentation.spec.ts` 2 条 (PWA 冷启动场景 + 移动视口 panel 无水平溢出). PC `pty-input.spec.ts` / L4 `pty-mobile-controls.spec.ts` 同步加 ^S touch target + raw 序列断言 (commits 7bf329c9, cbb9f2ab, 9b515a91).

### 清理

- 删 `STORAGE_KEYS.sessionId` / `sessionMode` 两个死键: source 里只有 read + remove, 永没 write 路径. phase-machine 冷启动 / proxy_selecting+online 两处 savedSessionId 恢复路径读到永远 null, 走的是 else 分支. 删掉 key 和对应 read / remove / 路径分支后逻辑等价, `route-restore` (last-chat-route) 是唯一在工作的冷启动恢复机制. `cleanStorageForPhaseTransition` 仅保留 proxyId 清理 (commit 0f286501).

## [0.2.5] - 2026-05-13

### 修复

- 上传文件 / 粘贴图片到 PTY 后 CLI agent (Claude Code / Codex) 看不到文件的 bug. 之前文件落在 `cwd/.dev-anywhere/{clipboard,uploads}/<sid>/` 相对路径, proxy 还会自动给 user repo 顶层 `.gitignore` 末尾追加 `.dev-anywhere/`. CLI 默认 respect `.gitignore`, 看到 `@.dev-anywhere/...` 不会读, 用户上传完 agent 没反应. 改为统一落 `os.tmpdir()/dev-anywhere/`, 返回绝对路径, 跟 user repo / `.gitignore` 完全脱钩 (commit 55ad4c4f). 文件名同时收紧到 `paste-<6 nanoid>.<ext>` / `up-<6 nanoid>.<ext>`, mention 路径长度从 ~80 字符降到 ~50.
- 移动端 PTY / 聊天里 `@<path>` 链接范围识别错位: 中文文本里夹一个 ASCII 单词 (`logo` 等) 触发 `image-preview-path` / `file-download-path` 主干字符集 `[^\s\`"'<>]*?`, lazy 一路啃过中文 + `@` 抵达尾部 `.png`, 整段中文都被框成下划线. 主干改成严格 ASCII 路径白名单 `[A-Za-z0-9_./~%+,:=#-]` 后中文 / 全宽标点 / `@` 都挡住 (commit 8d6d6abe).
- PTY 滚回底冻结: 输出过程中 wheel up 离开底部再滚回底, 渲染似冻结, 要点击 focus / blur 才恢复. longHost 模式 `isAtBottom = cursorInViewport`, 小幅 wheel 期间 atBottom 一直 true, `notifyAtBottom` 的 false→true 状态过渡条件不再触发, 不释放 `userHasVerticalScrollIntent`. 释放条件改为 "在底 + 还有 intent + 非触屏 + user 主动 wheel/touch/scrollbar 250ms 内", 时间窗 guard 防 reconnect 重建 controller 时 layout 重置 transient atBottom=true 错误清掉跨周期保留的回看意图 (commits 49100ade, e5fc51f4).
- vivo Android Chrome 等 OEM 定制版点击没设 `accept` 的文件 input 时会预申请相机权限, 用户从聊天菜单点"上传文件"看到摄像头授权弹窗, 体感不好. 拆成"上传图片" + "上传文件"两条入口, accept 分别为 `image/*` 和 `application/*,text/*`, 文件路径不再触发相机授权 (commit e07ba49d).
- WebSocket 重连竞态导致 `Failed to execute 'send' on 'WebSocket': Still in CONNECTING state` + "WebSocket is closed before the connection is established" 警告. wakeReconnect 在老 ws 还 CONNECTING 时主动 close + 立即 doConnect 新 ws, 老 ws close listener 异步 fire 时不区分 ws 实例, 把刚创建的新 ws `this.ws=null` 又 schedule 一轮重连, 多个 ws 并存互相覆盖. listener 加 stale-ws guard + wakeReconnect 检测到 CONNECTING 直接 return (commit fde0c1eb).
- BackToBottom button 触发 "Blocked aria-hidden on element because its descendant retained focus" 警告. `aria-hidden + tabIndex=-1` 不阻止 retain focus, button 自己被 focus 后 visible 切 false 时 aria-hidden=true 违反 WAI-ARIA. 改用 `inert` (React 19 + 现代浏览器原生支持, 自动 blur stale focus + 对 AT 隐藏) (commit 40e4b07a).

### 变更

- 图片预览支持 wheel / pinch / drag 真正的连续缩放 + 双击复位, 拆掉 fit / actual 二档 toggle. 接 `react-zoom-pan-pinch` (~7KB gzip), 桌面 wheel cursor-anchored 缩放 + 鼠标 drag pan, 移动端双指 pinch zoom + 单指 pan, 双击 reset (commit 3f647ce9).
- 移动端 PTY 控制条由 1 行扩到 2 行 (6 列 grid), 加 Tab / ⇧Tab / ^T / ^B 按键, 方向键按真实物理上下左右排列; chat header overflow 菜单的快捷键区域瘦身, Tab / ⇧Tab / ^T / ^C / ^B / 清空都挪到控制条, 菜单只留低频 Ctrl+O. BackToBottom 偏移同步从 4rem 调到 7rem 避免被控制条遮挡 (commit b8a9b1d3).
- 品牌图标 SVG glyph 占画面比例从 87.5% 缩到 ~75%, 上下左右留白 ~12% 对齐 iOS 图标安全区惯例; 小尺寸 favicon / PWA install icon 边缘不再因抗锯齿像被切. `build-icons.mjs` 同时补上 `pwa-{64,192,512}.png` 三档目标, SVG 改一次全套 PNG 都同步生成. 顺手清掉死配置 `pwa-assets.config.ts` + `@vite-pwa/assets-generator` devDep (commit 1df6516e).

### 工具

- 图片预览缩放交互 e2e 覆盖: 桌面 wheel zoom / dblclick reset / mouse drag pan + 移动 chromium-emulation 用 CDP `Input.dispatchTouchEvent` 模拟两指 pinch (commit fc0d6016). L4 真机 image preview pinch zoom 在 `Medium_Phone_API_36.1` Android emu 上实测跑过, 跟 chromium-emulation 互补覆盖 native touch driver 路径 (commit 15a52460).
- `scripts/check-prerequisite.sh` 错误提示从绑死阿里云改成通用文案, 容器镜像可来自任意 registry; 阿里云 vps 部署素材记录归档 (commits e8ac23de, 324de246).
- `scripts/test-mobile.sh` 给 mobile spec 注入 `WEB_BASE_URL=$BASE_URL`, helpers 默认 5173 不再让 emu (adb reverse 只 forward 5174 + 6100) 撞 ERR_CONNECTION_REFUSED; pre-existing flake 之前靠 emu chrome 缓存 page 蒙混 (commit 3d6ab92d).
- `e2e/pc/real-clipboard-image.spec.ts` 适配 upload 落 `os.tmpdir()` 新路径, 用前后 diff 定位本次 spec 落地的新文件, afterAll 清掉避免污染 tmp (commit 9dead2dd).

## [0.2.4] - 2026-05-12

### 修复

- 移动端 PTY 输出里的文件路径和图片路径触屏 tap 不触发预览/下载 (commit 88ec696a)。原实现强制要 `metaKey/ctrlKey` 修饰键, 触屏设备没修饰键所以 tap 永远不触发. 修后 `(pointer: coarse) || (hover: none)` 触屏设备 plain tap 即触发, PC 上 `cmd/ctrl+click` 防误触不变, 平板接外置键盘两条路径都 work.
- `apps/web/e2e/pc/real-clipboard-image.spec.ts` 的 `repoRoot` 计算错位 (从 `e2e/pc/` 起 3 个 `..` 算到 `apps/`, 不是 repo root), 让 `bash scripts/dev-relay-restart.sh` 找不到. 改成 4 个 `..`.

### 工具

- E2E 测试体系治理: pty-smoke 大文件按关注点拆 5 个 spec; chaos 子目录分 mock chaos (CI 默认跑) 和 integration chaos (`pnpm dev:chaos` 编排驱动); 新增 `localRuntime` / `hostedPty` / `jsonMode` fixture 起隔离 relay+proxy daemon.
- 移动端 L4 真 Android emulator + Chrome over CDP 跑业务 spec: 12 spec / 19 test 覆盖光标可见 / 输入路径 / IME / 软控制按键 / 长按 repeat / 滚动 back-to-bottom / 触屏链接 tap / 工具审批三按钮 / @ 文件选择器 / JSON 翻历史 / master-detail 导航 / 异常态 UI.
- 真 backend 业务 e2e (protocol-level): `apps/web/e2e/pc/real-backend-session.spec.ts` 通过 ClientWs 直接走 relay-control 协议, 验真 claude PTY banner 和 stream-json `assistant_message`.
- 新增 `docs/TESTING.md` 文档化 4 层测试体系 + chaos mock vs integration 区分 + fixture 选型 + 添加新 spec 决策树.
- baseline 修复: cdp.ts fixture scope / relay-control.ts 改用 Node 22 内置 WebSocket / session-list.spec.ts package.json 路径 / unused vi import. Playwright 全 tier 加 `expect.timeout=10s` + `retries=1` 抗 cpu 抢占类 flake.

### 备注

- L4 mobile 测试受 Android Chrome over CDP 三条平台限制: 不支持 newContext / `page.close` 不真删 tab / `addInitScript` 不能 unregister. `scripts/test-mobile.sh` 用 per-spec-file force-stop chrome + CDP `/json/close` 真删 stale tab 来规避.
- vite proxy target 静态绑定阻止 fixture 起的 isolated backend 给 web UI 用; integration chaos 因此必须由 `pnpm dev:chaos` 编排. 解锁路径见 `docs/known-issues/e2e-vite-proxy-static-target.md`.

## [0.2.3] - 2026-05-11

### 变更

- 品牌图标重新设计, 围绕 GitHub Octicon "agent" 字形 (云图 + chevron 提示符 + 下划线光标) 在原有暗色渐变色板上重绘. 之前的编辑器边框包装去掉了 — 新字形自身已经同时承载 agent 和 prompt 两层语义.

### 工具

- `pnpm build:icons` 用 `@resvg/resvg-js` 从 `brand-icon.svg` 重新生成 `apple-touch-icon-180x180.png` / `maskable-icon-512x512.png` / `favicon.ico` (16/32/48 inline PNG). 不再依赖系统二进制, 替换之前临时调用 rsvg-convert / Playwright 的脚本.
- `pnpm release vX.Y.Z` (v0.2.2 引入) 在 gates 通过后自动 push commit + tag; `y/N` 确认提示删除, 因为到 push 之前 `release:check` 和 `release:smoke` 已经验过. dry run 可继续用 `RELEASE_SKIP_PUSH=1`.
- `dev-health` 手动冒烟提示统一改成英文, 跟其它运维输出一致.
- `.github/workflows/release.yml` 把 tag 写进 `run-name`, Actions 列表显示 `Release v0.2.3` 而不是 `Release #N`.

### 备注

- v0.2.2 发布 npm 包成功, 但 docker image 推阿里云 ACR 撞到瞬时 `connection reset by peer`. v0.2.3 重新打 docker tag. ACR 再抖动就重跑 Actions 失败的 job.

## [0.2.2] - 2026-05-11

### 新增

- 开发机文件直接下载到用户浏览器. PTY 支持 cmd/ctrl+click 文件路径; 图片预览加下载按钮; 聊天消息中非图片文件路径渲染为下载链接. 通过 blob URL 触发普通浏览器下载, 不需要协议处理器.
- PTY 容器和 JSON 输入栏支持拖拽上传; PTY overflow 菜单加 "上传文件" 入口. JSON 输入栏也加附件 picker.
- 移动端键盘栏加专用 Ctrl+C 按钮, 方向键支持长按自动 repeat.
- 图片预览支持 fit-to-window / actual-size 切换, 比视口宽的截图可平移查看.
- 剪贴板图片粘贴上传期间显示 loading toast, 慢链接下用户能看到上传在进行.
- PTY 自动横向滚动, 让光标始终可见; 鼠标拖选超出容器边缘时也自动滚动.
- WebGL 渲染模型诊断 + `clearRenderModel` 操作: canvas 在睡眠/唤醒后乱码时可暴露 GPU 状态.

### 修复

- 本地终端 claude/codex 会话: ctrl+c×2 退出后会话不再卡在 web 列表, 后续上传不再 timeout. 每个清理步骤 (control handler / agent registry / seq counter / permission broker) 各自 try/catch, 一个 callback 抛错不会吞掉后续 `broadcastSessionList`.
- `disposeSeqCounter` 不再每次 PTY 退出就往刚被删的 session 目录写 sequence 文件. 之前 `ENOENT` 是静默的, c82caff6 的 per-step isolation 把它显出来了.
- 中文输入法混合文本和标点时, 标点不再以错位前缀形式渲染 (e.g. 输入 `hello-` 显示成 `-hello-`); 标点探测在 IME composition 期间跳过.
- "正在终止会话" toast 不再在 optimistic session 删除后继续显示.
- iOS PWA 从睡眠唤醒不再跳回 session 选择页; cold-start 恢复最后的 chat route.
- PTY 图片预览不再因为普通点击就打开 — 必须 cmd/ctrl+click, 跟文件下载链接行为一致. 同时显式 terminate 后清掉 last-route, 让重新打开应用回到干净状态.
- PTY 鼠标拖选跨行扩展现在派合成 mousemove 到 `.xterm-screen`, 选区真正能从初始 click cell 延伸出去.
- PTY 终端失焦时光标不再继续闪烁.
- 文件路径链接识别覆盖裸相对路径 (`README.md` / `package.json` / `docs/foo.md`) 和双扩展名 (`.tar.gz` / `.d.ts` / `fixture.test.snapshot.json`), 同时不再把版本号 (`5.0` / `Mozilla/5.0`) 误识别为路径.

### 变更

- Control message 错误码 (`PATH_NOT_FOUND` / `PATH_ACCESS_DENIED` / `SESSION_NOT_FOUND` / `TOO_LARGE` / `UNSUPPORTED_FORMAT` / `NOT_A_FILE` / `RATE_LIMITED`) 在到 UI 前翻译成中文; 原始 fs 错误字符串 (`ENOENT` / `EACCES`) 不再泄漏到用户面前的 toast.
- `relay_error` envelope 携带原始 `requestId`, 客户端 `waitForMessage` 在路由失败时立即 reject, 不再挂到 30s timeout.
- 上传 + toast lifecycle 统一: 剪贴板粘贴 / 拖拽 / 附件 picker / PTY overflow 上传都走 `uploadFileAndShowToast`, 消除多个调用点的 toast state 漂移.
- PTY 垂直滚动条空闲时隐藏, 滚动 / hover / 拖拽时再显示, 跟 macOS 原生行为一致.

### 可观测性

- `terminal-ipc` IPC 解析错误日志加 `err.cause` 和 200 字符的 `linePreview`, 下次复现时能看到 `JSON.parse` 拒绝了什么内容, 不再是不透明的错误字符串.
- 文件下载触发用 `console.debug` 记 ok/failed 事件, 带 `sessionId` / `path` / `size` / `errorCode` / `durationMs`.
- `__devAnywherePtyRenderDebug.dumpState` 改返回 JSON, 不再写 console, DevTools 失焦不再阻塞抓取.

### 工具

- `pnpm release` 脚本: 校验 `CHANGELOG.md` 有目标版本 entry, 跑 `release:check` + `release:smoke`, bump 4 个 package version, commit `release: vX.Y.Z`, tag, 询问后 push. CI (`.github/workflows/release.yml`) 在 tag push 后接管.
- `playwright.config.ts` 在 Node 25+ 下直接报清晰错误, 不再让 worker fork 静默 hang — Playwright 1.52 + Node 25 是多次 "无输出无退出" e2e 调试坑的根因.

## [0.2.1] - 2026-05-11

### 修复

- PTY 空白渲染 bug (长会话偶发 viewport 上半区一片黑): `computePtyHostLayout` 对"光标在屏中段且下方有空行"场景错用了 cold-start 的 "从底部填充" padding, 哪怕 buffer 已有滚动历史、光标上方都是有效内容也照做. 那段 padding 把 host 内容下推 `blankRows * cellH`, 而 `host.top` 仍按内容在 host 顶端预期, 形成 viewport 顶部那条黑带. padding 现在只在 `bufferLength <= rows` (真正 cold-start) 时启用.

## [0.2.0] - 2026-05-11

### 修复

- claude/codex stream-json 输出里的 CJK 和 emoji 字符不再因为多字节序列跨 stdout chunk 边界被截断成 `?` — 之前那一行整段被 schema 校验拒绝, 消息直接消失.
- JSON 会话不再在模型完成后卡在 `WORKING` — proxy 现在等 stdout 排空后 (1s fallback 处理挂死的管道) 再发 exit 信号, 最后的 `result` 一定能送到 web 客户端.
- iOS Safari 地址栏收起后 PTY 不再保留过时的行列几何.
- 重连快照重放不再把上一个恢复窗口的帧泄漏到新窗口里.
- Control message 路由现在严格用 relay 绑定的 proxy ID; 客户端发的 `proxyId` 字段不能再把请求重定向到别人的 proxy.
- Hosted-PTY 子进程退出时, 该会话仍在 pending 的工具审批请求会被 deny, 不再变成孤儿.
- proxy daemon 启动时遇到损坏的 session 持久化文件不再 abort; 退化为空状态加 warning, 已活的 worker 仍能恢复.
- `~/.dev-anywhere/config.json` / proxy-id 文件 / 每会话的 sequence 文件现在都用原子写 (tmp + rename), 写入中途崩溃不会损坏. `config.json` 同时改成 `0o600` 权限, 因为它存 relay token.
- 每条消息的 sequence-counter 持久化不再每次 envelope 都同步落盘; 高吞吐场景的 fsync 压力降下来了.
- 持续乱序投递下 PTY 恢复 buffer 现在有上限; 老条目到了上限就丢, 不再无限增长.
- 已终止的 session 不再触发新事件.

### 新增

- relay `/proxy` 和 `/client` upgrade 端点 + proxy 的 relay-incoming 路径加 `MAX_JSON_MESSAGE_SIZE` (1 MB) 上限. 超大 JSON 在 parse 之前就被 warning 拒绝.
- relay 加 `ALLOWED_ORIGINS` 环境变量 (逗号分隔的 origin allowlist), 公网隧道部署可选启用 CSWSH 防御. 默认行为不变.
- proxy 和 relay 的 WebSocket close handler 现在 log `code` / `reason`, 区分 ECONNREFUSED / ETIMEDOUT / 优雅关闭更容易.
- `docs/known-issues/pty-blank-render.md` 和 `docs/known-issues/pty-garbling.md` — 两个仍未关闭的移动端偶发渲染问题的诊断 playbook + 现场抓数据指引.

### 已知限制

- 视口宽度小于 360 px 时移动软键盘可能盖住 PTY 滚动条 thumb; 暂时用移动端控制栏滚动.

## [0.1.9] - 2026-05-10

### 修复

- relay client-token preflight (`/auth/client`) 和 admin client-token 拉取 (`/admin/client-token`) 现在挂在 `/api/` 下. 之前的路径不在生产 nginx forward 规则 (`^/(fonts|health|status|api)`) 内, 被当作 SPA HTML fallback 返回, 把 web 鉴权失败 UI 和 `dev-anywhere relay token` 对云 relay 的执行都搞坏了.

### 新增

- web 快捷菜单加 "发送 Ctrl+B" (`\x02`) 和 "发送 Ctrl+O" (`\x0f`), 浏览器里直接发这两个控制码.

## [0.1.8] - 2026-05-10

### 新增

- `dev-anywhere relay token [--relay <name>]` 显示已配置 relay 的活跃 client token, 用本地 proxy token 鉴权. 不再需要 ssh 上 VPS 看 `.env`.
- web 快捷菜单加 "发送 Shift+Tab" (CSI Z), 浏览器里循环切换 Claude CLI 权限模式.
- `LOG_LEVEL` env 和 `logLevel` config 字段控制 proxy 日志 verbosity (优先级: env > config > 每个 logger 的默认值). relay 之前已经响应 `LOG_LEVEL`.
- 新增文档: `docs/CONFIG.md` (运维端旋钮目录) 和 `docs/DEV.md` (内部管线参考).
- 当前 PTY 视图的诊断全局: `window.__devAnywherePtyDebug()` 返回几何快照, `window.__devAnywherePtyTerminal()` 暴露活的 terminal 实例供 devtools 临时恢复操作.

### 修复

- web PTY 视图现在在 `onContextLoss` 时重新加载 WebGL addon, 从 WebGL context loss 恢复. 之前 GPU context 恢复 (睡眠唤醒 / 后台 tab) 后 glyph atlas 还指着过期的 texture slot, 即使 buffer 内容正确也渲染成乱码.
- `dev-anywhere -v` 和其它无效调用不再 crash 在 `sonic-boom is not ready yet`. proxy logger 现在 lazy 初始化, 参数校验在 terminal 模块 import 之前.
- 选中的侧栏行的渐变现在干净地 fade 到侧栏右边, 不再在行中间突然截断.
- web 鉴权失败提示现在桌面端显示为整屏空状态, 不再是品牌 logo 下面一行小字.
- 错误的 `?relayToken=...` URL 不再覆写 localStorage 里已有的有效 token; token 只在 `/auth/client` preflight 通过后才持久化.

### 变更

- `~/.dev-anywhere/config.json` 加载时校验; 顶层字段拼错给清晰的 field-level 错误, 不再静默忽略.
- 本地开发脚本 (`dev-restart` / `dev-health` / `dev-chaos` / `mobile-smoke`) 通过对本地 relay (`ws://localhost:<port>`) 的 URL 匹配自动选 profile/relay, 不再隐式依赖 profile 名叫 `local`.

## [0.1.4] - 2026-05-09

### 修复

- PTY 图片预览链接的 hover 和点击范围现在按终端显示列对齐, 路径前出现 CJK 或其它宽字符也能正确命中.

## [0.1.3] - 2026-05-09

### 新增

- web 客户端可以从 JSON 消息和 PTY 终端输出预览显式的本地图片路径. 默认 proxy 提供会话工作目录和 OS temp 目录里的图片; 额外的绝对根可以通过 `previewRoots` 配置.
- 图片预览请求被共享协议 schema / proxy 单测 / web 单测 / Playwright JSON / PTY / loading / mobile 布局烟雾测试覆盖.

### 修复

- 图片预览 loading 用可见的 skeleton 过渡, 等浏览器图片加载后再淡入预览.
- 浏览器解码失败时图片预览给明确错误, 不再卡在 loading.
- 图片预览的操作栏聚焦于复制本地路径, 移除冗余的 "在新标签页打开" data-URL 操作.
- 移动端图片预览以真正的全屏图层打开, 不再被桌面 dialog 缩放压扁视口.
- 会话 overflow 菜单把屏幕常亮归到显示控制下, 字号 stepper 跟其它菜单项视觉对齐.

### 安全

- 图片预览拒绝缺失 session / 不在允许根下的路径 / 目录 / 非图片 payload / 不支持格式 / 大于 10 MB 的文件.

## [0.1.2] - 2026-05-09

### 新增

- chat 和 PTY 页 overflow 菜单加每会话的屏幕常亮 (screen wake lock) 开关.

### 修复

- 剪贴板图片粘贴在可能的情况下存到当前 session 的工作目录, 同时往项目已有 `.gitignore` 追加 `.dev-anywhere/`.
- 离开当前 chat 页 / 切换 session / 解析导航后的 pending wake lock 请求时, screen wake lock 都会释放.
- 移动端 PTY 辅助控制在系统软键盘被收起时跟着隐藏.
- 移动端 PTY back-to-bottom 控件靠近右边缘, 桌面端仍避开终端滚动条.

## [0.1.1] - 2026-05-09

### 变更

- proxy 配置改成显式的 `profiles` + `relays` + `--relay <name>` 命令; 旧的 `defaultEnv`/`envs` 形式被拒绝.
- 本地 web 开发现在要求显式 relay target, 例如 `pnpm dev:web -- --relay cloud --port 5174`.

### 修复

- 本地开发可以跑隔离的 proxy profile, 本地 relay 测试不再被迫打断已连云的 proxy.
- vite dev server 可以指向 local / cloud / 自定义 relay 后端, 不需要重启 proxy daemon.
- 公网 web 客户端在打开 relay WebSocket 之前显式提示输入 client token.
- chat 和终端字号菜单改成对齐的紧凑 stepper 布局.
- 活跃 relay 校验不再把临时的 `verify-proxy` entry 留在公网 proxy 列表.
- proxy 优雅断开现在清掉 relay 资源, 不再保留 offline proxy 记录.

## [0.1.0] - 2026-05-09

### 新增

- Claude Code 和 Codex 会话的本地 proxy CLI.
- WebSocket relay server 支持 proxy/client 注册 / 路由 / 健康检查 / 可选 token 鉴权.
- React web/PWA 客户端: 会话选择 / 聊天渲染 / hosted PTY 控制 / 重连恢复 / 移动端布局.
- relay / chat / session / control / system / tool 消息的共享协议 schema.
- npm 包和 Docker image 的 release workflow.
- 双语开源 README / 部署指南 / PWA 指南 / 脚本指南 / 公开截图素材.
- JSON 和 PTY 会话的剪贴板图片粘贴, 由 relay/proxy 上传消息和本地 proxy 端文件存储支撑.
- 公网 web/PWA 部署的 relay client token 支持.
- release 烟雾门禁覆盖桌面 / 移动 / PTY / 剪贴板 / 真 provider / chaos 场景.

### 变更

- 桌面端 chat 和终端字号默认改成 16px.
- PTY/JSON 会话仍在产出输出时, 会话活跃度会持续刷新.
- 长会话标题和历史标题通过 hover title 暴露完整文本.
- 公开示例和测试 fixture 不再包含私有项目名或机器路径.

### 修复

- PTY raw input 保留 IME 转换后的标点 (中文逗号 / 句号等).
- Hosted PTY provider exit chaos 不再重复标点输入.
- 慢速剪贴板图片上传始终归属到粘贴发起的那个会话.

### 安全

- 文档强调生产环境必须配置 proxy 和 client 双 relay token.
- 剪贴板图片上传拒绝不支持格式 / 超大 payload / 无效 session 路径.
