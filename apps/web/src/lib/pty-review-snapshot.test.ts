import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPtyReviewSnapshot } from "./pty-review-snapshot";

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

describe("attachPtyReviewSnapshot", () => {
  it("builds a styled preview directly from a serialized buffer range", () => {
    const host = createHost();
    const serializeRangeAsHtml = vi.fn(
      () =>
        "<html><body><pre><div style='color: rgb(220, 220, 220)'><div><span>older row</span></div><div><span style='color: rgb(0, 255, 0)'>target row</span></div><div><span>overscan row</span></div></div></pre></body></html>",
    );
    const controller = attachPtyReviewSnapshot(host, { serializeRangeAsHtml });

    expect(controller.captureRange(17, 2)).toBe(true);

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
    const controller = attachPtyReviewSnapshot(host, { serializeRangeAsHtml });

    controller.captureRange(10, 1);
    controller.captureRange(11, 1);

    const snapshots = host.querySelectorAll<HTMLElement>('[data-slot="pty-review-snapshot"]');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.textContent).toContain("next viewport");
  });

  it("clears the frozen layer when following resumes", () => {
    const host = createHost();
    const controller = attachPtyReviewSnapshot(host, {
      serializeRangeAsHtml: () =>
        "<html><body><pre><div><div><span>viewport</span></div></div></pre></body></html>",
    });

    controller.captureRange(0, 1);
    controller.clear();

    expect(host.querySelector('[data-slot="pty-review-snapshot"]')).toBeNull();
    expect(host.style.overflow).toBe("");
  });
});
