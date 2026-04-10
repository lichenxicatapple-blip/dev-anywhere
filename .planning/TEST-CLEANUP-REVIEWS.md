---
target: TEST-CLEANUP.md
reviewers: [gemini, codex]
reviewed_at: 2026-04-09T19:30:00+08:00
---

# Cross-AI Plan Review — Test Cleanup

## Gemini Review

该计划是一份极具针对性且专业的重构方案。它敏锐地识别了现有测试套件中"虚假繁荣"的核心痛点——即高覆盖率下的低安全性。计划通过"先减法、后加法"的策略，优先剔除无意义的源码检索（grep）测试和冗余的架构枚举，将精力集中在 `control-messages.ts`（路由安全）和 `frame-pusher.ts`（核心逻辑）等高风险区域。整体思路清晰，符合现代测试工程的最佳实践，能够显著提升测试套件的长期维护性和真实可信度。

**Strengths:**
- 病灶识别精准：准确指出了"源码检索测试"反模式
- 安全优先导向：Phase 3 明确提出路径遍历防御补强
- 效率提升显著：`it.each` 参数化测试替代手动枚举
- 工程化程度高：提取 Relay 测试助手至共享模块

**Concerns:**
- **MEDIUM**: 单元与集成测试边界风险——完全删除重合的单元测试可能导致故障排查成本（MTTR）上升
- **MEDIUM**: Schema 约束丢失风险——Zod Schema 含 `refine`/`transform` 时仅靠参数化测试可能不够
- **LOW**: 合并后文件可读性——3 个终端文件合并为 1 个需注意体积

**Suggestions:**
- 引入回归测试思维：查 Git 历史，针对历史 Bug 设计回归用例
- 增强参数化测试可读性：提供清晰的用例描述模板
- 细化删除标准：如果包装类未来可能承载复杂逻辑，保留基础行为测试
- 增加并发冲突测试：frame-pusher.ts 的竞态条件测试

**Risk: LOW** — 方案成熟，建议立即执行。

---

## Codex Review

The plan is directionally strong: it correctly targets obvious low-value tests, prioritizes real safety gaps on core runtime paths, and aims to replace test-count vanity with behavior coverage. The biggest risk is that it sometimes treats entire categories too aggressively, especially schema-enumeration and "trivial wrapper" tests, without clearly defining what runtime contracts must still remain protected.

**Strengths:**
- Anchored in behavior and risk, not raw test counts
- Deletion targets in Phase 1 are mostly credible
- Coverage priorities correct at system level
- Distinguishes between duplicate assertions and missing critical-path coverage
- Expected outcome is concrete and measurable
- "Coverage on security boundaries first" is the right principle

**Concerns:**
- **HIGH**: "No schema enumeration tests" is too absolute. Compact `it.each` contract test for externally meaningful unions can be high value.
- **HIGH**: Deleting `message-queue.test.ts` may be premature if the queue has semantic guarantees beyond array mechanics.
- **HIGH**: Plan calls out `ipc-protocol.ts worker path` as 0% but Phase 3 does not include a worker/approval-path work item. Priority-execution mismatch.
- **MEDIUM**: Merging 3 terminal test files into 1 can worsen failure localization.
- **MEDIUM**: "One behavior, one location" too rigid — some behaviors deserve both unit and integration coverage.
- **MEDIUM**: No branch coverage targets defined; statement coverage can miss decision logic.
- **MEDIUM**: No attention to test runtime, flakiness, fixture quality, or determinism.
- **MEDIUM**: Timer-heavy logic (pushCommandList 6-hour) needs explicit fake-timer strategy.

**Suggestions:**
- Add explicit Phase 3 item for ipc-protocol.ts worker/approval-path tests
- Replace "No schema enumeration tests" with: "Keep one compact contract-level enumeration test per protocol surface"
- Before deleting message-queue.test.ts, verify domain contracts (ordering, snapshot semantics, replay interaction)
- Consolidate by concern, not just file count — two focused files may beat one large file
- Add a "do not delete if" rubric: externally visible contract, security boundary, regression history, nontrivial branching
- For frame-pusher.ts add race/lifecycle cases: stop during pending push, repeated start/stop, rapid frame sequences
- For terminal-frame-renderer.ts include cache invalidation and out-of-order response handling
- After cleanup, run failure-diagnosability check: break one key branch, confirm suite points to right subsystem

**Risk: MEDIUM** — Direction correct, but risk of over-correction. Needs guardrails around protocol-contract tests and explicit IPC worker path coverage.

---

## Consensus Summary

### Agreed Strengths
- 问题识别精准，"虚假繁荣"诊断正确（2/2）
- 安全优先：control-messages.ts 路径遍历防御是最高优先级（2/2）
- `it.each` 参数化替代枚举是正确的工程决策（2/2）
- 预期结果具体可量化（2/2）

### Agreed Concerns
1. **终端测试合并粒度** (Gemini: LOW, Codex: MEDIUM) — 3 文件合 1 可能损害故障定位。建议按关注点拆分（rendering vs state），不要为了减少文件数而牺牲可读性。
2. **"一刀切"删除原则过于激进** (Gemini: MEDIUM, Codex: HIGH) — "No schema enumeration tests" 和 "No trivial wrapper tests" 需要细化。协议表面和有未来复杂度可能性的包装器应保留合约级测试。
3. **ipc-protocol worker/approval 路径缺失** (Codex: HIGH) — 问题陈述中标注为 0%，但 Phase 3 没有对应工作项。需补上。

### Divergent Views
- **整体风险评估**: Gemini 给 LOW（认为方案成熟可直接执行），Codex 给 MEDIUM（担心过度纠正）。差异来源于 Codex 更关注删除标准的模糊性，Gemini 更看重"先减后加"策略本身的安全性。
- **message-queue.test.ts**: Codex 标记 HIGH 风险（可能有隐含的领域契约），Gemini 未提及。实际检查该类只是一个无状态数组包装器，Codex 可能过于谨慎。
