# Script Guide

This repository keeps scripts only when they are part of the public development, verification, or release workflow.

## User-Facing Commands

These commands come from the published `@dev-anywhere/proxy` package:

| Command                                                  | Purpose                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `dev-anywhere init`                                      | Create `~/.dev-anywhere/config.json`.                        |
| `dev-anywhere serve start`                               | Start the selected proxy profile with its configured relay.  |
| `dev-anywhere serve start --relay cloud`                 | Start the current proxy profile against a named relay.       |
| `dev-anywhere --profile local serve start --relay local` | Start an isolated `local` proxy profile against local relay. |
| `dev-anywhere serve status`                              | Show daemon and relay connection status.                     |
| `dev-anywhere --profile local serve status`              | Show status for another local proxy profile.                 |
| `dev-anywhere serve restart --relay cloud`               | Restart the current profile and switch relay.                |
| `dev-anywhere serve stop`                                | Stop the current proxy profile.                              |
| `dev-anywhere claude [...args]`                          | Start or attach a Claude Code terminal session.              |
| `dev-anywhere --profile local claude [...args]`          | Start or attach Claude Code through the `local` profile.     |
| `dev-anywhere codex [...args]`                           | Start or attach a Codex terminal session.                    |

Arguments after `claude` or `codex` are passed to the real CLI:

```bash
dev-anywhere claude -c
dev-anywhere codex --model gpt-5.5
```

## Deployment

| Script                          | Purpose                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/install-relay.sh`      | Deploy relay + web to a VPS from published Docker images. Uses host nginx for public `80/443` and loopback Docker ports for DEV Anywhere. Supports local `--ssh` mode and direct VPS mode. |
| `scripts/check-prerequisite.sh` | Read-only VPS preflight before running `install-relay.sh`: SSH, sudo, Docker, nginx, DNS, and public `80/443` reachability.                                                                |

Production deployment should use `install-relay.sh`. It creates or reuses both `RELAY_PROXY_TOKEN` and `RELAY_CLIENT_TOKEN`.

## Contributor Development

Configuration sources are intentionally split:

| Source                        | Owns                                                                                        | Normal usage                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `~/.dev-anywhere/config.json` | Long-lived profiles and relay targets such as `local` and `cloud`, plus optional CLI paths. | Edit after `dev-anywhere init`.                                   |
| CLI arguments                 | The current command's `--profile`, `--relay`, `--port`, or `--target`.                      | Prefer this for day-to-day development.                           |
| Environment variables         | CI and temporary overrides.                                                                 | Advanced use only; public docs should prefer commands and config. |

| Command                                                                            | Purpose                                                                                                                          |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:web -- --relay cloud --port 5174`                                        | Start local Vite and proxy `/client`, `/health`, `/auth`, and font requests to the configured cloud relay. Does not touch proxy. |
| `pnpm dev:web -- --relay local --port 5173`                                        | Start local Vite against the configured local relay. Does not touch proxy.                                                       |
| `pnpm dev:restart`                                                                 | Restart the full local development loop: shared package, relay, web, and a `local` proxy profile.                                |
| `pnpm dev:restart -- --profile qa --relay local --web-port 5175 --relay-port 3101` | Restart the local loop with explicit profile, relay, and ports.                                                                  |
| `pnpm dev:health`                                                                  | Read-only health check for local ports, relay HTTP, proxy status, and recent logs in the `local` proxy profile.                  |
| `pnpm dev:health -- --profile qa --web-port 5175 --relay-port 3101`                | Run health checks against an explicit local profile and ports.                                                                   |
| `pnpm dev:relay:restart -- --relay-port 3101`                                      | Restart only a local relay port. This keeps web and proxy alive so reconnect behavior can be tested.                             |
| `pnpm proxy -- claude`                                                             | Run the default proxy profile command and attach Claude Code.                                                                    |
| `pnpm proxy -- codex`                                                              | Run the default proxy profile command and attach Codex.                                                                          |

Proxy profiles isolate local daemon state. `default` keeps the historical paths under `~/.dev-anywhere/`, while non-default profiles use `~/.dev-anywhere/profiles/<name>/` for socket, PID, sessions, fallback clipboard files, logs, and proxy ID. Clipboard images are saved under the active session working directory when possible. Use `dev-anywhere --profile local claude` or `dev-anywhere --profile local serve status` when working against the local relay without disturbing a cloud-connected proxy.

Agent CLI paths can be overridden:

| Environment variable | Purpose                          |
| -------------------- | -------------------------------- |
| `CLAUDE_BIN`         | Override the Claude Code binary. |
| `CODEX_BIN`          | Override the Codex binary.       |

## Verification

| Command                                                                               | Purpose                                                                                                              |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                   | Check formatting with Prettier.                                                                                      |
| `pnpm lint`                                                                           | Run ESLint and source-comment reference checks.                                                                      |
| `pnpm typecheck`                                                                      | Run TypeScript build-mode checks.                                                                                    |
| `pnpm test`                                                                           | Run the Vitest suite.                                                                                                |
| `pnpm knip`                                                                           | Check unused dependencies, exports, and entry points.                                                                |
| `pnpm release:check`                                                                  | Build release artifacts, inspect npm package contents, and smoke-test the installed command with an isolated `HOME`. |
| `pnpm release:smoke`                                                                  | Run desktop, mobile, PTY, clipboard, and chaos smoke gates against the explicit `local` profile.                     |
| `pnpm test:unit`                                                                      | Tier 1 — Vitest across workspaces.                                                                                   |
| `pnpm test:layout`                                                                    | Tier 2 — Playwright viewport (mobile/desktop layout contracts).                                                      |
| `pnpm test:pc`                                                                        | Tier 3 — Playwright real desktop Chromium (PC interaction).                                                          |
| `pnpm test:mobile`                                                                    | Tier 4 — Android emulator + Chrome CDP. Skips with exit 0 if no emu online.                                          |
| `WEB_BASE_URL=http://127.0.0.1:5175 bash scripts/test-pc.sh e2e/pc/pty-input.spec.ts` | Run selected Playwright specs against an explicit Web URL.                                                           |

测试分层和 fixture 选型的完整说明见 [docs/TESTING.md](./TESTING.md)。

## Advanced Diagnostics

| Command                                                                                                                                                | Purpose                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev:chaos`                                                                                                                                       | Run relay, proxy, web, PTY, JSON-mode, and reconnect failure-injection scenarios.                                              |
| `pnpm dev:chaos -- --profile qa --relay local --relay-port 3101 --web-port 5175 --base-url http://localhost:5175 --workdir /tmp/dev-anywhere-chaos-qa` | Run chaos against an explicit local profile and ports.                                                                         |
| `RELAY_PROXY_TOKEN=... RELAY_CLIENT_TOKEN=... pnpm --filter @dev-anywhere/relay exec tsx scripts/verify-relay.ts wss://dev-anywhere.example.com`       | Verify a deployed relay's health, registration, proxy listing, proxy selection, and bidirectional routing.                     |
| `pnpm --filter @dev-anywhere/proxy run sample:stream-json`                                                                                             | Sample Claude stream-json output and refresh schema-drift fixtures. Requires a locally installed and authenticated Claude CLI. |
| `node scripts/emu-debug.mjs <command>`                                                                                                                 | Android emulator + Chrome CDP helper for mobile debugging: tab list, navigation, screenshot, console, PTY metrics, and trace.  |

`pnpm dev:chaos` is intended for contributors working on reconnect, session lifecycle, PTY recovery, or JSON-mode behavior. By default it writes temporary chaos workspaces under `${TMPDIR:-/tmp}/dev-anywhere-chaos`; pass `--workdir` to isolate a run. Relay chaos tuning is also parameterized through flags such as `--relay-chaos-types`, `--relay-chaos-delay-ms`, `--relay-chaos-duplicate`, and `--relay-chaos-reorder`.
