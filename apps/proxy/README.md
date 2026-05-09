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

You need a relay server reachable from both your local machine and your mobile/web client. Deploy your own with [`@dev-anywhere/relay`](https://www.npmjs.com/package/@dev-anywhere/relay):

```bash
# On any VPS with ports 80/443 reachable:
npm install -g @dev-anywhere/relay
PORT=3100 dev-anywhere-relay
```

For a turnkey setup with TLS and nginx, see the `install-relay.sh` script in the [repo](https://github.com/lichenxicatapple-blip/dev-anywhere).

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
  },
  "previewRoots": []
}
```

The hosted relay rejects proxy connections without the `RELAY_PROXY_TOKEN`. Fill
`relays.cloud.proxyToken` from the relay server's `.env` before switching to
cloud. If the relay also sets `RELAY_CLIENT_TOKEN`, open the web app once with
`?relayToken=<RELAY_CLIENT_TOKEN>` so the browser client can authenticate.

`dev-anywhere serve start --relay cloud` and `dev-anywhere serve restart --relay cloud` use a named relay without editing the file each time.

Image preview is allowed for explicit image paths under the active session working directory and the OS temp directory. Add absolute paths to `previewRoots` if you want the web client to preview images from other folders. Directory listing is never exposed.

Environment variables are reserved for temporary overrides:

- `RELAY_URL` — relay WebSocket URL
- `RELAY_PROXY_TOKEN` — auth token
- `CLAUDE_BIN` — Claude Code CLI path
- `CODEX_BIN` — Codex CLI path

## How it works

- Local daemon wraps Claude Code and Codex CLI sessions with `node-pty` for transparent terminal control. Claude Code also supports a structured chat-message mode.
- IPC socket at `~/.dev-anywhere/run/dev-anywhere.sock` for terminal attachment.
- Terminal bytes + structured control messages are forwarded to relay over WebSocket.
- Relay is a pure passthrough; state lives on the proxy side.

## License

MIT © catli
