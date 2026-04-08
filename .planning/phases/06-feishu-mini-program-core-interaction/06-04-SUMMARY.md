---
phase: 06-feishu-mini-program-core-interaction
plan: 04
subsystem: proxy
tags: [command-discovery, file-watcher, directory-lister, slash-commands, fs-watch]

requires:
  - phase: 06
    plan: 01
    provides: RelayControlSchema with dir_list_request/response, command_list_push, file_tree_push
provides:
  - discoverCommands(workDir) scans REPL builtins, user/project skills and commands, plugins, with blacklist filtering
  - FileWatcher class with recursive fs.watch, blacklist exclusion, per-directory throttle
  - listDirectory(path) returns sorted DirEntry[] with directories-first ordering
  - parseSkillFrontmatter extracts name/description/argument-hint from SKILL.md YAML
  - isBlacklistedPath utility for path segment checking
affects: [06-05]

tech-stack:
  added: []
  patterns: [lazy expansion file watching, YAML frontmatter regex parsing without library dependency]

key-files:
  created:
    - apps/proxy/src/command-discovery.ts
    - apps/proxy/src/file-watcher.ts
    - apps/proxy/src/dir-lister.ts
    - apps/proxy/src/__tests__/command-discovery.test.ts
    - apps/proxy/src/__tests__/file-watcher.test.ts
  modified: []

key-decisions:
  - "FileWatcher uses single recursive fs.watch instead of per-directory watchers, relying on macOS FSEvents reliability"
  - "Command discovery uses simple regex for YAML frontmatter parsing instead of adding a YAML library dependency"
  - "Blacklist filtering applied at both event reception and directory listing levels for defense in depth"

patterns-established:
  - "WATCH_BLACKLIST shared between FileWatcher and listDirectory via dir-lister.ts export"
  - "Command priority: project overrides user overrides plugin overrides builtin"

requirements-completed: [FEISHU-03]

duration: 5min
completed: 2026-04-08
---

# Phase 6 Plan 04: Command Discovery, File Watcher, Directory Lister Summary

**Proxy modules for dynamic slash command discovery from skills/commands/plugins, recursive file monitoring with throttled updates, and sorted directory listing with blacklist filtering**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-08T12:55:58Z
- **Completed:** 2026-04-08T13:01:30Z
- **Tasks:** 2
- **Files created:** 5

## Task Completion

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Command discovery module (D-28) | c4fc43d | command-discovery.ts, command-discovery.test.ts |
| 2 | File watcher and directory lister (D-29, D-21) | 0a4d661 | file-watcher.ts, dir-lister.ts, file-watcher.test.ts |

## Implementation Details

### Task 1: Command Discovery

- `discoverCommands(workDir, options?)` scans 6 sources: REPL builtins, user skills, project skills, user commands, project commands, plugin skills/commands
- 18 REPL builtins defined (compact, status, cost, clear, model, help, memory, review, vim, terminal-setup, permissions, allowed-tools, add-dir, init, listen, pr-comments, release-notes, ide)
- 10 blacklisted commands filtered: login, logout, config, plugin, mcp, install, setup-token, doctor, update, upgrade
- `parseSkillFrontmatter` extracts name/description/argument-hint via regex without YAML library
- Deduplication: project-level overrides user-level overrides plugin overrides builtin
- Graceful handling of missing directories via try/catch

### Task 2: File Watcher and Directory Lister

- `FileWatcher` uses single `fs.watch({ recursive: true })` for macOS FSEvents
- Events throttled per directory (default 2s), blacklisted paths ignored at event level
- `getInitialTree(depth)` returns `Map<string, DirEntry[]>` for lazy expansion
- `listDirectory` returns sorted entries (dirs first, files second, alphabetical within groups)
- `isBlacklistedPath` checks all path segments against WATCH_BLACKLIST
- WATCH_BLACKLIST: node_modules, .git, dist, build, .next, .nuxt, __pycache__, .venv, .tox, target, .gradle

## Test Coverage

- **command-discovery.test.ts:** 10 tests (builtins, user skills, project skills, user commands, project commands, blacklist filtering, missing dirs, frontmatter parsing x3)
- **file-watcher.test.ts:** 11 tests (file creation event, blacklist filtering, throttle, initial tree, stop cleanup, listDirectory entries, non-existent path, sorting, blacklist in listing, isBlacklistedPath x2)
- **Total:** 21 tests, all passing

## Deviations from Plan

### Review Feedback Applied

**1. [Review] Lazy expansion instead of watching entire tree**
- **Source:** Cross-AI review feedback
- **Change:** FileWatcher uses `getInitialTree(depth=2)` for initial scope instead of eagerly walking entire directory tree. fs.watch recursive still covers the full tree for change detection, but directory listing is lazy.
- **Impact:** More resource-efficient for large projects

### Auto-fixed Issues

None -- plan executed as written with review feedback incorporated.

## Threat Model Verification

- T-06-11 (DoS via recursive fs.watch): Mitigated by WATCH_BLACKLIST excluding node_modules, .git, dist, etc. and per-directory throttling
- T-06-10 (path traversal): listDirectory itself does not validate paths; validation deferred to Plan 05 serve.ts wiring as specified in threat model
- T-06-12 (SKILL.md content leak): Accepted; only name/description/hint exposed

## Self-Check: PASSED

- FOUND: apps/proxy/src/command-discovery.ts
- FOUND: apps/proxy/src/file-watcher.ts
- FOUND: apps/proxy/src/dir-lister.ts
- FOUND: apps/proxy/src/__tests__/command-discovery.test.ts
- FOUND: apps/proxy/src/__tests__/file-watcher.test.ts
- FOUND: commit c4fc43d
- FOUND: commit 0a4d661
