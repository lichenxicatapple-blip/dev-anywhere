# Requirements: CC Anywhere

**Defined:** 2026-04-03
**Core Value:** 在任何地方（电脑或手机）都能与 Claude Code 实时交互，体验一致，不丢失上下文

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Local Proxy

- [x] **PROXY-01**: 用户通过 cc_anywhere 启动 claude 进程，本地终端体验与直接使用 claude 完全一致（stdin/stdout/stderr 透传、ANSI 转义、交互提示）
- [ ] **PROXY-02**: 本地使用 PTY 透传终端 I/O，远程使用 Agent SDK 提供结构化控制，两条通道并行不干扰
- [ ] **PROXY-03**: 支持同时管理多个 claude 子进程，每个会话独立，包含创建、状态监控、优雅终止和孤儿进程清理
- [ ] **PROXY-04**: 本地终端和飞书小程序可同时操作同一会话，双方看到一致的状态和输出

### Relay Server

- [ ] **RELAY-01**: 中转服务器通过 WebSocket 桥接本地代理和飞书小程序，本地代理主动连接，无需公网 IP
- [ ] **RELAY-02**: 支持自动重连（指数退避）、断线期间消息队列缓存、重连后会话状态恢复
- [ ] **RELAY-03**: 消息协议包含序列号，保证消息有序传递，检测并处理消息丢失
- [ ] **RELAY-04**: 飞书小程序后台销毁期间，中转服务器缓存消息，小程序重连后回放未读消息

### Feishu Mini Program - Core

- [ ] **FEISHU-01**: 用户在飞书小程序中发送文字消息，实时看到 Claude Code 的流式输出
- [ ] **FEISHU-02**: Claude Code 请求执行工具时，小程序弹出审批界面显示工具名称、参数预览，用户点击批准或拒绝
- [ ] **FEISHU-03**: 小程序展示会话列表，支持创建新会话、切换会话、终止会话
- [ ] **FEISHU-04**: 用户可查看会话历史消息，断开重连后不丢失之前的对话内容
- [ ] **FEISHU-05**: 输出内容以消息气泡、代码块、可折叠工具调用卡片等移动端友好的形式渲染

### Feishu Mini Program - Voice

- [ ] **VOICE-01**: 用户可通过语音输入，语音转文字后作为指令发送给 Claude Code

### Feishu Mini Program - Enhanced UX

- [ ] **UX-01**: 支持 markdown 渲染、代码语法高亮、diff 彩色显示
- [ ] **UX-02**: 提供快捷操作按钮（/compact、/status 等常用命令），减少手机打字
- [ ] **UX-03**: 任务完成、需要审批、出错时推送通知到飞书（小程序或 Bot 消息）
- [ ] **UX-04**: 支持会话命名和状态标记（空闲、工作中、等待审批、出错），一览全局
- [ ] **UX-05**: 展示每个会话的 token 用量、运行时长、工具调用次数

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Multi-Platform

- **PLAT-01**: 支持 Telegram 作为额外的移动端入口
- **PLAT-02**: 支持 Slack 作为额外的移动端入口
- **PLAT-03**: 支持钉钉作为额外的移动端入口

### Multi-Agent

- **AGENT-01**: 支持 Cursor Agent 作为可控制的 AI agent
- **AGENT-02**: 支持 Gemini CLI 作为可控制的 AI agent

### Collaboration

- **COLLAB-01**: 支持多用户认证（OAuth）
- **COLLAB-02**: 支持飞书群聊中多人协作控制会话

### Advanced

- **ADV-01**: 从飞书远程启动新的 Claude Code 会话（不需要先在电脑上操作）
- **ADV-02**: 文件变更摘要（显示修改了哪些文件、多少行，不做完整 diff 预览）

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| 终端模拟器（xterm.js in mini program） | 手机屏幕上 ANSI 转义+滚动 = 不可用，应用结构化渲染替代 |
| Web UI | v1 聚焦飞书小程序，官方已有 claude.ai/code |
| 云端 Claude Code 实例 | 架构假设 Claude Code 运行在用户本机 |
| 文件编辑/代码审查 | 手机屏幕不适合读写代码，应引导回桌面 |
| 自定义模型路由 | CC Anywhere 的价值是远程控制，不是模型切换 |
| 定时任务调度 | Claude Code 官方已有此功能 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| PROXY-01 | Phase 2 | Complete |
| PROXY-02 | Phase 3 | Pending |
| PROXY-03 | Phase 3 | Pending |
| PROXY-04 | Phase 7 | Pending |
| RELAY-01 | Phase 4 | Pending |
| RELAY-02 | Phase 5 | Pending |
| RELAY-03 | Phase 4 | Pending |
| RELAY-04 | Phase 5 | Pending |
| FEISHU-01 | Phase 6 | Pending |
| FEISHU-02 | Phase 7 | Pending |
| FEISHU-03 | Phase 6 | Pending |
| FEISHU-04 | Phase 6 | Pending |
| FEISHU-05 | Phase 8 | Pending |
| VOICE-01 | Phase 9 | Pending |
| UX-01 | Phase 8 | Pending |
| UX-02 | Phase 10 | Pending |
| UX-03 | Phase 10 | Pending |
| UX-04 | Phase 10 | Pending |
| UX-05 | Phase 10 | Pending |

**Coverage:**
- v1 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0

---
*Requirements defined: 2026-04-03*
*Last updated: 2026-04-03 after roadmap creation*
