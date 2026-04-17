---
phase: 10
reviewers: [gemini]
reviewers_skipped: [claude, codex, cursor]
reviewed_at: 2026-04-17
plans_reviewed:
  - 10-01a-PLAN.md
  - 10-01b-PLAN.md
  - 10-02-PLAN.md
  - 10-03-PLAN.md
  - 10-04a-PLAN.md
  - 10-04b-PLAN.md
  - 10-05-PLAN.md
  - 10-06-PLAN.md
---

# Cross-AI Plan Review — Phase 10

> Reviewers attempted: gemini, codex, cursor. Self (claude) skipped for independence per workflow rule.
> - **gemini**: success
> - **codex**: skipped — `codex exec "$(cat prompt)"` hangs when prompt exceeds arg buffer (510KB here); stdin-mode retry (`codex exec < prompt`) also timed out. Re-run via `codex exec < prompt` with smaller prompt (exclude bulky UI-SPEC/RESEARCH sections) if needed.
> - **cursor**: skipped — `cursor-agent` installed version outdated. Run `cursor-agent update` then re-invoke.

---

## Gemini Review

这套 Phase 10 的实施计划（10-01a 至 10-06）设计严密，逻辑清晰，完整覆盖了从基础原子组件到多会话并排布局的全部迁移需求。以下是针对该计划的结构化评审反馈：

### 1. 计划分段评估 (Plan-by-Plan Assessment)

*   **10-01a & 10-01b (基础与骨架):** 优先安装 shadcn 原子组件并进行主题覆盖（琥珀色、圆角、字重）是非常明智的决策，确保了后续业务组件的视觉统一性。在 `sidebar.tsx` 中引入 **Stub Module**（占位模块）的策略极具预见性，成功规避了 W3 阶段 10-02 与 10-03 并行开发时的文件冲突。
*   **10-02 & 10-03 (导航与管理):** 采用了响应式布局组件模式（`layout="page"|"dropdown"`），实现了移动端全屏与桌面端侧栏逻辑的高度复用。Master-detail 的即时切换逻辑（URL 更新但不触发页面级转场）符合现代单页应用（SPA）的高级交互直觉。
*   **10-04a & 10-04b (JSON 聊天核心):** 这部分是工作量最大的环节。虚拟滚动（TanStack Virtual）与 Markdown 安全渲染（XSS 防护）方案选型成熟。10-04b 中对 `CreateSessionDialog` 的重构体现了对代码复用的重视。
*   **10-05 (PTY 通道升级):** 选择了 **方案 A**（仅改 shared + serve + client），将 PTY 原始键位（D-21）的跨包改动最小化，且不破坏现有的 PTY 稳定链路。
*   **10-06 (多会话增强):** 作为最终演进，将 `chat-store` 重构为 per-session 架构，不仅满足了并排显示（SplitPane）的需求，也清理了扁平化状态管理的架构债。

### 2. 设计亮点 (Strengths)

*   **接口先行与并行安全:** 10-01b 确定的 Sidebar 模块路径契约（Frozen Module-Path Contract）是大型重构中处理并发任务的范式。
*   **架构的前瞻性:** 在 10-04 阶段就强制组件接收 `sessionId` prop，使得 10-06 的 store 重构仅涉及 Selector 的改动，极大降低了回归成本。
*   **协议严谨性:** `chat-dispatcher` 完全基于真实的 schema type literals（如 `assistant_message`），摒弃了草案中的虚构名称，从底层保证了消息处理的准确性。
*   **安全防御到位:** 在 `MarkdownView` 中强制执行 `skipHtml` 和 `disallowedElements` 黑名单，并配合单元测试验证 XSS 防御，符合高标准工程要求。
*   **UX 细节打磨:** 考虑到了 iOS Safari `visualViewport` 的偏移校正、流式输出时的滚动冻结逻辑、以及 ToolApproval 的 y/n/a 快捷键作用域限制。

### 3. 潜在风险与关注点 (Concerns)

*   **iOS 26 偏移量 Bug (中等):** `use-visual-viewport.ts` 中针对 iOS 26 的 300ms 延迟补偿是一个经验值。在性能较低的设备上，InputBar 的位置校正可能存在视觉闪烁或滞后。
*   **虚拟滚动与流式内容的性能 (低):** 当消息数量超过 1000 条且包含大量 Markdown 渲染时，`ResizeObserver` 频繁触发的 `measureElement` 可能引起布局抖动。建议在 10-04a 的人工验收中进行压力测试。
*   **双 PTY 实例的内存开销 (低):** 在 SplitPane 模式下运行两个独立的 xterm 实例（各 5000 行回滚缓冲），在内存受限的移动端设备（若用户通过 URL 强行开启）可能存在压力。目前的 `lg` 视口限制有效缓解了此风险。

### 4. 改进建议 (Suggestions)

*   **E2E 视口模拟:** 在 Playwright 测试中，建议明确模拟 md (768px) 和 lg (1024px) 的临界值测试，确保布局切换点（Breakpoint）没有重叠或死区。
*   **FilePicker 的降级处理:** 在 `CreateSessionDialog` 中，如果 FileWatcher 未能返回目录树（例如 Proxy 刚启动尚未扫描完成），应确保手动输入路径的 Input 框依然能够正常提交。
*   **CustomEvent 桥接清理:** 在 10-06 的 SUMMARY 中，应增加一个全局 Grep 检查项，确认 `cc:input-history-*` 相关的事件监听已完全被 store-backed 方案替代。

### 5. 风险评估 (Risk Assessment)

*   **总体风险: 低 (LOW)**
*   **理由:** 计划中包含了详尽的技术调研（RESEARCH.md）、一致性设计契约（UI-SPEC.md）以及覆盖 Unit + E2E 的自动化验证。关键的 PTY raw-input 采用了影响面最小的实现路径。所有业务逻辑在 10-04/10-05 均已有 sessionId 感知，最后的 10-06 重构是可控的。

---
**评审结论：** 计划通过。可以按照 10-01a 开始执行。在 W4/W5 阶段（10-04/10-05）应重点关注 PTY 原始字节在不同网络环境下的传输完整性。

---

## Consensus Summary

> 单 reviewer（gemini），无 consensus 比较维度。以下是 gemini 单方判断，仅供参考，不构成多源共识。

### Strengths (gemini 认可)
- Sidebar stub-module contract 解决 W3 写冲突
- sessionId prop drill 从 10-04 起就绪，10-06 只改 selector
- chat-dispatcher 真实 schema literal（避免 ghost name 静默丢弃）
- Markdown XSS 防御（skipHtml + disallowedElements）
- D-21 方案 A（最小跨包改动）

### Concerns (gemini 提出)
- **MEDIUM**: iOS 26 visualViewport offsetTop bug 的 300ms 延迟补偿在低性能设备上可能滞后
- **LOW**: 虚拟滚动 1000+ 消息时 ResizeObserver 的 measureElement 可能抖动
- **LOW**: SplitPane 下两 xterm 实例各 5000 行 scrollback 的内存开销（lg 阈值已缓解）

### Suggestions (gemini 建议)
1. Playwright 测试 md (768px) 和 lg (1024px) 临界值视口
2. CreateSessionDialog 在 FileWatcher 未就绪时保证手输路径可提交
3. Plan 10-06 SUMMARY 加 grep 检查项：确认 `cc:input-history-*` CustomEvent 监听全清

### Divergent Views
N/A — 单 reviewer

### Overall Risk
**LOW** (gemini 判定)

---

## Incorporating Feedback

将 gemini 建议纳入 plan 修订：

```
/gsd-plan-phase 10 --reviews
```

或手动在 Plan 10-04a / 10-04b / 10-06 的对应 task 加 acceptance criteria：
- 10-04a Task（virtualized list 视觉验证）→ 加 1000 条消息压力测试
- 10-04b Task（CreateSessionDialog）→ 加 FileWatcher 未就绪时 fallback 测试
- 10-06 SUMMARY/acceptance → 加 `grep "cc:input-history-" apps/web/src returns 0 matches` 断言

不过这些建议的严重程度均为 LOW/MEDIUM、gemini 明确"计划通过"，可选择**直接执行 Plan 10-01a**，在执行过程中遇到问题再局部调整。
