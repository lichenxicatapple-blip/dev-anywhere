# 更新日志

本项目所有可见的变更都记录在这个文件里。每条聚焦用户可感知的影响；根因分析、commit hash、文件路径等实现细节请查 git log 与 PR 描述。

`1.0.0` 之前遵循语义化版本：minor 版本可能包含 breaking change，patch 版本只做兼容修复。

## [0.4.25] - 2026-05-25

### 修复

- 继续修正移动端 PTY 从底部开始上滑时的起步轻微抖动：同一 xterm viewport 内，浏览器原生滚动如果在手指停住时继续过冲，会被钉回当前手指对应的 scrollTop，不再让同一屏内容自行滑出几像素。

### 测试

- 新增 PTY scroll controller 回归，覆盖用户 trace 中同一 viewport 内原生触摸滚动过冲、但不应触发 xterm viewport 切换的场景。
- 重新验证 Android emulator 下 PTY 底部上滑/回底与横向滑动回归。

## [0.4.24] - 2026-05-25

### 修复

- 进一步减少移动端 PTY 从底部开始上滑时的轻微起步抖动：同一 xterm viewport 内浏览器原生滚动明显落后手指位移时，先让容器位置跟上手指，但不触发 xterm 换行同步。

### 测试

- 新增 PTY scroll controller 单测，覆盖底部起步、同一 viewport 内跟随手指且不触发 xterm viewport 切换的场景。
- 重新验证 Android emulator 下 PTY 横向滑动、触摸文件链接、长按复制与长按文件链接下载回归。

## [0.4.23] - 2026-05-25

### 修复

- 减少移动端 PTY 上滑初段的一行内小抖动：触摸滚动仍在同一 xterm 行内时不再反复同步 viewport，只合并通知 React 状态。
- PTY 文件路径在移动端不再 tap 后直接下载，恢复为长按选中文件链接后通过浮层里的“下载终端链接”按钮确认下载。
- 多行折行的 PTY 文件路径现在作为一个完整跨行链接返回给 xterm，hover/命中范围覆盖整段路径，而不是只覆盖第一行。

### 测试

- 新增 PTY scroll controller 单测，覆盖同一行内原生触摸滚动不应触发 xterm viewport 反复同步的场景。
- 更新 Android emulator E2E，覆盖移动端文件路径 tap 不下载、长按文件链接仍能从 toolbar 下载、图片路径 tap 预览不回退。

## [0.4.22] - 2026-05-25

### 修复

- 修复移动端 PTY 上滑回看时仍由 `restore-touch-drift` 按手指位移公式强行改写 `scrollTop`，导致浏览器原生滚动和 JS 纠偏互相抢控制权、出现剧烈抖动的问题。
- PTY 触摸滚动期间只保留静止布局跳变和灾难性跳到页顶这两类异常修正，正常纵向滚动完全交给浏览器原生 `pan-y`。
- 触摸期间异常修正会延后 host 定位到 xterm render 后提交，减少中间帧 host 与 viewport 错位。

### 测试

- 新增 PTY scroll controller 单测，复现 Android trace 中 native scroll 位置滞后于手指位移公式时不应被拉回 expected scrollTop 的场景。
- 重新验证 Android emulator 下 PTY 底部滚动、横向滑动和触摸文件链接下载回归。

## [0.4.21] - 2026-05-25

### 修复

- 修复移动端 PTY 横向触摸滑动在锁定横向手势后又被覆盖成纵向 review 的问题；有横向溢出的会话现在可以通过手指横滑移动 `scrollLeft`。
- 修复移动端 PTY 中文档路径被项目符号缩进、手动换行和终端自动折行共同拆成多段后无法点击下载的问题。
- 移动端 PTY 纵向触摸滚动改回由浏览器原生 `pan-y` 处理，减少滑动不跟手、轻扫被 JS 每帧改写 `scrollTop` 造成的跳变。
- PTY 文件路径触摸下载增加短时间去重，避免同一次 tap 被 touch 激活和 xterm 兼容点击重复触发下载。

### 测试

- 新增 Android emulator E2E，覆盖 PTY 在移动端存在横向溢出时，真实 CDP touch-drag 必须触发 `horizontal-pan` 并改变横向滚动位置。
- 新增 Android emulator E2E，覆盖缩进硬换行的 Markdown 文档路径在移动端 tap 后必须发出完整 `file_download_request`。
- 更新 PTY 触摸滚动单测，验证纵向滑动不再阻止浏览器原生滚动。

## [0.4.20] - 2026-05-24

### 修复

- 重构移动端 PTY 触摸手势仲裁：tap、long press、纵向滚动和横向滚动分开判定，避免轻微拖动时由浏览器原生滚动、xterm viewport 和 React 手势同时争夺 `scrollTop`。
- PTY 文档/图片路径上的轻触会优先按链接 tap 处理，不再被长按选择定时器抢先吞掉，修复移动端文档链接点击后不触发下载的问题。
- 无横向溢出时会清理 stale horizontal intent，减少软键盘和轻扫场景下的错误回看状态与底部空白。

### 测试

- Android emulator E2E 覆盖带轻微手指漂移的文件路径、折行文档路径和图片路径触摸点击。
- Android emulator E2E 覆盖 PTY 底部轻扫、回到底部和回看时新输出不吸底。

## [0.4.19] - 2026-05-24

### 修复

- 移动端 PTY 里的文件、Markdown 文档和图片路径现在使用真实触摸坐标命中终端链接，修复无 hover 环境下点击路径不触发下载或预览的问题。
- 移动端 PTY 贴底时的小幅触摸会继续保持在 cursor-aware 底部，避免轻触或轻扫时闪现上一屏内容。
- PTY 长 host / fractional line-height 场景下的底部判定会容忍亚像素误差，避免已经在底部时仍被误判为回看状态。

### 测试

- Android emulator E2E 改为真实触摸终端中的文件路径、折行文档路径和图片路径，并新增贴底小幅触摸不跳页回归。

## [0.4.18] - 2026-05-24

### 修复

- 移动端 PTY 输出里的文件路径可以直接点击下载，包括被终端自动折成多行的长 Markdown 文档路径。
- 移动端 PTY 视口在底部跟随时会减少接近一整行的底部空白，避免软键盘和滚动场景下出现大块留白。

### 测试

- 增加 Android emulator E2E 覆盖移动端 PTY 文件下载链接、折行文档路径下载，以及 PTY 屏幕底部留白回归。

## [0.4.17] - 2026-05-24

### 修复

- 移动端 PTY 在软键盘场景下轻微上滑时，会拒绝浏览器异常跳到顶部的原生滚动值，并保留用户实际的回看位置。
- PTY 滚动 trace 保留 touch 关键诊断事件，避免大量终端输出把复现线索挤出报告。
- PTY 输出里的下载路径即使被终端自动折成多行，也可以正确识别为同一个可下载文件；移动端长按选择下载同样支持折行路径。

## [0.4.16] - 2026-05-24

### 修复

- PTY 页面重新加载、从后台切回或会话重新激活时统一回到底部，减少浏览器恢复旧滚动位置导致的错位和误判。
- 移动端 PTY 点击屏幕不再立即进入“回看”状态，只有实际滑动超过阈值才暂停跟随，避免轻触后闪现上一页内容或被异常拉到顶部。

## [0.4.15] - 2026-05-24

### 修复

- 历史会话列表在 macOS 上也会隐藏 `/private/var/folders/.../T` 这类系统临时目录项目，避免自动化测试会话残留在历史列表里。

## [0.4.14] - 2026-05-24

### 修复

- PTY 会话从后台或其它会话切回时，如果切走前位于底部，会重新回到底部，避免浏览器恢复旧滚动位置后误判为用户正在回看历史。
- 历史会话列表隐藏系统临时目录下的项目会话，减少 `/tmp`、系统缓存目录里的临时会话干扰正常项目列表。

## [0.4.13] - 2026-05-24

### 修复

- 修复 PTY 模式下手机输入法偶尔把上一轮输入内容重新塞回终端的问题，避免隐藏输入框残留影响后续输入。

## [0.4.12] - 2026-05-24

### 修复

- Claude 历史会话在需要选择恢复模式时，将“聊天 / 终端”按钮移到会话标题下方并与标题左侧对齐，避免按钮挤占标题右侧空间。

## [0.4.11] - 2026-05-24

### 修复

- 修复移动端 PTY 在短 host 场景下打开会话或原生滚动时出现一行内抖动的问题，统一 host 定位计算口径，避免在贴底偏移和行顶对齐之间来回跳。
- “压缩中”状态改用独立的紫色状态色和低强度呼吸效果，避免和普通“工作中”状态混淆。

## [0.4.10] - 2026-05-24

### 修复

- JSON 会话执行 `/compact` 时会正确处理 Claude Code 的本地命令完成/失败事件，压缩成功或失败都会显示反馈并退出“压缩中”状态。
- `/compact` 失败时会展示具体失败原因，避免界面长时间停在无响应状态。

## [0.4.9] - 2026-05-24

### 新增

- JSON 会话支持 Claude Code 原生 `/compact` 命令，用于压缩当前上下文并继续保留会话。

### 修复

- `/compact` 不再作为普通用户消息气泡显示，多端同步时也不会回显成一条聊天消息。
- 压缩上下文期间会话进入“压缩中”状态，状态灯带、侧边栏和 Voice Pilot 忙碌判断会同步反映，避免误以为 agent 正在普通响应或继续收音。

## [0.4.8] - 2026-05-23

### 修复

- 移动端 Voice Pilot 设置页改为底部设置面板布局，表单区域独立滚动，测试/保存操作固定在底部，避免长表单在手机上挤压和遮挡。
- 语音模型、音色和地域选择改为应用内选择器，不再触发移动浏览器原生大下拉，减少选项换行和样式割裂。
- 打开 Voice Pilot 设置时固定首屏从标题区域开始，并保持副标题、表单和底部操作的间距一致，避免自动聚焦 API Key 导致页面从中段打开。

## [0.4.7] - 2026-05-23

### 修复

- JSON 历史会话通过恢复入口重新打开时，会保留原 Claude 会话作为历史来源，同时允许当前 worker 使用新的 Claude 会话 ID，避免恢复后点进会话只看到空白“开始对话”。
- 已受影响的活跃 JSON 恢复会话会在 proxy 重启后从本地历史元数据自动补回历史来源。

## [0.4.6] - 2026-05-23

### 测试

- Release 使用的 Playwright layout、PC、mobile 门禁默认启用 flaky 检测；只要用例 retry 后才通过，发布流程也会失败，避免靠运气发版。
- 移动端连接丢失面板测试隔离上一个 auto-restore 用例的路由状态，减少 Android Chrome 共享页面带来的假超时。
- 移动端 PTY 光标可见性测试改为验证真实光标锚点，而不是依赖 Android Chrome 中 xterm helper textarea 的元素高度，避免半行级布局抖动造成误报。

## [0.4.5] - 2026-05-23

### 修复

- 会话历史新增模式元数据，重启开发机或 proxy 后可以按原来的 JSON/PTY 模式恢复会话，避免 JSON 会话丢失后只能按终端会话重建。
- 历史列表在无法确定模式的 Claude 会话上提供聊天/终端选择；已知模式的会话则直接恢复到正确入口。
- 会话标题、工作目录和原生 Claude 会话 ID 会随历史元数据保存，并参与去重，减少重启后出现重复或信息不完整的历史项。
- 设置页的 Voice Pilot 入口补充副标题，说明可用语音输入、听取回复和处理审批。
- 清理 Voice Pilot 控制器的 hook 依赖与稳定回调，避免 lint 警告掩盖真实状态同步问题。

## [0.4.4] - 2026-05-21

### 变更

- 移动端发布门禁改为默认使用 2 台专用 Android emulator 并行执行，并在 release smoke 中自动启动或复用 emulator pool，避免发布时忘记准备移动端环境。
- 移动端 PTY 长按复制测试拆分稳定 gate 与专项边缘滚动诊断：默认门禁保留选区、复制、下载、toolbar 和清空行为覆盖，最容易受 Android 触摸调度影响的边缘 autoscroll 诊断改为显式开启。

### 测试

- Mobile E2E 新增 per-spec timing report、shard timing 汇总、Chrome 首次启动页处理和更严格的 CDP page readiness 检查，用于降低发布阶段的偶发失败和定位慢用例。

## [0.4.3] - 2026-05-21

### 新增

- 设置页新增可选“延迟监控”悬浮窗，持续显示浏览器、中转服务、开发机之间的连接延迟，方便普通用户判断卡顿是否来自网络或代理链路。

### 可观测性

- 延迟监控与高级排障能力分层：悬浮窗只展示用户可理解的连接状态，逐字符回显、渲染差异和滚动记录等高级诊断仍需开发人员手动开启。

## [0.4.2] - 2026-05-20

### 可观测性

- PTY 原始输入协议新增可选 trace ID，并在 Web、proxy、Hosted PTY 和前端渲染链路中打通输入延迟追踪，方便定位“敲键后很久才看到回显”是卡在发送、转发、PTY 写入、输出回流还是浏览器 paint。

## [0.4.1] - 2026-05-20

### 修复

- 移动端 PTY 长按复制选区在软键盘 visual viewport 动画、选区手柄拖拽和外部点按清理时更稳定，避免发布门禁中出现首跑失败、retry 才通过的 flaky。
- Release workflow 将 npm 包发布改为显式启用，避免 npm scope 尚未开通或 token 权限不足时阻断 Docker 镜像与 VPS 发布。

## [0.4.0] - 2026-05-20

### 新增

- JSON 会话新增 Voice Pilot 语音助手模式。用户可在屏幕常亮场景下用语音驱动会话，支持语音识别、语音播报、实时状态条、提示音和退出/复述等基础语音指令。
- 设置页新增语音识别及合成配置，支持百炼语音服务、API Key 掩码展示与清空、模型/音色选择、配置测试和测试音频播放。
- 工具审批支持语音播报概述，并可通过“批准”“拒绝”“始终允许”处理审批；PTY 审批场景新增始终允许入口，后续同类审批可自动放行。

### 变更

- Voice Pilot 改为由明确状态机驱动，区分聆听、等待、播报、审批和异常状态；agent 思考或工具执行期间不再继续收音，减少背景噪音误提交。
- 会话菜单继续收敛布局和分组，Voice Pilot 并入会话组，字号控制保持正文列左对齐。
- 新建会话的聊天模式说明补充“气泡式”体验和 Voice Pilot 支持，减少 JSON 模式理解成本。

### 修复

- 修复 Voice Pilot 在多轮播报、审批、ASR/TTS socket 空闲关闭和会话恢复场景下状态漂移的问题，避免播完不回聆听、思考中仍聆听、审批语音无响应等异常。
- 修复 Claude/Codex 审批请求在同毫秒生成重复 ID 导致会话卡住的问题。
- 修复 JSON 消息中的文件路径识别过宽导致 `json.loads` 等点号 API 符号被误显示为下载链接的问题；现在只有明确路径或约定俗成的顶层项目文件会自动成为下载动作。
- 修复新建会话标题和会话重命名逻辑未完全联动的问题。
- 修复 PTY 移动端控制键和清空输入交互中的误触风险，降低连续点击清空导致终端退出的概率。

## [0.3.14] - 2026-05-18

### 修复

- PTY keep-alive 会话在切到其他会话后如果隐藏态 DOM 滚动被浏览器还原到顶部，重新切回时会按隐藏前的“跟随底部”语义恢复到底部，避免长输出会话停在最上方。
- 会话菜单的字号控制移除重复的“终端字号/聊天字号”文案，并让 stepper 左边缘与其他菜单项正文列对齐，保持菜单宽度和视觉节奏稳定。

## [0.3.13] - 2026-05-18

### 修复

- PTY 页面从后台/锁屏恢复且连接在恢复期间重建时，会继续按隐藏前的“跟随底部”语义恢复到底部，避免 Chrome 把 DOM 滚动还原到顶部后，新 controller attach 误以为用户正在回看而停在最上方。

## [0.3.12] - 2026-05-18

### 修复

- 移动端 PTY 在触屏滚动、软键盘和长行输入场景下进一步稳定底部锚点与水平光标跟随，避免输入时视口跳到 host 顶部、长行看不见光标，回车后水平滚动不回到行首。
- 移动端 PTY 粘贴按钮改走 xterm 的 paste 流程，保留 Codex bracketed paste 边界，让大段粘贴继续被 Codex 压缩为 `[Pasted Content ...]`。
- JSON 模式 Markdown 表格中的 inline-code 文件路径现在可点击下载，仍保留普通正文 inline code 不自动改写的保护。
- 会话菜单的字号 stepper 改到“终端字号/聊天字号”下方，避免在移动端横向撑宽菜单项。
- 开启屏幕常亮后页面进入后台会主动释放 wake lock，避免返回后即使关闭常亮仍保持不熄屏。

## [0.3.11] - 2026-05-18

### 修复

- 移动端 PTY 在软键盘态底部长按/复制后，如果键盘收起导致 cursor-aware bottom 的原始 `scrollTop` 变小，`touchend` 会按语义底部释放回跟随状态，避免随后 relayout 把视口拉回 host 顶部并造成复制浮层、手柄和光标位置突变。

## [0.3.10] - 2026-05-18

### 修复

- 移动端 PTY 在底部长按/触发复制时，如果 Chrome 原生滚动把 long-host 容器临时拉回 host 顶部，会立即恢复到 cursor-aware bottom，并且 `touchend` 不再用旧的底部位置误清回看意图，避免状态显示为跟随底部但光标实际离开视口。
- `dev-anywhere serve restart` 的服务清理流程改为幂等，避免 PID 文件已被提前删除时重启失败。
- 发布包校验补充 proxy CLI shebang 覆盖，防止 npm 全局安装后的命令入口缺少 `node` shebang。

## [0.3.9] - 2026-05-17

### 修复

- PTY 页面从后台或浏览器历史恢复时，如果离开前处于跟随底部状态，会在恢复后按语义状态重新定位到底部，避免 Chrome 还原旧 `scrollTop` 后误入回看；如果离开前用户正在回看历史，则继续保留回看位置。
- 移动端 PTY 文件路径不再单击即下载，降低误触；长按文件路径会选中完整链接，并在选区浮层中提供“下载”动作，普通文本长按仍只提供复制。
- 移动端 PTY 长按选区在软键盘收起、手柄拖拽与底部边缘自动滚动场景下保持浮层和手柄对齐，避免复制/下载按钮随旧触点跳变。
- 移动端 PTY “清空输入区”改为清理 agent 输入区完整草稿：Claude 发送双 `Esc`，Codex 按官方 TUI 行为发送 `Ctrl+C` 清空非空 composer，不再使用只能清到行首的 `Ctrl+U`。
- 移动端顶部品牌标语 `/unlimited @anytime` 在窄屏上保持单行展示，并将设置按钮的可见圆形收窄到与标语高度接近，同时保留 44px 触控热区。
- 清理发布门禁中暴露的 lint/format 问题，根级 `lint`、`format:check`、`typecheck` 与单元测试重新通过。

## [0.3.8] - 2026-05-17

### 修复

- 移动端 PTY 长按复制选区在软键盘收起或视口重排后，复制按钮会随选区手柄一起按当前终端坐标重算位置，避免按钮停在旧触点而手柄跳到底部；新增真 Android Chrome 回归测试覆盖键盘收起后的浮层/手柄对齐。

## [0.3.7] - 2026-05-17

### 修复

- 移动端 PTY 在软键盘打开后长按复制时，不再因 Chrome 先改容器滚动、后发 visualViewport 变化而让复制按钮/选区手柄跳到错误位置；长按候选行会在 touchstart 时缓存为终端 buffer 坐标，键盘收起或布局重排后仍能稳定创建选区并回到底部。

## [0.3.6] - 2026-05-17

### 修复

- 移动端 PTY 在软键盘/控制键导致底部锚点变化时，不再把底部轻触误判成用户回看；移动端控制键输入会在本帧内强制回到底部，避免 Shift+Tab 等按钮触发焦点切换后出现短暂跳到 host 顶部的画面跳变。

## [0.3.5] - 2026-05-17

### 修复

- 移动端 PTY 在软键盘弹出时长按选择/复制不再把视口误判为用户回看并留下错误滚动意图；复制按钮改按 visual viewport 定位，避免键盘收起/展开期间复制浮层和光标跟随出现明显漂移。

## [0.3.4] - 2026-05-17

### 修复

- 移动端 PTY 在底部轻触或 Chrome 重新进入后不再残留临时回看意图，避免会话重新挂载时停在顶部并跳过初始化滚到底。

## [0.3.3] - 2026-05-16

### 修复

- 移动端 PTY 控制条新增“粘贴”按钮，通过安全上下文中的原生 Clipboard API 读取文本并发送到终端，便于真机验证剪贴板输入；读取失败时仅显示错误提示。

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
