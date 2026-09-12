import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  CornerDownLeft,
} from "lucide-react";
import type { TerminalShellFamily } from "@dev-anywhere/shared";
import { getPtyShortcutPreset, type PtyShortcut } from "@/lib/pty-shortcuts";
import type { SessionProvider } from "@/lib/session-provider";

interface PtyMobileControlsProps {
  sessionKind?: "agent" | "terminal";
  provider?: SessionProvider;
  shellFamily?: TerminalShellFamily;
  bottomInset?: number;
  onInput: (data: string) => void;
  onPaste: () => void;
  onHeightChange?: (height: number) => void;
}

// 长按重复触发节奏: 首发立即, 然后 300ms 延迟内单击退出, 之后 50ms 一次稳定 repeat。
// 数字参考浏览器原生 keyboard repeat 体感。
const REPEAT_INITIAL_DELAY_MS = 300;
const REPEAT_INTERVAL_MS = 50;
const CTRL_C_CLEAR_GUARD_MS = 1200;
// The four contextual keys share one preset with the menu. Their positions leave the
// arrow cluster, Paste and Enter unchanged in portrait and landscape.
export function PtyMobileControls({
  sessionKind,
  provider,
  shellFamily,
  bottomInset = 0,
  onInput,
  onPaste,
  onHeightChange,
}: PtyMobileControlsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { mobile } = getPtyShortcutPreset({ kind: sessionKind, provider, shellFamily });

  useLayoutEffect(() => {
    if (!onHeightChange) return;
    const element = rootRef.current;
    if (!element) return;

    const measure = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange]);

  return (
    <div
      ref={rootRef}
      className="dev-pty-mobile-controls fixed inset-x-0 z-40 flex items-stretch gap-1 border-t px-1 py-1.5"
      style={{ bottom: bottomInset }}
      data-slot="pty-mobile-controls"
      aria-label="终端移动端控制"
    >
      <div
        className="dev-pty-mobile-key-grid grid min-w-0 flex-1 grid-cols-6 grid-rows-2 gap-1"
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
        <ShortcutKey shortcut={mobile[0]} position="primary" onInput={onInput} />
        <ShortcutKey shortcut={mobile[1]} position="secondary" onInput={onInput} />
        {mobile[2] === "clear" ? (
          <ClearInputKey key={provider} provider={provider} onInput={onInput} />
        ) : (
          <ShortcutKey shortcut={mobile[2]} position="editing" onInput={onInput} />
        )}
        <SinglePressKey
          label="发送 Ctrl+C"
          slot="pty-mobile-key-ctrl-c"
          onPress={() => onInput("\x03")}
        >
          ^C
        </SinglePressKey>
        <ShortcutKey shortcut={mobile[3]} position="tertiary" onInput={onInput} />
        <RepeatableKey
          label="光标左移"
          slot="pty-mobile-key-left"
          icon={ArrowLeft}
          onPress={() => onInput("\x1b[D")}
        />
        <RepeatableKey
          label="光标上移"
          slot="pty-mobile-key-up"
          icon={ArrowUp}
          onPress={() => onInput("\x1b[A")}
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
      <div className="dev-pty-mobile-action-grid grid w-[4.375rem] shrink-0 grid-rows-2 gap-1">
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
const ARROW_KEY_PILL_CLASS =
  "dev-pty-mobile-key-pill dev-pty-mobile-key-pill-arrow inline-flex h-9 w-full items-center justify-center rounded-[6px] border px-1 text-xs font-mono";

interface SinglePressKeyProps {
  label: string;
  slot: string;
  onPress: () => void;
  position?: string;
  children: ReactNode;
}

function SinglePressKey({ label, slot, onPress, position, children }: SinglePressKeyProps) {
  return (
    <button
      type="button"
      className={KEY_BUTTON_OUTER_CLASS}
      aria-label={label}
      data-slot={slot}
      data-key-position={position}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      <span className={KEY_PILL_CLASS}>{children}</span>
    </button>
  );
}

function ShortcutKey({
  shortcut,
  position,
  onInput,
}: {
  shortcut: PtyShortcut;
  position: string;
  onInput: (data: string) => void;
}) {
  return (
    <SinglePressKey
      label={`发送 ${shortcut.key}`}
      slot={`pty-mobile-key-${shortcut.id}`}
      position={position}
      onPress={() => onInput(shortcut.data)}
    >
      {shortcut.display}
    </SinglePressKey>
  );
}

function ClearInputKey({
  provider,
  onInput,
}: {
  provider?: SessionProvider;
  onInput: (data: string) => void;
}) {
  const usesCtrlC = provider === "codex" || provider === "kimi";
  const guardTimerRef = useRef<number | null>(null);
  const [guarded, setGuarded] = useState(false);
  useEffect(
    () => () => {
      if (guardTimerRef.current !== null) window.clearTimeout(guardTimerRef.current);
    },
    [],
  );

  return (
    <button
      type="button"
      className={KEY_BUTTON_OUTER_CLASS}
      aria-label="清空输入区"
      aria-disabled={guarded || undefined}
      data-slot="pty-mobile-key-clear"
      data-key-position="editing"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (guardTimerRef.current !== null) return;
        onInput(usesCtrlC ? "\x03" : "\x1b\x1b");
        if (!usesCtrlC) return;
        // Codex/Kimi reuse Ctrl+C for exit. Suppress a rapid second tap after clearing.
        setGuarded(true);
        guardTimerRef.current = window.setTimeout(() => {
          guardTimerRef.current = null;
          setGuarded(false);
        }, CTRL_C_CLEAR_GUARD_MS);
      }}
    >
      <span className={`${KEY_PILL_CLASS}${guarded ? " opacity-60" : ""}`}>
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
