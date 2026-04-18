---
created: "2026-04-18T00:00:00.000Z"
title: SplitPane 双 chat 并排（桌面端 ≥lg）
area: web
files:
  - apps/web/src/components/shell/split-pane.tsx
  - apps/web/src/components/chat/chat-header.tsx
  - apps/web/src/pages/chat.tsx
  - apps/web/src/lib/router.tsx
  - apps/web/e2e/split-pane.spec.ts
---

## Problem

Phase 10 的原 D-18 + Addendum 1 D-18 re-confirm 规划了 SplitPane 双 chat 并排（lg 视口专属），让用户能同时看 PTY session A 与 JSON session B。Wave 4 验证后重新评估：当前没有真实使用需求；SplitPane 只在 ≥lg 1024px 激活，属于桌面 power-user 功能；持有它意味着每次 ChatHeader / router / chat-store 改动都要兼顾 split vs 非 split 两套状态模型，持续税收。

Phase 10 Addendum 3 D-52 决定**撤回** SplitPane，降级至本 todo。chat-store per-session 重写（10-06 Task 1/2）保留交付——那是核心数据模型修复，无论 SplitPane 做不做都需要。

## Trigger conditions

以下任一条件触发，把本 todo 升级为独立 phase：

1. 用户提出真实多屏并排需求（明确场景：如"同时看 Bash 部署 + Claude 改代码"）
2. 桌面端使用量显著上升（DAU 中桌面 ≥lg 占比 > 30% 持续两周）
3. 配套需求出现（例如 session 对比、PR review 双窗口）

不满足以上任一条件前不动工。

## Solution outline (当触发时参考)

- SplitPane 组件 `apps/web/src/components/shell/split-pane.tsx`：CSS grid `lg:grid-cols-2` + 垂直 Separator，每列独立 ChatHeader + ChatJsonView / ChatPtyView
- URL schema：`/chat/:id?mode=X&split=<otherId>&splitMode=Y`；只在 `split` 有值时进入 SplitPane
- ChatHeader split picker：DropdownMenu 列出**其他** session（排除当前），disabled 状态 tooltip "新建第二个会话以分列"
- 合并列：picker 按钮在已 split 态下变 "合并列"，点击直接去掉 `split` / `splitMode` 参数
- Playwright e2e：`apps/web/e2e/split-pane.spec.ts`（covering toggle visible/disabled at breakpoints, picker lists other sessions, URL transitions, two ChatHeaders rendered when split, 合并列 reverse）
- **前置依赖**：10-06 Task 1/2 的 chat-store per-session 重写必须已完成（本 todo 启动时该条件已满足）

## Related

- 10-CONTEXT.md Addendum 3 D-52（撤回决策 + 重触发条件）
- 10-CONTEXT.md D-18（原决策，已被 D-52 覆盖）
- 10-06 原 PLAN Task 3+4 的完整 SplitPane / e2e spec 实现（git history: pre-Wave-4 commit 之前的 10-06-PLAN.md 版本，可作为参考脚手架复用）

## Area boundary

- **In scope**: SplitPane 组件 + ChatHeader split picker + chat.tsx URL dispatch + router note + e2e spec
- **Out of scope**: 3+ 列并排（MVP 限 2 列）、跨视口折叠行为（ < lg 时 URL 还带 `split=` 仅渲染 pane1）、移动端抽屉式多 chat
