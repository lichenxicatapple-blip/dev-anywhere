# Internals & Development Reference

Developer-only documentation for plumbing that DEV Anywhere uses internally but doesn't expose to operators. If you only run the system, [CONFIG.md](./CONFIG.md) is what you want.

## Hook subprocess plumbing

Claude Code's hook system invokes a small Node forwarder for each tool-permission event. The proxy daemon launches the underlying `claude` CLI with a hook command embedded in its env, and that command spawns a child that needs to know how to call back into the daemon's hook server.

Communication is one-shot environment variables, set when the proxy spawns `claude`, inherited by the hook child via Claude's hook invocation.

| Variable                   | Set by                            | Read by                                    | Purpose                                                                                                |
| -------------------------- | --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `DEV_ANYWHERE_HOOK_URL`    | proxy daemon (`buildProviderEnv`) | hook forwarder child                       | URL of the daemon's local hook HTTP server (e.g. `http://127.0.0.1:8765/hook`).                        |
| `DEV_ANYWHERE_HOOK_TOKEN`  | proxy daemon                      | hook forwarder child + JSON session worker | Bearer token expected by the hook server. Per-daemon, randomly generated at startup.                   |
| `DEV_ANYWHERE_HOOK_MARKER` | proxy daemon                      | hook forwarder child                       | Magic string the daemon uses to recognize hook events as "ours" vs. user-installed Claude hooks.       |
| `DEV_ANYWHERE_HOOK_EVENT`  | proxy hook command stub           | hook forwarder child                       | Hook event name (e.g. `PreToolUse`); falls back to `hook_event_name` or `event_name` from the payload. |
| `DEV_ANYWHERE_SESSION_ID`  | proxy daemon                      | hook forwarder child                       | Session this hook event belongs to.                                                                    |
| `DEV_ANYWHERE_PROVIDER`    | proxy daemon                      | hook forwarder child + `terminal.ts`       | Which CLI is hosting the session (`claude` / `codex`).                                                 |

These are not user-facing knobs. Setting them by hand will not enable any feature; they only carry context from parent to child within a single proxy invocation.

`DEV_ANYWHERE_PROXY_NAME` is similar but operator-adjacent: it overrides the auto-generated proxy display name shown in the web UI's machine list. Set it in your shell rc if you want a stable name across daemon restarts.

## Test harness variables

Used only by the test suites; setting them in normal usage is a no-op.

| Variable       | Used by                                    | Purpose                                                                                                                                 |
| -------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `VITEST`       | `apps/proxy/src/common/logger.ts`          | When set, logger initializes in silent mode to keep test output clean. Vitest sets it automatically.                                    |
| `TEST_SCOPE`   | `vitest.config.ts` (multiple)              | `unit` runs only `*.test.ts`; `integration` runs only `__tests__/integration/**`. Driven by `pnpm test:unit` / `pnpm test:integration`. |
| `WEB_BASE_URL` | `apps/web/playwright.config.ts`, e2e tests | Override the URL Playwright opens (default `http://localhost:5173`).                                                                    |

## Real-device HTTPS dev

Use this when a bug only reproduces on a physical phone and depends on browser secure-context APIs, such as `navigator.clipboard.writeText`. LAN HTTP (`http://192.168.x.x:5173`) is fast but not a secure context. Public tunnels are HTTPS but add too much latency for touch/scroll debugging. A local trusted CA keeps traffic on the LAN and still gives the browser a trusted HTTPS origin.

1. Pick the LAN IP the phone can reach:

```bash
LAN_IP="$(ipconfig getifaddr en0 || ipconfig getifaddr en1)"
echo "$LAN_IP"
```

2. Generate a local CA and a server certificate for that IP:

```bash
CERT_DIR="$HOME/.dev-anywhere/certs"
mkdir -p "$CERT_DIR"

openssl genrsa -out "$CERT_DIR/dev-anywhere-local-ca.key" 2048
openssl req -x509 -new -nodes \
  -key "$CERT_DIR/dev-anywhere-local-ca.key" \
  -sha256 -days 825 \
  -subj "/CN=DEV Anywhere Local CA" \
  -out "$CERT_DIR/dev-anywhere-local-ca.crt"

cat >"$CERT_DIR/dev-anywhere-$LAN_IP.ext" <<EOF
subjectAltName = IP:$LAN_IP,IP:127.0.0.1,DNS:localhost
extendedKeyUsage = serverAuth
keyUsage = digitalSignature,keyEncipherment
EOF

openssl genrsa -out "$CERT_DIR/dev-anywhere-$LAN_IP.key" 2048
openssl req -new \
  -key "$CERT_DIR/dev-anywhere-$LAN_IP.key" \
  -subj "/CN=$LAN_IP" \
  -out "$CERT_DIR/dev-anywhere-$LAN_IP.csr"
openssl x509 -req \
  -in "$CERT_DIR/dev-anywhere-$LAN_IP.csr" \
  -CA "$CERT_DIR/dev-anywhere-local-ca.crt" \
  -CAkey "$CERT_DIR/dev-anywhere-local-ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/dev-anywhere-$LAN_IP.crt" \
  -days 825 -sha256 \
  -extfile "$CERT_DIR/dev-anywhere-$LAN_IP.ext"
```

3. Serve the CA file so the phone can install it:

```bash
python3 -m http.server 8765 --bind 0.0.0.0 --directory "$HOME/.dev-anywhere/certs"
```

Open this on the phone and install the CA certificate:

```text
http://<LAN_IP>:8765/dev-anywhere-local-ca.crt
```

On Android this is a user-installed CA and the system may show a standard network-monitoring warning. Remove `DEV Anywhere Local CA` from the phone's credential settings after testing if it is no longer needed.

4. Start the local stack with HTTPS enabled:

```bash
CERT_DIR="$HOME/.dev-anywhere/certs"
DEV_ANYWHERE_WEB_HTTPS_CERT="$CERT_DIR/dev-anywhere-$LAN_IP.crt" \
DEV_ANYWHERE_WEB_HTTPS_KEY="$CERT_DIR/dev-anywhere-$LAN_IP.key" \
pnpm dev:restart -- --profile local --relay local --relay-port 3100 --web-port 5173
```

5. Open the web UI on the phone:

```text
https://<LAN_IP>:5173
```

For a specific session, append the hash route as usual:

```text
https://<LAN_IP>:5173/#/chat/<session-id>?mode=pty
```

If Clipboard API still fails, verify from the phone browser console:

```js
window.isSecureContext;
Boolean(navigator.clipboard?.writeText);
```

Both should be `true` / `true`. Clipboard writes still require a user gesture; test by tapping the app's copy button, not by running `writeText` from an arbitrary async callback.

To return to normal HTTP dev, restart without the two `DEV_ANYWHERE_WEB_HTTPS_*` variables.

## E2E chaos toggles

The web e2e tests have a "real local chain" mode that brings up a full proxy + relay + web stack and injects deliberate failures. The toggles are env-only and gated by per-suite enable flags.

| Variable                                                                                            | Default                                     | Purpose                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `DEV_ANYWHERE_REAL_LOCAL_SMOKE`                                                                     | `0`                                         | Master switch for real-stack mobile smoke.                             |
| `DEV_ANYWHERE_REAL_CREATE_SESSION_SMOKE`                                                            | `0`                                         | Within real smoke, create live PTY sessions vs. just verifying chrome. |
| `DEV_ANYWHERE_LOCAL_PTY_CHAOS` / `DEV_ANYWHERE_HOSTED_PTY_CHAOS` / `DEV_ANYWHERE_JSON_WORKER_CHAOS` | `0`                                         | Per-mode chaos enable.                                                 |
| `DEV_ANYWHERE_*_CHAOS_PROVIDER`                                                                     | `claude`                                    | Which CLI to use under chaos.                                          |
| `DEV_ANYWHERE_*_CHAOS_BIN`                                                                          | unset                                       | Override the CLI binary path.                                          |
| `DEV_ANYWHERE_*_CHAOS_CWD`                                                                          | `/tmp/dev-anywhere-chaos/<mode>`            | Working directory for the chaos session.                               |
| `DEV_ANYWHERE_REAL_PROVIDER_APPROVAL_TIMEOUT_MS`                                                    | `60000`                                     | How long the approval test waits for a permission decision.            |
| `DEV_ANYWHERE_REAL_PROVIDER_CWD`                                                                    | `/tmp/dev-anywhere-chaos/provider-approval` | CWD for the approval test.                                             |
| `DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_SMOKE`                                                           | `0`                                         | Run the clipboard image upload e2e.                                    |
| `DEV_ANYWHERE_REAL_CLIPBOARD_IMAGE_CWD`                                                             | `/tmp/dev-anywhere-chaos/clipboard-image`   | Working directory for that test.                                       |
| `DEV_ANYWHERE_EXPECT_RELAY_DOWN`                                                                    | `0`                                         | Relax assertions when chaos has the relay forcibly offline.            |

The relay-side chaos injection has its own knobs read by `apps/relay/src/chaos.ts` (and surfaced through `loadRelayRuntimeEnv` for type safety):

| Variable                                      | Default | Purpose                                                   |
| --------------------------------------------- | ------- | --------------------------------------------------------- |
| `DEV_ANYWHERE_RELAY_CHAOS`                    | `0`     | Master enable.                                            |
| `DEV_ANYWHERE_RELAY_CHAOS_TYPES`              | (all)   | CSV allow-list of message types to affect.                |
| `DEV_ANYWHERE_RELAY_CHAOS_DELAY_MS`           | `0`     | Delay every forwarded match by this many ms.              |
| `DEV_ANYWHERE_RELAY_CHAOS_DUPLICATE`          | `0`     | If `1`, send each match twice.                            |
| `DEV_ANYWHERE_RELAY_CHAOS_DUPLICATE_DELAY_MS` | `10`    | Gap between the original and duplicate.                   |
| `DEV_ANYWHERE_RELAY_CHAOS_REORDER`            | `0`     | If `1`, delay every other message extra to reorder pairs. |
| `DEV_ANYWHERE_RELAY_CHAOS_REORDER_DELAY_MS`   | `40`    | Reorder delay.                                            |

## Daemon lifecycle state

`~/.dev-anywhere/run/` (or `~/.dev-anywhere/profiles/<name>/run/` when `--profile` is non-default) holds runtime files that coordinate the CLI and the daemon.

| File                | Writer                         | Reader                                    | Purpose                                                                                   |
| ------------------- | ------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `dev-anywhere.pid`  | daemon at startup              | CLI subcommands (status / stop / restart) | PID lock. CLI uses `kill -0` to detect stale entries.                                     |
| `dev-anywhere.sock` | daemon at startup              | CLI status, terminal client               | Unix domain socket for IPC.                                                               |
| `stopped`           | CLI on `serve stop`            | (advisory marker)                         | Distinguishes "user stopped" from "crashed".                                              |
| `desired-relay`     | CLI on `serve start --relay X` | daemon respawn paths                      | Persists relay choice across daemon restarts. Cleared by `serve start` without `--relay`. |
| `desired-env`       | CLI                            | daemon respawn                            | Same idea for arbitrary env passthrough.                                                  |

These are session-local state, not config. Don't edit by hand. `serve restart` is the supported way to refresh them.

## Profile-scoped vs global state

| Path                                    | Scope                | Why                                                                                                       |
| --------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `~/.dev-anywhere/config.json`           | global               | Single source of truth for all profiles.                                                                  |
| `~/.dev-anywhere/run/`                  | default profile only | Default profile uses unprefixed paths for backward compatibility with the original single-profile design. |
| `~/.dev-anywhere/profiles/<name>/run/`  | per profile          | Non-default profiles isolate their PID/socket/data here.                                                  |
| `~/.dev-anywhere/logs/`                 | global               | Service / terminal logs. Pino multistream rotates by run id.                                              |
| `~/.dev-anywhere/profiles/<name>/logs/` | per profile          | Same, scoped per profile.                                                                                 |
| `~/.dev-anywhere/relay-data/`           | global               | Standalone relay's persistence (font assets etc.) when running locally.                                   |

The default profile and non-default profiles use slightly different paths. If you're touching path logic, run `apps/proxy/src/__tests__/unit/profile-paths.test.ts` to verify both branches.

## Centralized env parsers

`apps/proxy/src/common/runtime-env.ts` and `apps/relay/src/runtime-env.ts` are the only places that should read `process.env.X` for user-facing knobs. Subprocess plumbing (the `DEV_ANYWHERE_HOOK_*` group, `TERM`, etc.) deliberately stays inline at its single consumer — those are not knobs and broadcasting them via the parser would imply they were operator-tunable.

If you add a new env var:

1. Decide: is it user-facing? → goes in `runtime-env.ts` and [CONFIG.md](./CONFIG.md). Internal? → consume locally, document here.
2. For user-facing, also add a config field if the value is naturally persistent (like `LOG_LEVEL`).
3. Maintain the precedence order in code AND in CONFIG.md's quick-reference table.

## See also

- [CONFIG.md](./CONFIG.md) — operator-facing knob inventory.
- [DEPLOYMENT.md](./DEPLOYMENT.md) — VPS deployment steps.
- [SCRIPTS.md](./SCRIPTS.md) — dev-loop shell script reference.
