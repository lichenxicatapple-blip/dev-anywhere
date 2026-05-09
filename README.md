<p align="center">
  <img src="docs/assets/logo.svg" width="88" height="88" alt="DEV Anywhere logo" />
</p>

<h1 align="center">DEV Anywhere</h1>

<p align="center">
  <strong>Run Claude Code or Codex locally. Control the session from desktop, iPad, iPhone, or any browser.</strong>
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node.js >= 20" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
  <img src="https://img.shields.io/npm/v/@dev-anywhere/proxy?label=proxy" alt="@dev-anywhere/proxy on npm" />
  <img src="https://img.shields.io/npm/v/@dev-anywhere/relay?label=relay" alt="@dev-anywhere/relay on npm" />
</p>

<p align="center">
  <img src="docs/assets/hero.png" alt="DEV Anywhere running across desktop, iPad, and iPhone" />
</p>

DEV Anywhere gives you remote access to local AI coding CLI sessions without moving your repository, shell environment, or credentials onto a remote app server. Your developer machine keeps ownership of Claude Code or Codex. The relay only forwards authenticated WebSocket traffic between the local proxy and your devices.

```text
Desktop / iPad / iPhone / Browser
        <-> Relay Server
        <-> Local Proxy
        <-> Claude Code / Codex
```

## Highlights

- Control local Claude Code and Codex sessions from a responsive web/PWA client.
- Use PTY terminal mode for interactive CLI workflows and JSON mode for structured chat.
- Resume sessions with history, reconnect recovery, mobile layouts, and tool approvals.
- Self-host the relay with token authentication and TLS in front.
- Install the proxy and relay from npm, or publish the web/relay Docker images from the release workflow.

## Screenshots

<p>
  <img src="docs/assets/demo.gif" alt="DEV Anywhere demo animation" width="640" />
</p>

<p>
  <img src="docs/assets/json-mode.png" alt="DEV Anywhere JSON mode" />
</p>

<p>
  <img src="docs/assets/mobile.png" alt="DEV Anywhere mobile view" width="320" />
</p>

## Quick Start: Hosted Relay + Local Proxy

1. Deploy the relay and web client to a VPS:

```bash
IMAGE_TAG=0.1.0 ./scripts/install-relay.sh --ssh ubuntu@dev-anywhere.example.com dev-anywhere.example.com
```

The installer prints a `RELAY_PROXY_TOKEN`, a `RELAY_CLIENT_TOKEN`, and a Web UI URL.

2. Install and initialize the local proxy on your developer machine:

```bash
npm install -g @dev-anywhere/proxy
dev-anywhere init
```

Edit `~/.dev-anywhere/config.json`:

```json
{
  "defaultEnv": "cloud",
  "envs": {
    "cloud": {
      "relayUrl": "wss://dev-anywhere.example.com",
      "relayToken": "<RELAY_PROXY_TOKEN>"
    }
  }
}
```

3. Start the local daemon and attach an AI CLI session:

```bash
dev-anywhere serve start --env cloud
dev-anywhere claude
dev-anywhere codex
```

4. Open the Web UI URL printed by the installer:

```text
https://dev-anywhere.example.com/?relayToken=<RELAY_CLIENT_TOKEN>
```

Choose your developer machine, create or resume a session, and install the page as a PWA on iPhone or iPad if you want a home-screen app.

See the full [Deployment Guide](docs/DEPLOYMENT.md) for VPS preparation, upgrades, health checks, and token rotation. See [Install the PWA](docs/PWA.md) for iPhone, iPad, and desktop installation steps.

## Local Development Relay

If you only need a standalone relay for local testing, install the relay package directly:

```bash
npm install -g @dev-anywhere/relay
RELAY_PROXY_TOKEN="$(openssl rand -hex 24)" \
RELAY_CLIENT_TOKEN="$(openssl rand -hex 24)" \
PORT=3100 dev-anywhere-relay
```

The npm relay package does not serve the production web client by itself. For a complete hosted web/PWA deployment, use the Docker-based installer above.

## Daily Use

1. Keep `dev-anywhere serve start --env cloud` running on the developer machine.
2. Start sessions from the repository you want to work on with `dev-anywhere claude` or `dev-anywhere codex`.
3. Open the web client on desktop, iPad, or iPhone.
4. Select the machine, resume a session, approve tools, and follow terminal or JSON-mode output.
5. Stop the local daemon with `dev-anywhere serve stop` when you no longer want the machine reachable through the relay.

## Packages

| Package               | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `@dev-anywhere/proxy` | Local daemon and CLI wrapper for Claude Code and Codex sessions. |
| `@dev-anywhere/relay` | WebSocket relay server for proxy and web clients.                |
| `@dev-anywhere/web`   | Browser/PWA client served as a Docker image.                     |

## Security Model

- The relay does not need repository access and does not run the AI CLI.
- CLI processes, shell state, local paths, and credentials stay on the developer machine.
- Public relay deployments must set `RELAY_PROXY_TOKEN`, `RELAY_CLIENT_TOKEN`, and TLS.
- Tool approvals are surfaced in the client before scoped local commands run.

An unauthenticated relay is suitable only for local development. Anyone who can reach an unauthenticated relay can attempt to discover or bind to connected proxies.

## Repository Layout

```text
apps/proxy      Local CLI proxy and session runtime
apps/relay      WebSocket relay service
apps/web        React web/PWA client
packages/shared Shared protocol schemas and utilities
docs            Public documentation and README assets
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

## Documentation

- [Proxy README](apps/proxy/README.md)
- [Relay README](apps/relay/README.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [PWA install guide](docs/PWA.md)
- [Publishing](PUBLISHING.md)
- [Script guide](docs/SCRIPTS.md)
- [Changelog](CHANGELOG.md)

## License

MIT
