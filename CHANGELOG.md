# Changelog

All notable changes to this project will be documented in this file.

This project follows Semantic Versioning before `1.0.0`: minor versions may include breaking changes, and patch versions are reserved for compatible fixes.

## [0.2.1] - 2026-05-11

### Fixed

- PTY blank-render bug (intermittent upper-half-black viewport on long sessions): `computePtyHostLayout` was applying its cold-start "fill from bottom" padding whenever the cursor was mid-screen with empty rows below, even when the buffer had scrollback and those rows above the cursor were valid content. The padding pushed host content down by `blankRows * cellH` while `host.top` still expected content at host top, leaving the gap as a black band at the viewport top. Padding is now gated on `bufferLength <= rows` (true cold-start only).

## [0.2.0] - 2026-05-11

### Fixed

- CJK and emoji characters in claude/codex stream-json output no longer corrupt to `?` when the multi-byte sequence straddles a stdout chunk boundary; the affected line was previously dropped by schema validation and the message would disappear entirely.
- JSON sessions no longer get stuck in `WORKING` after the model finishes — the proxy now waits for stdout to drain (with a 1s fallback for hung pipes) before signaling exit, so the final `result` always reaches the web client.
- iOS Safari address-bar collapse no longer leaves the PTY at stale row/column geometry.
- Reconnect snapshot replay no longer leaks frames from a previous recovery window into a fresh one.
- Control-message routing always uses the relay's bound proxy ID; a client-supplied `proxyId` field can no longer redirect a request at someone else's proxy.
- When a hosted-PTY child exits, any tool-approval requests still pending for that session are now denied, instead of being orphaned.
- The proxy daemon no longer aborts startup on a corrupt session-persistence file; it falls back to empty state with a warning and live workers are still recovered.
- `~/.dev-anywhere/config.json`, the proxy-id file, and per-session sequence files are now written atomically (tmp + rename), so a crash mid-write cannot corrupt them. `config.json` is also written with `0o600` since it stores relay tokens.
- Per-message sequence-counter persistence no longer issues a sync write on every relay envelope; reduces fsync load under high-throughput sessions.
- PTY recovery buffers are now bounded under sustained out-of-order delivery; oldest entries are dropped at the cap instead of growing without limit.
- Events are no longer fired against a session that has just terminated.

### Added

- `MAX_JSON_MESSAGE_SIZE` (1 MB) limit on relay `/proxy` and `/client` upgrade endpoints and on the proxy's relay-incoming path. Oversized JSON is rejected with a warning before parse.
- `ALLOWED_ORIGINS` env var on the relay (comma-separated origin allowlist) — opt-in CSWSH defense for public-tunnel deployments. Default behavior is unchanged.
- WebSocket close handlers in proxy and relay now log close `code` / `reason`, making it easier to distinguish ECONNREFUSED / ETIMEDOUT / graceful drops.
- `docs/known-issues/pty-blank-render.md` and `docs/known-issues/pty-garbling.md` — diagnostic playbooks with field-capture instructions for the two intermittent mobile rendering issues that remain open.

### Known Limitations

- On viewports under 360 px the mobile soft keyboard can cover the PTY scrollbar thumb; use the mobile control bar to scroll for now.

## [0.1.9] - 2026-05-10

### Fixed

- Relay client-token preflight (`/auth/client`) and admin client-token retrieval (`/admin/client-token`) are now mounted under `/api/`. The previous paths fell outside the production nginx forward rule (`^/(fonts|health|status|api)`) and were served as the SPA HTML fallback, which broke the web auth-failure UI and `dev-anywhere relay token` against cloud relays.

### Added

- Web shortcut menu adds "发送 Ctrl+B" (`\x02`) and "发送 Ctrl+O" (`\x0f`) for sending these control codes from the browser.

## [0.1.8] - 2026-05-10

### Added

- `dev-anywhere relay token [--relay <name>]` prints the active client token of a configured relay, authenticated by the local proxy token. No more ssh into the VPS to read `.env`.
- Web shortcut menu adds "发送 Shift+Tab" (CSI Z) for cycling Claude CLI permission modes from the browser.
- `LOG_LEVEL` env var and `logLevel` config field control proxy log verbosity (precedence: env > config > per-logger default). The relay already respected `LOG_LEVEL`.
- New docs: `docs/CONFIG.md` (operator-facing knob inventory) and `docs/DEV.md` (internal plumbing reference).
- Diagnostic globals on the active PTY view: `window.__devAnywherePtyDebug()` returns a geometry snapshot, and `window.__devAnywherePtyTerminal()` exposes the live terminal for ad-hoc recovery commands from devtools.

### Fixed

- Web PTY view now recovers from WebGL context loss by reloading the WebGL addon on `onContextLoss`. Previously, GPU context resumption (sleep/wake, backgrounded tabs) left the glyph atlas pointing at stale texture slots, which rendered as garbled characters even though the buffer was correct.
- `dev-anywhere -v` and other invalid invocations no longer crash with `sonic-boom is not ready yet`. The proxy logger is now lazily initialized and arg validation runs before terminal module import.
- The selected sidebar row's gradient now fades cleanly into the sidebar's right edge instead of cutting off abruptly partway across the row.
- The web auth-failure copy is now shown as a full-screen empty state on desktop instead of a small subtitle under the brand logo.
- A wrong `?relayToken=...` URL no longer overwrites a previously valid token in localStorage; tokens are persisted only after the `/auth/client` preflight succeeds.

### Changed

- `~/.dev-anywhere/config.json` is now validated at load time; typos in top-level fields produce a clear field-level error instead of being silently ignored.
- Local dev scripts (`dev-restart`, `dev-health`, `dev-chaos`, `mobile-smoke`) auto-resolve which profile/relay to use by URL match against the local relay (`ws://localhost:<port>`), removing the implicit dependency on profiles being named `local`.

## [0.1.4] - 2026-05-09

### Fixed

- PTY image-preview links now align their hover and click range with terminal display columns when CJK or other wide characters appear before the image path.

## [0.1.3] - 2026-05-09

### Added

- Web clients can preview explicit local image paths from JSON messages and PTY terminal output. By default the proxy serves images from the session working directory and the OS temp directory; additional absolute roots can be configured with `previewRoots`.
- Image preview requests are covered by shared protocol schemas, proxy unit tests, web unit tests, and Playwright smoke tests for JSON, PTY, loading, and mobile layouts.

### Fixed

- Image preview loading now uses a visible skeleton transition and waits for the browser image load before fading the preview in.
- Image preview now reports browser decode failures instead of staying in a loading state indefinitely.
- Image preview keeps the action bar focused on copying the local path and no longer exposes a redundant data-URL "open in new tab" action.
- Mobile image preview opens as a true full-screen layer without the desktop dialog zoom shrinking the viewport.
- The session overflow menu now groups screen wake lock under display controls, and the font-size stepper is visually aligned with other menu items.

### Security

- Image preview rejects missing sessions, paths outside allowed roots, directories, non-image payloads, unsupported formats, and files over 10 MB.

## [0.1.2] - 2026-05-09

### Added

- Chat and PTY pages now expose a per-session screen wake lock toggle in the overflow menu.

### Fixed

- Clipboard image paste now stores files inside the active session working directory when possible and appends `.dev-anywhere/` to an existing project `.gitignore`.
- Screen wake lock is released when leaving the current chat page, switching sessions, or resolving a pending wake-lock request after navigation.
- Mobile PTY auxiliary controls now hide when the soft keyboard is dismissed by the system keyboard.
- Mobile PTY back-to-bottom control now sits closer to the right edge while desktop still avoids the terminal scrollbar.

## [0.1.1] - 2026-05-09

### Changed

- Proxy configuration now uses explicit `profiles` and `relays` with `--relay <name>` commands; the old `defaultEnv`/`envs` shape is rejected.
- Local Web development now requires an explicit relay target, for example `pnpm dev:web -- --relay cloud --port 5174`.

### Fixed

- Local development can now run isolated proxy profiles, so local relay testing no longer has to interrupt a cloud-connected proxy.
- Vite development servers can target local, cloud, or custom relay backends without restarting the proxy daemon.
- Public web clients now show an explicit client-token prompt before opening the relay WebSocket.
- Chat and terminal font-size menus now use an aligned compact stepper layout.
- Active relay verification no longer leaves the temporary `verify-proxy` entry in public proxy lists.
- Graceful proxy disconnects now clean relay resources instead of preserving an offline proxy record.

## [0.1.0] - 2026-05-09

### Added

- Local proxy CLI for Claude Code and Codex sessions.
- WebSocket relay server with proxy/client registration, routing, health checks, and optional token authentication.
- React web/PWA client for session selection, chat rendering, hosted PTY control, reconnect recovery, and mobile layouts.
- Shared protocol schemas for relay, chat, session, control, system, and tool messages.
- Release workflow for npm packages and Docker images.
- Bilingual open-source README, deployment guide, PWA guide, script guide, and public screenshot assets.
- Clipboard image paste for JSON and PTY sessions, backed by relay/proxy upload messages and local proxy-side file storage.
- Relay client token support for public web/PWA deployments.
- Release smoke gate covering desktop, mobile, PTY, clipboard, real provider, and chaos scenarios.

### Changed

- Default desktop chat and terminal font size is now 16px.
- Session activity now updates while PTY/JSON sessions continue producing output.
- Long session and history titles expose their full text via hover titles.
- Public examples and test fixtures no longer use private local project names or machine paths.

### Fixed

- PTY raw input preserves IME-transformed punctuation such as Chinese commas and periods.
- Hosted PTY provider-exit chaos no longer duplicates punctuation input.
- Slow clipboard image uploads stay scoped to the session where the paste started.

### Security

- Documented production requirement to configure both proxy and client relay tokens.
- Clipboard image uploads reject unsupported formats, oversized payloads, and invalid session paths.
