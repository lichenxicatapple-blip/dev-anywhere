---
phase: 06
reviewers: [gemini, codex]
reviewed_at: "2026-04-08T14:30:00Z"
plans_reviewed: [06-01-PLAN.md, 06-02-PLAN.md, 06-03-PLAN.md, 06-04-PLAN.md, 06-05-PLAN.md, 06-06-PLAN.md, 06-07-PLAN.md, 06-08-PLAN.md, 06-09-PLAN.md, 06-10-PLAN.md, 06-11-PLAN.md]
---

# Cross-AI Plan Review -- Phase 6

## Gemini Review

(Model: Gemini 2.5 Pro)

Phase 6 的实施计划是一个设计精良、逻辑严密的工程蓝图。它通过 **"协议先行 -> Proxy 增强 -> 终端基础设施 -> UI 分页演进"** 的四层递进式路径，稳步构建了 CC Anywhere 的核心移动端交互。计划充分考虑了性能优化（如 5fps 节流、增量文件推送）、安全边界（路径校验、环境过滤）及用户体验（响应式布局、PC 模式、打字机品牌感）。11 个方案之间的依赖关系清晰，Wave 排序合理，能够确保开发过程的高并发与低冲突。

### Strengths
- 双模式渲染的深度解构：PTY 服务端渲染（文本网格）与 JSON 客户端渲染（聊天气泡）完美结合
- 极致的性能平衡：5fps 帧率控制、`hasGridChanged` 检测、`ScrollView` 滚动粘滞 Bug 规避
- 多端响应式架构：`useScreenSize` 实时监听 + CSS 变量驱动布局
- 开发体验的移动端复刻：斜杠命令动态发现、文件路径补全、目录选择器
- 健壮的韧性设计：JSON 会话持久化与自动恢复（D-35/D-36）、断线重连状态同步（D-41）

### Concerns
- **MEDIUM**: PTY 提取开销 -- 200ms 周期提取 40x120 样式网格，多会话时 CPU 开销可能较高
- **MEDIUM**: 文件监听器压力 -- 大型项目根目录 `fs.watch` 递归监听可能触碰文件描述符上限
- **LOW**: MP 构建体积 -- 11 个方案引入大量组件，需关注 Taro 打包策略确保主包不超限
- **LOW**: `tt.setWindowSize` 是飞书较新 API，需确认旧版 PC 客户端降级表现

### Suggestions
- 引入行级增量更新：只推送变更行而非全量网格
- 文件监听防抖增强：对 `git checkout` 等大规模变更增加更激进的防抖
- 审批二次确认：对"允许同类工具"操作增加确认弹窗防误操作
- Store 持久化预读：增加对持久化 Seq 序列号的校验逻辑

### Risk Assessment
**LOW-MEDIUM** -- 技术方案已通过 Spike 原型在真机验证，风险点主要在于实施工作量巨大。11 个方案的细粒度划分有效分散了复杂度。

---

## Codex Review

(Model: GPT-5.4)

### Plan 01: Shared Schema Extensions
**Summary**: Good foundation plan. Correctly front-loads shared schema work, but under-specifies approval metadata and richer session/proxy list fields.

**Concerns**:
- `HIGH`: `tool_approve`/`tool_deny` payloads not extended for D-25 "allow same tool in session"; later plans assume whitelist flag exists but Plan 01 does not define it
- `MEDIUM`: `session_history_response` shape likely too thin for resume flows
- `MEDIUM`: `command_list_push` uses `source: z.string()` instead of bounded enum
- `LOW`: `pty_state_ctrl` listed in must-haves but not defined in task body

**Risk**: MEDIUM

### Plan 02: Terminal Grid Extraction & OSC
**Summary**: Technically useful and focused, but over-prescriptive in color extraction for first usable PTY milestone.

**Concerns**:
- `HIGH`: Full embedded 256-color lookup table is heavy and brittle for first implementation
- `MEDIUM`: `hasGridChanged()` via whole-grid stringify expensive at 5 fps with scrollback
- `MEDIUM`: Trimming trailing empty lines may conflict with viewport fidelity
- `MEDIUM`: `mid_pause` exists locally but Plan 01's shared schema excludes it

**Risk**: MEDIUM

### Plan 03: Tool Approval & Session Resume
**Summary**: One of the most important and riskiest plans. Covers right behaviors but assumes protocol fields not established in Plan 01.

**Concerns**:
- `HIGH`: Approval correlation underspecified -- no clear mapping between `tool_use_request`, worker `requestId`, and `tool_approve/tool_deny`
- `HIGH`: "Allow all" requires protocol support Plan 01 does not define
- `HIGH`: Claude session ID capture insufficient without persistence across proxy restarts
- `MEDIUM`: `filterClaudeEnvVars` may miss variants or over-strip

**Risk**: HIGH

### Plan 04: Command Discovery & File Watcher
**Summary**: Useful but drifts toward over-engineering. Not core to phase goal compared with session/chat/reconnect.

**Concerns**:
- `HIGH`: `fs.watch(..., { recursive: true })` not portable/reliable across platforms
- `MEDIUM`: Plugin scanning under `~/.claude/plugins/cache/` can be expensive
- `MEDIUM`: Security boundary split across plans (validation deferred to Plan 05)

**Risk**: MEDIUM

### Plan 05: Relay Routing & Terminal Frame Push
**Summary**: Necessary integration plan but overloaded. Depends on subtle assumptions from Plans 01, 03, 04.

**Concerns**:
- `HIGH`: `serve.ts` becomes convergence point for 7+ responsibilities -- high-complexity hotspot
- `HIGH`: `scanSessionHistory()` underspecified; Claude session file format discovery deferred
- `MEDIUM`: `dir_list_request` path validation insufficient (absolute paths can escape intended roots)
- `MEDIUM`: 200ms PTY frame pushes with full-grid diffing may be bandwidth/CPU heavy

**Risk**: HIGH

### Plan 06: Mini Program Services
**Summary**: Sensible service-layer plan, mostly well-scoped. Main weakness is type mirror drift risk.

**Concerns**:
- `MEDIUM`: Type mirrors will drift from shared schemas without sync discipline
- `MEDIUM`: `routeStreamEvent` action set too narrow for actual JSON session rendering
- `LOW`: `parseAssistantMessage` assumes clean JSON stringified content

**Risk**: LOW-MEDIUM

### Plan 07: Proxy Select & Session List Pages
**Summary**: UX scope coherent, but contains a product-decision conflict.

**Concerns**:
- `HIGH`: D-24 says proxy selection always shows; D-02 "auto-navigate directly to chat" conflicts
- `MEDIUM`: Session creation from "+" jumps to chat before DirectoryPicker exists
- `MEDIUM`: Swipe-to-terminate underspecified for Taro/Feishu gesture reliability

**Risk**: MEDIUM

### Plan 08: Chat Page
**Summary**: Right core UI plan. Correctly separates PTY and JSON rendering. Biggest risk is store shape assumptions.

**Concerns**:
- `MEDIUM`: JSON chat flow assumes message-level grouping already exists in chat store
- `MEDIUM`: "Timestamp on tap" adds complexity outside core success criteria
- `MEDIUM`: Auto-scroll logic easy to get wrong in mini program runtimes

**Risk**: MEDIUM

### Plan 09: Tool Approval UI
**Summary**: Feature-rich but scope creep is obvious. Rich per-tool previews, PTY overlay, collapsible cards, back-to-bottom in one wave is too dense.

**Concerns**:
- `HIGH`: Approval envelope payload depends on missing protocol definition
- `MEDIUM`: Rich Edit/Bash/Write specialized previews too much for first working version
- `MEDIUM`: PTY approval overlay assumes request ID correlation not clearly established

**Risk**: MEDIUM-HIGH

### Plan 10: State Stores & App Infrastructure
**Summary**: Strongest and cleanest plan. Provides store and app scaffolding UI plans need.

**Concerns**:
- `MEDIUM`: `Map<string, DirEntry[]>` in React state awkward for updates/serialization
- `MEDIUM`: App lifecycle assumes globally available relay URL not yet specified

**Risk**: LOW-MEDIUM

### Plan 11: Pickers, Quoting, Settings
**Summary**: Clearest case of Phase 6 overloading. Directory picker in scope, but slash/file pickers, quoting, settings menu, permission mode, PC window resizing in one final wave is too much.

**Concerns**:
- `HIGH`: Permission mode controls introduced without protocol/back-end support defined
- `HIGH`: PC window resizing is product polish, not core interaction -- platform-specific risk late in phase
- `MEDIUM`: Slash/file pickers depend on command/file cache correctness from non-trivial earlier plans
- `MEDIUM`: Quote XML injection adds UX/state complexity outside phase goal

**Risk**: HIGH

### Cross-Plan Assessment
**Overall**: Ambitious and mostly coherent, but tries to deliver core Phase 6 objective AND substantial Phase 7/8/UX polish in same milestone.

**Systemic Concerns**:
- `HIGH`: Approval flow not fully specified at shared-protocol level, yet multiple plans depend on it
- `HIGH`: `serve.ts` overloaded across Plans 03 and 05
- `HIGH`: D-24 vs D-02 navigation behavior conflict
- `MEDIUM`: Session resume/history scanning partly "discover during implementation"
- `MEDIUM`: Command/file picker work looks like optional enhancement, not core requirement

**Suggested Re-baseline**:
- Must-have: Plans 01, 02, 03, 05, 06, 08, 10, minimal 07
- Nice-to-have: much of 04, 09, 11

**Overall Risk**: MEDIUM-HIGH

---

## Consensus Summary

### Agreed Strengths
- **PTY as first-class citizen**: Both reviewers praised the dual-mode rendering architecture (PTY server-rendered grid + JSON chat bubbles) as the correct design
- **Layered sequencing**: Protocol-first -> proxy -> relay -> mini program infra -> pages ordering is sound
- **Strong testing culture**: TDD approach and test coverage throughout all plans
- **Responsive multi-device support**: useScreenSize + CSS variables for phone/tablet/PC adaptation

### Agreed Concerns
- **PTY extraction performance** (both MEDIUM): 200ms grid extraction at 5fps with full stringify comparison is a CPU/bandwidth risk. Both suggest incremental/row-level updates
- **File watcher reliability** (both MEDIUM): `fs.watch` recursive monitoring on large repos risks FD exhaustion and platform inconsistency
- **Phase scope creep** (Codex HIGH, Gemini implicit): Plans 09 and 11 pack too many features beyond core Phase 6 goals

### Divergent Views
- **Overall risk**: Gemini rates LOW-MEDIUM (spike-validated, well-decomposed); Codex rates MEDIUM-HIGH (protocol gaps, scope overload, serve.ts complexity)
- **Approval protocol**: Gemini treats as adequate; Codex identifies HIGH-severity gaps in approval payload definition, correlation IDs, and whitelist protocol
- **D-02 vs D-24 conflict**: Only Codex flagged the auto-navigate vs always-show-proxy-select product decision conflict
- **serve.ts complexity**: Only Codex identified the convergence of 7+ responsibilities as a structural risk
- **Plan 11 scope**: Codex explicitly recommends keeping only DirectoryPicker in Phase 6; Gemini does not flag this
