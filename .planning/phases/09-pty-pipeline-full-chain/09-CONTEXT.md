# Phase 9: PTY Pipeline Full Chain - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

<domain>
## Phase Boundary

原始 PTY 字节从 proxy 经 relay 流到浏览器 xterm.js 实时渲染，所有数据通过 EventStore 落盘持久化以支持恢复和回放。

涵盖三端改造：proxy（EventStore + headless snapshot + binary IPC）、relay（binary frame 透传 + session-buffer 删除）、browser（xterm.js /pty-test 测试页）。

不包含：客户端断线重连恢复（Phase 11）、多客户端广播（Phase 11）、会话历史回放（Phase 11）、JSON 模式链路改造（Phase 8/10）、Chat 页面集成（Phase 10）。

</domain>

<decisions>
## Implementation Decisions

### EventStore 落盘格式
- **D-01:** 自定义二进制格式，CCAE magic header + length-prefixed 事件
- **D-02:** 每事件立即写入磁盘，不丢数据优先（不做应用层缓冲）
- **D-03:** gzip 归档采用双策略：活跃文件超大小阈值时轮转压缩 + 会话结束时归档剩余文件

### CCAE 二进制格式
- **D-29:** 文件头：4 字节 magic ('CCAE') + 2 字节 version = 6 字节
- **D-30:** 事件结构：1B type + 8B timestamp(ms) + 4B payload_len + payload + 4B total_len（尾部 trailer 支持反向扫描）
- **D-31:** 事件类型编码：0x01=PTY_DATA, 0x02=SNAPSHOT, 0x03=RESIZE(固定 4B: 2B cols + 2B rows), 0x04=METADATA(JSON)
- **D-23:** METADATA 作为文件第一个事件，包含初始终端尺寸和会话元信息

### EventStore 文件组织
- **D-15:** 轮转采用序号命名：`events.bin`（活跃）-> `events.001.bin.gz`, `events.002.bin.gz`...
- **D-16:** 数据清理为手动，不自动删除历史会话文件
- **D-47:** 快照不清理历史事件，所有事件永久保留（支持 Phase 11 全量回放）
- **D-49:** 轮转时新 `events.bin` 开头强制写入 SNAPSHOT，确保活跃文件自包含，恢复无需读归档

### 快照触发策略
- **D-04:** 事件数触发（每累积 N 个事件生成一次快照），N 值由实现确定
- **D-05:** 快照嵌入 EventStore，作为特殊事件类型（0x02）写入同一二进制文件
- **D-48:** 快照定位用反向扫描——从文件尾部读 4B trailer 向前跳，找到最近 SNAPSHOT 事件
- **D-22:** 不做应用层分片，PTY onData 数据块直接作为一个事件写入

### Binary/JSON 混合传输
- **D-06:** binary 帧格式 = 1 字节 sessionId 长度 + sessionId UTF-8 字节 + PTY 数据。直接用现有 nanoid，不维护额外 ID 映射
- **D-07:** relay 纯透传 binary 帧，只读 sessionId 前缀路由，不解析不缓存不修改内容
- **D-42:** relay 转发 binary 帧保留 sessionId 前缀，零拷贝直接 ws.send(data)
- **D-43:** 客户端解析 binary 帧：读 1B 长度 -> 读 sessionId -> 剩余字节 write 到 xterm.js
- **D-08:** 重连恢复属于 Phase 11，由 proxy EventStore + 快照驱动，relay 不参与

### 架构决策
- **D-12:** 直接删除 TerminalTracker + frame-pusher + frame-cache + terminal-frame-renderer 及其测试
- **D-32:** shared 包中的 TermLine、TermSpan、terminal_frame 等旧 PTY 链路类型一并清理
- **D-33:** (同 D-32)
- **D-13:** Phase 9 只改 PTY 模式链路，JSON 模式链路保持不变
- **D-14:** 本地终端优先——先写 stdout，然后异步做 EventStore 写盘 + headless write + WebSocket 发送
- **D-24:** @xterm/headless + EventStore 放在 terminal.ts 进程，PTY 数据第一站直接处理
- **D-36:** Phase 9 删除 relay 端 session-buffer + buffer-store + buffer-compressor，relay 变完全无状态管道
- **D-37:** 所有消息恢复（JSON + binary）统一由 proxy 驱动，Phase 11 实现具体恢复协议

### 恢复策略
- **D-17:** 恢复场景为 serve.ts 重启——从 EventStore 加载最新快照服务客户端，terminal.ts 重连后恢复直播
- **D-18:** terminal.ts 崩溃 = PTY 死亡 = 会话结束，不做进程恢复（Phase 9 范围内）

### IPC 协议改造
- **D-27:** IPC 协议改造为混合模式——NDJSON 控制消息 + length-prefixed binary 帧共用一个 Unix socket
- **D-46:** RelayConnection 方法重命名：`sendEnvelope()` 发 JSON 信封消息（有队列），`sendBinary()` 发 binary PTY 帧（无队列，断线丢弃）

### xterm.js 浏览器端
- **D-09:** 独立 `/pty-test` 测试页验证全链路，不依赖 Phase 8/10 的业务逻辑
- **D-28:** `/pty-test` 页面 = 全屏 xterm.js + 连接状态栏 + 手动输入 relay URL 和 sessionId
- **D-44:** `/pty-test` 页面只读，不支持远程输入。输入功能走现有 JSON 链路，Phase 10 集成
- **D-10:** xterm.js addon：fit + serialize + web-links
- **D-11:** PTY 为尺寸权威，客户端被动跟随 resize 事件，CSS 缩放适配视口
- **D-19:** 两端 scrollback 统一 5000 行（proxy @xterm/headless + browser xterm.js）
- **D-25:** `/pty-test` 页面用原生 `new WebSocket()`，Phase 9 不依赖 Phase 8
- **D-26:** 浏览器端按 `event.data` 类型分发：ArrayBuffer -> xterm.js，string -> JSON 控制消息处理
- **D-40:** xterm.js 主题用设计 token——bg #1E1E1E, fg #D4D4D4, cursorAccent #00D4AA, ANSI 16 色用 VS Code Dark+ 色板
- **D-41:** 字体加载时序——`document.fonts.ready` 后再初始化 xterm.js，保证 CJK 字符宽度计算正确

### 测试与验证
- **D-20:** 全链路测试 = Playwright E2E 保基础链路 + 手动验证视觉质量
- **D-21:** replay.ts 迁移到新链路（binary frame + EventStore）
- **D-38:** 测试随代码同步迁移，每个 plan 后测试都能跑通

### 实现顺序与风险
- **D-34:** 实现顺序 09-01 proxy -> 09-02 relay -> 09-03 browser，沿数据流方向
- **D-35:** 风险前置验证——Plan 09-01 第一步做 spike 验证 headless+serialize 导入、IPC 混合协议原型、EventStore 写入压测
- **D-45:** Phase 9 先于 Phase 8 执行，避免 shared 包类型冲突

### Claude's Discretion
- 事件数触发快照的具体 N 值（可参考 b05bec2 的 100 事件/次作为起点）
- gzip 轮转的文件大小阈值
- IPC 混合协议的帧边界标识字节设计
- xterm.js unicode11 addon 是否需要启用（CJK 宽字符处理）
- `/pty-test` 页面的具体 UI 布局细节

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Migration Blueprint
- `.planning/quick/260415-k44-migrate-feishu-client-from-taro-mini-pro/MIGRATION-PLAN.md` -- v2.0 整体迁移蓝图，Phase D 对应本 phase。注意：本 CONTEXT.md 的决策为最新权威，在有差异的地方以本文档为准

### Prior EventStore Implementation (Git History)
- commit `b05bec2` (`git show b05bec2:apps/proxy/src/event-store.ts`) -- 之前实现的 EventStore，CCAE 二进制格式、gzip、disk persistence。作为参考起点但需要根据本次决策改进（写盘策略、事件类型、尾部 trailer、多文件轮转等）
- commit `b05bec2` (`git show b05bec2:apps/proxy/src/terminal-tracker.ts`) -- 之前的 TerminalTracker，@xterm/headless + serialize addon 快照。快照生成逻辑可参考
- commit `411e583` -- 删除 EventStore 的 commit，了解当时为什么删除以及替换方案

### Current PTY Pipeline (To Be Replaced)
- `apps/proxy/src/terminal-tracker.ts` -- 当前 TerminalTracker，Phase 9 删除
- `apps/proxy/src/frame-pusher.ts` -- 当前 JSON 帧推送器，Phase 9 删除
- `apps/proxy/src/frame-cache.ts` -- 当前帧缓存，Phase 9 删除
- `apps/proxy/src/terminal-frame-renderer.ts` -- 当前终端帧渲染器，Phase 9 删除

### Core Files to Modify
- `apps/proxy/src/terminal.ts` -- PTY 数据第一站，加入 EventStore + headless + binary 发送
- `apps/proxy/src/serve.ts` -- service daemon，加入 binary IPC 接收和 binary WebSocket 转发
- `apps/proxy/src/ipc-protocol.ts` -- IPC 协议定义，改为混合模式
- `apps/proxy/src/relay-connection.ts` -- relay 连接管理，加 sendBinary()，rename send -> sendEnvelope
- `apps/proxy/src/paths.ts` -- 文件路径定义，`events.bin` 已预留

### Relay Files to Modify
- `apps/relay/src/handlers/proxy.ts` -- proxy handler，加入 binary frame 透传
- `apps/relay/src/handlers/client.ts` -- client handler，转发 binary frame
- `apps/relay/src/session-buffer.ts` -- Phase 9 删除
- `apps/relay/src/buffer-store.ts` -- Phase 9 删除
- `apps/relay/src/buffer-compressor.ts` -- 已是死代码，Phase 9 清理

### Shared Package
- `packages/shared/src/schemas/envelope.ts` -- MessageEnvelope 定义，理解 JSON 信封结构
- `packages/shared/src/schemas/relay-control.ts` -- terminal_frame 相关类型待清理

### Design Tokens (Phase 7)
- `apps/web/src/app.css` -- 设计 token 定义，xterm.js 主题需对齐
- Phase 7 CONTEXT.md D-01~D-03 -- 锚点色：#1E1E1E surface、#D4D4D4 text、#00D4AA accent

### Font Loading
- `apps/relay/src/server.ts` L36-41 -- relay `/fonts/` 静态文件服务
- relay-data `/fonts/sarasa-fixed-sc/result.css` -- cn-font-split 子集化字体

### Requirements
- `.planning/REQUIREMENTS.md` -- PTY-01 至 PTY-04、FRONT-07

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **EventStore (b05bec2):** CCAE 二进制格式实现，可作为起点重构。核心逻辑（文件头、事件编码/解码、gzip 归档）高度可复用
- **TerminalTracker (b05bec2):** @xterm/headless + serialize addon 快照逻辑，快照生成和加载可复用
- **paths.ts:** `sessionPaths(id).events` 已预留 `events.bin` 路径
- **IPC 协议:** `ipc-protocol.ts` 现有 NDJSON 协议和 LineBuffer，混合协议需在此基础上扩展
- **RelayConnection:** 已有 WebSocket 管理、自动重连、消息队列，加 sendBinary 即可
- **osc-extractor.ts:** OSC 信号提取（Claude Code 状态），继续在原始 PTY 流上工作
- **Sarasa Fixed SC 字体:** cn-font-split 子集化完成，relay `/fonts/` 已 serve

### Established Patterns
- ESM + TypeScript 全项目统一
- pnpm workspace monorepo
- zod schema 运行时校验
- pino 结构化 JSON 日志
- vitest 测试框架

### Integration Points
- `apps/web/` -- 新增 /pty-test 页面和路由
- `apps/proxy/src/terminal.ts` -- DataTap 回调是 PTY 数据入口
- `apps/relay/src/handlers/proxy.ts` -- WebSocket message handler 需区分 binary/text
- Vite `server.proxy` -- 开发模式代理 WebSocket 到 relay

</code_context>

<specifics>
## Specific Ideas

- b05bec2 的 EventStore 实现是起点但不是终点，需要根据本次讨论的 50 项决策改进
- MIGRATION-PLAN.md 是早期探索性文档，本 CONTEXT.md 的决策是最新权威
- relay 无状态是架构方向选择——相比客户端重连的微小延迟，换来部署简单、逻辑清晰、内存可预测
- 输出走 binary（高频大量）、输入走 JSON（低频微量）的非对称设计
- `/pty-test` 是临时验证页，Phase 10 集成到 Chat 页面后可保留为调试工具或删除

</specifics>

<deferred>
## Deferred Ideas

- **relay 完全无状态化延伸** -- JSON 消息的恢复也统一从 proxy 走（当前 MemoryMessageQueue 仍在 proxy 端），彻底消除 relay 任何状态。Phase 11 评估
- **客户端驱动 resize** -- 浏览器端 fit addon 计算最优尺寸后反向通知 proxy 调整 PTY。当前 PTY 为权威，客户端被动跟随。可作为未来体验优化
- **EventStore 自动清理** -- 按时间或磁盘空间自动清理老会话数据。当前为手动清理

### Reviewed Todos (not folded)
- "小程序消息缓存采用快照清理策略"（area: feishu, score: 0.6）-- 飞书小程序已废弃，不适用于 Phase 9 的 EventStore 设计

</deferred>

---

*Phase: 09-pty-pipeline-full-chain*
*Context gathered: 2026-04-15*
