# cc-anywhere

Transparent local proxy for Claude Code that bridges sessions to a mobile/web SPA via a relay server — interact with your Claude Code sessions from anywhere.

## Install

```bash
npm install -g @lichenxi.cat/cc-anywhere
```

This installs the `cc-anywhere` command globally.

Requires Node.js >= 20 and [Claude Code CLI](https://code.claude.com/) installed locally.

## Quick start

```bash
# 1. Initialize workspace (creates ~/.cc-anywhere/config.json)
cc-anywhere init

# 2. Edit ~/.cc-anywhere/config.json:
#   { "relayUrl": "wss://your-relay.example.com", "relayToken": "<token>" }

# 3. Start background daemon
cc-anywhere serve start

# 4. Open the web SPA served by your relay, pick your proxy, create a session
```

## Commands

```
cc-anywhere serve start      # start background daemon
cc-anywhere serve stop       # stop daemon
cc-anywhere serve restart    # restart daemon
cc-anywhere serve status     # show daemon status
cc-anywhere init             # create default config at ~/.cc-anywhere/config.json
cc-anywhere --help
```

The daemon connects to the relay server over WebSocket and manages local Claude Code CLI sessions (both PTY and `stream-json` modes). A mobile/web client connected to the same relay can then see and drive those sessions.

## Relay server

You need a relay server reachable from both your local machine and your mobile/web client. Deploy your own with [`@lichenxi.cat/cc-anywhere-relay`](https://www.npmjs.com/package/@lichenxi.cat/cc-anywhere-relay):

```bash
# On any VPS with ports 80/443 reachable:
npm install -g @lichenxi.cat/cc-anywhere-relay
cc-anywhere-relay --port 3100
```

For a turnkey setup with TLS and nginx, see the `install-relay.sh` script in the [repo](https://github.com/lichenxicatapple-blip/cc-anywhere).

## Configuration

Config file: `~/.cc-anywhere/config.json`

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
- IPC socket at `~/.cc-anywhere/run/cc-anywhere.sock` for terminal attachment.
- Binary PTY frames + structured control messages forwarded to relay over WebSocket.
- Relay is a pure passthrough; state lives on the proxy side.

## License

MIT © catli
