# @lichenxi.cat/cc-anywhere-relay

Relay server for [`@lichenxi.cat/cc-anywhere`](https://www.npmjs.com/package/@lichenxi.cat/cc-anywhere) — bridges local Claude Code proxies to remote web clients via WebSocket.

## Install

```bash
npm install -g @lichenxi.cat/cc-anywhere-relay
```

This installs the `cc-anywhere-relay` command globally.

Requires Node.js >= 20.

## Quick start

```bash
# Minimal, plaintext WS on port 3100:
PORT=3100 cc-anywhere-relay

# With auth token (recommended):
RELAY_PROXY_TOKEN="$(openssl rand -hex 24)" PORT=3100 cc-anywhere-relay
```

## Endpoints

| Path      | Purpose                                        |
| --------- | ---------------------------------------------- |
| `/health` | HTTP GET — health probe                        |
| `/status` | HTTP GET — proxy/client counts                 |
| `/proxy`  | WS — proxy daemon connection (requires token)  |
| `/client` | WS — web SPA / mobile client connection (open) |

## Environment variables

| Variable             | Default                        | Notes                                             |
| -------------------- | ------------------------------ | ------------------------------------------------- |
| `PORT`               | `3100`                         | HTTP + WSS listen port                            |
| `DATA_DIR`           | `~/.cc-anywhere/relay-data`    | Persistent state. Set to empty string to disable. |
| `HEARTBEAT_INTERVAL` | `30000` (ms)                   | WS ping cadence                                   |
| `RELAY_PROXY_TOKEN`  | unset (open `/proxy` endpoint) | When set, `/proxy` rejects connections without it |
| `LOG_LEVEL`          | `info`                         | pino log level                                    |

**Production warning:** always set `RELAY_PROXY_TOKEN`. Without it, anyone can register as a proxy.

## TLS

This package serves plain HTTP + WS. For production, put it behind nginx / Caddy / Cloudflare with a TLS termination. One-liner turnkey setup (docker compose + nginx + certbot) is available via `install-relay.sh` in the [repo](https://github.com/lichenxicatapple-blip/cc-anywhere).

## Using the embedded server programmatically

```ts
import { createRelayServer } from "@lichenxi.cat/cc-anywhere-relay/server";
import pino from "pino";

const relay = createRelayServer({
  port: 3100,
  logger: pino(),
  proxyToken: process.env.RELAY_PROXY_TOKEN,
});
```

## License

MIT © catli
