# Scripts

Repository scripts are grouped by workflow. Prefer the `pnpm` commands in the
root `package.json` for common tasks; call scripts directly only when debugging a
specific workflow.

| Directory  | Purpose                                                      |
| ---------- | ------------------------------------------------------------ |
| `dev/`     | Local relay/web/proxy loops, health checks, and chaos runs.  |
| `test/`    | Test tier entrypoints for unit, layout, PC, and mobile E2E.  |
| `release/` | Release gates, smoke tests, and version/tag publishing flow. |
| `deploy/`  | VPS deploy installer and deploy-specific checks.             |
| `quality/` | Source hygiene and aggregate quality checks.                 |
| `tools/`   | Ad hoc diagnostics such as Android emulator CDP helpers.     |
| `lib/`     | Shared shell/Node helpers sourced by the workflow scripts.   |
