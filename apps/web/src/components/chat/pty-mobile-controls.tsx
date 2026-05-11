import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft } from "lucide-react";

interface PtyMobileControlsProps {
  onInput: (data: string) => void;
}

// 长按重复触发节奏: 首发立即, 然后 300ms 延迟内单击退出, 之后 50ms 一次稳定 repeat。
// 数字参考浏览器原生 keyboard repeat 体感。
const REPEAT_INITIAL_DELAY_MS = 300;
const REPEAT_INTERVAL_MS = 50;

// 移动端浮层按键：方向键支持长按连发, 控制类按键 (清空 / Ctrl+C / 回车) 单击触发。
// onPointerDown preventDefault 防止把焦点抢走 xterm。
export function PtyMobileControls({ onInput }: PtyMobileControlsProps) {
  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-1 border-t border-[#343434] bg-[#202020]/[0.98] px-1 py-1.5 shadow-[0_-10px_24px_rgba(0,0,0,0.35)]"
      data-slot="pty-mobile-controls"
      aria-label="终端移动端控制"
    >
      <div className="grid min-w-0 flex-1 grid-cols-6 gap-1" role="group" aria-label="辅助按键">
        <SinglePressKey
          label="清空当前输入"
          slot="pty-mobile-key-clear"
          onPress={() => onInput("\x15")}
        >
          <span className="inline-flex h-9 min-w-0 items-center justify-center rounded-[6px] border border-[#3A3A3A] bg-[#1A1A1A] px-1.5 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            清空
          </span>
        </SinglePressKey>
        <SinglePressKey
          label="发送 Ctrl+C 中断"
          slot="pty-mobile-key-ctrl-c"
          onPress={() => onInput("\x03")}
        >
          <span className="inline-flex h-9 min-w-0 items-center justify-center rounded-[6px] border border-[#3A3A3A] bg-[#1A1A1A] px-1.5 text-xs font-mono shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            ^C
          </span>
        </SinglePressKey>
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
      <button
        type="button"
        className="inline-flex h-11 w-[4.375rem] shrink-0 items-center justify-center rounded-[6px] text-sm text-[#F1E0CB] transition-colors active:text-white"
        aria-label="回车"
        data-slot="pty-mobile-key-enter"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => onInput("\r")}
      >
        <span className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[#7A6046] bg-[#5A452E] px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          <CornerDownLeft aria-hidden="true" className="size-4" />
          <span>回车</span>
        </span>
      </button>
    </div>
  );
}

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
      className="inline-flex h-11 min-w-0 items-center justify-center rounded-[6px] text-[#D8D8D8] transition-colors active:text-white"
      aria-label={label}
      data-slot={slot}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      {children}
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
      intervalTimerRef.current = window.setInterval(onPress, REPEAT_INTERVAL_MS);
    }, REPEAT_INITIAL_DELAY_MS);
  };

  useEffect(() => stopRepeat, []);

  return (
    <button
      type="button"
      className="inline-flex h-11 min-w-0 items-center justify-center rounded-[6px] text-[#D8D8D8] transition-colors active:text-white"
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
      <span className="inline-flex size-9 items-center justify-center rounded-[6px] border border-[#3A3A3A] bg-[#1A1A1A] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <Icon aria-hidden="true" className="size-4" />
      </span>
    </button>
  );
}
