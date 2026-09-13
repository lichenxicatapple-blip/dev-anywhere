import { beforeEach, expect, it, vi } from "vitest";
import { listFileSystemRoots } from "#src/common/filesystem-roots.js";
import { RelayResourceHandlers } from "#src/serve/relay-resource-handlers.js";

vi.mock("#src/common/filesystem-roots.js", () => ({ listFileSystemRoots: vi.fn() }));
vi.mock("#src/common/logger.js", () => ({ serviceLogger: { warn: vi.fn() } }));

beforeEach(() => vi.mocked(listFileSystemRoots).mockReset());

it.each([false, true])("returns a correlated disk listing, failure=%s", async (failure) => {
  if (failure) vi.mocked(listFileSystemRoots).mockRejectedValueOnce(new Error("permission denied"));
  else vi.mocked(listFileSystemRoots).mockResolvedValueOnce([{ name: "D:\\", path: "D:\\" }]);
  const relaySend = vi.fn();
  const handlers = new RelayResourceHandlers({
    relaySend,
    controlHandlers: {} as never,
    sessionManager: {} as never,
    getProviderEnv: () => ({}),
    getAgentCliSuggestions: () => ({}),
    setAgentCliPath: vi.fn(),
  });
  await handlers.onFileSystemRootsRequest({
    type: "filesystem_roots_request",
    requestId: "roots-1",
  });
  expect(JSON.parse(relaySend.mock.calls[0]![0])).toMatchObject({
    type: "filesystem_roots_response",
    requestId: "roots-1",
    roots: failure ? [] : [{ name: "D:\\", path: "D:\\" }],
    ...(failure ? { errorCode: "UNKNOWN", error: "无法读取磁盘位置" } : {}),
  });
});
