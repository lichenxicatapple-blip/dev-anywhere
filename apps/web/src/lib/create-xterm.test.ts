import { describe, expect, it } from "vitest";
import { buildXtermTerminalOptions } from "./create-xterm";

describe("buildXtermTerminalOptions", () => {
  // 失焦光标走 "outline" 时, xterm 内部计算的 inactive 位置在长会话里会偏离当前
  // prompt, 视觉上是个孤立的空心方框落在错误格子。锁死 "none" 让失焦时不画。
  // 任何把这一项改回 outline / underline / block 的 PR 都会被这条测试拦下。
  it("disables the inactive cursor so a stale ghost cell can't render on blur", () => {
    const opts = buildXtermTerminalOptions();
    expect(opts.cursorInactiveStyle).toBe("none");
  });

  it("threads the caller's fontSize through to xterm", () => {
    expect(buildXtermTerminalOptions({ fontSize: 18 }).fontSize).toBe(18);
  });

  it("falls back to the project default fontSize when caller omits one", () => {
    const opts = buildXtermTerminalOptions();
    expect(opts.fontSize).toBeGreaterThan(0);
    expect(typeof opts.fontSize).toBe("number");
  });
});
