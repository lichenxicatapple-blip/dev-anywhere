# CC Anywhere

## What This Is

CC Anywhere 是 Claude Code 的透明代理和远程控制系统。它在本地包装 Claude Code CLI 进程，保持终端体验完全一致，同时通过中转服务器将会话桥接到 Web 客户端（PWA），让用户在手机上也能像在电脑前一样与 Claude Code 实时交互。面向开发者的开源工具。

## Core Value

在任何地方（电脑或手机）都能与 Claude Code 实时交互，体验一致，不丢失上下文。

## Requirements

### Validated

- [x] 本地透明代理：包装 claude CLI 进程，stdin/stdout 完全透传，用户体验与直接使用 claude 一致 — Validated in Phase 2
- [x] 多会话管理：支持同时启动和管理多个独立的 Claude Code 实例 — Validated in Phase 3

### Active

- [ ] 中转服务器：轻量级消息桥接，连接本地代理和 Web 客户端
- [ ] Web 客户端（PWA）：React SPA，手机/平板/PC 全平台
- [ ] xterm.js 终端渲染：替换自写渲染器，proxy 转发原始 PTY 字节流
- [ ] 会话持久化：EventStore + 快照落盘，支持断线恢复和历史回看
- [ ] 实时双向消息：在手机上发送指令，实时看到 Claude Code 输出
- [ ] 工具调用审批：当 Claude Code 请求执行工具时，在手机上确认或拒绝
- [ ] 远程启停：从手机上创建和终止 Claude Code 会话
- [ ] 语音输入：通过 Web Speech API 语音发送指令给 Claude Code
- [ ] 智能输出渲染：markdown、语法高亮、diff 彩色显示等移动端友好的渲染
- [ ] 双表面同步：终端和手机同时操作，状态一致
- [ ] 快捷操作和通知推送：一键常用命令、任务完成/审批/出错时推送

### Out of Scope

- 多平台 IM 集成（Telegram/Slack/飞书 Bot 等） -- 走 PWA 路线，不做 IM Bot
- 多 Agent 支持 -- 仅支持 Claude Code
- OAuth / 用户认证系统 -- 面向个人或信任环境，不需要复杂认证
- 多人协作 -- 聚焦单用户多会话场景
- 自动扩缩容 / 云端 Claude Code 实例 -- Claude Code 运行在用户本机

## Context

- cc-connect (https://github.com/chenhg5/cc-connect) 是同领域的成熟开源项目（Go 实现，Bot 路线），在进程管理、会话管理、飞书集成等方面可作为重要参考，但我们走小程序+透明代理的差异化路线
- Claude Code 是 Anthropic 官方的 CLI 工具，支持交互式终端操作，包括实时输出、工具调用确认等
- 飞书小程序支持自定义 UI，比纯聊天机器人交互更丰富
- 中转服务器需要解决本机 NAT 穿透问题，本地代理主动连接中转服务器（WebSocket）
- 技术栈统一使用 TypeScript，前后端一致
- 作为开源项目发布，需要考虑部署便利性和文档完善度

## Constraints

- **Tech Stack**: TypeScript -- 前后端统一，与 Claude Code 同技术栈
- **Runtime**: 本地代理运行在用户电脑上，中转服务器需要公网可访问
- **Platform**: PWA（React SPA）作为跨平台客户端，部署为飞书网页应用或独立 PWA
- **Dependency**: 依赖 Claude Code CLI，需要用户本地已安装
- **UX**: 本地代理必须对 Claude Code 原生终端体验完全透明，用户回到电脑操作时不能有任何干扰

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 包装 CLI 进程而非 SDK | 保持与 Claude Code 完全一致的行为，不受 API 变动影响 | -- Pending |
| PWA 而非飞书小程序 | Taro 抽象层导致 DOM/CSS/滚动问题，PWA 有完整浏览器能力（Web Speech、Wake Lock） | v2.0 |
| 中转服务器而非内网穿透 | 更稳定可控，不依赖第三方穿透服务 | -- Pending |
| TypeScript 全栈 | 前后端统一，降低维护成本 | -- Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check -- still the right priority?
3. Audit Out of Scope -- reasons still valid?
4. Update Context with current state

## Current Milestone: v2.0 React SPA + xterm.js Migration

**Goal:** 将客户端从 Taro 飞书小程序迁移到纯 React SPA + PWA，用 xterm.js 替换自写终端渲染，简化全链路数据管道。

**Target features:**
- apps/web: Vite + React + TypeScript + Tailwind CSS + shadcn/ui
- xterm.js 终端渲染 + proxy 原始 PTY 字节流转发
- EventStore + @xterm/headless 快照持久化（恢复 b05bec2 设计）
- Binary WebSocket frame 传输 PTY 数据
- PWA（Service Worker、Screen Wake Lock、manifest）
- Relay 同进程 serve 前端静态文件
- 设计 token 统一 + replay 命令恢复

## Current State

Phase 6 complete — Taro 飞书小程序核心交互全部实现（28 plans）。PTY 终端查看、JSON 聊天、工具审批、会话管理、Markdown 渲染均可用。但 Taro 抽象层导致滚动/CSS/DOM 兼容性问题持续，决定迁移到 React SPA + PWA。apps/feishu 保留为存档，不再维护。

---
*Last updated: 2026-04-15 after v2.0 milestone started*
