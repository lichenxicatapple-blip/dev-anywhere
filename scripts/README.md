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

## Real iPad Voice Pilot

The fixed-recording UAT drives a connected physical iPad through Safari
WebDriver and verifies Wake Lock, VAD, ASR, Agent response, and TTS in one run.
It requires an HTTPS URL serving a web build created with
`VITE_DEV_ANYWHERE_VOICE_FIXTURE=1` and a dedicated JSON session:

```bash
IPAD_VOICE_UAT_URL=https://example.test \
DEV_ANYWHERE_VOICE_FIXTURE_SESSION_ID=session-id \
pnpm test:ipad:voice-fixture
```

The script discovers the connected iPad by default. Set `IPAD_UDID` when more
than one physical iPad is available. Run evidence is written under
`artifacts/voice-pilot-uat/runs/`.
