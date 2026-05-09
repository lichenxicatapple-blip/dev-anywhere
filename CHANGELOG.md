# Changelog

All notable changes to this project will be documented in this file.

This project follows Semantic Versioning before `1.0.0`: minor versions may include breaking changes, and patch versions are reserved for compatible fixes.

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
