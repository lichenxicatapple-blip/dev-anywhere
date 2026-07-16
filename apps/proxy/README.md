# DEV Anywhere

Transparent local proxy for AI coding CLIs that bridges local sessions to a mobile/web SPA via a relay server.

## Install

```bash
npm install -g @dev-anywhere/proxy
```

This installs the `dev-anywhere` command globally.

Requires Node.js >= 20 and at least one supported local AI coding CLI installed locally: Claude Code or Codex.

## Quick start

```bash
# 1. Initialize workspace (creates ~/.dev-anywhere/config.json)
dev-anywhere init

# 2. Edit ~/.dev-anywhere/config.json:
#   set relays.cloud.proxyToken when your cloud relay requires auth

# 3. Start background daemon
dev-anywhere serve start

# Or switch relay target while restarting the daemon
dev-anywhere serve restart --relay cloud

# 4. Start or attach a terminal session from any directory
dev-anywhere claude
dev-anywhere codex

# 5. Open the web SPA served by your relay, pick your computer, create or resume a session
```

## Commands

```
dev-anywhere serve start      # start background daemon
dev-anywhere serve stop       # stop daemon
dev-anywhere serve restart    # restart daemon using the selected profile's relay
dev-anywhere serve restart --relay cloud
dev-anywhere serve status     # show daemon status
dev-anywhere init             # create default config at ~/.dev-anywhere/config.json
dev-anywhere tunnel           # temporary account-free Cloudflare Quick Tunnel
dev-anywhere claude [...args] # start/attach a Claude Code terminal session
dev-anywhere codex [...args]  # start/attach a Codex terminal session
dev-anywhere --help
```

The daemon connects to the relay server over WebSocket and manages local AI CLI sessions. A mobile/web client connected to the same relay can then see and drive those sessions.

Arguments after `claude` or `codex` are passed through to the real CLI:

```bash
dev-anywhere claude -c
dev-anywhere codex --model gpt-5.5
```

## Relay server

For a temporary evaluation without a VPS, install `cloudflared` and run:

```bash
dev-anywhere tunnel
```

The command starts an isolated local Relay, Web client, and Proxy profile, then prints a random `trycloudflare.com` URL. Keep it running while testing. Quick Tunnels are not intended for production.

For regular use, deploy a Relay reachable from both your local machine and your mobile/web client:

```bash
# On any VPS with ports 80/443 reachable:
npm install -g @dev-anywhere/relay
PORT=3100 dev-anywhere-relay
```

The Relay package includes the Web client. For a turnkey VPS setup with TLS and nginx, see the `install-relay.sh` script in the [repo](https://github.com/lichenxicatapple-blip/dev-anywhere).

## Configuration

Config file: `~/.dev-anywhere/config.json`

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "relay": "cloud"
    },
    "local": {
      "relay": "local"
    }
  },
  "relays": {
    "cloud": {
      "url": "wss://dev-anywhere.example.com",
      "proxyToken": ""
    },
    "local": {
      "url": "ws://localhost:3100"
    }
  }
}
```

The hosted relay rejects proxy connections without the `RELAY_PROXY_TOKEN`. Fill
`relays.cloud.proxyToken` from the relay server's `.env` before switching to
cloud. If the relay also sets `RELAY_CLIENT_TOKEN`, open the web app and paste
that value in Settings -> Relay Token so the browser client can authenticate.

`dev-anywhere serve start --relay cloud` and `dev-anywhere serve restart --relay cloud` use a named relay without editing the file each time.

Environment variables are reserved for temporary overrides:

- `RELAY_URL` — relay WebSocket URL
- `RELAY_PROXY_TOKEN` — auth token
- `CLAUDE_BIN` — Claude Code CLI path
- `CODEX_BIN` — Codex CLI path

## How it works

- Local daemon wraps Claude Code and Codex CLI sessions with `node-pty` for transparent terminal control. Claude Code also supports a structured chat-message mode.
- IPC socket at `~/.dev-anywhere/run/dev-anywhere.sock` for terminal attachment.
- Terminal bytes + structured control messages are forwarded to relay over WebSocket.
- Relay serves the Web client and routes live traffic; session state remains on the proxy side.

## License

MIT © catli
