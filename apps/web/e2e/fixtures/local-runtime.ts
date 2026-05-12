// localRuntime fixture (worker scope): 共享一个隔离 relay + proxy daemon 给 spec 用.
// 真正的 spawn / teardown 在 runtime-spawn.ts; chaos spec 直接调 spawnLocalRuntime
// 自管 lifecycle 注入 chaos agent.
import { test as base } from "@playwright/test";
import { dumpLastFailureLog, spawnLocalRuntime, type LocalRuntime } from "./runtime-spawn";

export type { LocalRuntime } from "./runtime-spawn";

interface Fixtures {
  localRuntime: LocalRuntime;
}

export const test = base.extend<Record<never, never>, Fixtures>({
  localRuntime: [
    async ({}, use) => {
      const rt = await spawnLocalRuntime();
      try {
        await use(rt);
      } catch (err) {
        await dumpLastFailureLog(rt.profileHome);
        throw err;
      } finally {
        await rt.destroy();
      }
    },
    { scope: "worker", timeout: 60_000 },
  ],
});

export { expect } from "@playwright/test";
