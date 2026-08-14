import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPtyHistoryProjection } from "./pty-history-projection";

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
  it("builds a styled preview directly from a serialized buffer range", () => {
    const host = createHost();
    const serializeRangeAsHtml = vi.fn(
      () =>
        "<html><body><pre><div style='color: rgb(220, 220, 220)'><div><span>older row</span></div><div><span style='color: rgb(0, 255, 0)'>target row</span></div><div><span>overscan row</span></div></div></pre></body></html>",
    );
    const controller = attachPtyHistoryProjection(host, { serializeRangeAsHtml });

    expect(
      controller.render({
        kind: "review",
        startLine: 17,
        endLine: 19,
        rowHeight: 20,
        topOffset: 0,
      }),
    ).toBe(true);

    const snapshot = host.querySelector<HTMLElement>('[data-slot="pty-review-snapshot"]');
    expect(serializeRangeAsHtml).toHaveBeenCalledWith(17, 19);
    expect(snapshot?.textContent).toContain("older row");
    expect(snapshot?.textContent).toContain("target row");
    expect(snapshot?.textContent).toContain("overscan row");
    expect(snapshot?.querySelector(".xterm-rows")?.children).toHaveLength(3);
    expect(snapshot?.querySelector('[style*="0, 255, 0"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-slot="pty-review-snapshot"]')).toHaveLength(1);
    expect(snapshot?.nextElementSibling).toHaveClass("xterm-selection");
    expect(host.style.overflow).toBe("visible");
  });

  it("keeps the terminal row height when an expanded review viewport captures more rows", () => {
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
      kind: "review",
      startLine: 100,
      endLine: 134,
      rowHeight: 20,
      topOffset: -40,
    });

    const snapshot = host.querySelector<HTMLElement>('[data-slot="pty-review-snapshot"]');
    const rows = snapshot?.querySelector<HTMLElement>(".xterm-rows");
    expect(snapshot?.style.top).toBe("-40px");
    expect(snapshot?.style.height).toBe("700px");
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
      kind: "review",
      startLine: 0,
      endLine: 0,
      rowHeight: 20,
      topOffset: 0,
    });

    const cell = host.querySelector<HTMLElement>(
      '[data-slot="pty-review-snapshot"] .xterm-rows > div > span',
    );
    const foreground = cell?.firstElementChild;
    expect(cell?.style.backgroundColor).toBe("rgb(52, 55, 60)");
    expect(cell?.style.opacity).toBe("");
    expect(foreground).toBeInstanceOf(HTMLSpanElement);
    expect((foreground as HTMLElement | null)?.style.opacity).toBe("0.5");
    expect(foreground?.textContent).toBe("Explain this codebase");
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
      kind: "review",
      startLine: 0,
      endLine: 3,
      rowHeight: 20,
      topOffset: 0,
    });

    const rows = host.querySelectorAll<HTMLElement>(
      '[data-slot="pty-review-snapshot"] .xterm-rows > div',
    );
    expect(rows[2]?.firstElementChild).toHaveStyle({ backgroundColor: "#393939" });
    expect(rows[3]?.lastElementChild).not.toHaveAttribute("style");
  });

  it("replaces the whole snapshot after deliberate navigation", () => {
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
      kind: "review",
      startLine: 10,
      endLine: 10,
      rowHeight: 20,
      topOffset: 0,
    });
    controller.render({
      kind: "review",
      startLine: 11,
      endLine: 11,
      rowHeight: 20,
      topOffset: 0,
    });

    const snapshots = host.querySelectorAll<HTMLElement>('[data-slot="pty-review-snapshot"]');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.textContent).toContain("next viewport");
  });

  it("atomically replaces review with preceding live rows above a short host", () => {
    const host = createHost();
    const serializeRangeAsHtml = vi
      .fn()
      .mockReturnValueOnce(
        "<html><body><pre><div><div><span>review frame</span></div></div></pre></body></html>",
      )
      .mockReturnValueOnce(
        "<html><body><pre><div><div><span>history 2005</span></div><div><span>history 2006</span></div><div><span>history 2007</span></div><div><span>history 2008</span></div><div><span>history 2009</span></div></div></pre></body></html>",
      );
    const controller = attachPtyHistoryProjection(host, { serializeRangeAsHtml });

    controller.render({
      kind: "review",
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

    expect(host.querySelector('[data-slot="pty-review-snapshot"]')).toBeNull();
    const backfill = host.querySelector<HTMLElement>('[data-slot="pty-live-backfill"]');
    expect(backfill?.textContent).toContain("history 2005");
    expect(backfill?.textContent).toContain("history 2009");
    expect(backfill?.style.top).toBe("-100px");
    expect(backfill?.style.height).toBe("100px");
    expect(host.querySelectorAll('[data-slot="pty-live-backfill"]')).toHaveLength(1);
    expect(serializeRangeAsHtml).toHaveBeenLastCalledWith(2005, 2009);
  });

  it("clears the frozen layer when following resumes", () => {
    const host = createHost();
    const controller = attachPtyHistoryProjection(host, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div><span>viewport</span></div></div></pre></body></html>",
    });

    controller.render({
      kind: "review",
      startLine: 0,
      endLine: 0,
      rowHeight: 20,
      topOffset: 0,
    });
    controller.render(null);

    expect(host.querySelector('[data-slot="pty-review-snapshot"]')).toBeNull();
    expect(host.style.overflow).toBe("");
  });
});
