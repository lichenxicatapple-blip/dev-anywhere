# DEV Anywhere Follow-up Code Audit - 2026-05-30

## Scope

本次是对 `docs/code-audit-2026-05-30.md` 修复后的二审，重点确认：

1. 初审修复是否真正降低复杂度，而不是把问题换位置。
2. PTY scroll / theme / provider startup 这些近期事故高发区域是否还有明显残留。
3. UI 相关改动是否存在可验证的 a11y、响应式、主题边界和测试质量问题。

`audit` 技能要求依赖项目设计上下文；当前仓库没有 `.impeccable.md`，本次没有中断去做设计访谈，只审可验证的实现问题。

## Health Score

| Dimension          |     Score | Key finding                                                                          |
| ------------------ | --------: | ------------------------------------------------------------------------------------ |
| Architecture       |       4/4 | Provider ready、event mapping、PTY scroll 子域已拆开，关键路径边界清晰。             |
| Code Quality       |       4/4 | 主体没有新的 dead code / reload / theme repaint 残留；二审发现的 runtime edge 已修。 |
| UI Maintainability |       3/4 | Settings/Create Session 已明显降复杂度；设计上下文缺失仍限制更高阶 UI 审查。         |
| Test Quality       |       4/4 | 新增纯模型测试和 provider startup 测试；已补 `jest-dom` 作为 DOM 断言基础设施。      |
| Operability        |       4/4 | Codex/Claude child spawn error 现在可通过 worker exit 路径显式暴露。                 |
| **Total**          | **19/20** | **Excellent: no blocking follow-up findings remain.**                                |

## Findings Fixed In Follow-up

### R-01 [P2] Agent CLI provider button 的 `aria-disabled` 语义误导

Location:

- `apps/web/src/components/session/agent-cli-picker.tsx`
- `apps/web/src/components/session/create-session-dialog.test.tsx`

Problem:

缺失 CLI 的 provider button 仍然需要可点击，因为用户要点进去打开“指定路径”编辑器。但按钮同时带 `aria-disabled=true`，这会向辅助技术表达“不可操作”，和真实行为冲突。

Fix:

- 移除 provider picker 上的 `aria-disabled`。
- 保留视觉不可用状态和“创建”按钮禁用逻辑。
- 测试改为断言 provider 仍可选，且 create 仍被阻止。

### R-02 [P1] JSON provider child process `spawn` error 没有统一上报

Location:

- `apps/proxy/src/worker/codex-app-server-session.ts`
- `apps/proxy/src/worker/json-session.ts`
- `apps/proxy/src/session-worker.ts`

Problem:

初审修了 Codex app-server ready 等待，但二审发现更底层的 `child_process` `error` 事件没有统一处理。CLI 不存在、权限错误或 spawn 失败时，可能继续表现成 ready timeout / 断连，而不是明确的 provider 启动失败。

Fix:

- Codex app-server session 监听 child `error`，reject pending requests / ready promise，写入 stderr preview，并只上报一次 exit。
- Claude stream-json session 同样把 child `error` 转为 `onExit(1)`。
- `session-worker` 对缺失/非法 pid 做兜底，不再发送虚假的 `worker_ready`。
- 增加 Codex/Claude spawn error 单测。

### R-03 [P2] Web DOM 测试缺少 `jest-dom`，导致断言可读性下降

Location:

- `apps/web/src/test/setup-storage.ts`
- `apps/web/package.json`
- `pnpm-lock.yaml`

Problem:

React Testing Library 测试已经大量按 DOM 行为写，但没有接 `@testing-library/jest-dom/vitest`，所以像 `toHaveAttribute` / `toBeDisabled` / `toBeInTheDocument` 这类高信号 matcher 不可用。

Fix:

- 添加 `@testing-library/jest-dom` 到 web devDependencies。
- 在 web Vitest setup 统一 import `@testing-library/jest-dom/vitest`。
- 将二审新增的 DOM 断言改回 `toHaveAttribute` 风格。
- lockfile 已用 pnpm 10 offline 方式收敛，避免 pnpm 11 重整造成无关大 diff。

## Follow-up Scan Result

二审重点扫过：

- PTY fixed-dark theme ownership: 未发现浅色 xterm profile 或 app theme 继续改写 xterm theme 的路径。
- PTY scroll split: touch、horizontal、container source、trace、DOM listener 已拆出，主 controller 仍偏长但不再承担所有纯判断。
- Settings/Create Session: 未发现 `location.reload` / 命令式重建 relay client / 低对比度主题残留。
- Provider startup: ready 等待、request timeout、child exit/error 都已有明确路径。
- Tests: 新增路径避免固定 sleep；历史测试里仍有一些 polling/sleep，但不属于本轮改动引入。

## Verification

已通过：

- `pnpm vitest run apps/web/src/components/session/create-session-dialog.test.tsx apps/proxy/src/__tests__/unit/codex-app-server-session.test.ts apps/proxy/src/__tests__/unit/json-session.test.ts`
  - 3 files, 56 tests passed.
- `pnpm exec tsc --noEmit --pretty false --project apps/web/tsconfig.json`
  - passed.
- `pnpm exec tsc --noEmit --pretty false --project apps/proxy/tsconfig.json`
  - passed.
- `pnpm vitest run apps/web/src/lib/pty-container-scroll-model.test.ts apps/web/src/lib/pty-touch-scroll-handler.test.ts apps/web/src/lib/pty-horizontal-scroll-model.test.ts apps/web/src/lib/pty-touch-scroll-state.test.ts apps/web/src/lib/pty-scroll-model.test.ts apps/web/src/lib/pty-scroll-controller.test.ts apps/proxy/src/__tests__/unit/relay-router-input.test.ts apps/proxy/src/__tests__/unit/worker-registry-disconnect.test.ts`
  - 8 files, 150 tests passed.

Final gate:

- `pnpm run quality:check`
  - format, lint, typecheck, knip, unit all passed.
