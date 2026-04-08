---
phase: 6
slug: feishu-mini-program-core-interaction
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-08
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.x |
| **Config file** | `vitest.config.ts` (per package) |
| **Quick run command** | `pnpm --filter @cc-anywhere/shared test && pnpm --filter @cc-anywhere/proxy test && pnpm --filter @cc-anywhere/relay test` |
| **Full suite command** | `pnpm -r test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick test for affected package
- **After every plan wave:** Run `pnpm -r test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | FEISHU-01 | — | N/A | unit | `pnpm --filter @cc-anywhere/shared test` | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | FEISHU-03 | — | N/A | unit | `pnpm --filter @cc-anywhere/proxy test` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | FEISHU-01 | — | N/A | unit | `pnpm --filter @cc-anywhere/relay test` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 3 | FEISHU-04 | — | N/A | integration | `pnpm -r test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Shared schema tests for new message types (terminal_frame, pty_state, dir_list_*, command_list_push, file_tree_push, session_history_*)
- [ ] Proxy unit tests for terminal grid extraction, tool approval forwarding, command discovery
- [ ] Relay unit tests for new message routing

*Wave 0 tasks will be refined by planner based on plan breakdown.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real-time streaming display on Feishu mini program | FEISHU-01 | Requires Feishu real device | Open mini program, send message, verify streaming text appears |
| PTY terminal grid rendering on mobile | FEISHU-01 | Feishu rendering engine | Open PTY session in mini program, verify colored text grid |
| Session list navigation and creation | FEISHU-03 | Feishu UI interaction | Create/switch/terminate sessions from mini program |
| Background reconnect with message replay | FEISHU-04 | Feishu lifecycle events | Put mini program in background, return, verify missed messages appear |
| Slash command picker interaction | FEISHU-03 | Feishu input UI | Type "/" in input, verify picker appears with commands |
| @file path picker interaction | FEISHU-03 | Feishu input UI | Type "@" in input, verify file picker appears |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
