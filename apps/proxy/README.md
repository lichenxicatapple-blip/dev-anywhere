# dev-anywhere

Transparent local proxy for AI coding CLIs that bridges local sessions to a mobile/web SPA via a relay server.

## Install

```bash
npm install -g @dev-anywhere/proxy
```

This installs the `dev-anywhere` command globally.

Requires Node.js >= 20 and a supported local AI coding CLI installed locally. The first supported provider is Claude Code; Codex support is part of the provider-adapter workstream.

## Quick start

```bash
# 1. Initialize workspace (creates ~/.dev-anywhere/config.json)
dev-anywhere init

# 2. Edit ~/.dev-anywhere/config.json:
#   { "relayUrl": "wss://your-relay.example.com", "relayToken": "<token>" }

# 3. Start background daemon
dev-anywhere serve start

# 4. Open the web SPA served by your relay, pick your proxy, create a session
```

## Commands

```
dev-anywhere serve start      # start background daemon
dev-anywhere serve stop       # stop daemon
dev-anywhere serve restart    # restart daemon
dev-anywhere serve status     # show daemon status
dev-anywhere init             # create default config at ~/.dev-anywhere/config.json
dev-anywhere --help
```

The daemon connects to the relay server over WebSocket and manages local AI CLI sessions. A mobile/web client connected to the same relay can then see and drive those sessions.

## Relay server

You need a relay server reachable from both your local machine and your mobile/web client. Deploy your own with [`@dev-anywhere/relay`](https://www.npmjs.com/package/@dev-anywhere/relay):

```bash
# On any VPS with ports 80/443 reachable:
npm install -g @dev-anywhere/relay
dev-anywhere-relay --port 3100
```

For a turnkey setup with TLS and nginx, see the `install-relay.sh` script in the [repo](https://github.com/lichenxicatapple-blip/dev-anywhere).

## Configuration

Config file: `~/.dev-anywhere/config.json`

```json
{
  "relayUrl": "wss://your-relay.example.com",
  "relayToken": "<token from relay RELAY_PROXY_TOKEN env>"
}
```

Environment variables override config:

- `RELAY_URL` — relay WebSocket URL
- `RELAY_PROXY_TOKEN` — auth token

## How it works

- Local daemon wraps Claude Code CLI with `node-pty` (transparent terminal) and/or `claude --output-format stream-json --input-format stream-json` (programmatic control).
- IPC socket at `~/.dev-anywhere/run/dev-anywhere.sock` for terminal attachment.
- Binary PTY frames + structured control messages forwarded to relay over WebSocket.
- Relay is a pure passthrough; state lives on the proxy side.

## License

MIT © catli
