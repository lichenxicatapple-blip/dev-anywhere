# Phase 2: Local Proxy - PTY Transparency - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md -- this log preserves the alternatives considered.

**Date:** 2026-04-03
**Phase:** 02-local-proxy-pty-transparency
**Areas discussed:** CLI invocation, PTY lifecycle, Signal forwarding, Output interception
**Mode:** --auto (all decisions auto-selected)

---

## CLI Invocation Design

| Option | Description | Selected |
|--------|-------------|----------|
| Transparent passthrough | All args forwarded to claude, cc-anywhere config via env vars | [auto] |
| Subcommand namespace | cc-anywhere proxy -- claude args | |
| Config file approach | cc-anywhere reads .cc-anywhere.json for own settings | |

**User's choice:** [auto] Transparent passthrough (recommended default)
**Notes:** Minimizes friction -- users don't need to learn new CLI syntax

---

## PTY Lifecycle Management

| Option | Description | Selected |
|--------|-------------|----------|
| Direct spawn + exit code propagation | node-pty spawn, propagate exit code, detect crashes | [auto] |
| Process group management | Create process group, manage as unit | |
| Supervisor pattern | Restart on crash with backoff | |

**User's choice:** [auto] Direct spawn + exit code propagation (recommended default)
**Notes:** Simplest correct approach. Supervisor pattern not needed -- cc-anywhere should not auto-restart claude

---

## Signal Forwarding

| Option | Description | Selected |
|--------|-------------|----------|
| PTY-native control chars | Write Ctrl chars to PTY stdin, resize() for SIGWINCH | [auto] |
| OS signal forwarding | process.kill(childPid, signal) | |
| Hybrid approach | PTY for interactive, OS for lifecycle signals | |

**User's choice:** [auto] PTY-native control characters (recommended default)
**Notes:** PTY-native is correct for terminal transparency -- OS signals bypass the terminal layer and can cause unexpected behavior

---

## Output Interception Architecture

| Option | Description | Selected |
|--------|-------------|----------|
| Pipe with noop tap | Pure passthrough, stream architecture allows future tap | [auto] |
| Dual writer from start | tee to both stdout and buffer | |
| Pure passthrough only | No architectural preparation for future relay | |

**User's choice:** [auto] Pipe with noop tap (recommended default)
**Notes:** Balances Phase 2 simplicity with Phase 3-4 forward compatibility

---

## Claude's Discretion

- node-pty configuration parameters (shell, env passing)
- Error message formatting

## Deferred Ideas

- Multi-session management (Phase 3)
- Agent SDK integration (Phase 3)
- Relay connection (Phase 4)
