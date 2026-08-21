import { afterEach, describe, expect, it, vi } from "vitest";
import type { IBufferCell, IBufferLine } from "@xterm/xterm";
import {
  attachPtyHistoryProjection,
  getRenderedPtyHistorySelectionLines,
} from "./pty-history-projection";

function createHost(): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = `
    <div class="xterm-screen" style="background-color: rgb(30, 30, 30)">
      <div class="xterm-rows xterm-focus">
        <div><span>history</span></div>
        <div><span class="xterm-cursor xterm-cursor-block">A</span></div>
      </div>
      <div class="xterm-selection"></div>
    </div>
  `;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("attachPtyHistoryProjection", () => {
  it("keeps live-backfill row identity when a full scrollback trim shifts xterm's buffer", () => {
    const host = createHost();
    let rowIdentityOffset = 0;
    const line = {
      length: 1,
      isWrapped: false,
      getCell: () => ({ getChars: () => "A", getWidth: () => 1 }) as unknown as IBufferCell,
      translateToString: () => "A",
    } as unknown as IBufferLine;
    const controller = attachPtyHistoryProjection(host, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div><span>A</span></div><div><span>B</span></div></div></pre></body></html>",
      getSelectionLine: () => line,
      getBufferRowIdentityOffset: () => rowIdentityOffset,
    });

    controller.render({
      kind: "live-backfill",
      startLine: 40,
      endLine: 41,
      rowHeight: 20,
      topOffset: 800,
    });

    const backfill = host.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    expect(backfill?.dataset.rowIdentityOffset).toBe("0");
    expect(Array.from(getRenderedPtyHistorySelectionLines(host).keys())).toEqual([40, 41]);
    rowIdentityOffset = -3;
    expect(Array.from(getRenderedPtyHistorySelectionLines(host).keys())).toEqual([37, 38]);
    expect(backfill?.textContent).toContain("A");
    expect(backfill?.textContent).toContain("B");
  });

  it("builds styled live backfill directly from a serialized buffer range", () => {
    const host = createHost();
    const serializeRangeAsHtml = vi.fn(
      () =>
        "<html><body><pre><div style='color: rgb(220, 220, 220)'><div><span>older row</span></div><div><span style='color: rgb(0, 255, 0)'>target row</span></div><div><span>overscan row</span></div></div></pre></body></html>",
    );
    const controller = attachPtyHistoryProjection(host, { serializeRangeAsHtml });

    expect(
      controller.render({
        kind: "live-backfill",
        startLine: 17,
        endLine: 19,
        rowHeight: 20,
        topOffset: 0,
      }),
    ).toBe(true);

    const backfill = host.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    expect(serializeRangeAsHtml).toHaveBeenCalledWith(17, 19);
    expect(backfill?.textContent).toContain("older row");
    expect(backfill?.textContent).toContain("target row");
    expect(backfill?.textContent).toContain("overscan row");
    expect(backfill?.querySelector(".xterm-rows")?.children).toHaveLength(3);
    expect(backfill?.querySelector('[style*="0, 255, 0"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-slot="pty-live-backfill"]')).toHaveLength(1);
    expect(backfill?.nextElementSibling).toHaveClass("xterm-selection");
    expect(host.style.overflow).toBe("visible");
  });

  it("keeps the terminal row height when live backfill contains more rows", () => {
    const host = createHost();
    const renderedRows = host.querySelector<HTMLElement>(".xterm-rows");
    if (!renderedRows) throw new Error("missing rendered rows");
    Object.defineProperty(renderedRows, "clientHeight", { configurable: true, value: 500 });
    const serializedRows = Array.from(
      { length: 35 },
      (_, index) => `<div><span>row ${index}</span></div>`,
    ).join("");
    const controller = attachPtyHistoryProjection(host, {
      serializeRangeAsHtml: () =>
        `<html><body><pre><div>${serializedRows}</div></pre></body></html>`,
    });

    controller.render({
      kind: "live-backfill",
      startLine: 100,
      endLine: 134,
      rowHeight: 20,
      topOffset: -40,
    });

    const backfill = host.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    const rows = backfill?.querySelector<HTMLElement>(".xterm-rows");
    expect(backfill?.style.top).toBe("-40px");
    expect(backfill?.style.height).toBe("700px");
    expect(rows?.style.height).toBe("700px");
    expect(rows?.firstElementChild).toHaveStyle({ height: "20px", lineHeight: "20px" });
  });

  it("dims serialized glyphs without fading their cell background", () => {
    const host = createHost();
    const controller = attachPtyHistoryProjection(host, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div><span style='color: rgb(150, 150, 150); background-color: rgb(52, 55, 60); opacity: 0.5'>Explain this codebase</span></div></div></pre></body></html>",
    });

    controller.render({
      kind: "live-backfill",
      startLine: 0,
      endLine: 0,
      rowHeight: 20,
      topOffset: 0,
    });

    const cell = host.querySelector<HTMLElement>(
      '[data-slot="pty-live-backfill"] .xterm-rows > div > span',
    );
    const foreground = cell?.firstElementChild;
    expect(cell?.style.backgroundColor).toBe("rgb(52, 55, 60)");
    expect(cell?.style.opacity).toBe("");
    expect(foreground).toBeInstanceOf(HTMLSpanElement);
    expect((foreground as HTMLElement | null)?.style.opacity).toBe("0.5");
    expect(foreground?.textContent).toBe("Explain this codebase");
  });

  it("keeps dim truecolor glyphs identical to xterm's live DOM renderer", () => {
    const host = createHost();
    const sourceRows = [
      [
        { text: "你", isDim: false, isRenderedFgRGB: false },
        { text: "", isDim: false, isRenderedFgRGB: false },
        { text: "R", isDim: true, isRenderedFgRGB: true },
        { text: "G", isDim: true, isRenderedFgRGB: true },
        { text: "B", isDim: true, isRenderedFgRGB: true },
        { text: "P", isDim: true, isRenderedFgRGB: false },
      ],
    ];
    const controller = attachPtyHistoryProjection(host, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div><span>你</span><span style='color: #cdd6f4; opacity: 0.5'>RGB</span><span style='color: #e5e5e5; opacity: 0.5'>P</span></div></div></pre></body></html>",
      getSerializedCell: (line, column) => sourceRows[line]?.[column] ?? null,
    });

    controller.render({
      kind: "live-backfill",
      startLine: 0,
      endLine: 0,
      rowHeight: 20,
      topOffset: 0,
    });

    const spans = host.querySelectorAll<HTMLElement>(
      '[data-slot="pty-live-backfill"] .xterm-rows > div > span',
    );
    expect(spans[1]?.textContent).toBe("RGB");
    expect(spans[1]?.style.color).toBe("rgb(205, 214, 244)");
    expect(spans[1]?.style.opacity).toBe("");
    expect(spans[1]?.children).toHaveLength(0);
    expect(spans[2]?.style.opacity).toBe("");
    expect(spans[2]?.firstElementChild).toHaveStyle({ opacity: "0.5" });
    expect(spans[2]?.textContent).toBe("P");
  });

  it("removes carried dim opacity for a truecolor row without an explicit opening span", () => {
    const host = createHost();
    const sourceRows = [
      [{ text: "A", isDim: true, isRenderedFgRGB: true }],
      [{ text: "B", isDim: true, isRenderedFgRGB: true }],
    ];
    const controller = attachPtyHistoryProjection(host, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div><span></span><span style='color: #cdd6f4; opacity: 0.5'>A</span></div><div><span>B</span></div></div></pre></body></html>",
      getSerializedCell: (line, column) => sourceRows[line]?.[column] ?? null,
    });

    controller.render({
      kind: "live-backfill",
      startLine: 0,
      endLine: 1,
      rowHeight: 20,
      topOffset: 0,
    });

    const rows = host.querySelectorAll<HTMLElement>(
      '[data-slot="pty-live-backfill"] .xterm-rows > div',
    );
    expect(rows[0]?.lastElementChild).toHaveStyle({ color: "rgb(205, 214, 244)" });
    expect((rows[0]?.lastElementChild as HTMLElement | null)?.style.opacity).toBe("");
    expect(rows[1]?.firstElementChild).toHaveStyle({ color: "rgb(205, 214, 244)" });
    expect((rows[1]?.firstElementChild as HTMLElement | null)?.style.opacity).toBe("");
  });

  it("preserves a background that carries onto a blank row", () => {
    const host = createHost();
    const controller = attachPtyHistoryProjection(host, {
      serializeRangeAsHtml: () => `
        <html><body><pre><div>
          <div><span></span><span style="background-color: #393939">   </span></div>
          <div><span></span><span style="background-color: #393939">› prompt   </span></div>
          <div><span>   </span></div>
          <div><span></span><span>next row</span></div>
        </div></pre></body></html>
      `,
    });

    controller.render({
      kind: "live-backfill",
      startLine: 0,
      endLine: 3,
      rowHeight: 20,
      topOffset: 0,
    });

    const rows = host.querySelectorAll<HTMLElement>(
      '[data-slot="pty-live-backfill"] .xterm-rows > div',
    );
    expect(rows[2]?.firstElementChild).toHaveStyle({ backgroundColor: "#393939" });
    expect(rows[3]?.lastElementChild).not.toHaveAttribute("style");
  });

  it("replaces the whole live backfill after its serialized range changes", () => {
    const host = createHost();
    const serializeRangeAsHtml = vi
      .fn()
      .mockReturnValueOnce(
        "<html><body><pre><div><div><span>older viewport</span></div></div></pre></body></html>",
      )
      .mockReturnValueOnce(
        "<html><body><pre><div><div><span>next viewport</span></div></div></pre></body></html>",
      );
    const controller = attachPtyHistoryProjection(host, { serializeRangeAsHtml });

    controller.render({
      kind: "live-backfill",
      startLine: 10,
      endLine: 10,
      rowHeight: 20,
      topOffset: 0,
    });
    controller.render({
      kind: "live-backfill",
      startLine: 11,
      endLine: 11,
      rowHeight: 20,
      topOffset: 0,
    });

    const backfills = host.querySelectorAll<HTMLElement>('[data-slot="pty-live-backfill"]');
    expect(backfills).toHaveLength(1);
    expect(backfills[0]?.textContent).toContain("next viewport");
  });

  it("atomically refreshes preceding live rows above a short host", () => {
    const host = createHost();
    const serializeRangeAsHtml = vi
      .fn()
      .mockReturnValueOnce(
        "<html><body><pre><div><div><span>previous backfill</span></div></div></pre></body></html>",
      )
      .mockReturnValueOnce(
        "<html><body><pre><div><div><span>history 2005</span></div><div><span>history 2006</span></div><div><span>history 2007</span></div><div><span>history 2008</span></div><div><span>history 2009</span></div></div></pre></body></html>",
      );
    const controller = attachPtyHistoryProjection(host, { serializeRangeAsHtml });

    controller.render({
      kind: "live-backfill",
      startLine: 1900,
      endLine: 1902,
      rowHeight: 20,
      topOffset: 0,
    });
    controller.render({
      kind: "live-backfill",
      startLine: 2005,
      endLine: 2009,
      rowHeight: 20,
      topOffset: -100,
    });

    const backfill = host.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    expect(backfill?.textContent).toContain("history 2005");
    expect(backfill?.textContent).toContain("history 2009");
    expect(backfill?.style.top).toBe("-100px");
    expect(backfill?.style.height).toBe("100px");
    expect(host.querySelectorAll('[data-slot="pty-live-backfill"]')).toHaveLength(1);
    expect(serializeRangeAsHtml).toHaveBeenLastCalledWith(2005, 2009);
  });

  it("clears live backfill when the projection is no longer needed", () => {
    const host = createHost();
    const controller = attachPtyHistoryProjection(host, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div><span>viewport</span></div></div></pre></body></html>",
    });

    controller.render({
      kind: "live-backfill",
      startLine: 0,
      endLine: 0,
      rowHeight: 20,
      topOffset: 0,
    });
    controller.render(null);

    expect(host.querySelector('[data-slot="pty-live-backfill"]')).toBeNull();
    expect(host.style.overflow).toBe("");
  });
});
