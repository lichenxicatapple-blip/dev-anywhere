# Mobile Smoke

Mobile smoke is local-first. It must verify the current workspace against local Web, local Relay, and local proxy serve; cloud checks belong to release verification after deployment.

## Default Local Smoke

Run:

```bash
pnpm mobile:smoke
```

This command refuses remote `WEB_BASE_URL` values. By default it uses `http://127.0.0.1:5173`.

It runs two layers:

1. Mobile UI contract with FakeRelay across `mobile-small`, `mobile`, and `mobile-landscape`.
2. Real local relay/proxy smoke against the local serve daemon, without creating long-running sessions.

The local real layer requires:

```bash
pnpm dev:restart
INIT_CWD="$PWD" pnpm --filter @dev-anywhere/proxy run dev -- serve restart --env local
```

`pnpm mobile:smoke` then verifies:

- top-level mobile pages do not render a persistent app header
- mobile top-level pages keep the typewriter brand hero
- direct mobile entry to `/sessions` without a selected proxy returns to root proxy selection
- mobile settings is available as a floating utility and opens the same settings dialog as desktop
- no document-level horizontal overflow
- visible interactive controls meet the 44px touch target rule
- proxy selection and session browsing work on phone viewports
- create-session remains usable on phone
- JSON input survives a simulated `visualViewport` keyboard resize
- slash and file pickers remain visible with the keyboard simulated
- PTY terminal stays visible across portrait and landscape
- real local proxy/session resources load from the local relay/proxy chain

## Full Local Smoke

Run:

```bash
pnpm mobile:smoke:full
```

This adds real local session creation:

- creates and terminates a hosted PTY session
- creates a JSON chat session, sends a short prompt, and waits for the model reply

Use this before shipping mobile changes that touch session creation, chat input, PTY, or provider wiring.

## iOS Simulator Safari Smoke

Run:

```bash
pnpm mobile:smoke:simulator
```

This includes the default local smoke, then opens local Web in iOS Simulator Safari and saves screenshots to `artifacts/mobile-smoke/`.

The simulator layer checks Safari/WebKit realities that Chromium emulation cannot prove:

- iOS safe-area behavior
- browser chrome and address bar viewport behavior
- real screenshot artifacts for review
- portrait and landscape first paint

## Desktop Guard

Run:

```bash
pnpm desktop:smoke
```

This is the local desktop guard for shared shell/session/input changes. Mobile rewrites that touch shared components should pass both `pnpm mobile:smoke` and `pnpm desktop:smoke`.

## Release/Cloud Checks

Cloud checks are not part of mobile smoke. After deployment, use release-specific verification against the deployed URL, and keep those results separate from local smoke so failures are attributable.
