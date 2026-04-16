---
phase: 10
slug: pages-components-migration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-17
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `10-RESEARCH.md` §11 Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `vitest@^4.1.2` (单测) + Playwright MCP (视觉 / 交互 / E2E) |
| **Config file** | `apps/web/vitest.config.ts` (existing) / `apps/web/playwright.config.ts` (需在 Plan 10-01 配置) |
| **Quick run command** | `pnpm --filter web typecheck && pnpm --filter web test` |
| **Full suite command** | `pnpm --filter web test && pnpm --filter web exec playwright test` (需 relay + proxy 在线) |
| **Estimated runtime** | quick ~30s; full ~3min (含 Playwright) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter web typecheck && pnpm --filter web test`
- **After every plan wave:** Run full suite + Playwright MCP 视觉验证 + 用户批准截图 (CONTEXT D-39)
- **Before `/gsd-verify-work`:** Full suite green; iOS 真机验证完成 (Plan 10-04 / 10-05)
- **Max feedback latency:** 30 seconds for quick; 3 minutes for full suite

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 10-01-* | 01 | 1 | FRONT-03 | — | AppShell 响应式 layout, md 断点切换 | Playwright | `playwright test shell.spec.ts` (viewport 375 / 1024) | ❌ W0 | ⬜ pending |
| 10-01-* | 01 | 1 | FRONT-08 | — | Sonner `useToast` API 兼容 phase-machine 现有调用 | unit | `pnpm --filter web test phase-machine` | ✓ (已有单测，需更新) | ⬜ pending |
| 10-01-* | 01 | 1 | FRONT-03 | — | Sonner Toaster 路由切换时保持 mount | Playwright | `playwright test toast.spec.ts` | ❌ W0 | ⬜ pending |
| 10-01-* | 01 | 1 | FRONT-03 | V5 | shadcn 原子按 UI-SPEC token 主题 override (amber #D4A574, radius 0.375rem) | Playwright 视觉 | manual screenshot diff vs UI-SPEC §Color | ❌ manual | ⬜ pending |
| 10-02-* | 02 | 2 | FRONT-04 | — | ProxySwitcher `layout=page` / `dropdown` 行为等价 | Playwright 双视口对比 | `playwright test proxy-switcher.spec.ts` | ❌ W0 | ⬜ pending |
| 10-03-* | 03 | 2 | FRONT-05 | V5 | CreateSessionDialog 字段校验 (name / mode / CWD) | unit (Dialog state) + Playwright | `pnpm --filter web test session-list && playwright test session-list.spec.ts` | ❌ W0 | ⬜ pending |
| 10-03-* | 03 | 2 | FRONT-05 | — | SessionList 点击即时切换 Chat (不触发页面 transition) | Playwright | `playwright test master-detail.spec.ts` | ❌ W0 | ⬜ pending |
| 10-04-* | 04 | 3 | FRONT-06 | V5 | MessageBubble 渲染 user / assistant / tool / system 四态 | unit (snapshot) | `pnpm --filter web test message-bubble` | ❌ W0 | ⬜ pending |
| 10-04-* | 04 | 3 | FRONT-06 | V5 | Markdown XSS 防护 `<script>` / `<iframe>` 被丢弃 | unit | `pnpm --filter web test markdown-view` | ❌ W0 | ⬜ pending |
| 10-04-* | 04 | 3 | FRONT-06 | — | ToolApprovalCard y/n/a 快捷键仅在卡片聚焦时响应 | Playwright (keyboard) | `playwright test tool-approval.spec.ts` | ❌ W0 | ⬜ pending |
| 10-04-* | 04 | 3 | FRONT-06 | — | Virtualized list 1000 条消息滚动无显著掉帧 | Playwright perf trace | manual trace review | ❌ manual | ⬜ pending |
| 10-04-* | 04 | 3 | FRONT-06 | — | Follow-output 用户上滑后冻结, 回到底部后恢复 | Playwright | `playwright test follow-output.spec.ts` | ❌ W0 | ⬜ pending |
| 10-04-* | 04 | 3 | FRONT-06 | — | InputBar `/` 触发 SlashCommandPicker, 选中注入命令 | Playwright (keyboard + click) | `playwright test input-bar.spec.ts` | ❌ W0 | ⬜ pending |
| 10-04-* | 04 | 3 | FRONT-06 | V12 | InputBar `@` 触发 FilePathPicker + dir_list_request | Playwright (mock relay) | `playwright test file-picker.spec.ts` | ❌ W0 | ⬜ pending |
| 10-05-* | 05 | 4 | D-21 | V5 | PTY raw key → ANSI 序列映射正确 (方向键 / Ctrl 组合 / Tab / ESC) | unit (pure function) | `pnpm --filter web test ansi-keys` | ❌ W0 | ⬜ pending |
| 10-05-* | 05 | 4 | D-21 | V5 | `remote_input_raw` control message proxy 端 handler 透传到 PTY stdin | unit (apps/proxy) | `pnpm --filter proxy test control-messages` | ✓ (已有框架，新增 case) | ⬜ pending |
| 10-05-* | 05 | 4 | D-21 | — | 方向键在真实 PTY session 中导航 Claude Code 菜单 | **manual** | 用户人工验证 + 截图 | — | ⬜ pending |
| 10-05-* | 05 | 4 | FRONT-06 | — | ChatPtyView 复用 pty-test.tsx 的 xterm 配置 (字体 / WebGL / 主题) verbatim | unit (hook import diff) + Playwright | `pnpm --filter web test create-xterm` | ❌ W0 | ⬜ pending |
| 10-all | all | all | D-34 | — | iOS Safari 键盘弹起 InputBar 贴键盘上方 | **manual** (真机) | 用户人工验证 | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/web/playwright.config.ts` — 配置 apps/web 入口、mock relay fixture (Plan 10-01)
- [ ] `apps/web/e2e/helpers.ts` — 共享 fixtures (mock relay server、session bootstrap) (Plan 10-01)
- [ ] `apps/web/src/components/ui/*.test.tsx` — shadcn 组件主题验证骨架 (Plan 10-01)
- [ ] `apps/web/src/lib/ansi-keys.ts` + `ansi-keys.test.ts` — PTY raw key 映射纯函数 + 表驱动测试 (Plan 10-05)
- [ ] `apps/proxy/src/__tests__/unit/remote-input-raw.test.ts` — proxy 端 control message handler 单测 (Plan 10-05)
- [ ] `apps/web/e2e/shell.spec.ts` — AppShell 响应式骨架测试 (Plan 10-01)
- [ ] `apps/web/e2e/proxy-switcher.spec.ts` — ProxySwitcher 双 layout 测试 (Plan 10-02)
- [ ] `apps/web/e2e/session-list.spec.ts` — SessionList + CreateSessionDialog (Plan 10-03)
- [ ] `apps/web/e2e/master-detail.spec.ts` — 侧栏点击即时切换 (Plan 10-03)
- [ ] `apps/web/e2e/input-bar.spec.ts` — 斜杠菜单 / 历史 / 多行 (Plan 10-04)
- [ ] `apps/web/e2e/file-picker.spec.ts` — @ 文件选择器 (Plan 10-04)
- [ ] `apps/web/e2e/tool-approval.spec.ts` — 分级 + 快捷键 (Plan 10-04)
- [ ] `apps/web/e2e/follow-output.spec.ts` — 虚拟滚动 + follow-output (Plan 10-04)
- [ ] `apps/web/e2e/toast.spec.ts` — Sonner 集成 (Plan 10-01)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| iOS Safari 键盘弹起 InputBar 位置正确 | D-34 | 真机布局差异 (iOS 26 visualViewport offsetTop bug) | 用户在 iPhone Safari 打开 H5 预览, focus InputBar, 键盘弹起后 InputBar 应紧贴键盘顶部, 横屏 + 竖屏均验证 |
| PTY 方向键导航 Claude Code 菜单 | D-21 | 需要真实 Claude Code PTY session 才能 end-to-end 验证 ANSI 序列 | 用户在 PTY 模式创建 session, 运行触发菜单的命令 (例: `claude --help` 交互式选单), 用 ↑↓ Enter 导航 |
| Plan 级视觉与 UI-SPEC 一致性复核 | All | 需人眼判定 token / variant / 状态 / 间距 / 动效一致 | 每 plan 完成启动 `pnpm --filter web dev`, Playwright MCP 截图 + 用户对照 10-UI-SPEC.md 逐项打勾 (D-39) |
| Virtualized message list 滚动流畅度主观感受 | FRONT-06 | 性能 trace 需人判读 jank | Playwright performance trace 1000 条消息滚动, DevTools timeline 目视检查 long task 与 frame drop |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags (all tests run non-interactive)
- [ ] Feedback latency < 30s for quick suite
- [ ] `nyquist_compliant: true` set in frontmatter after approval

**Approval:** pending
