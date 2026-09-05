import { spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateOwnedProcessTree } from "#src/common/process-termination.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

function ownedChild(overrides: Partial<ChildProcess> = {}): ChildProcess {
  return {
    pid: 456,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    ...overrides,
  } as unknown as ChildProcess;
}

describe("owned command termination", () => {
  it("retains existing signal behavior on POSIX", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const child = ownedChild();
    expect(terminateOwnedProcessTree(child, "SIGKILL")).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("terminates only the owned Windows process subtree", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    const child = ownedChild();
    expect(terminateOwnedProcessTree(child)).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "456", "/T", "/F"],
      expect.objectContaining({ windowsHide: true, timeout: 5_000 }),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    { pid: undefined },
    { pid: -1 },
    { pid: 0 },
    { exitCode: 0 },
    { signalCode: "SIGTERM" as const },
  ])("does not target an invalid or already exited child: %j", (overrides) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(terminateOwnedProcessTree(ownedChild(overrides))).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("reports an unsuccessful tree termination", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    expect(terminateOwnedProcessTree(ownedChild())).toBe(false);
  });
});
