# Mobile Redesign

This initiative is a product redesign for mobile, not a pass of local responsive fixes. The goal is a coherent phone experience backed by automated smoke coverage.

## Product Position

Phone usage prioritizes monitoring, approvals, short prompts, session switching, and emergency terminal access. It should be possible to complete core work from a phone, but long coding sessions remain desktop-first.

## Interaction Model

- Top-level mobile navigation uses pages, not the desktop sidebar.
- Dense desktop menus become touch sheets or full-width mobile menus.
- Creation and picker flows use progressive disclosure.
- Sticky bottom actions account for `env(safe-area-inset-bottom)`.
- Keyboard-aware surfaces use `visualViewport` and do not rely on body scrolling.
- Terminal horizontal overflow stays inside the PTY surface, never the document.
- Desktop and mobile may share behavior/state while rendering different structures.

## Brand Model

Desktop and mobile use one brand system with different density:

- Desktop keeps the persistent sidebar brand mark and the main-panel `BrandHero` typewriter surface.
- Mobile top-level pages (`/` and `/sessions`) do not use a persistent app header.
- Mobile top-level pages use a page-level `MobileBrandHero` with the same typewriter copy as desktop.
- Mobile settings is a floating utility button in the safe-area corner, not a header constraint.
- Mobile direct entry to `/sessions` redirects to `/` when no proxy is selected; proxy selection stays owned by the root route.
- Chat routes suppress the mobile brand chrome so active work keeps maximum vertical space.
- Settings, version, proxy selection, and session creation must remain functionally equivalent across desktop and mobile. Mobile can render different surfaces, but not reduced capability.

This keeps mobile from becoming a stripped-down mode while avoiding a desktop sidebar or toolbar squeezed into a phone viewport.

## Component Matrix

| Surface                | Desktop                            | Mobile                                             | Ownership                                                                                                    |
| ---------------------- | ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Brand mark             | Sidebar chrome                     | Folded into page-level hero                        | `apps/web/src/components/brand/brand-mark.tsx`, `apps/web/src/components/brand/mobile-brand-hero.tsx`        |
| Brand hero/context     | Main-panel typewriter hero         | Page-level typewriter hero                         | `apps/web/src/components/brand/brand-hero.tsx`, `apps/web/src/components/brand/mobile-brand-hero.tsx`        |
| Settings               | Sidebar settings button + dialog   | Floating settings utility + same dialog            | `apps/web/src/components/shell/sidebar.tsx`, `apps/web/src/components/shell/app-shell.tsx`                   |
| Proxy selection        | Sidebar dropdown plus desktop hero | Full-page connection list                          | `apps/web/src/components/proxy/proxy-switcher.tsx`                                                           |
| Session browsing       | Persistent sidebar list            | Full-page navigator with sticky create action      | `apps/web/src/components/session/session-list.tsx`                                                           |
| Create session         | Center dialog                      | Bottom sheet or staged full-height sheet           | `apps/web/src/components/session/create-session-dialog.tsx`                                                  |
| Agent/provider choice  | Two-column cards                   | Single-column touch cards                          | `apps/web/src/components/session/create-session-dialog.tsx`                                                  |
| File picker            | Floating popover                   | Sheet or inline explorer with 44px rows            | `apps/web/src/components/chat/file-path-picker.tsx`                                                          |
| JSON composer          | Compact input card                 | Keyboard-aware composer with stable touch controls | `apps/web/src/components/chat/input-bar.tsx`                                                                 |
| Slash/file suggestions | Floating list                      | Keyboard-safe sheet or anchored panel              | `apps/web/src/components/chat/slash-command-picker.tsx`, `apps/web/src/components/chat/file-path-picker.tsx` |
| PTY                    | Dense terminal viewport            | Fit-to-width emergency terminal, landscape aware   | `apps/web/src/components/chat/chat-pty-view.tsx`                                                             |
| Chat overflow          | Dropdown menu                      | Touch sheet or large menu items                    | `apps/web/src/components/chat/chat-header.tsx`                                                               |

## Quality Contracts

- No document-level horizontal overflow at 375px, 390px, and phone landscape sizes.
- Primary interactive targets are at least 44px on phone.
- Inputs stay visible when `visualViewport.height` shrinks.
- Bottom actions do not collide with safe areas.
- PTY remains visible and usable in portrait and landscape.
- Mobile top-level pages do not render `app-shell-header`.
- Mobile top-level pages keep the typewriter brand hero and floating settings utility.
- Mobile `/sessions` direct entry without a selected proxy returns to the root proxy-selection route.
- Mobile settings opens the same settings dialog as desktop.
- Desktop behavior remains covered by existing desktop e2e.

## Refactor Rules

- Do not make mobile pass by sprinkling one-off `max-w`, `overflow-hidden`, or `h-11` patches without revisiting the component structure.
- Keep behavior shared when possible, but allow separate mobile render trees for dense surfaces.
- Prefer reusable primitives for mobile sheets, picker surfaces, and keyboard-safe composers.
- Add or update tests before large layout rewrites so regressions are visible.
- Re-run desktop e2e for every shared component touched by a mobile refactor.
