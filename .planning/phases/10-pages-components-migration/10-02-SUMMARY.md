---
phase: 10-pages-components-migration
plan: 02
subsystem: ui
tags: [proxy-select, master-detail, popover, status-dot, playwright, frozen-sidebar-contract]

# Dependency graph
requires:
  - phase: 10-pages-components-migration
    plan: 01a
    provides: Popover atom (bottom-start via align="start"), Button (font-normal ghost variant), amber theme
  - phase: 10-pages-components-migration
    plan: 01b
    provides: Sidebar 冻结契约 + ProxySwitcher stub 模块路径 + EmptyState(no-proxy) + showErrorToast API
  - phase: 08-business-logic-adaptation
    provides: useAppStore (proxies / selectedProxyId / setProxy / setProxyOnline / transitionToPhase) + relayClientRef + createHashRouter
provides:
  - ProxySwitcher 完整实现（layout="page"|"dropdown" 双形态, 共享 handleSelect 逻辑）
  - ProxyStatusDot 基础原子（online/offline/connecting 三态, 8px 圆点）
  - proxy-select.tsx 重写为 ProxySwitcher layout="page" 薄壳
  - Playwright proxy-switcher.spec.ts（4 tests × mobile+desktop = 8 runs）
affects:
  - 10-03 (SessionList 侧栏需要 ProxySwitcher 已在 sidebar 顶部占位才能在布局上验证)
  - 10-04a/b, 10-05, 10-06 (sidebar 内 ProxySwitcher 切换 proxy 时需正确更新 app-store 以让下游路由感知)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dual-layout via `layout` prop: 单个业务组件通过 prop 区分移动全屏 / 桌面 dropdown, 数据订阅和 handleSelect 只写一份, 避免 D-10 的 page 与 dropdown 语义分叉"
    - "EmptyState variant=no-proxy 复用于 layout=page 的零 proxy 态, 不在 ProxySwitcher 内自造文案"
    - "Radix Popover 通过 `data-slot=popover-content` 定位, E2E 不依赖 [role=dialog]/portal-wrapper 私有属性"
    - "aria-pressed 承载 selected 语义, 配合 data-proxy-id 给测试做语义锚"

key-files:
  created:
    - apps/web/src/components/proxy/proxy-status-dot.tsx
    - apps/web/e2e/proxy-switcher.spec.ts
  modified:
    - apps/web/src/components/proxy/proxy-switcher.tsx  # 10-01b stub body 被完整覆盖
    - apps/web/src/pages/proxy-select.tsx  # 从 53 行 Phase 8 调试页精简为 8 行 ProxySwitcher 薄壳

key-decisions:
  - "relayClientRef 导入路径锁定 @/hooks/use-relay-setup（现有源）, 而非 PLAN action 中写的 @/services/ensure-binding —— 后者不导出该符号, plan 文本有误"
  - "relayClientRef 是模块级 `RelayClient | null`, 而非 `{ current: RelayClient | null }`, 取值不走 `.current`"
  - "proxy-select.tsx 桌面端也渲染 ProxySwitcher layout=page 作为深链 fallback, 不做 viewport 分支 —— 桌面主入口是 sidebar dropdown, page 形态在桌面下纯粹是可访问性兜底"
  - "ProxySwitcher page 态 h-11 与 min-h-[44px] 双重保障, 即便 text overflow 或 flex shrink 触发意外压缩, touch target 仍 ≥44px"
  - "Popover w-[260px] 与 UI-SPEC spacing layout constant 一致（sidebar 280px - 内边距 ≈ 260px）, 视觉上 popover 不超过 sidebar 可见宽度"
  - "aria-label 写 `Proxy status: ${status}` 英文, 遵循 /CLAUDE.md 日志/可读属性英语、注释中文 的项目规范"

patterns-established:
  - "Module-path-as-contract 验证 PASSED: 10-01b Sidebar 提前 import 的 proxy-switcher 模块, 被 10-02 原地重写 body 后 sidebar.tsx 零改动, 下游 10-03 可同 wave 并行不冲突"
  - "Dual-layout 业务组件模板: 共享 state + handleSelect 顶层, 仅渲染分支依据 layout prop 二选一; 后续 SessionList / InputBar 的类似双形态可沿用"

requirements-completed:
  - FRONT-04
  - FRONT-08

# Metrics
duration: ~12min
completed: 2026-04-17
---

# Phase 10 Plan 02: ProxySwitcher dual-layout Summary

**ProxySwitcher 双形态正式实现（layout=page 全屏列表 + layout=dropdown Popover）, ProxyStatusDot 三态原子, proxy-select.tsx 精简为 ProxySwitcher 薄壳, Sidebar.tsx 零改动验证通过, Playwright 4 条 spec × 2 viewport = 8 runs 可列出且 typecheck 清洁。**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-04-17T14:44Z (worktree base 5e5cfb3b)
- **Completed:** 2026-04-17T14:56Z
- **Tasks:** 3 code tasks 完成; Task 4 是 `checkpoint:human-verify` 门禁, 按 parallel-executor 合约交给 orchestrator 负责
- **Files touched:** 4 (2 created + 2 modified)

## Accomplishments

- **ProxyStatusDot** (`components/proxy/proxy-status-dot.tsx`): 8px `w-2 h-2 rounded-full shrink-0` inline-block span, status → class map via Record: `online` → `bg-[var(--color-status-success)]`（teal #00D4AA）、`offline` → `bg-[var(--muted-foreground)]`、`connecting` → `bg-[var(--color-status-working)] animate-pulse`. `role="status"` + `aria-label="Proxy status: {status}"`。
- **ProxySwitcher** (`components/proxy/proxy-switcher.tsx`): 完整覆盖 10-01b stub body, 保留 props 契约 `{ layout: "page" | "dropdown" }`。顶层订阅 `proxies` / `selectedProxyId`, `handleSelect` 函数在两种 layout 下逻辑等价: `relayClientRef.selectProxy(proxyId)` → `localStorage.setItem("cc_proxyId", ...)` → `useAppStore.setProxy/setProxyOnline/transitionToPhase`, 仅在 `layout==="page"` 时 `navigate("/sessions")`。页面态 0 proxy 时渲染 `<EmptyState variant="no-proxy" />`, 桌面下拉 0 proxy 时显示 "没有可用 Proxy" 小字。
- **proxy-select.tsx**: 从 53 行 Phase 8 调试页缩减到 8 行纯薄壳, 直接 `return <ProxySwitcher layout="page" />`. Phase 8 调试页面的 clientId / relayUrl 调试信息已随 ProxySwitcher 上线交由 AppShell header + Command Palette 承担, 不在 proxy 选择页呈现。
- **E2E spec** (`e2e/proxy-switcher.spec.ts`): 4 条测试 —— 移动端 (`renders at /` + `touch-target ≥44px`), 桌面端 (`dropdown trigger visible` + `click opens Popover`), 共 4 × 2 projects = 8 个 run 在 `playwright test --list` 中可见。测试有意容忍 "无 proxy" 情况 (跳过 touch-target 断言) —— 真实 proxy 选择链路在 Task 4 人工 checkpoint 下覆盖。

## ProxySwitcher API & 行为契约

### Props & 数据订阅

```tsx
interface ProxySwitcherProps {
  layout: "page" | "dropdown";
}
const proxies = useAppStore((s) => s.proxies);                 // ProxyInfo[]
const selectedProxyId = useAppStore((s) => s.selectedProxyId); // string | null
```

### handleSelect 共享行为

```tsx
async function handleSelect(proxyId: string, proxyName: string | undefined) {
  const relay = relayClientRef;
  if (!relay) { showErrorToast("Relay client not available"); return; }
  const result = await relay.selectProxy(proxyId);
  if (!result.success) {
    showErrorToast(`选择 Proxy 失败: ${result.error ?? "unknown"}`);
    return;
  }
  localStorage.setItem("cc_proxyId", proxyId);
  useAppStore.getState().setProxy(proxyId, proxyName ?? null);
  useAppStore.getState().setProxyOnline(true);
  useAppStore.getState().transitionToPhase("session_browsing");
  if (layout === "page") navigate("/sessions");
}
```

### 渲染分支

| layout | 容器 | 列表项样式 | 空态 | 选中后导航 |
| --- | --- | --- | --- | --- |
| `page` | `<div class="flex flex-col gap-2 p-4 h-full overflow-auto">` + `<h2>选择一个 Proxy</h2>` | `w-full h-11 min-h-[44px] rounded-md border border-border bg-card hover:bg-accent` | `<EmptyState variant="no-proxy" />` | `navigate("/sessions")` |
| `dropdown` | `<Popover><PopoverTrigger asChild><Button variant="ghost" size="sm" class="w-full justify-start gap-2 h-9" data-slot="proxy-switcher-trigger">` 里嵌状态点 + proxy 名/"未选择" | `w-full h-9 rounded-md hover:bg-accent px-2`, 容器 `PopoverContent align="start" w-[260px] p-1` | `<div>没有可用 Proxy</div>` 小字 | 停留当前路由, 仅 app-store 更新 |

### 语义锚 (E2E + a11y)

| 锚 | 位置 | 用途 |
| --- | --- | --- |
| `data-slot="proxy-switcher-trigger"` | dropdown 触发按钮 | E2E 识别桌面入口 |
| `data-slot="proxy-item"` | 每个 proxy 的 button | E2E 统计/点击 |
| `data-proxy-id="{proxyId}"` | proxy 按钮 | 语义化 proxy 引用 |
| `aria-pressed={selectedProxyId === p.proxyId}` | proxy 按钮 | 屏读器标识当前选中 |
| `data-slot="popover-content"` | Popover 内容（shadcn 自带） | E2E 断言 popover 展开 |

## ProxyStatusDot API

```tsx
interface ProxyStatusDotProps {
  status: "online" | "offline" | "connecting";
  className?: string;
}
```

复用面: ProxySwitcher 两种 layout 都用; 未来 Chat header / Sidebar session row 可复用同一原子。

## Frozen Sidebar Contract — 验证通过

**契约:** Plan 10-01b 已在 `apps/web/src/components/shell/sidebar.tsx` 中 `import { ProxySwitcher } from "@/components/proxy/proxy-switcher"`。本 Plan 重写该模块 body, sidebar.tsx 仅通过模块路径消费, 零改动。

**验证命令:**
```bash
git diff 5e5cfb3b..HEAD -- apps/web/src/components/shell/sidebar.tsx
# → 空 (无任何 diff)

git diff --name-only 5e5cfb3b..HEAD
# → apps/web/e2e/proxy-switcher.spec.ts
# → apps/web/src/components/proxy/proxy-status-dot.tsx
# → apps/web/src/components/proxy/proxy-switcher.tsx
# → apps/web/src/pages/proxy-select.tsx
```

Sidebar 不在 diff 中, 说明本 plan 的 module-path-as-contract 模式生效, Plan 10-03 可在同 Wave 并行而不与本 worktree 的 sidebar 写入冲突。

## Page 与 Dropdown 布局差异

| 维度 | page (mobile) | dropdown (desktop) |
| --- | --- | --- |
| 触发 | 进入 `/` 路径后主区渲染 | 侧栏顶部按钮点击后弹出 |
| 容器 | 全 viewport `h-full overflow-auto p-4` | Popover portal `w-[260px] p-1` |
| 列表项 | 44px 触控高度, 显示 "离线" 副标签 | 36px (`h-9`) 紧凑高度, 无副标签 |
| 零态 | `<EmptyState variant="no-proxy">` 全屏引导 | "没有可用 Proxy" 小字 |
| 选中后 | `navigate("/sessions")` 进入会话列表 | 停留当前路由, Popover 自动 collapse |
| 触发 a11y | `<h2 class="text-lg font-semibold">选择一个 Proxy</h2>` 语义大标题 | `aria-label` 隐含在 trigger 按钮内容中 |

## proxy-select.tsx 重写 Diff

```diff
-import { useAppStore } from "@/stores/app-store";
-import { relayClientRef } from "@/hooks/use-relay-setup";
-import { router } from "@/lib/router";
-
-export function ProxySelectPage() {
-  const { phase, connected, proxies, clientId, relayUrl } = useAppStore();
-
-  async function handleSelect(proxyId: string, proxyName: string | undefined) {
-    if (!relayClientRef) return;
-    const result = await relayClientRef.selectProxy(proxyId);
-    if (result.success) {
-      localStorage.setItem("cc_proxyId", proxyId);
-      useAppStore.getState().setProxy(proxyId, proxyName || null);
-      useAppStore.getState().setProxyOnline(true);
-      useAppStore.getState().transitionToPhase("session_browsing");
-      router.navigate("/sessions");
-    }
-  }
-  ...（45 行 Phase 8 调试 UI）
-}
+import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
+
+export function ProxySelectPage() {
+  return <ProxySwitcher layout="page" />;
+}
```

Phase 8 的 phase / connected / clientId / relayUrl 调试展示已由 AppShell chrome + Command Palette + /pty-test 调试页承担, 不再挂在 proxy 选择页上。

## E2E Spec 输出

```
pnpm --filter web exec playwright test --list 中本 plan 新增 8 个 run:
  [mobile]  proxy-switcher.spec.ts:14 — renders at / without sidebar
  [mobile]  proxy-switcher.spec.ts:24 — touch-target height is at least 44px on mobile
  [mobile]  proxy-switcher.spec.ts:46 — renders inside sidebar dropdown slot
  [mobile]  proxy-switcher.spec.ts:53 — clicking trigger opens Popover with proxy list or empty state
  [desktop] 同上 4 条

Total: 28 tests in 4 files (smoke 1 + shell 7 + toast 2 + proxy-switcher 4 = 14 tests × 2 projects = 28 runs)
```

Spec 未在 worktree 中实跑 (parallel-executor 无 dev server + relay), 由 orchestrator 在合并后统一执行。Spec 设计上容忍 "没有 proxy" 态：touch-target 测试在无 proxy 时 `test.skip`, 其他测试只断言 slot 命中 + popover 出现, 不依赖具体选择结果。

## Task Commits

Worktree 分支上 `--no-verify` 按 parallel-executor 合约提交:

1. **Task 1: ProxySwitcher dual-layout + status dot** — `59309ed` (feat) — 2 files (1 created + 1 modified)
2. **Task 2: wire proxy-select page to ProxySwitcher** — `5819a01` (feat) — 1 file modified
3. **Task 3: proxy-switcher e2e spec** — `3227a85` (test) — 1 file created

无 REFACTOR commit, 无 RED 门 (plan 为 `type: execute` 非 TDD plan)。

## Verification Matrix

| Acceptance criterion | 结果 |
| --- | --- |
| `proxy-switcher.tsx` exports `ProxySwitcher({ layout })`, 签名与 10-01b stub 相同 | PASS (props 契约字段同为 `"page" \| "dropdown"`) |
| `proxy-status-dot.tsx` exports `ProxyStatusDot` 三态 | PASS |
| `online` dot 用 `bg-[var(--color-status-success)]`, `connecting` 带 `animate-pulse` | PASS |
| `handleSelect` 调用 `relayClientRef.selectProxy` + 写 `cc_proxyId` localStorage | PASS |
| `handleSelect` 仅在 `layout==="page"` 时 `navigate("/sessions")` | PASS |
| Mobile page 使用 `min-h-[44px]` (iOS HIG) | PASS |
| Desktop dropdown 用 Popover `align="start"` | PASS |
| 错误处理用 `showErrorToast` (import from `@/components/toast`) | PASS |
| Page 态 `proxies.length === 0` → `<EmptyState variant="no-proxy" />` | PASS |
| `sidebar.tsx` 无改动 | PASS (git diff 空) |
| `pnpm --filter web typecheck` 退出码 0 | PASS |
| `pnpm --filter web test` 10/10 passed | PASS (pre-existing theme-tokens tests) |
| `playwright test --list` 识别 proxy-switcher.spec.ts | PASS (4 tests × 2 projects) |

## Decisions Made

- **relayClientRef 导入路径纠正** — Plan action 文本写的是 `@/services/ensure-binding`, 但该模块只导出 `ensureBinding` 函数, 不导出 `relayClientRef`。`relayClientRef` 的真正出处是 `@/hooks/use-relay-setup`（模块级 `RelayClient | null` 变量, 不是 ref 对象）。按现有项目约定走, plan 文本误导属于 Rule 1 bug（见 Deviations 1）。
- **proxy-select.tsx 桌面渲染策略** — 桌面端命中 `/` 时仍渲染 `<ProxySwitcher layout="page" />` 而非 redirect 或 blank; AppShell 负责 sidebar 布局, page 态主区会平铺 proxy 列表, 与 sidebar dropdown 在视觉上并存但不互斥。避免额外引入视口分支状态, 保持 URL `/` 始终可访问。
- **Popover content 宽度 260px 而非 280px sidebar 全宽** — 留出左右各 10px 视觉边距, 避免 popover 边缘贴住 sidebar border, UI 上更舒展。
- **EmptyState 无 action CTA** — Page 态 0 proxy 时只展示 EmptyState 默认的 heading + body, 不放 "连接 Proxy" 按钮。cc-anywhere CLI 启动后自动出现, 用户不需要 UI 内操作; UI-SPEC copy "在本地运行 cc-anywhere 后，它会出现在这里" 已自包含行动引导。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan action 中 `relayClientRef.current` 用法错误**
- **Found during:** Task 1 源码 audit (执行前对比 `@/hooks/use-relay-setup` 与 `@/services/ensure-binding` 导出)
- **Issue:** Plan <action> 的示例代码写:
  ```tsx
  import { relayClientRef } from "@/services/ensure-binding";
  const relay = relayClientRef.current;
  ```
  实际情况:
  - `@/services/ensure-binding.ts` 只导出 `ensureBinding`、类型 `BindingResult`, 不导出 `relayClientRef`
  - `relayClientRef` 的真正来源是 `@/hooks/use-relay-setup.ts` (L14 `export let relayClientRef: RelayClient | null = null`), 本身就是模块级变量, 不是 React ref, 没有 `.current` 属性
  - 若按 plan 字面写会双重错误: import 失败 + `undefined.selectProxy` 运行时崩溃
- **Fix:** 按现有项目约定改为 `import { relayClientRef } from "@/hooks/use-relay-setup"` 并直接 `const relay = relayClientRef` (不解 `.current`)
- **Verification:** `pnpm --filter web typecheck` 清洁, `handleSelect` 调用链与 Phase 8 旧 `proxy-select.tsx` (L10) 既有模式完全一致
- **Committed in:** `59309ed` (Task 1)

**2. [Rule 2 - Missing critical functionality] Dropdown 态 proxyId 不做 null-check 直接访问**
- **Found during:** Task 1 edge case review
- **Issue:** Plan <action> 的 dropdown 分支里用 `currentProxy?.online` 但没处理 `currentProxy` 完全 undefined 的场景 (proxies 列表为空或 selectedProxyId 无匹配时)。若直接传 `status={currentProxy?.online ? "online" : "offline"}`, 当 `currentProxy` 为 undefined 时落到 "offline" 分支, 这是期望行为但缺乏显式注释
- **Fix:** 保留 `currentProxy?.online ? "online" : "offline"` 三态表达式, 同时在 Popover content 里单独处理 `proxies.length === 0` 的 "没有可用 Proxy" 文案, 避免空 list 渲染为空 `<ul>`
- **Verification:** 两套分支在 typecheck + 逻辑上都可达, E2E 的 "clicking trigger opens Popover with proxy list or empty state" 覆盖
- **Committed in:** `59309ed` (Task 1, 与 Fix 1 合并)

**3. [Rule 1 - Test pattern] E2E popover locator 改用 data-slot 而非 role=dialog**
- **Found during:** Task 3 E2E spec 起草
- **Issue:** Plan <action> 给的 Playwright locator 是 `page.locator('[role="dialog"], [data-radix-popper-content-wrapper]')`。前者不是 Popover 正确 role (Popover 默认不带 dialog role, 只有 `<Popover modal>` 或 DialogPrimitive 才有); 后者 `data-radix-popper-content-wrapper` 是 Radix 内部实现细节, 不稳定
- **Fix:** 改为 `page.locator('[data-slot="popover-content"]')` —— `data-slot` 是 shadcn new-york 变体的稳定对外锚, 10-01a 的 popover atom 在 `PopoverContent` 上明确写了 `data-slot="popover-content"` (见 `apps/web/src/components/ui/popover.tsx` L29)
- **Verification:** `playwright test --list` 识别 spec, locator 表达稳定
- **Committed in:** `3227a85` (Task 3)

**Total deviations:** 3 (1 × Rule 1 plan text bug, 1 × Rule 2 explicit null handling, 1 × Rule 1 test locator fidelity)

所有修正都在 plan 明确列出的文件边界内, 无 scope creep, 无架构改动。

## Threat Flags

无新 threat surface。`<threat_model>` 中 T-10-02-01 ~ T-10-02-04 全部按 plan 约定 disposition 处理:
- T-10-02-01 (proxyId 篡改): accept —— proxyId 来自 `proxy_list_response` (relay-client 里 zod 校验)
- T-10-02-02 (proxy name 展示): accept —— 与现状一致, 无增量曝光
- T-10-02-03 (selectProxy 失败 DoS): **mitigate** —— `handleSelect` 中 `!result.success` 分支主动 `showErrorToast`, 错误被用户感知而非静默吞掉, 与 RESEARCH §2.6 一致
- T-10-02-04 (localStorage 篡改): accept —— ensure-binding 流程对非法 id 会走 error path

## Issues Encountered

无阻塞性问题。Baseline `pnpm install --ignore-scripts` + `pnpm --filter @cc-anywhere/shared build` 走通后, typecheck 全程绿。

## Visual Checkpoint Status (Task 4)

Task 4 是 `checkpoint:human-verify` blocking gate, parallel worktree 模式下无法与用户直接交互。代码状态已就绪, 由 orchestrator 合并 worktree 后交接:

**合并后验证步骤:**
1. 启动链路: `pnpm --filter relay dev` + `pnpm --filter proxy serve start` + `pnpm --filter web dev`
2. **Mobile 390x844, URL `/`**: 主区是 ProxySwitcher page 态, 0 proxy 时 EmptyState 全屏, 有 proxy 时每项 status-dot + name, 离线项多 "离线" 副标签; 44px 触控目标
3. **Desktop 1280x800, URL `/`**: Sidebar 可见, 顶部 `data-slot="proxy-switcher-trigger"` 按钮显示 "未选择" 或当前 proxy 名, 点击打开 Popover
4. 点击 mobile proxy → 跳 `/#/sessions` + localStorage 写 `cc_proxyId`
5. 点击 desktop dropdown item → URL 不变, trigger 文案刷新, app-store.selectedProxyId 更新
6. 三态 dot 颜色: online teal `#00D4AA`, offline muted gray, connecting cyan `#4FC1FF` + pulse
7. 交叉检查 UI-SPEC 6 维度: Color (dot token + popover bg #2D2D2D + hover --accent), Typography (proxy name text-sm 400), Spacing (h-9 dropdown + min-h-[44px] mobile + w-[260px] popover), States (hover bg --accent, focus-visible ring amber), Copy ("选择一个 Proxy", "未选择"), Responsive (md 断点切换)
8. `git diff 5e5cfb3b..HEAD -- apps/web/src/components/shell/sidebar.tsx` 为空
9. 运行 e2e: `pnpm --filter web exec playwright test proxy-switcher.spec.ts`

Plan frontmatter `autonomous: false` + Task 4 blocking gate 意味着人工批准前该 plan 不算完全完成。Orchestrator 在 Wave 3 worktrees 合并后组织验证。

## User Setup Required

无。

## Next Plan Readiness

- **10-03 (SessionList 真实实现)** 可并行（本 plan 未触 sidebar / session-list 相关文件, 本 wave 3 的 write-surface 隔离）
- **10-04a/b、10-05** 将消费 sidebar dropdown 选出的 proxy, selectedProxyId 的 app-store 更新与 localStorage `cc_proxyId` 持久化由本 plan 保证
- **sidebar 顶部槽已自动填充实现**: 10-01b 的 `<ProxySwitcher layout="dropdown" />` 节点在下一次渲染时即显示本 plan 的真实 Popover trigger, 无额外 wiring

## Self-Check: PASSED

**File existence:**
- `.planning/phases/10-pages-components-migration/10-02-SUMMARY.md` — FOUND (this file)
- `apps/web/src/components/proxy/proxy-switcher.tsx` — FOUND (modified, 126 lines)
- `apps/web/src/components/proxy/proxy-status-dot.tsx` — FOUND (27 lines)
- `apps/web/src/pages/proxy-select.tsx` — FOUND (8 lines, rewritten)
- `apps/web/e2e/proxy-switcher.spec.ts` — FOUND (63 lines)

**Untouched guarantee:**
- `apps/web/src/components/shell/sidebar.tsx` — UNCHANGED vs worktree base (git diff 空)

**Commits:**
- `59309ed` (Task 1 — ProxySwitcher + ProxyStatusDot) — verified
- `5819a01` (Task 2 — proxy-select rewrite) — verified
- `3227a85` (Task 3 — e2e spec) — verified

---
*Phase: 10-pages-components-migration*
*Plan: 10-02*
*Completed: 2026-04-17*
