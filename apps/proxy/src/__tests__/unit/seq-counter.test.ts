import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeqCounter } from "#src/common/seq-counter.js";

describe("SeqCounter", () => {
  it("persists flushed sequence numbers across restarts", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "seq-counter-test-"));

    try {
      const counter = new SeqCounter("test-session", baseDir);
      expect(counter.current()).toBe(0);
      expect(counter.next()).toBe(1);
      expect(counter.next()).toBe(2);

      counter.flush();

      const restarted = new SeqCounter("test-session", baseDir);
      expect(restarted.current()).toBe(2);
      expect(restarted.next()).toBe(3);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
