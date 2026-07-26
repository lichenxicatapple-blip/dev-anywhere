import { describe, expect, it } from "vitest";
import { resolveInitialPtyGeometry } from "#src/serve/relay-session-create-handler.js";

describe("initial PTY geometry", () => {
  it("preserves an adaptive geometry above the baseline", () => {
    expect(resolveInitialPtyGeometry({ cols: 125, rows: 34 })).toEqual({
      cols: 125,
      rows: 34,
    });
  });

  it("enforces the QR-safe 80x24 baseline", () => {
    expect(resolveInitialPtyGeometry({ cols: 42, rows: 12 })).toEqual({
      cols: 80,
      rows: 24,
    });
  });

  it("keeps old clients on the baseline", () => {
    expect(resolveInitialPtyGeometry({})).toEqual({ cols: 80, rows: 24 });
  });
});
