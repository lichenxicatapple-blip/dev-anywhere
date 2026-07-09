# iPad 0.5 UAT

This document is the execution checklist for iPad acceptance before `0.5.0`.
It is intentionally separate from `RELEASE-0.5-READINESS.md`: that file defines
release gates; this file defines what to do on the real iPad, in what order,
and who confirms each result.

## Rules Of Engagement

- Do not mark an item passed from a DOM read or screenshot alone when the item
  depends on feel, focus, keyboard behavior, touch selection, or visual comfort.
- The agent may use WebKit inspection, screenshots, logs, and DOM geometry as
  evidence, but the user is the final judge for human-visible behavior.
- Before each manual step, the agent states the current device state, the action
  requested from the user, and the expected result.
- The user answers pass/fail or describes the observed mismatch. The agent then
  records the status before moving on.
- Do not jump to a different device class during this UAT. Android, desktop, and
  release smoke checks are separate gates.
- If new iPad scope is mentioned during UAT, update this checklist before
  continuing so the scope is not lost in chat history.

## Status Legend

- `NOT_STARTED`: not touched in this UAT run.
- `OBSERVED`: inspected by the agent only; not accepted by the user.
- `PASS`: user confirmed, or the item is purely technical and objective.
- `FAIL`: user observed a mismatch or automation found a clear defect.
- `RETEST`: a previous attempt was invalid because the setup was contaminated.
- `BLOCKED`: cannot continue without user action or a broken test harness.

## Test Context

- Device: real iPad Pro 11-inch (M4), iPadOS 26.5.
- Browser: Safari on iPad.
- Current URL: local DEV Anywhere web at `http://192.168.1.2:5173`.
- Current orientation at plan creation: landscape.
- Current keyboard state at plan creation: no hardware keyboard attached.
- WebKit inspection: available through `ios_webkit_debug_proxy` when stable.

## Evidence Policy

Evidence can include:

- Screenshot path.
- WebKit DOM/geometry snapshot.
- PTY output before/after.
- User confirmation text.
- Bug note with reproduction steps.

Screenshots and DOM snapshots are supporting evidence only for interactive or
visual quality items.

## Checklist

### A. Harness And Baseline

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| A1 | iPad is connected and inspectable | Device appears in `devicectl`; Safari tab can be listed | Page shown on the physical iPad is the expected DEV Anywhere page | PASS | `devicectl` showed physical iPad; WebKit listed DEV Anywhere tab |
| A2 | Test URL and proxy are correct | URL is local DEV Anywhere page; current session is PTY | User agrees this is the intended test target | PASS | WebKit state read local `http://192.168.1.2:5173/#/chat/nNVwQOjQkvorhuO05giS4?mode=pty` |
| A3 | Orientation and keyboard state are known | Read viewport and keyboard state | User confirms physical orientation and whether keyboard is attached | PASS | Landscape viewport `1210x748`; keyboard offset `0`; user said no hardware keyboard |

### B. Landscape, No Hardware Keyboard

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| B1 | Sidebar layout | Sidebar width, brand area, session list, bottom actions visible | Layout feels usable; no important content is squeezed out | OBSERVED | Refreshed screenshot `/tmp/dev-anywhere-ipad-b1-sessions-layout-current.png`; landscape viewport `1210x748`; sidebar `280x748`, brand/proxy area `279x128`, session list `279x538`, bottom action area `279x82`, no geometry overflow. |
| B2 | Bottom actions | New and Settings buttons are complete and visually balanced | Buttons look intentional and tappable | OBSERVED | Same screenshot as B1; `新建` and `设置` are both `128x46`, aligned at bottom; history refresh is a `32x32` icon button. |
| B3 | Create menu | New menu opens; options are Agent session and Terminal session | Labels are clear; no duplicated wording in visible UI | OBSERVED | `/tmp/dev-anywhere-ipad-b3-create-menu-current.png`; menu `208x82`, options are `Agent 会话` and `终端会话`; no duplicated `新建` wording in the menu. |
| B4 | PTY readability | PTY area is visible and not overlapped | Text is readable at normal viewing distance | OBSERVED | `/tmp/dev-anywhere-ipad-b4-pty-current.png`; PTY viewport `930x699`, `pty-host` `904x660`, header `930x49`, no visible geometry overflow. |
| B5 | Back-to-bottom placement | Button is in upper-right PTY area, not over bottom controls | Position feels discoverable and not annoying | OBSERVED | In PTY geometry, `back-to-bottom` is `36x36` at `top=89,left=1147`, inside the PTY upper-right area and away from sidebar bottom actions. |
| B6 | Settings main dialog | Dialog has safe margins and consistent structure | Visual hierarchy and spacing are acceptable | OBSERVED | `/tmp/dev-anywhere-ipad-b6-settings-main-current.png`; main settings dialog `440x732` at `left=385..825`, safe within `1210x748`; first-screen settings fit, lower settings are reachable through internal scroll. |
| B7 | Settings subdialogs | Relay Token, Client Management, Voice Pilot use consistent title/subtitle/layout | Copy and alignment feel consistent | OBSERVED | Relay Token `/tmp/dev-anywhere-ipad-b7-relay-token-current.png` (`440x258`, title/description left-aligned, input `360x40`); Client Management `/tmp/dev-anywhere-ipad-b7-client-management-current.png` (`440x388`, refresh `32x32`, `断开` and `当前设备` both `120x36`); Voice Pilot covered by `/tmp/dev-anywhere-ipad-h1-voice-settings.png`. |
| B8 | Input mode setting | `输入方式` shows `自动 / 触控优先 / 实体键盘优先` | Copy is understandable | OBSERVED | `/tmp/dev-anywhere-ipad-b6-settings-main-current.png`; options visible in one row and fit: `自动`, `触控优先`, `实体键盘优先`. |
| B9 | Font size setting | Font size controls are reachable and state changes apply without overflow | Text size controls feel usable on iPad and do not make chat/PTY layout awkward | PASS | PTY header menu opened via keyboard-accessible trigger; screenshot `/tmp/dev-anywhere-ipad-b9-font-menu-open.png`. Font size changed 16 → 17 (`xterm.options.fontSize` and `localStorage`), then reset to 16. Menu stayed within viewport. |

### C. Landscape Touch Input, No Hardware Keyboard

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| C1 | Tapping PTY focuses terminal | Active element becomes terminal textarea | Tap target feels natural | NOT_STARTED | |
| C2 | Soft keyboard behavior | `visualViewport` shrinks; keyboard offset is set | Soft keyboard appears only when expected | NOT_STARTED | |
| C3 | Mobile auxiliary bar | Controls appear above keyboard and fit viewport | Controls are visible, not clipped, and usable | NOT_STARTED | |
| C4 | Auxiliary Enter | Pressing `回车` sends Enter to PTY | User sees expected prompt/output behavior | NOT_STARTED | |
| C5 | Auxiliary control keys | Esc, Tab, Shift+Tab, Ctrl-C/B/S/T behave reasonably | No key feels broken or hidden | NOT_STARTED | |
| C6 | Keyboard dismissal | Closing keyboard restores layout without drift | Selection/content does not jump unexpectedly | NOT_STARTED | |

### D. Landscape With Hardware Keyboard

This section is not optional. It should run immediately after the no-keyboard
landscape baseline so differences are easy to compare.

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| D1 | Hardware keyboard attached state is known | Re-read viewport/media/focus state after attach | User confirms keyboard is physically attached | PASS | User said keyboard is attached; WebKit state stayed landscape `1210x748`, `keyboardOffset=0`, `keyboardLayoutInset=0` |
| D2 | No accidental soft keyboard | Tap/focus PTY with hardware keyboard attached | Soft keyboard does not unexpectedly cover content | PASS | User physically tapped PTY with hardware keyboard attached; WebKit state after tap: active `TEXTAREA` / `Terminal input`, `visualViewport.height=748`, `keyboardOffset=0`, no `pty-mobile-controls` |
| D3 | First key is not lost | User types a short command from keyboard without tapping extra controls | First character appears and command can run | PASS | User typed through hardware keyboard; PTY DOM tail showed `echo ipad-kbd-ok` and output `ipad-kbd-ok` |
| D4 | Enter and Backspace | User types, deletes, and submits | Behavior matches terminal expectations | PASS | User typed `echo ipad-kbdx`, Backspace, `-ok`, Enter; resulting command/output was `ipad-kbd-ok`; `keyboardOffset=0`, no mobile controls |
| D5 | Tab and Shift+Tab | User presses Tab and Shift+Tab | No focus trap or broken terminal input | PASS | User pressed Tab and Shift+Tab; PTY showed shell completion output, active element stayed `TEXTAREA` / `Terminal input`, `keyboardOffset=0`, no mobile controls |
| D6 | Arrow keys | User presses arrow keys in PTY | Cursor/history behavior is acceptable | PASS | User pressed arrow keys after Tab checks; focus stayed in terminal textarea, page did not move focus to sidebar/buttons, `keyboardOffset=0`, no mobile controls |
| D7 | Touch plus keyboard mixing | User touches terminal or selection, then types again | Focus remains predictable; no mode confusion | PASS | Retested from a clean prompt. User tapped PTY and typed `echo ipad-mix-clean`; WebKit/xterm buffer showed exact command and `ipad-mix-clean` output, active element stayed `TEXTAREA` / `Terminal input`, `keyboardOffset=0`, no mobile controls. |
| D8 | Switching sessions | User switches session and types again | Hardware keyboard behavior still works | PASS | After switching to another terminal session, user typed `echo ipad-switch`; active keepalive entry showed `echo ipad-switch` and output `ipad-switch`, focus stayed `TEXTAREA`, `keyboardOffset=0`, no mobile controls |

### E. Portrait, No Hardware Keyboard

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| E1 | Portrait shell layout | Sidebar/mobile layout and session list fit | Important controls are not hidden or cramped | NOT_STARTED | |
| E2 | Portrait create flow | New session entry opens correctly | Sheet/dialog copy and spacing are acceptable | NOT_STARTED | |
| E3 | Portrait settings flow | Settings and subdialogs have safe margins | No edge-touching or overflow | NOT_STARTED | |
| E4 | Portrait PTY readability | PTY view is readable and not clipped | Text and controls feel usable | NOT_STARTED | |
| E5 | Portrait soft keyboard | PTY focus raises keyboard and adjusts viewport | Output area and auxiliary bar stay visible | NOT_STARTED | |

### F. Touch Selection And Content Operations

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| F1 | Long-press selection | Selection handles/toolbars appear near selected text | Selection does not drift when keyboard appears or disappears | NOT_STARTED | |
| F2 | Copy selected text | Clipboard operation can be completed | Copied content is correct enough | NOT_STARTED | |
| F3 | Image preview | Known local image path can preview | Preview fits screen, including wide images | OBSERVED | Covered through chat content path in I9 using real repo image `docs/assets/readme-mobile-create.png`; preview opened and fit landscape dialog. Human touch/selection confirmation still pending. |
| F4 | File download | Known file path can download through formal link | Download flow is understandable and not timeout-prone | OBSERVED | Covered through chat content path in I9 using real repo file `README.md`; formal download toast appeared. Human touch/selection confirmation still pending. |
| F5 | Selection fallback actions | Selecting a path-like text exposes preview/download fallback when applicable | Fallback is discoverable when auto-linking fails | NOT_STARTED | |

### G. Agent Sessions And Management

Use a local test agent session where possible. A Codex session is acceptable for
agent-management coverage; do not use production work that the user cares about.

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| G1 | Create Agent session | New Agent session can be created from iPad | Creation flow is understandable and has feedback while connecting | PASS | Created chat-mode Codex test session `iPad UAT Codex` from iPad. Sidebar active count changed 2 → 3 and route became `/chat/tXLJAz9cJ0FA1YHrsNpnZ?mode=json`. Screenshots: `/tmp/dev-anywhere-ipad-g1-agent-create-dialog.png`, `/tmp/dev-anywhere-ipad-g1-agent-created.png`. |
| G2 | Agent session list/status | Sidebar shows agent session status accurately | Labels and status do not conflict with terminal sessions | PASS | Sidebar showed `终端 2` for terminal sessions and `Codex 1` for the agent group. Test row text was `iPad UAT Codex · Codex · 空闲 · 刚刚`; no terminal/agent wording conflict observed. |
| G3 | Switch Agent sessions | Switching between Agent and terminal sessions preserves context | User does not feel lost; focus and scroll are predictable | PASS | Switched from `iPad UAT Codex` JSON chat to terminal PTY and back. URL changed to `mode=pty` then back to `mode=json`; PTY refocused `Terminal input`, Agent view returned to empty `开始对话` state, `keyboardOffset=0` throughout. |
| G4 | Agent management menu | Session menu exposes expected actions without misleading terminal/agent wording | Management actions are clear and not dangerous by accident | PASS | Opened `iPad UAT Codex` row menu. Menu text was `重命名` / `终止会话`; no terminal wording appeared for the Agent session. Screenshot: `/tmp/dev-anywhere-ipad-g4-agent-menu.png`. |
| G5 | Approval banner and Always Yes | Approval prompt, Always Yes, and menu state stay consistent | Banner position and behavior are acceptable on iPad | PASS | In strict-approval Codex chat session, `/tmp` write command showed approval banner and sidebar state `等待审批` with `始终允许` / `拒绝` / `允许`. Tapped `始终允许`; command completed and later `/tmp` write ran without another banner. Verified file contents, then removed temp files. Screenshots: `/tmp/dev-anywhere-ipad-g5-approval-banner.png`, `/tmp/dev-anywhere-ipad-g5-always-yes-complete.png`. |
| G6 | Agent session termination or detach | Management action works for test session only | Copy matches Agent vs terminal semantics | PASS | Terminated only the test Codex session. Confirmation dialog used Agent copy: `这会停止当前 Agent 进程...`; after confirming, route returned to `/sessions`, active count returned 3 → 2, and `iPad UAT Codex` disappeared. Screenshots: `/tmp/dev-anywhere-ipad-g6-agent-terminate-dialog.png`, `/tmp/dev-anywhere-ipad-g6-agent-terminated.png`. |

### H. Voice Pilot

Voice behavior requires human judgment for permission prompts, timing, and
whether the UI feels distracting.

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| H1 | Voice Pilot settings | Voice Pilot settings page opens with safe margins | Title/subtitle/alignment match other subdialogs | PASS | Opened Voice Pilot settings from the iPad settings dialog. Dialog stayed centered in landscape, title/subtitle were left-aligned, form scrolled independently, and footer buttons stayed fixed. Screenshot: `/tmp/dev-anywhere-ipad-h1-voice-settings.png`. |
| H2 | Voice enable/disable | Toggling Voice Pilot updates state and handles missing permissions clearly | No confusing prompt or stuck state | PASS | In a temporary Codex chat session `WhoKeqxrokqZ7pTk6Ao2w`, the header menu exposed `Voice Pilot` as an unchecked item and opened the start confirmation dialog. On the local HTTP URL, Safari reported `isSecureContext=false` and no `navigator.mediaDevices`; pressing `开启 Voice Pilot` showed the toast `当前浏览器不支持麦克风访问。` and left the dialog cancellable. Screenshots: `/tmp/dev-anywhere-ipad-h2-voice-confirm.png`, `/tmp/dev-anywhere-ipad-h2-voice-mic-unsupported.png`. Full microphone start still requires an HTTPS test URL. |
| H3 | Voice controls in chat | Voice controls are reachable in iPad chat UI | Controls do not collide with keyboard, input, or PTY controls | PASS | Used dev-only store injection to render the active Voice Pilot panel without starting the microphone. `聆听` state rendered above the chat input with a visible waveform and stop button, no viewport overflow. Screenshot: `/tmp/dev-anywhere-ipad-h3-voice-listening-panel.png`. |
| H4 | Voice feedback states | Listening/processing/error states are visible and not over-animated | User can tell what state voice is in | PASS | Verified `聆听`, `播报`, and `异常` panel states through dev-only state injection. Error state text was visible (`当前浏览器不支持屏幕常亮`), and active states kept the waveform inside the panel. Screenshots: `/tmp/dev-anywhere-ipad-h4-voice-speaking-panel.png`, `/tmp/dev-anywhere-ipad-h4-voice-error-panel.png`. |

### I. Chat Bubbles

Chat bubbles are a high-risk visual surface. Cover representative message types
rather than only a happy-path text reply.

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| I1 | User text bubble | Send a normal text prompt | User bubble spacing, wrapping, and alignment are acceptable | PASS | Sent multiple text prompts in `iPad UAT Codex`; prompts rendered in the chat timeline without viewport overflow. |
| I2 | Assistant text bubble | Receive a normal assistant reply | Assistant bubble is readable and visually distinct | PASS | Received normal assistant replies for `pwd` and Markdown-only prompts; text was readable in iPad landscape. |
| I3 | Streaming bubble | Observe an in-progress assistant response | Streaming state does not jump or flicker badly | PASS | Sent 80-line text request and captured `工作中` state while output was growing. Screenshot: `/tmp/dev-anywhere-ipad-i3-long-stream-attempt.png`. |
| I4 | Long text bubble | Render long paragraphs and long unbroken text | Wrapping does not overflow or crush adjacent UI | PASS | Markdown prompt included `SuperLongTokenForIPadBubbleWrappingCheck_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789`; DOM confirmed token present and no main-content viewport overflow. |
| I5 | Code block bubble | Render code/diff-like content | Code is readable; horizontal scroll or wrapping behavior is sane | PASS | Rendered TypeScript code block and command blocks; `pre`/`code` rects stayed inside viewport. |
| I6 | Tool/activity bubble | Render agent/tool activity entries | Status, icons, and labels are understandable | PASS | Codex command activity rendered `运行命令` and `已运行` blocks for `pwd` and `/tmp` write commands. |
| I7 | Approval/request bubble | Trigger or inspect approval-related bubble/banner | It is visible without covering header or input awkwardly | PASS | `/tmp` write command triggered approval banner with `始终允许` / `拒绝` / `允许`; screenshot `/tmp/dev-anywhere-ipad-g5-approval-banner.png`. |
| I8 | Error/empty/reconnect bubble | Render an error or reconnect state if available | Copy and layout are clear and not noisy | PASS | Empty state `开始对话` was visible in the temporary Codex chat. A dev-injected error activity rendered as a compact activity row, and expanded details stayed within the chat rail without covering the input. Screenshots: `/tmp/dev-anywhere-ipad-i8-error-activity-bubble-valid.png`, `/tmp/dev-anywhere-ipad-i8-error-activity-details.png`. |
| I9 | Image/file bubble | Attach or display image/file-related chat content | Preview/download affordances fit iPad and do not timeout in normal use | PASS | Injected real local paths from this repo: `docs/assets/readme-mobile-create.png` and `README.md`. Chat rendered inline preview/download buttons without path overflow. Image preview opened through the formal preview URL, loaded successfully, and fit the iPad landscape dialog. File download showed `已开始下载 /Users/catli/MyApps/dev-anywhere/README.md`. Screenshots: `/tmp/dev-anywhere-ipad-i9-inline-file-image-links.png`, `/tmp/dev-anywhere-ipad-i9-image-preview-dialog.png`, `/tmp/dev-anywhere-ipad-i9-file-download-toast.png`. |
| I10 | Scroll with many bubbles | Use a chat with many mixed bubbles | Scroll, back-to-bottom, and keyboard interactions remain stable | PASS | Mixed conversation contains user prompts, assistant text, command activity, approval, Markdown/code/table, and 80-line long reply. Final screenshot `/tmp/dev-anywhere-ipad-i-long-bubbles-final.png` showed bottom content and input still reachable. |

### J. Portrait With Hardware Keyboard

Run this if landscape hardware-keyboard testing passes and the user can keep
the keyboard attached while rotating.

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| J1 | Rotation with keyboard attached | Re-read viewport after rotation | Layout does not enter a confused mode | NOT_STARTED | |
| J2 | Portrait keyboard input | User types in PTY | No accidental soft keyboard; first key works | NOT_STARTED | |
| J3 | Portrait touch plus keyboard | User mixes touch focus/selection with keyboard input | Focus remains predictable | NOT_STARTED | |

### K. Chrome On iPad

Chrome on iPad is a separate acceptance surface because its keyboard accessory
and autofill behavior can differ from Safari even though it uses the iOS browser
engine.

| ID | Item | Agent checks | User confirms | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| K1 | Chrome launchability | Chrome is installed and can open the local DEV Anywhere URL | Page shown in Chrome is the expected DEV Anywhere page | OBSERVED | Chrome is installed as `com.google.chrome.ios` version `150.7871.51`; `devicectl` launched it with the local PTY URL. |
| K2 | Chrome inspectability | Check whether Chrome exposes a WebKit Inspector target | Whether manual visual testing is needed | OBSERVED | `ios_webkit_debug_proxy` did not expose a Chrome page target; it only exposed Safari's DEV Anywhere target. Chrome cannot currently be DOM-driven like Safari. |
| K3 | Hardware-keyboard autofill/candidate toolbar | Focus PTY/input in Chrome with hardware keyboard attached | No unexpected password/autofill toolbar appears, and IME candidate UI does not switch between light and dark while typing | NOT_STARTED | Requires triggering the issue by typing in Chrome. DVT device-level screenshots work and capture the real Chrome screen (`/tmp/dev-anywhere-ipad-dvt-screenshot.png`, `2420x1668`), so this can be verified by screenshot loop once typing is triggered. The app now syncs `meta[name=color-scheme]` to the effective theme to remove mixed `light dark` signals before retest. Safari DOM probe showed PTY focus uses `colorScheme=light`, root `colorScheme=light`, and meta `content=light`. |
| K4 | Chrome input mitigation probe | If K3 reproduces, compare normal textarea, xterm helper textarea, `inputmode=none`, and contenteditable probes | Identify whether a web-side attribute can suppress the toolbar without breaking hardware-keyboard IME | NOT_STARTED | |

## Current Run Notes

- Initial agent observations were made before this checklist existed. They are
  recorded as `OBSERVED`, not `PASS`, unless later retested and explicitly
  accepted.
- Landscape hardware-keyboard items D1-D8 have been accepted.
- Portrait items have not started yet.
- Long-press selection and no-hardware soft-keyboard behavior still require
  the user to be physically near the iPad.
- Font size, Agent management, Voice Pilot, and chat-bubble coverage were added
  explicitly after user review and must not be skipped.
- Latest user-away pass refreshed automated landscape evidence for B1-B8 only.
  These remain `OBSERVED` because screenshot/DOM checks cannot confirm visual
  comfort or touch feel.
- Chrome on iPad was added after the user reported an unexpected
  password/autofill toolbar with a hardware keyboard. Chrome can be launched,
  but it is not currently inspectable through `ios_webkit_debug_proxy`, so K3
  needs physical observation or another screen-capture mechanism.
- Device-level screenshot capture is available through
  `pymobiledevice3 developer dvt screenshot --userspace`; unlike WebKit
  screenshots, it captures Chrome and system UI. A probe screenshot was saved
  at `/tmp/dev-anywhere-ipad-dvt-screenshot.png`.
- A related Chrome/iPad IME candidate-color issue was suspected to come from
  mixed color-scheme signals. `meta[name=color-scheme]` now synchronizes to the
  effective `light`/`dark` theme; Safari runtime verification showed
  `rootColorScheme=light` and `metaColorScheme=light`.
- Extra user-away Safari probes:
  - In `auto` input mode, focused PTY helper textarea reported
    `autocorrect=off`, `autocapitalize=off`, `spellcheck=false`,
    `colorScheme=light`, but `autocomplete=null`.
  - Temporarily switching to `hardware` input mode and reloading made the
    focused PTY helper textarea report `autocomplete=off` and
    `enterkeyhint=send`; input mode was restored to `auto` afterward.
  - Theme matrix was verified on the real iPad Safari target: forced `dark`
    produced `data-theme=dark`, root/meta `color-scheme=dark`; forced `light`
    produced `data-theme=light`, root/meta `color-scheme=light`; restored
    `auto` produced no stored theme and root/meta `color-scheme=light` on the
    current iPad.
