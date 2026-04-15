---
phase: 7
slug: project-scaffold-design-tokens
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-15
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | apps/web/vitest.config.ts (Wave 0 installs) |
| **Quick run command** | `pnpm --filter web test` |
| **Full suite command** | `pnpm --filter web test --run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter web test`
- **After every plan wave:** Run `pnpm --filter web test --run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | 01 | 1 | FRONT-01 | — | N/A | build | `pnpm --filter web build` | ❌ W0 | ⬜ pending |
| TBD | 01 | 1 | FRONT-02 | — | N/A | visual | `pnpm --filter web dev` | ❌ W0 | ⬜ pending |
| TBD | 02 | 1 | DEPLOY-02 | — | N/A | integration | `pnpm --filter web dev` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/web/vitest.config.ts` — vitest configuration
- [ ] `apps/web/src/__tests__/` — test directory structure
- [ ] `vitest` + `@testing-library/react` — install as devDependencies

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dark theme colors render correctly (#1E1E1E surface, #D4D4D4 text) | FRONT-02 | Visual verification | Open dev server, inspect body background and text colors |
| shadcn/ui Button renders with #00D4AA accent | FRONT-02 | Visual verification | Open token showcase page, verify Button component styling |
| WebSocket proxy connects to relay | DEPLOY-02 | Requires running relay | Start relay + web dev server, check browser WebSocket connection |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
