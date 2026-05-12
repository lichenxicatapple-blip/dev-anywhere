// jsonMode fixture: localRuntime 之上加一个 mode=json 的 session, proxy spawn 出
// session-worker, worker 跑 claude --input/output-format stream-json. 依赖真 claude CLI.
import { execSync } from "node:child_process";
import { test as runtimeTest } from "./local-runtime";
import { spawnSessionViaRelay, type SessionViaRelay } from "./relay-control";

interface Fixtures {
  jsonMode: SessionViaRelay;
}

function claudeOnPath(): boolean {
  try {
    execSync("command -v claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const test = runtimeTest.extend<Fixtures>({
  jsonMode: async ({ localRuntime }, use, testInfo) => {
    if (!claudeOnPath()) {
      testInfo.skip(true, "jsonMode fixture 需要真 claude CLI (PATH 找不到)");
      return;
    }
    const session = await spawnSessionViaRelay(localRuntime, {
      mode: "json",
      cwd: "/tmp",
      provider: "claude",
    });
    try {
      await use(session);
    } finally {
      await session.terminate();
    }
  },
});

export { expect } from "@playwright/test";
