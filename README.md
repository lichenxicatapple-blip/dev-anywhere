# DEV Anywhere

Run AI coding CLI sessions on your own machine and control them from a browser or mobile PWA.

DEV Anywhere is for developers who want remote access to local Claude Code or Codex sessions without moving their source code, shell environment, or credentials onto a remote server. Your laptop keeps ownership of the terminal process; a relay only forwards WebSocket traffic between the local proxy and the web client.

```text
Browser / PWA  <->  Relay Server  <->  Local Proxy  <->  Claude Code / Codex
```

## What You Get

- Local Claude Code and Codex sessions exposed through a remote web UI.
- PTY-based terminal control for interactive CLI workflows.
- Session list, history, reconnect recovery, and mobile-friendly layouts.
- Self-hostable relay with optional proxy/client token authentication.
- npm packages for the proxy and relay, plus Docker images for hosted deployments.

## Packages

| Package | Purpose |
| --- | --- |
| `@dev-anywhere/proxy` | Local daemon and CLI wrapper for Claude Code and Codex sessions. |
| `@dev-anywhere/relay` | WebSocket relay server for proxy and web clients. |
| `@dev-anywhere/web` | Browser/PWA client served as a Docker image. |

## Install the Local Proxy

Install the local proxy:

```bash
npm install -g @dev-anywhere/proxy
dev-anywhere init
dev-anywhere serve start
```

Start or attach a local AI CLI session:

```bash
dev-anywhere claude
dev-anywhere codex
```

## Run a Relay

For local development:

```bash
npm install -g @dev-anywhere/relay
RELAY_PROXY_TOKEN="$(openssl rand -hex 24)" \
RELAY_CLIENT_TOKEN="$(openssl rand -hex 24)" \
PORT=3100 dev-anywhere-relay
```

For production, put the relay behind TLS and set both relay tokens. See [Publishing](PUBLISHING.md) for the hosted Docker workflow.

## How It Works

1. `dev-anywhere serve start` launches a local daemon.
2. `dev-anywhere claude` or `dev-anywhere codex` starts a local AI CLI session under the proxy.
3. The proxy streams terminal bytes and structured control events to the relay.
4. The web client connects to the relay, selects a proxy, and drives the session remotely.

The relay does not need repository access. It routes authenticated proxy/client traffic and keeps the session runtime on the developer machine.

## Repository Layout

```text
apps/proxy      Local CLI proxy and session runtime
apps/relay      WebSocket relay service
apps/web        React web/PWA client
packages/shared Shared protocol schemas and utilities
docs            Architecture, release, and smoke-test documentation
scripts         Development, verification, and deployment helpers
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm release:check
```

Use `pnpm dev:restart` and `pnpm dev:health` when working on the full local proxy/relay/web loop.

## Security

Public relay deployments must set both `RELAY_PROXY_TOKEN` and `RELAY_CLIENT_TOKEN`. An unauthenticated relay is suitable only for local development.

Do not expose a relay publicly without TLS and tokens. Anyone who can reach an unauthenticated relay can attempt to discover or bind to connected proxies.

## Documentation

- [Proxy README](apps/proxy/README.md)
- [Relay README](apps/relay/README.md)
- [Publishing](PUBLISHING.md)
- [Script guide](docs/SCRIPTS.md)

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
