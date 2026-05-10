import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft } from "lucide-react";

interface PtyMobileControlsProps {
  onInput: (data: string) => void;
}

// 移动端浮层按键：方向键 / Ctrl+U（清空当前行）/ 回车。
// onPointerDown preventDefault 防止 mousedown 把焦点抢走 xterm。
export function PtyMobileControls({ onInput }: PtyMobileControlsProps) {
  const keys = [
    { label: "光标左移", slot: "pty-mobile-key-left", data: "\x1b[D", icon: ArrowLeft },
    { label: "光标上移", slot: "pty-mobile-key-up", data: "\x1b[A", icon: ArrowUp },
    { label: "光标下移", slot: "pty-mobile-key-down", data: "\x1b[B", icon: ArrowDown },
    { label: "光标右移", slot: "pty-mobile-key-right", data: "\x1b[C", icon: ArrowRight },
  ];

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-1 border-t border-[#343434] bg-[#202020]/[0.98] px-1 py-1.5 shadow-[0_-10px_24px_rgba(0,0,0,0.35)]"
      data-slot="pty-mobile-controls"
      aria-label="终端移动端控制"
    >
      <div className="grid min-w-0 flex-1 grid-cols-5 gap-1" role="group" aria-label="辅助按键">
        <button
          type="button"
          className="inline-flex h-11 min-w-0 items-center justify-center rounded-[6px] text-[#D8D8D8] transition-colors active:text-white"
          aria-label="清空当前输入"
          data-slot="pty-mobile-key-clear"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onInput("\x15")}
        >
          <span className="inline-flex h-9 min-w-0 items-center justify-center rounded-[6px] border border-[#3A3A3A] bg-[#1A1A1A] px-1.5 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            清空
          </span>
        </button>
        {keys.map(({ label, slot, data, icon: Icon }) => (
          <button
            key={slot}
            type="button"
            className="inline-flex h-11 min-w-0 items-center justify-center rounded-[6px] text-[#D8D8D8] transition-colors active:text-white"
            aria-label={label}
            data-slot={slot}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onInput(data)}
          >
            <span className="inline-flex size-9 items-center justify-center rounded-[6px] border border-[#3A3A3A] bg-[#1A1A1A] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <Icon aria-hidden="true" className="size-4" />
            </span>
          </button>
        ))}
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
