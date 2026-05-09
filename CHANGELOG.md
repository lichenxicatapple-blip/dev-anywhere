# Changelog

All notable changes to this project will be documented in this file.

This project follows Semantic Versioning before `1.0.0`: minor versions may include breaking changes, and patch versions are reserved for compatible fixes.

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
