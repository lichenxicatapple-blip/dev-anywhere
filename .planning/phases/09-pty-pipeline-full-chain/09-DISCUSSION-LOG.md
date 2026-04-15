# Phase 9: PTY Pipeline Full Chain - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md -- this log preserves the alternatives considered.

**Date:** 2026-04-15
**Phase:** 09-pty-pipeline-full-chain
**Areas discussed:** EventStore format, snapshot strategy, binary/JSON transport, xterm.js integration, TerminalTracker retirement, PTY/JSON coexistence, local terminal impact, EventStore file organization, proxy restart recovery, xterm scrollback, full-chain testing, IPC protocol, /pty-test UI, binary frame routing, font loading, relay session-buffer, binary frame forwarding, client binary parsing, remote input, Phase 8/9 intersection, CCAE format details, code deletion scope, implementation order, risk points, EventStore reverse scanning, rotation snapshots, MIGRATION-PLAN.md reference

---

## EventStore Format

| Option | Description | Selected |
|--------|-------------|----------|
| Custom binary (recommended) | CCAE magic header + length-prefixed events | * |
| NDJSON + base64 | JSON objects, PTY data base64 encoded | |
| SQLite | Single-file database | |

**User's choice:** Custom binary
**Notes:** Aligns with success criteria specifying CCAE header

## Write Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Memory buffer + timed flush | Accumulate, flush every 1s or when full | |
| Immediate write per event | Write to file on every PTY output | * |
| OS write cache proxy | Direct fs.write, rely on OS page cache | |

**User's choice:** Immediate write -- user cannot tolerate data loss
**Notes:** User asked about I/O pressure first. After learning Claude Code produces ~1-5MB/30min, confirmed immediate write is acceptable

## gzip Archival

| Option | Description | Selected |
|--------|-------------|----------|
| Session end only | Compress on session close | |
| File size trigger | Rotate when exceeding threshold | |
| Both combined | Size rotation + session end archival | * |

**User's choice:** Both combined -- sessions are typically long-running

## Snapshot Trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Event count (recommended) | Every N events generate snapshot | * |
| Time interval | Every fixed interval (e.g. 30s) | |
| State transition | On Claude Code state changes (OSC signals) | |
| Hybrid | State transition + event count fallback | |

**User's choice:** Event count trigger

## Snapshot Storage

| Option | Description | Selected |
|--------|-------------|----------|
| Embedded in EventStore (recommended) | Snapshot as special event type in same binary file | * |
| Separate snapshot files | Write to independent .snapshot files | |

**User's choice:** Embedded

## Binary Frame Routing

| Option | Description | Selected |
|--------|-------------|----------|
| 4-byte sessionId hash | Hash sessionId to 4 bytes | |
| Single session binding | One WS connection = one session | |
| SessionId string prefix | 1B length + sessionId UTF-8 bytes + PTY data | * |

**User's choice:** Initially selected 4-byte hash, then revised to sessionId string prefix to avoid maintaining dual ID systems

## Relay Binary Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Pure passthrough (recommended) | Read session routing prefix, forward as-is | * |
| Buffered forwarding | Cache recent binary frames for reconnection | |

**User's choice:** Pure passthrough -- recovery driven by proxy EventStore
**Notes:** User asked about reconnection implications, confirmed relay doesn't need buffer

## xterm.js Positioning

| Option | Description | Selected |
|--------|-------------|----------|
| Standalone test page (recommended) | /pty-test page, independent of Phase 8/10 | * |
| Integrate into Chat page | As PTY mode component in Chat | |

**User's choice:** Standalone test page

## xterm.js Addons

| Option | Description | Selected |
|--------|-------------|----------|
| fit + serialize (recommended) | Minimum set for Phase 9 | |
| fit + serialize + web-links | Add clickable URLs in terminal | * |

**User's choice:** fit + serialize + web-links

## Terminal Sizing

**User's choice:** PTY is size authority, client passively follows resize events, CSS scales to viewport
**Notes:** User confirmed this matches v1.0 architecture -- PTY decides cols/rows, client must match exactly

## TerminalTracker Retirement

| Option | Description | Selected |
|--------|-------------|----------|
| Keep parallel (recommended) | Old and new chains coexist | |
| Delete immediately | Remove all old PTY chain code | * |

**User's choice:** Direct deletion -- feishu app is archived, no need to maintain old chain

## JSON Mode Coexistence

**User's choice:** Phase 9 only changes PTY chain, JSON mode unchanged
**Notes:** User asked about future JSON chain changes -- explained Phase 8/10 handle that

## Local Terminal Priority

| Option | Description | Selected |
|--------|-------------|----------|
| Local terminal first (recommended) | stdout first, then async EventStore + WS | * |
| Synchronous all | All operations in same callback | |

**User's choice:** Local terminal first

## EventStore File Naming

| Option | Description | Selected |
|--------|-------------|----------|
| Sequence rotation (recommended) | events.bin -> events.001.bin.gz, events.002.bin.gz | * |
| Timestamp naming | events-20260415T1230.bin.gz | |

**User's choice:** Sequence rotation

## Data Cleanup

| Option | Description | Selected |
|--------|-------------|----------|
| Manual cleanup | User manages disk space | * |
| Auto cleanup by age | Delete files older than N days | |

**User's choice:** Manual cleanup

## Proxy Restart Recovery

| Option | Description | Selected |
|--------|-------------|----------|
| Visual state recovery (recommended) | Load snapshot + replay events | |
| Visual + process recovery | Also attempt claude --resume | |
| serve.ts restart recovery | Serve loads EventStore to serve clients while terminal reconnects | * |

**User's choice:** serve.ts restart scenario -- terminal.ts rarely crashes, serve.ts is the real recovery target
**Notes:** User pointed out terminal.ts is transparent to PTY, so serve crash doesn't kill PTY/EventStore recording

## xterm Scrollback

**User's choice:** 5000 lines, unified on both proxy and browser sides
**Notes:** User asked about @xterm/headless vs xterm.js difference -- explained they share the same engine

## Testing Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Browser manual only | Manual visual verification | |
| Playwright E2E only | Automated browser tests | |
| Both combined | E2E + manual visual verification | * |

**User's choice:** Both combined

## replay.ts Migration

| Option | Description | Selected |
|--------|-------------|----------|
| Migrate to new chain | Use binary frames + EventStore fixtures | * |
| Leave unchanged | Keep old chain, migrate in Phase 11 | |

**User's choice:** Migrate to new chain

## IPC Protocol

| Option | Description | Selected |
|--------|-------------|----------|
| Mixed protocol (recommended) | NDJSON + length-prefixed binary on same socket | * |
| Dual socket | Separate sockets for JSON and binary | |
| NDJSON + base64 | Keep existing protocol, base64 encode binary | |

**User's choice:** Mixed protocol

## /pty-test Page UI

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal terminal (recommended) | Full-screen xterm.js + status bar + manual URL/sessionId input | * |
| With session selection | Add session list from relay | |

**User's choice:** Minimal terminal

## Relay session-buffer

**User's choice:** Delete in Phase 9 -- relay becomes completely stateless
**Notes:** User's rationale: "stateless relay's benefits far outweigh the slight reconnection latency"

## RelayConnection Send Interface

| Option | Description | Selected |
|--------|-------------|----------|
| Unified send() | Single method, internal type branching | |
| Separate methods | sendEnvelope() for JSON, sendBinary() for binary | * |

**User's choice:** Separate methods -- different queue behavior (JSON queued, binary fire-and-forget) makes unification misleading
**Notes:** User asked for rename to sendEnvelope to make distinction clear to planner

## Binary Frame Forwarding (Relay -> Client)

| Option | Description | Selected |
|--------|-------------|----------|
| Keep prefix (recommended) | Forward as-is, zero-copy ws.send(data) | * |
| Strip prefix | Extract sessionId, forward only PTY data | |

**User's choice:** Keep prefix -- relay zero-copy

## CCAE File Header

| Option | Description | Selected |
|--------|-------------|----------|
| magic + version (recommended) | 4B 'CCAE' + 2B version = 6 bytes | * |
| magic + version + metadata length | Add variable-length metadata area | |

**User's choice:** magic + version

## Event Header

| Option | Description | Selected |
|--------|-------------|----------|
| type + timestamp + length (recommended) | 1B + 8B + 4B = 13B header + payload + 4B trailer | * |
| type + seqNo + timestamp + length | Add 4B sequence number | |

**User's choice:** type + timestamp + length, plus 4B total_len trailer for reverse scanning
**Notes:** User suggested reverse scanning for finding latest snapshot -- confirmed this requires the trailer

## Code Deletion Scope

**User's choice:** Full deletion -- TerminalTracker, FramePusher, FrameCache, TerminalFrameRenderer, shared TermLine/TermSpan types, relay session-buffer/buffer-store

## Implementation Order

| Option | Description | Selected |
|--------|-------------|----------|
| proxy -> relay -> browser (recommended) | Follow data flow direction | * |
| End-to-end skeleton first | Simplest binary chain first, then add persistence | |

**User's choice:** proxy -> relay -> browser

## Risk Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Plan 09-01 upfront spike (recommended) | Validate headless+serialize import, IPC mixed protocol, EventStore write pressure | * |
| Fix as encountered | No upfront validation | |

**User's choice:** Upfront spike validation

## Phase 8/9 Ordering

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 9 first (recommended) | Avoid shared package type conflicts | * |
| Parallel with coordination | Both in parallel, coordinate on shared | |

**User's choice:** Phase 9 first

## Remote Input

| Option | Description | Selected |
|--------|-------------|----------|
| Read-only (recommended) | /pty-test only shows output | * |
| Support input | xterm.js onData sends pty_input via JSON | |

**User's choice:** Read-only -- input uses existing JSON chain, Phase 10 integrates

## Event History After Snapshot

**User's choice:** Keep all events, never clean up -- needed for Phase 11 replay

## Snapshot Location Strategy

**User's choice:** Reverse scan from file end using 4B trailer

## Rotation Snapshot

**User's choice:** Force SNAPSHOT as first event in new events.bin after rotation

## xterm.js Theme

**User's choice:** Use Phase 7 design tokens -- bg #1E1E1E, fg #D4D4D4, cursorAccent #00D4AA, VS Code Dark+ ANSI colors

## Font Loading Timing

**User's choice:** document.fonts.ready before xterm.js initialization

---

## Claude's Discretion

- Snapshot event count N value (b05bec2 used 100)
- gzip rotation file size threshold
- IPC mixed protocol frame boundary design
- xterm.js unicode11 addon for CJK
- /pty-test page layout details

## Deferred Ideas

- relay fully stateless extension (JSON recovery from proxy too)
- Client-driven PTY resize
- Automatic EventStore data cleanup
