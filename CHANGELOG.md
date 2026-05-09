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
- Smoke-test and release-check scripts for local and published artifacts.

### Security

- Documented production requirement to configure both proxy and client relay tokens.
