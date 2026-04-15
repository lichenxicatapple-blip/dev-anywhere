# Requirements: CC Anywhere — Milestone v2.0

**Defined:** 2026-04-15
**Core Value:** 在任何地方（电脑或手机）都能与 Claude Code 实时交互，体验一致，不丢失上下文

## Frontend Migration (FRONT)

- [ ] **FRONT-01**: apps/web 项目搭建（Vite + React + TypeScript + Tailwind CSS + shadcn/ui）
- [ ] **FRONT-02**: 设计 token 定义（颜色、字号、间距、圆角）配置到 Tailwind 主题
- [ ] **FRONT-03**: App Shell 布局组件（safe area、导航栏、响应式断点）
- [ ] **FRONT-04**: Proxy Select 页面迁移
- [ ] **FRONT-05**: Session List 页面迁移
- [ ] **FRONT-06**: Chat 页面迁移（JSON 模式：聊天气泡、Markdown 渲染、工具审批）
- [ ] **FRONT-07**: Chat 页面迁移（PTY 模式：xterm.js 终端视图）
- [ ] **FRONT-08**: 通用组件迁移（InputBar、Toast、Modal、StatusLine、BackToBottom 等）
- [ ] **FRONT-09**: phase-machine 状态机适配（react-router + localStorage）
- [ ] **FRONT-10**: relay-store WebSocket 层清理（移除 Taro 分支，仅保留原生 WebSocket）

## PTY Pipeline (PTY)

- [x] **PTY-01**: proxy 端 @xterm/headless + serialize addon 快照机制
- [x] **PTY-02**: proxy 端 EventStore 二进制持久化恢复（落盘 + gzip）
- [x] **PTY-03**: proxy 转发原始 PTY 字节流（替换 TerminalTracker + frame 推送）
- [ ] **PTY-04**: relay 端 binary WebSocket frame 透传
- [ ] **PTY-05**: 客户端断线重连：快照 + 增量事件重放
- [ ] **PTY-06**: 多客户端同时观看同一 session 广播
- [ ] **PTY-07**: replay 命令恢复（读 EventStore 回放会话）

## PWA (PWA)

- [ ] **PWA-01**: manifest.json + Service Worker + 离线缓存
- [ ] **PWA-02**: 用 nanobanana 生成应用图标（192x192、512x512）
- [ ] **PWA-03**: Screen Wake Lock（屏幕常亮）
- [ ] **PWA-04**: Web Speech API 语音输入
- [ ] **PWA-05**: Web Speech API 语音朗读 Claude Code 输出

## Deployment (DEPLOY)

- [ ] **DEPLOY-01**: relay 同进程 serve 前端静态文件（express.static）
- [ ] **DEPLOY-02**: Vite 开发模式 WebSocket proxy 到 relay

## Notifications + Quick Actions (NOTIF)

- [ ] **NOTIF-01**: Browser Push API 通知（任务完成/工具审批/出错时推送，即使页面关闭也能收到）
- [ ] **NOTIF-02**: 快捷操作面板（一键常用命令、快速切换会话）

## Future Requirements (Deferred)

- 飞书网页应用配置（开放平台注册、JSSDK 鉴权）

## Out of Scope

- 飞书小程序维护 — 已决定迁移到 PWA，apps/feishu 存档不再开发
- 多 Agent 支持 — 仅支持 Claude Code
- 用户认证系统 — 面向个人或信任环境

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| FRONT-01 | Phase 7 | Pending |
| FRONT-02 | Phase 7 | Pending |
| FRONT-03 | Phase 10 | Pending |
| FRONT-04 | Phase 10 | Pending |
| FRONT-05 | Phase 10 | Pending |
| FRONT-06 | Phase 10 | Pending |
| FRONT-07 | Phase 9 | Pending |
| FRONT-08 | Phase 10 | Pending |
| FRONT-09 | Phase 8 | Pending |
| FRONT-10 | Phase 8 | Pending |
| PTY-01 | Phase 9 | Complete |
| PTY-02 | Phase 9 | Complete |
| PTY-03 | Phase 9 | Complete |
| PTY-04 | Phase 9 | Pending |
| PTY-05 | Phase 11 | Pending |
| PTY-06 | Phase 11 | Pending |
| PTY-07 | Phase 11 | Pending |
| PWA-01 | Phase 12 | Pending |
| PWA-02 | Phase 12 | Pending |
| PWA-03 | Phase 13 | Pending |
| PWA-04 | Phase 13 | Pending |
| PWA-05 | Phase 13 | Pending |
| DEPLOY-01 | Phase 12 | Pending |
| DEPLOY-02 | Phase 7 | Pending |
| NOTIF-01 | Phase 14 | Pending |
| NOTIF-02 | Phase 14 | Pending |
