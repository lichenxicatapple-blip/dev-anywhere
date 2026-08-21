import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { attachPtyHistoryProjection } from "./pty-history-projection";
import { getClientPositionForTerminalPoint, getTerminalPointAtClient } from "./pty-line-selection";

function geometryFixture(): { terminal: Terminal; host: HTMLDivElement } {
  const terminal = {
    rows: 10,
    cols: 20,
    buffer: { active: { viewportY: 30, length: 80, getLine: () => undefined } },
  } as unknown as Terminal;
  const host = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  host.append(screen);
  screen.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 200 }) as DOMRect;
  Object.defineProperties(screen, {
    clientWidth: { value: 200 },
    clientHeight: { value: 200 },
  });
  return { terminal, host };
}

describe("PTY buffer/client coordinate projection", () => {
  it("maps a client coordinate to an absolute buffer cell", () => {
    const { terminal, host } = geometryFixture();
    expect(
      getTerminalPointAtClient({
        terminal,
        host,
        clientX: 35,
        clientY: 65,
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ row: 32, column: 2 });
  });

  it("maps an absolute buffer cell boundary back to client space", () => {
    const { terminal, host } = geometryFixture();
    expect(
      getClientPositionForTerminalPoint({
        terminal,
        host,
        point: { row: 32, column: 2 },
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ left: 30, top: 80 });
    expect(
      getClientPositionForTerminalPoint({
        terminal,
        host,
        point: { row: 32, column: 2 },
        affinity: "after",
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ left: 40, top: 80 });
  });

  it("uses the live-backfill row plane while active viewportY is far ahead", () => {
    const { terminal, host } = geometryFixture();
    Object.defineProperty(terminal.buffer.active, "viewportY", {
      configurable: true,
      value: 60,
    });
    let rowIdentityOffset = 0;
    const line = {
      length: 20,
      isWrapped: false,
      getCell: () => ({ getWidth: () => 1, getChars: () => "x" }),
      translateToString: () => "projected row",
    };
    terminal.buffer.active.getLine = () => line as never;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("missing xterm screen");
    screen.innerHTML =
      '<div class="xterm-rows"><div>native</div></div><div class="xterm-selection"></div>';
    const projectionController = attachPtyHistoryProjection(host, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div>row 25</div><div>row 26</div><div>row 27</div></div></pre></body></html>",
      getSelectionLine: () => line as never,
      getBufferRowIdentityOffset: () => rowIdentityOffset,
    });
    expect(
      projectionController.render({
        kind: "live-backfill",
        startLine: 25,
        endLine: 27,
        rowHeight: 20,
        topOffset: -40,
      }),
    ).toBe(true);
    rowIdentityOffset = -3;
    const projection = screen.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    if (!projection) throw new Error("missing live backfill projection");
    projection.getBoundingClientRect = () =>
      ({ left: 10, top: -20, width: 200, height: 60, right: 210, bottom: 40 }) as DOMRect;

    expect(
      getTerminalPointAtClient({
        terminal,
        host,
        clientX: 35,
        clientY: 10,
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ row: 23, column: 2 });
    expect(
      getClientPositionForTerminalPoint({
        terminal,
        host,
        point: { row: 23, column: 2 },
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ left: 30, top: 20 });

    // Row 26 is below the three serialized projection rows, but it is still on the same painted
    // plane. Falling back to active.viewportY here would incorrectly resolve this point as row 62.
    expect(
      getTerminalPointAtClient({
        terminal,
        host,
        clientX: 35,
        clientY: 70,
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ row: 26, column: 2 });
    expect(
      getTerminalPointAtClient({
        terminal,
        host,
        clientX: 35,
        clientY: 70,
        cellWidth: 10,
        cellHeight: 20,
        clampToBuffer: true,
      }),
    ).toEqual({ row: 26, column: 2 });
    expect(
      getClientPositionForTerminalPoint({
        terminal,
        host,
        point: { row: 29, column: 2 },
        cellWidth: 10,
        cellHeight: 20,
      }),
    ).toEqual({ left: 30, top: 140 });
  });
});
