import { afterEach, describe, expect, it } from "vitest";
import { captureBrowserStateDump, getBrowserStateDumpMode } from "./browser-state-dump";

describe("browser-state-dump", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
    delete window.__devAnywhereLastBrowserStateDump;
  });

  it("enables automatic mode from the debugDump hash query", () => {
    window.history.replaceState(null, "", "/#/chat/s1?mode=pty&debugDump=auto");

    expect(getBrowserStateDumpMode()).toBe("auto");
  });

  it("keeps the existing debugInput route as a manual dump entry", () => {
    window.history.replaceState(null, "", "/#/chat/s1?mode=pty&debugInput=1");

    expect(getBrowserStateDumpMode()).toBe("manual");
  });

  it("captures the current DOM and focused input metadata", () => {
    document.body.innerHTML = `
      <main data-slot="chat-pty-view">
        <section data-slot="pty-terminal" style="overflow: auto">
          <textarea class="xterm-helper-textarea" aria-label="Terminal input" autocomplete="off">hello</textarea>
        </section>
      </main>
    `;
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("missing textarea");
    textarea.focus();

    const dump = captureBrowserStateDump("test");

    expect(dump.trigger).toBe("test");
    expect(dump.document.activeElement?.tag).toBe("textarea");
    expect(dump.document.activeElement?.attrs["aria-label"]).toBe("Terminal input");
    expect(dump.document.activeElement?.attrs.autocomplete).toBe("off");
    expect(dump.document.root.kind).toBe("element");
    expect(dump.document.nodeCount).toBeGreaterThan(1);
    expect(window.__devAnywhereLastBrowserStateDump).toBe(dump);
  });
});
