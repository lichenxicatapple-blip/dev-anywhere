import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTopLevelScript, spawnScript } from "#src/common/env.js";
import { createLoggerFake } from "./test-fakes.js";

// 等待子进程彻底结束（exit + 所有 stdio 流关闭），保证 stderr 的 data 事件已派发完
function waitForClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("close", () => resolve()));
}

const fixtureUrl = new URL("../fixtures/spawn-child", import.meta.url);

describe("spawnScript with logger", () => {
  it("forwards child stderr lines to logger.warn", async () => {
    const logger = createLoggerFake();
    const child = spawnScript(fixtureUrl, ["stderr", "0"], { logger, unref: false });
    await waitForClose(child);

    const warnMsgs = logger.calls.filter((c) => c.level === "warn").map((c) => c.msg);
    expect(warnMsgs).toContain("line one");
    expect(warnMsgs).toContain("line two");
  });

  it("logs error with code when child exits non-zero", async () => {
    const logger = createLoggerFake();
    const child = spawnScript(fixtureUrl, ["quiet", "2"], { logger, unref: false });
    await waitForClose(child);

    const errors = logger.calls.filter((c) => c.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe("child exited abnormally");
    expect(errors[0]!.obj).toMatchObject({ code: 2 });
  });

  it("flushes trailing partial line (no newline) when stream ends", async () => {
    const logger = createLoggerFake();
    const child = spawnScript(fixtureUrl, ["partial", "0"], { logger, unref: false });
    await waitForClose(child);

    const warnMsgs = logger.calls.filter((c) => c.level === "warn").map((c) => c.msg);
    expect(warnMsgs).toContain("complete-line");
    // 关键：没带 \n 的最后一行也要被 flush 出来，不能被吞
    expect(warnMsgs).toContain("trailing-no-newline");
  });

  it("stays silent on clean zero exit", async () => {
    const logger = createLoggerFake();
    const child = spawnScript(fixtureUrl, ["quiet", "0"], { logger, unref: false });
    await waitForClose(child);

    expect(logger.calls.filter((c) => c.level === "error")).toHaveLength(0);
  });
});

describe("spawnScript without logger", () => {
  it("defaults to stdio ignore, child.stderr is null", async () => {
    const child = spawnScript(fixtureUrl, ["stderr", "1"], { unref: false });
    await waitForClose(child);
    expect(child.stderr).toBeNull();
  });
});

// Regression: serve-bootstrap.ts / worker-registry.ts 嵌在 src/terminal/ 与 src/serve/ 子目录，
// 早期 API 让调用方写 `new URL("../serve", import.meta.url)`——src 下相对父目录是对的，但 tsup
// 把所有 chunk 拍平到 dist/ 根目录后，`../serve` 反而跳出 dist/ 命中包根目录，daemon 启动报
// `Cannot find module '.../proxy/serve.js'`。这两条用例守住"按 entry 名解析必须落在和 env.ts
// 同布局的目录"——dev 下与 env.ts 同在 src/ 下、prod 下与 chunk 同在 dist/ 下。
describe("resolveTopLevelScript", () => {
  it("points to src/<name> when env.ts runs from source layout (dev/test)", () => {
    const url = resolveTopLevelScript("serve");
    const path = fileURLToPath(url);
    // vitest 跑源码 IS_DEV 为 true，此时应解析到 apps/proxy/src/serve（spawnScript 再补 .ts 后缀）
    expect(path.endsWith("/apps/proxy/src/serve")).toBe(true);
  });

  it("composes the entry name verbatim without escaping the package root", () => {
    const url = resolveTopLevelScript("session-worker");
    const path = fileURLToPath(url);
    expect(path.endsWith("/apps/proxy/src/session-worker")).toBe(true);
    // 关键防回归：不能再出现 `../<name>` 把路径推到 apps/proxy/<name> 这一层
    expect(path).not.toMatch(/\/apps\/proxy\/session-worker$/);
  });
});

describe("spawnScript captures pre-logger crash", () => {
  // 子进程在 module load 阶段就 throw，此时它自己的 logger 还没初始化。
  // 这是真实世界"早期启动错误"最典型的场景（import 失败、语法错误、top-level throw 等）。
  // 验证：父进程的 logger 能拿到子进程 Node runtime 打到 stderr 的原始 Error stack。
  it("captures Node runtime stderr from a child throwing at module load", async () => {
    const logger = createLoggerFake();
    const crashUrl = new URL("../fixtures/crash-on-load", import.meta.url);
    const child = spawnScript(crashUrl, [], { logger, unref: false });
    await waitForClose(child);

    const warnMsgs = logger.calls.filter((c) => c.level === "warn").map((c) => c.msg);
    // Node 打的 stack trace 里一定包含 Error message
    expect(warnMsgs.some((m) => m.includes("crash-on-load"))).toBe(true);

    // 同时非零 exit 也落进 error
    const errors = logger.calls.filter((c) => c.level === "error");
    expect(errors.some((e) => e.msg === "child exited abnormally")).toBe(true);
  });
});
