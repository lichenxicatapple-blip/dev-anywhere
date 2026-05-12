// 统一的 e2e session fixture: localRuntime + hostedPty + jsonMode 三字段合在一个 base test.
// 单 spec 内可同时混用 (各 fixture lazy 激活, 不会强制 spawn 不需要的 session).
import { execSync } from "node:child_process";
import { test as runtimeTest } from "./local-runtime";
import { spawnSessionViaRelay, type SessionViaRelay } from "./relay-control";

interface Fixtures {
  hostedPty: SessionViaRelay;
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
  hostedPty: async ({ localRuntime }, use, testInfo) => {
    if (!claudeOnPath()) {
      testInfo.skip(true, "hostedPty fixture 需要真 claude CLI (PATH 找不到)");
      return;
    }
    const session = await spawnSessionViaRelay(localRuntime, {
      mode: "pty",
      cwd: "/tmp",
      provider: "claude",
    });
    try {
      await use(session);
    } finally {
      await session.terminate();
    }
  },

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
