# Phase 6: Feishu Mini Program - Core Interaction - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-07
**Phase:** 06-feishu-mini-program-core-interaction
**Areas discussed:** Page structure, Session management, Message layout, Streaming & scroll, PTY rendering (emerged as critical topic)

---

## Page Structure & Navigation

| Option | Description | Selected |
|--------|-------------|----------|
| Dual page: list + chat | Session list page and chat page, navigator push. Like WeChat. | |
| Single page + drawer | Single chat page with sidebar drawer for session list. | |
| Three pages: list + chat + settings | Extra settings page with TabBar navigation. | |

**User's choice:** Dual page (recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Always show session list | Every cold start shows list first. | |
| Auto-enter last session | If active session exists, go directly to chat. | |

**User's choice:** Auto-enter last session
**Notes:** User doesn't want to select a session every time returning from background. Background-return is handled by Taro onShow (no navigation needed). Cold-start auto-enters last active session.

| Option | Description | Selected |
|--------|-------------|----------|
| Auto summary | First user message, truncated to 20 chars. | |
| Timestamp + serial number | "Session #1 - 4/7 14:30" | |
| You decide | Claude decides | |

**User's choice:** Auto summary (recommended)

---

## Session Management

| Option | Description | Selected |
|--------|-------------|----------|
| Title + status + time | Summary title, status dot, relative time. | |
| Title + last message preview | WeChat-style with message preview. | |

**User's choice:** Title + status + time (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Nav bar "+" button | Fixed position in navigation bar. | |
| Bottom card in list | "New session" card at bottom of list. | |

**User's choice:** Nav bar "+" button (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Left-swipe delete | iOS-style swipe to reveal terminate button. | |
| In-chat terminate button | Terminate button inside chat page. | |
| Both | Both entry points. | |

**User's choice:** Left-swipe delete (recommended)

---

## PTY Rendering (Critical — emerged during discussion)

This was not one of the original gray areas but became the most important topic. User stated PTY remote viewing is the core motivation for building CC Anywhere.

### PTY vs JSON session handling

User challenged the assumption that Phase 6 could skip PTY sessions. Key findings:
- PTY output is raw ANSI terminal data, not linear text
- strip-ansi cannot handle cursor movement commands (only strips colors)
- @xterm/addon-serialize output is also ANSI, not plain text
- Out of Scope explicitly excluded xterm.js in mini program

### Rendering approach evaluation

| Option | Pros | Cons | Selected |
|--------|------|------|----------|
| JSON structured grid | Colors preserved, text selectable, delta updates, bandwidth efficient | Complex server extraction, many Text elements | |
| HTML + RichText | Simplest implementation | Cannot select text precisely (verified by web research + spike), limited CSS, no delta | |
| Image stream (PNG) | Pixel-perfect, zero font issues | Bandwidth disaster (60-600KB/s), no text copy, heavy server deps | |

**User's choice:** JSON structured grid
**Notes:** User requires precise text fragment selection for copying. RichText confirmed unable to do this via web research and spike testing.

### Spike validation results

Built and tested on real device:
- RichText: Cannot copy text precisely — eliminated
- JSON Grid with `<Text selectable>`: Correct rendering, text copyable
- 200 lines: Performance acceptable
- ScrollView scrollX+scrollY: Works on Feishu mini program
- MovableView scale: Does NOT work on Feishu (WeChat only per Taro docs)
- Manual pinch-to-zoom with transform: Works but boundary/panning issues
- Font size switching via A-/A+ buttons + pinch gesture: Clean solution
- Flex layout with viewport flex:1: Adapts to portrait/landscape

---

## Message Layout (JSON sessions)

| Option | Description | Selected |
|--------|-------------|----------|
| Left-right bubbles | User right, Claude left. Classic IM layout. | |
| Full-width card flow | Messages full width, background color distinguishes user/assistant. | |

**User's choice:** Left-right bubbles

## Tool Call Display

| Option | Description | Selected |
|--------|-------------|----------|
| Collapsible card | Tool name + param summary as title, click to expand. Default collapsed. | |
| Always expanded | Full display inline. | |

**User's choice:** Collapsible card (recommended)

---

## Streaming & Scroll

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-scroll + pause on user scroll | New content scrolls to bottom. User scroll up pauses. "Back to bottom" button. | |
| Always auto-scroll | Force scroll to bottom always. | |

**User's choice:** Auto-scroll + pause on user scroll (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Realtime append to bubble | Delta appended to current bubble text. Bubble grows naturally. | |
| Typewriter effect | Character-by-character animation. | |

**User's choice:** Realtime append to bubble (recommended)

---

## Claude's Discretion

- PTY terminal frame push frequency and throttling strategy
- PTY terminal frame incremental update mechanism
- JSON session bubble visual style details
- "Back to bottom" button appearance conditions
- Session list empty state design
- Chat/terminal page transition animation

## Deferred Ideas

- xterm.js in WebView as fallback if JSON Grid performance insufficient
- Authentication flow (pairing code + long-term token)
- Mini program message cache snapshot cleanup strategy
