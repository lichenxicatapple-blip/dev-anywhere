import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeSeqCounter, getSeqCounterFor } from "#src/common/seq-counter.js";

// 复现日志里看到的 ENOENT: terminateSession 的 onSessionRemoved 先 rmSync 了 session 目录,
// cleanupSessionResources 紧接着 disposeSeqCounter, 走 flush → save → atomicWriteFileSync
// 命中已不存在的目录。dispose 语义是"释放, 不再关心", 此时 flush 没意义 (sessionId 是
// nanoid 不复用, 续号也不会再用)。
describe("disposeSeqCounter after session directory removed", () => {
  it("does not throw when session directory has been removed", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "seq-dispose-test-"));
    const sessionId = "test-session-rm";
    const counter = getSeqCounterFor(sessionId, baseDir);
    counter.next();
    counter.next();

    rmSync(baseDir, { recursive: true, force: true });

    expect(() => disposeSeqCounter(sessionId)).not.toThrow();
  });
});
