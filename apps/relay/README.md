# @dev-anywhere/relay

Relay server for [`@dev-anywhere/proxy`](https://www.npmjs.com/package/@dev-anywhere/proxy) — bridges local AI CLI proxies to remote web clients via WebSocket.

## Install

```bash
npm install -g @dev-anywhere/relay
```

This installs the `dev-anywhere-relay` command globally.

Requires Node.js >= 20.

## Quick start

```bash
# Minimal, plaintext WS on port 3100:
PORT=3100 dev-anywhere-relay

# With auth tokens (recommended for any public relay):
RELAY_PROXY_TOKEN="$(openssl rand -hex 24)" \
RELAY_CLIENT_TOKEN="$(openssl rand -hex 24)" \
PORT=3100 dev-anywhere-relay
```

## Endpoints

| Path      | Purpose                                 |
| --------- | --------------------------------------- |
| `/health` | HTTP GET — health probe                 |
| `/status` | HTTP GET — proxy/client counts          |
| `/proxy`  | WS — proxy daemon connection            |
| `/client` | WS — web SPA / mobile client connection |

## Environment variables

| Variable             | Default                         | Notes                                              |
| -------------------- | ------------------------------- | -------------------------------------------------- |
| `PORT`               | `3100`                          | HTTP + WSS listen port                             |
| `DATA_DIR`           | `~/.dev-anywhere/relay-data`    | Persistent state. Set to empty string to disable.  |
| `HEARTBEAT_INTERVAL` | `30000` (ms)                    | WS ping cadence                                    |
| `RELAY_PROXY_TOKEN`  | unset (open `/proxy` endpoint)  | When set, `/proxy` rejects connections without it  |
| `RELAY_CLIENT_TOKEN` | unset (open `/client` endpoint) | When set, `/client` rejects connections without it |
| `LOG_LEVEL`          | `info`                          | pino log level                                     |

**Production warning:** always set both `RELAY_PROXY_TOKEN` and `RELAY_CLIENT_TOKEN`. Without a client token, anyone who can reach the relay can connect to `/client`, list proxies, and attempt to bind to a proxy.

For the bundled web client, open the app URL, then paste `RELAY_CLIENT_TOKEN` in Settings -> Relay Token. The token is stored in browser-local storage and appended to `/client` WebSocket connections.

## TLS

This package serves plain HTTP + WS. For production, put it behind nginx / Caddy / Cloudflare with a TLS termination. One-liner turnkey setup (docker compose + nginx + certbot) is available via `install-relay.sh` in the [repo](https://github.com/lichenxicatapple-blip/dev-anywhere).

## Using the embedded server programmatically

```ts
import { createRelayServer } from "@dev-anywhere/relay/server";
import pino from "pino";

const relay = createRelayServer({
  port: 3100,
  logger: pino(),
  proxyToken: process.env.RELAY_PROXY_TOKEN,
  clientToken: process.env.RELAY_CLIENT_TOKEN,
});
```

## License

MIT © catli
