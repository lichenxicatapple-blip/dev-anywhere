import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  CornerDownLeft,
} from "lucide-react";
import type { SessionProvider } from "@/lib/session-provider";

interface PtyMobileControlsProps {
  sessionKind?: "agent" | "terminal";
  provider?: SessionProvider;
  bottomInset?: number;
  onInput: (data: string) => void;
  onPaste: () => void;
}

// 长按重复触发节奏: 首发立即, 然后 300ms 延迟内单击退出, 之后 50ms 一次稳定 repeat。
// 数字参考浏览器原生 keyboard repeat 体感。
const REPEAT_INITIAL_DELAY_MS = 300;
const REPEAT_INTERVAL_MS = 50;
const CODEX_CLEAR_GUARD_MS = 1200;

function clearInputSequence(
  sessionKind: "agent" | "terminal" | undefined,
  provider: SessionProvider | undefined,
): string {
  if (sessionKind === "terminal") return "\x15";
  return provider === "codex" ? "\x03" : "\x1b\x1b";
}

// 移动端浮层按键 (2 行):
//   Row1: [Esc ][Tab ][⇧Tab][^T  ][ ↑ ][ ^S ]
//   Row2: [清空][ ^C ][ ^B ][  ← ][ ↓ ][  → ]
//   Paste / Enter 在最右, 各占一行
// 方向键长按连发, 其他单击。所有按键统一 h-11 外壳 / h-9 内 pill, 视觉上一致。
// onPointerDown preventDefault 防把焦点抢走 xterm。
export function PtyMobileControls({
  sessionKind,
  provider,
  bottomInset = 0,
  onInput,
  onPaste,
}: PtyMobileControlsProps) {
  return (
    <div
      className="dev-pty-mobile-controls fixed inset-x-0 z-40 flex items-stretch gap-1 border-t px-1 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]"
      style={{ bottom: bottomInset }}
      data-slot="pty-mobile-controls"
      aria-label="终端移动端控制"
    >
      <div
        className="grid min-w-0 flex-1 grid-cols-6 grid-rows-2 gap-1"
        role="group"
        aria-label="辅助按键"
      >
        <SinglePressKey
          label="发送 Escape"
          slot="pty-mobile-key-esc"
          onPress={() => onInput("\x1b")}
        >
          Esc
        </SinglePressKey>
        <SinglePressKey label="发送 Tab" slot="pty-mobile-key-tab" onPress={() => onInput("\t")}>
          Tab
        </SinglePressKey>
        <SinglePressKey
          label="发送 Shift+Tab"
          slot="pty-mobile-key-shift-tab"
          onPress={() => onInput("\x1b[Z")}
        >
          ⇧Tab
        </SinglePressKey>
        <SinglePressKey
          label="发送 Ctrl+T"
          slot="pty-mobile-key-ctrl-t"
          onPress={() => onInput("\x14")}
        >
          ^T
        </SinglePressKey>
        <RepeatableKey
          label="光标上移"
          slot="pty-mobile-key-up"
          icon={ArrowUp}
          onPress={() => onInput("\x1b[A")}
        />
        <SinglePressKey
          label="发送 Ctrl+S"
          slot="pty-mobile-key-ctrl-s"
          onPress={() => onInput("\x13")}
        >
          ^S
        </SinglePressKey>

        <ClearInputKey
          sessionKind={sessionKind}
          provider={provider}
          label="清空输入区"
          slot="pty-mobile-key-clear"
          onInput={onInput}
        />
        <SinglePressKey
          label="发送 Ctrl+C 中断"
          slot="pty-mobile-key-ctrl-c"
          onPress={() => onInput("\x03")}
        >
          ^C
        </SinglePressKey>
        <SinglePressKey
          label="发送 Ctrl+B"
          slot="pty-mobile-key-ctrl-b"
          onPress={() => onInput("\x02")}
        >
          ^B
        </SinglePressKey>
        <RepeatableKey
          label="光标左移"
          slot="pty-mobile-key-left"
          icon={ArrowLeft}
          onPress={() => onInput("\x1b[D")}
        />
        <RepeatableKey
          label="光标下移"
          slot="pty-mobile-key-down"
          icon={ArrowDown}
          onPress={() => onInput("\x1b[B")}
        />
        <RepeatableKey
          label="光标右移"
          slot="pty-mobile-key-right"
          icon={ArrowRight}
          onPress={() => onInput("\x1b[C")}
        />
      </div>
      <div className="grid w-[4.375rem] shrink-0 grid-rows-2 gap-1">
        <button
          type="button"
          className={KEY_BUTTON_OUTER_CLASS}
          aria-label="粘贴剪贴板"
          data-slot="pty-mobile-key-paste"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onPaste}
        >
          <span className="dev-pty-mobile-key-pill dev-pty-mobile-key-pill-paste inline-flex h-9 w-full items-center justify-center gap-1 rounded-[6px] border px-1.5 text-xs">
            <ClipboardPaste aria-hidden="true" className="size-3.5" />
            <span>粘贴</span>
          </span>
        </button>
        <button
          type="button"
          className={KEY_BUTTON_OUTER_CLASS}
          aria-label="回车"
          data-slot="pty-mobile-key-enter"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onInput("\r")}
        >
          <span className="dev-pty-mobile-key-pill dev-pty-mobile-key-pill-enter inline-flex h-9 w-full items-center justify-center gap-1 rounded-[6px] border px-1.5 text-xs">
            <CornerDownLeft aria-hidden="true" className="size-3.5" />
            <span>回车</span>
          </span>
        </button>
      </div>
    </div>
  );
}

const KEY_BUTTON_OUTER_CLASS =
  "dev-pty-mobile-key inline-flex h-11 min-w-0 items-center justify-center rounded-[6px] transition-colors";

const KEY_PILL_BASE_CLASS =
  "dev-pty-mobile-key-pill inline-flex h-9 w-full items-center justify-center rounded-[6px] border px-1 text-xs font-mono";
const KEY_PILL_CLASS = `${KEY_PILL_BASE_CLASS} dev-pty-mobile-key-pill-default`;
const GUARDED_KEY_PILL_CLASS = `${KEY_PILL_BASE_CLASS} dev-pty-mobile-key-pill-guarded`;
const ARROW_KEY_PILL_CLASS =
  "dev-pty-mobile-key-pill dev-pty-mobile-key-pill-arrow inline-flex h-9 w-full items-center justify-center rounded-[6px] border px-1 text-xs font-mono";

interface SinglePressKeyProps {
  label: string;
  slot: string;
  onPress: () => void;
  children: ReactNode;
}

function SinglePressKey({ label, slot, onPress, children }: SinglePressKeyProps) {
  return (
    <button
      type="button"
      className={KEY_BUTTON_OUTER_CLASS}
      aria-label={label}
      data-slot={slot}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      <span className={KEY_PILL_CLASS}>{children}</span>
    </button>
  );
}

interface ClearInputKeyProps {
  sessionKind?: "agent" | "terminal";
  provider?: SessionProvider;
  label: string;
  slot: string;
  onInput: (data: string) => void;
}

function ClearInputKey({ sessionKind, provider, label, slot, onInput }: ClearInputKeyProps) {
  const guardTimerRef = useRef<number | null>(null);
  const guardedRef = useRef(false);
  const [guarded, setGuarded] = useState(false);

  const clearGuard = (): void => {
    if (guardTimerRef.current !== null) {
      window.clearTimeout(guardTimerRef.current);
      guardTimerRef.current = null;
    }
    guardedRef.current = false;
    setGuarded(false);
  };

  useEffect(
    () => () => {
      if (guardTimerRef.current !== null) window.clearTimeout(guardTimerRef.current);
    },
    [],
  );

  const startCodexGuard = (): void => {
    guardedRef.current = true;
    setGuarded(true);
    if (guardTimerRef.current !== null) window.clearTimeout(guardTimerRef.current);
    guardTimerRef.current = window.setTimeout(clearGuard, CODEX_CLEAR_GUARD_MS);
  };

  const handlePress = (): void => {
    if (provider === "codex" && guardedRef.current) return;
    onInput(clearInputSequence(sessionKind, provider));
    if (provider === "codex") startCodexGuard();
  };

  return (
    <button
      type="button"
      className={KEY_BUTTON_OUTER_CLASS}
      aria-label={label}
      aria-disabled={guarded ? "true" : undefined}
      data-slot={slot}
      data-guarded={guarded ? "true" : undefined}
      onPointerDown={(event) => event.preventDefault()}
      onClick={handlePress}
    >
      <span className={guarded ? GUARDED_KEY_PILL_CLASS : KEY_PILL_CLASS}>
        {guarded ? "已清" : "清空"}
      </span>
    </button>
  );
}

interface RepeatableKeyProps {
  label: string;
  slot: string;
  icon: ComponentType<{ "aria-hidden"?: boolean | "true" | "false"; className?: string }>;
  onPress: () => void;
}

// 长按重复发送的按键: pointerdown 立即首发并启动延迟 + 节奏定时器,
// pointerup/leave/cancel 终止。click 通过 pointerFiredRef 去重避免与 pointerdown 双发,
// 但保留 onClick 让键盘 Enter / Playwright .click() 等纯 click 路径仍能触发一次。
function RepeatableKey({ label, slot, icon: Icon, onPress }: RepeatableKeyProps) {
  const initialTimerRef = useRef<number | null>(null);
  const intervalTimerRef = useRef<number | null>(null);
  const pointerFiredRef = useRef(false);

  const stopRepeat = (): void => {
    if (initialTimerRef.current !== null) {
      window.clearTimeout(initialTimerRef.current);
      initialTimerRef.current = null;
    }
    if (intervalTimerRef.current !== null) {
      window.clearInterval(intervalTimerRef.current);
      intervalTimerRef.current = null;
    }
  };

  const startRepeat = (): void => {
    stopRepeat();
    onPress();
    initialTimerRef.current = window.setTimeout(() => {
      initialTimerRef.current = null;
      onPress();
      intervalTimerRef.current = window.setInterval(onPress, REPEAT_INTERVAL_MS);
    }, REPEAT_INITIAL_DELAY_MS);
  };

  useEffect(() => stopRepeat, []);

  return (
    <button
      type="button"
      className={KEY_BUTTON_OUTER_CLASS}
      aria-label={label}
      data-slot={slot}
      onPointerDown={(event) => {
        event.preventDefault();
        pointerFiredRef.current = true;
        startRepeat();
      }}
      onPointerUp={stopRepeat}
      onPointerLeave={stopRepeat}
      onPointerCancel={stopRepeat}
      onClick={() => {
        if (pointerFiredRef.current) {
          pointerFiredRef.current = false;
          return;
        }
        onPress();
      }}
    >
      <span className={ARROW_KEY_PILL_CLASS}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
    </button>
  );
}
