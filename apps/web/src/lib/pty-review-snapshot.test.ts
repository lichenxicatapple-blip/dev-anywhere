import { afterEach, describe, expect, it } from "vitest";
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
  it("freezes the rendered rows without replacing the live xterm row layer", () => {
    const host = createHost();
    const rows = host.querySelector<HTMLElement>(".xterm-rows");
    const controller = attachPtyReviewSnapshot(host);

    expect(controller.capture()).toBe(true);
    rows!.firstElementChild!.textContent = "live update";

    const snapshot = host.querySelector<HTMLElement>('[data-slot="pty-review-snapshot"]');
    expect(snapshot?.textContent).toContain("history");
    expect(snapshot?.textContent).not.toContain("live update");
    expect(host.querySelectorAll(".xterm-rows")).toHaveLength(2);
    expect(snapshot?.nextElementSibling).toHaveClass("xterm-selection");
  });

  it("replaces the whole snapshot after deliberate navigation", () => {
    const host = createHost();
    const rows = host.querySelector<HTMLElement>(".xterm-rows");
    const controller = attachPtyReviewSnapshot(host);

    controller.capture();
    rows!.firstElementChild!.textContent = "next viewport";
    controller.capture();

    const snapshots = host.querySelectorAll<HTMLElement>('[data-slot="pty-review-snapshot"]');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.textContent).toContain("next viewport");
  });

  it("clears the frozen layer when following resumes", () => {
    const host = createHost();
    const controller = attachPtyReviewSnapshot(host);

    controller.capture();
    controller.clear();

    expect(host.querySelector('[data-slot="pty-review-snapshot"]')).toBeNull();
  });
});
