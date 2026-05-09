# Script Guide

This repository keeps scripts only when they are part of the public development, verification, or release workflow.

## User-Facing Commands

These commands come from the published `@dev-anywhere/proxy` package:

| Command                                  | Purpose                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| `dev-anywhere init`                      | Create `~/.dev-anywhere/config.json`.                  |
| `dev-anywhere serve start`               | Start the local proxy daemon with `defaultEnv`.        |
| `dev-anywhere serve start --env cloud`   | Start the local proxy daemon with a named environment. |
| `dev-anywhere serve status`              | Show daemon and relay connection status.               |
| `dev-anywhere serve restart --env cloud` | Restart the daemon and switch environments.            |
| `dev-anywhere serve stop`                | Stop the local proxy daemon.                           |
| `dev-anywhere claude [...args]`          | Start or attach a Claude Code terminal session.        |
| `dev-anywhere codex [...args]`           | Start or attach a Codex terminal session.              |

Arguments after `claude` or `codex` are passed to the real CLI:

```bash
dev-anywhere claude -c
dev-anywhere codex --model gpt-5.5
```

## Deployment

| Script                     | Purpose                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `scripts/install-relay.sh` | Deploy relay + web to a VPS from published Docker images. Supports local `--ssh` mode and direct VPS mode. |

Production deployment should use `install-relay.sh`. It creates or reuses both `RELAY_PROXY_TOKEN` and `RELAY_CLIENT_TOKEN`.

## Contributor Development

| Command                  | Purpose                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `pnpm dev:restart`       | Restart the local development loop: shared package, relay, web, and proxy daemon.                 |
| `pnpm dev:health`        | Read-only health check for local ports, relay HTTP, proxy status, and recent logs.                |
| `pnpm dev:relay:restart` | Restart only the local relay. This keeps web and proxy alive so reconnect behavior can be tested. |
| `pnpm proxy -- claude`   | Run the development proxy command and attach Claude Code.                                         |
| `pnpm proxy -- codex`    | Run the development proxy command and attach Codex.                                               |

Agent CLI paths can be overridden:

| Environment variable | Purpose                          |
| -------------------- | -------------------------------- |
| `CLAUDE_BIN`         | Override the Claude Code binary. |
| `CODEX_BIN`          | Override the Codex binary.       |

## Verification

| Command                       | Purpose                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`           | Check formatting with Prettier.                                                                                      |
| `pnpm lint`                   | Run ESLint and source-comment reference checks.                                                                      |
| `pnpm typecheck`              | Run TypeScript build-mode checks.                                                                                    |
| `pnpm test`                   | Run the Vitest suite.                                                                                                |
| `pnpm knip`                   | Check unused dependencies, exports, and entry points.                                                                |
| `pnpm release:check`          | Build release artifacts, inspect npm package contents, and smoke-test the installed command with an isolated `HOME`. |
| `pnpm release:smoke`          | Run desktop, mobile, PTY, clipboard, and chaos smoke gates while restoring the previous proxy env afterward.         |
| `pnpm desktop:smoke`          | Run the local desktop Playwright guard.                                                                              |
| `pnpm mobile:smoke`           | Run mobile layout contracts and local relay/proxy smoke checks.                                                      |
| `pnpm mobile:smoke:full`      | Include real session creation/termination in the mobile smoke.                                                       |
| `pnpm mobile:smoke:simulator` | Capture iOS Simulator Safari screenshots after the mobile smoke.                                                     |

## Advanced Diagnostics

| Command                                                                                                                                          | Purpose                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev:chaos`                                                                                                                                 | Run relay, proxy, web, PTY, JSON-mode, and reconnect failure-injection scenarios.                                              |
| `scripts/with-proxy-env.sh local -- <command>`                                                                                                   | Temporarily run a command with the proxy on a named env, then restore the previous daemon env or stopped state.                |
| `RELAY_PROXY_TOKEN=... RELAY_CLIENT_TOKEN=... pnpm --filter @dev-anywhere/relay exec tsx scripts/verify-relay.ts wss://dev-anywhere.example.com` | Verify a deployed relay's health, registration, proxy listing, proxy selection, and bidirectional routing.                     |
| `pnpm --filter @dev-anywhere/proxy run sample:stream-json`                                                                                       | Sample Claude stream-json output and refresh schema-drift fixtures. Requires a locally installed and authenticated Claude CLI. |

`pnpm dev:chaos` is intended for contributors working on reconnect, session lifecycle, PTY recovery, or JSON-mode behavior. By default it writes temporary chaos workspaces under `${TMPDIR:-/tmp}/dev-anywhere-chaos`; set `DEV_ANYWHERE_CHAOS_WORKDIR` or the more specific `DEV_ANYWHERE_*_CHAOS_CWD` variables to override.
