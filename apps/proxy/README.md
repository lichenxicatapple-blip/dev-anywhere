# DEV Anywhere

Transparent local proxy for AI coding CLIs that bridges local sessions to a mobile/web SPA via a relay server.

## Install

```bash
npm install -g @dev-anywhere/proxy
```

This installs the `dev-anywhere` command globally.

Supported development machines: macOS, Linux, and native Windows 11. WSL is not required on Windows.

Requires Node.js >= 20 and at least one supported local AI coding CLI installed locally: Claude Code, Codex, or Kimi Code.

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
dev-anywhere kimi

# 5. Open the web SPA served by your relay, pick your computer, create or resume a session
```

## Commands

```
dev-anywhere serve start      # start background daemon
dev-anywhere serve stop       # stop daemon
dev-anywhere serve restart    # restart daemon using the selected profile's relay
dev-anywhere serve restart --relay cloud
dev-anywhere serve status     # show daemon status
dev-anywhere serve autostart enable  # start automatically at user login
dev-anywhere serve autostart disable # cancel automatic startup
dev-anywhere serve autostart status  # show automatic startup setting
dev-anywhere init             # create default config at ~/.dev-anywhere/config.json
dev-anywhere tunnel           # temporary account-free Cloudflare Quick Tunnel
dev-anywhere claude [...args] # start/attach a Claude Code terminal session
dev-anywhere codex [...args]  # start/attach a Codex terminal session
dev-anywhere kimi [...args]   # start/attach a Kimi Code terminal session
dev-anywhere --help
```

The daemon connects to the relay server over WebSocket and manages local AI CLI sessions. A mobile/web client connected to the same relay can then see and drive those sessions.

Autostart is optional and applies to the selected profile. Enabling or disabling it does not start, restart, or stop the current Proxy. It is available on macOS, Linux with systemd user services, and Windows for the current user.

Arguments after `claude`, `codex`, or `kimi` are passed through to the real CLI:

```bash
dev-anywhere claude -c
dev-anywhere codex --model gpt-5.5
dev-anywhere kimi --auto
```

Kimi Code supports both terminal sessions and structured ACP chat. You can start
a terminal with `dev-anywhere kimi ...`, create either mode from the Web UI, and
resume Kimi sessions from the historical session list.

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

Config file: `~/.dev-anywhere/config.json` (`%USERPROFILE%\.dev-anywhere\config.json` on Windows).

```json
{
  "defaultProfile": "default",
  "autoUpdate": true,
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

`autoUpdate` defaults to `true` and runs after this machine connects to the Relay. Set `autoUpdate` to `false` and restart the service to keep the installed version.

The first upgrade from an earlier release to 0.9.2 requires a one-time manual update. Stop the Proxy with the existing CLI before upgrading the Relay or installing the new release:

```bash
dev-anywhere serve stop
```

After upgrading the Relay:

```bash
npm install -g @dev-anywhere/proxy@0.9.2
dev-anywhere serve start --relay cloud
```

See the [upgrade guide](https://github.com/lichenxicatapple-blip/dev-anywhere/blob/main/README.en.md#upgrading) for the full steps and session impact.

If DEV Anywhere cannot detect an agent CLI automatically, set its persistent
path under the top-level `agentCli` object:

```json
{
  "agentCli": {
    "claudeBin": "/absolute/path/to/claude",
    "codexBin": "/absolute/path/to/codex",
    "kimiBin": "/absolute/path/to/kimi"
  }
}
```

Environment variables are reserved for temporary overrides:

- `RELAY_URL` — relay WebSocket URL
- `RELAY_PROXY_TOKEN` — auth token
- `CLAUDE_BIN` — Claude Code CLI path; overrides `agentCli.claudeBin`
- `CODEX_BIN` — Codex CLI path; overrides `agentCli.codexBin`
- `KIMI_BIN` — Kimi Code CLI path; overrides `agentCli.kimiBin`

## How it works

- Local daemon wraps Claude Code, Codex, and Kimi Code CLI sessions with `node-pty` for transparent terminal control. Claude Code and Codex also support structured chat-message mode; Kimi Code supports ACP chat with streaming output, tool calls and interactive approvals, turn cancellation, and history resume.
- Local terminal attachment uses a Unix-domain socket on macOS/Linux or a named pipe on Windows.
- Terminal bytes + structured control messages are forwarded to relay over WebSocket.
- Relay serves the Web client and routes live traffic; session state remains on the proxy side.

## License

MIT © catli
