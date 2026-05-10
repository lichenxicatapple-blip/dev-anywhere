# Configuration Reference

Operator-facing inventory of every knob that affects DEV Anywhere at runtime: config file fields, environment variables, and CLI flags. Internal subprocess plumbing and test-harness variables are documented separately in [DEV.md](./DEV.md).

## Mental model

Three layers of state:

1. **Config file** `~/.dev-anywhere/config.json` — persistent, versioned in your home directory. Edited by hand or via `dev-anywhere init`. Defines reusable named relays and named profiles.
2. **Environment variables** — one-shot overrides for a single invocation. `RELAY_URL=...` lets you point at a different relay without editing config.
3. **CLI flags** — explicit per-command selection. `--profile <name>` and `--relay <name>` pick a stored entry.

Precedence is consistent across the system: **CLI flag > environment variable > config field > built-in default**.

A _profile_ is a saved selection of which _relay_ the proxy daemon should connect to, plus profile-scoped runtime state (PID, socket, logs). A _relay_ is a saved (URL, proxy-token) pair. Multiple profiles can point at the same relay, and the proxy daemon for each profile runs in its own isolated workspace.

## Config file: `~/.dev-anywhere/config.json`

Created by `dev-anywhere init`. JSON, validated against a strict schema on load — typos in top-level keys produce a clear error rather than silently being ignored.

```jsonc
{
  "defaultProfile": "default",
  "profiles": {
    "default": { "relay": "cloud" },
    "local": { "relay": "local" },
  },
  "relays": {
    "cloud": { "url": "wss://relay.example.com", "proxyToken": "<token>" },
    "local": { "url": "ws://localhost:3100" },
  },
  "agentCli": {
    "claudeBin": "/usr/local/bin/claude",
    "codexBin": "/usr/local/bin/codex",
  },
  "previewRoots": ["/Users/me/projects"],
  "logLevel": "info",
}
```

### Top-level fields

| Field            | Type     | Required     | Default            | Purpose                                                                                                                        |
| ---------------- | -------- | ------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `defaultProfile` | string   | optional     | `"default"`        | Profile used when `--profile` not supplied.                                                                                    |
| `profiles`       | record   | **required** | —                  | Named profiles. Key is the profile name, value is a `ProfileEntry`.                                                            |
| `relays`         | record   | **required** | —                  | Named relays. Key is the relay name, value is a `RelayEntry`.                                                                  |
| `agentCli`       | object   | optional     | —                  | Saved Agent CLI binary paths. Edited via `dev-anywhere claude` / `codex` flow when prompted.                                   |
| `previewRoots`   | string[] | optional     | `[]`               | Extra absolute paths the image-preview endpoint may serve from.                                                                |
| `logLevel`       | enum     | optional     | per-logger default | One of `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent`. Applies to both proxy loggers (service + terminal). |

### `ProfileEntry`

| Field   | Type   | Required | Purpose                                                                                             |
| ------- | ------ | -------- | --------------------------------------------------------------------------------------------------- |
| `relay` | string | optional | Name of a relay defined in `relays`. The profile uses this relay unless `--relay <name>` overrides. |

### `RelayEntry`

| Field        | Type   | Required | Purpose                                                                                                   |
| ------------ | ------ | -------- | --------------------------------------------------------------------------------------------------------- |
| `url`        | string | optional | Relay WebSocket URL. `ws://` for local, `wss://` for hosted.                                              |
| `proxyToken` | string | optional | Pre-shared token sent to relay's `/proxy` endpoint. Required when the relay's `RELAY_PROXY_TOKEN` is set. |

### `agentCli`

| Field              | Type     | Purpose                                                         |
| ------------------ | -------- | --------------------------------------------------------------- |
| `claudeBin`        | string   | Path to the `claude` CLI binary. Override via `CLAUDE_BIN` env. |
| `codexBin`         | string   | Path to the `codex` CLI binary. Override via `CODEX_BIN` env.   |
| `claudeBinHistory` | string[] | Recent paths, surfaced as quick-pick suggestions in the web UI. |
| `codexBinHistory`  | string[] | Same, for codex.                                                |

## Environment variables

### Proxy (`dev-anywhere`)

| Variable                 | Override of                 | Default                          | Purpose                                                                                                            |
| ------------------------ | --------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `RELAY_URL`              | `relays[name].url`          | —                                | Force a one-shot relay URL.                                                                                        |
| `RELAY_PROXY_TOKEN`      | `relays[name].proxyToken`   | —                                | Force a one-shot proxy token.                                                                                      |
| `CLAUDE_BIN`             | `agentCli.claudeBin`        | —                                | Override the Claude CLI path.                                                                                      |
| `CODEX_BIN`              | `agentCli.codexBin`         | —                                | Override the Codex CLI path.                                                                                       |
| `LOG_LEVEL`              | `logLevel` (config)         | service=`info`, terminal=`debug` | Pino log level. Applies to both proxy loggers.                                                                     |
| `DEV_ANYWHERE_HOOK_PORT` | (derived from profile name) | computed                         | Override the local hook server port. Mostly useful when running multiple profiles and wanting deterministic ports. |

### Relay (`dev-anywhere-relay`)

The relay reads only environment variables — it has no config file.

| Variable             | Required                      | Default                      | Purpose                                                         |
| -------------------- | ----------------------------- | ---------------------------- | --------------------------------------------------------------- |
| `PORT`               | no                            | `3100`                       | HTTP/WebSocket listen port.                                     |
| `RELAY_PROXY_TOKEN`  | **yes for public deployment** | unset (open `/proxy`)        | Pre-shared token required on `/proxy` upgrades.                 |
| `RELAY_CLIENT_TOKEN` | **yes for public deployment** | unset (open `/client`)       | Pre-shared token required on `/client` upgrades.                |
| `DATA_DIR`           | no                            | `~/.dev-anywhere/relay-data` | Persistence directory (fonts etc.). Empty string `""` disables. |
| `HEARTBEAT_INTERVAL` | no                            | `30000`                      | Proxy/client WS heartbeat interval in ms.                       |
| `LOG_LEVEL`          | no                            | `info`                       | Pino log level.                                                 |

### Web (build-time / dev server)

| Variable                        | Read by                    | Default                 | Purpose                                                                                                                    |
| ------------------------------- | -------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DEV_ANYWHERE_WEB_RELAY_TARGET` | `apps/web` Vite dev server | `http://localhost:3100` | Which relay the dev server proxies `/client` and `/fonts` to. Production builds rely on same-origin nginx routing instead. |

## CLI flags

### `dev-anywhere` (proxy)

```
dev-anywhere [--profile <name>] <subcommand>
```

| Flag               | Where | Purpose                                                                  |
| ------------------ | ----- | ------------------------------------------------------------------------ |
| `-v`, `--version`  | root  | Print version.                                                           |
| `--profile <name>` | root  | Use an isolated proxy profile. Defaults to `defaultProfile` from config. |

Subcommands:

| Subcommand         | Flags                                       | Purpose                                                                |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| `init`             | —                                           | Create `~/.dev-anywhere/` and write the default config.                |
| `serve start`      | `--relay <name>`                            | Start the daemon. Persists relay choice for this profile.              |
| `serve restart`    | `--relay <name>`                            | Stop + start.                                                          |
| `serve stop`       | —                                           | Stop the daemon.                                                       |
| `serve status`     | `-w/--watch`, `-n/--interval <s>`           | Show daemon status. Watch mode redraws on an interval.                 |
| `relay token`      | `--relay <name>`                            | Print the relay's active client token (auth: proxy token from config). |
| `claude` / `codex` | (passes args through to the underlying CLI) | Start an interactive PTY session.                                      |

### `dev-anywhere-relay`

| Flag              | Purpose        |
| ----------------- | -------------- |
| `-h`, `--help`    | Show help.     |
| `-v`, `--version` | Print version. |

All operational tuning is via the env vars above.

## Precedence quick-reference

| Knob                            | Sources (highest → lowest)                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Relay URL (proxy)               | `RELAY_URL` env → `relays[name].url` from config                                                           |
| Proxy token (proxy)             | `RELAY_PROXY_TOKEN` env → `relays[name].proxyToken` from config                                            |
| Relay name (which entry to use) | `--relay <name>` flag → `desired-relay` file (set by previous `serve start`) → `profile.relay` from config |
| Profile name                    | `--profile <name>` flag → `defaultProfile` from config → `"default"`                                       |
| Claude/Codex binary             | `CLAUDE_BIN`/`CODEX_BIN` env → `agentCli.claudeBin`/`.codexBin` from config                                |
| Hook port                       | `DEV_ANYWHERE_HOOK_PORT` env → derived from profile name                                                   |
| Log level (proxy)               | `LOG_LEVEL` env → `logLevel` from config → service=`info`, terminal=`debug`                                |
| Log level (relay)               | `LOG_LEVEL` env → `info`                                                                                   |

## Common scenarios

**Switch a single command to a different relay** without editing config:

```bash
RELAY_URL=ws://my-other-relay:3100 RELAY_PROXY_TOKEN=secret dev-anywhere claude
```

**Run two profiles in parallel** (e.g. cloud + local) on the same machine:

```bash
dev-anywhere --profile default serve start --relay cloud
dev-anywhere --profile local   serve start --relay local
```

Each profile gets its own PID, socket, and logs under `~/.dev-anywhere/profiles/<name>/`.

**Bump proxy log verbosity for one run**:

```bash
LOG_LEVEL=debug dev-anywhere claude
```

**Persist a higher log level across runs**: edit `~/.dev-anywhere/config.json`:

```json
{ ..., "logLevel": "debug" }
```

**Fetch the active client token** of a configured cloud relay (instead of ssh'ing to read `.env`):

```bash
dev-anywhere relay token --relay cloud
```
