# Quick Task 260411-w2m: Fix chat UI style consistency and relay/proxy connectivity

## Summary

Fixed two critical issues blocking usable chat UI in the Feishu mini program:

### Task 1: CSS 750-design-width conversion (13 files)

All chat-related component CSS files were using "actual pixel" values (e.g., `font-size: 14px`) that Taro's pxtransform further halved, resulting in unreadably small text (~5.6px actual on 390px screen). Converted all values to 750-design-width system matching SPIKE reference code.

**Before/After (on 390px screen):**
- Header title: 6.4px -> 12.8px
- Input field font: 5.6px -> 11.2px
- Input field height: 14.4px -> 28.8px
- Menu/send buttons: 14.4px -> 28.8px
- Picker item names: 5.6px -> 11.2px
- Bubble text: 5.6px -> 11.2px

**Files modified:** slash-command-picker, file-path-picker, input-bar, safe-area-header, chat page settings, assistant-bubble, user-bubble, tool-call-card, tool-approval-card, quote-preview-bar, back-to-bottom, chat-bubble-list, directory-picker

### Task 2: H5 WebSocket connectivity fix

Taro's `connectSocket` H5 polyfill has a race condition: the SocketTask constructor creates `new WebSocket(url)` immediately, but `onOpen`/`onMessage` handlers are registered after the Promise resolves. For localhost connections, `onopen` fires before handlers exist, causing silent event loss.

**Fix:** In H5 mode (`process.env.TARO_ENV === 'h5'`), bypass Taro polyfill and use native `WebSocket` with `addEventListener` (which works even after the event has fired for subsequent events, and uses the event queue correctly).

## Verification

Playwright E2E test confirmed:
- WebSocket connects and proxy list loads
- Navigation: proxy-select -> session-list -> chat works
- All font sizes match expected 750-design-width conversions
- Header bar height: 35.2px (88px design)
- Input field: 11.2px font, 28.8px height (28px/72px design)

## Known Remaining Issues

- PTY terminal shows 0 lines (termLineCount: 0) — terminal frame data may not be flowing through relay
- Directory picker shows "No subdirectories" — dir_list_request may need time or proxy support
