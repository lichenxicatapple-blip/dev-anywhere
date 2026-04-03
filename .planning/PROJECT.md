# CC Anywhere

## What This Is

CC Anywhere 是 Claude Code 的透明代理和远程控制系统。它在本地包装 Claude Code CLI 进程，保持终端体验完全一致，同时通过中转服务器将会话桥接到飞书小程序，让用户在手机上也能像在电脑前一样与 Claude Code 实时交互。面向开发者的开源工具。

## Core Value

在任何地方（电脑或手机）都能与 Claude Code 实时交互，体验一致，不丢失上下文。

## Requirements

### Validated

(None yet -- ship to validate)

### Active

- [ ] 本地透明代理：包装 claude CLI 进程，stdin/stdout 完全透传，用户体验与直接使用 claude 一致
- [ ] 多会话管理：支持同时启动和管理多个独立的 Claude Code 实例
- [ ] 会话持久化：记录会话历史，断开后可查看之前的输出
- [ ] 中转服务器：轻量级消息桥接，连接本地代理和飞书小程序
- [ ] 飞书小程序：手机端完整交互 UI
- [ ] 实时双向消息：在飞书上发送指令，实时看到 Claude Code 输出
- [ ] 工具调用审批：当 Claude Code 请求执行工具时，在飞书上确认或拒绝
- [ ] 远程启停：从飞书上创建和终止 Claude Code 会话
- [ ] 语音输入：在飞书小程序中通过语音发送指令给 Claude Code
- [ ] 智能输出渲染：markdown、语法高亮、diff 彩色显示等移动端友好的渲染
- [ ] 双表面同步：终端和手机同时操作，状态一致
- [ ] 快捷操作和通知推送：一键常用命令、任务完成/审批/出错时推送

### Out of Scope

- 多平台支持（Telegram/Slack 等） -- v1 聚焦飞书，通过小程序 UI 与 cc-connect 等 Bot 方案拉开差距
- 多 Agent 支持 -- v1 仅支持 Claude Code
- OAuth / 用户认证系统 -- v1 面向个人或信任环境，不需要复杂认证
- 飞书群聊多人协作 -- v1 聚焦单用户多会话场景
- Web 端 UI -- v1 只做飞书小程序
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
- **Platform**: 飞书小程序作为移动端入口
- **Dependency**: 依赖 Claude Code CLI，需要用户本地已安装
- **UX**: 本地代理必须对 Claude Code 原生终端体验完全透明，用户回到电脑操作时不能有任何干扰

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 包装 CLI 进程而非 SDK | 保持与 Claude Code 完全一致的行为，不受 API 变动影响 | -- Pending |
| 飞书小程序而非机器人 | 小程序 UI 更丰富，能更好地展示多会话、输出流等 | -- Pending |
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

---
*Last updated: 2026-04-03 after initialization*
