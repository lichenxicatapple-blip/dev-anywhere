import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import {
  isNamedPipeEndpoint,
  localIpcEndpointMayExist,
  prepareLocalIpcEndpoint,
  removeLocalIpcEndpoint,
  setLocalIpcEndpointPermissions,
} from "#src/common/local-ipc-endpoint.js";

vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("local IPC filesystem boundary", () => {
  it("never treats a Windows pipe as a filesystem entry", () => {
    for (const endpoint of ["\\\\.\\pipe\\example", "\\\\?\\pipe\\example"]) {
      expect(isNamedPipeEndpoint(endpoint)).toBe(true);
      prepareLocalIpcEndpoint(endpoint);
      setLocalIpcEndpointPermissions(endpoint);
      removeLocalIpcEndpoint(endpoint);
      expect(localIpcEndpointMayExist(endpoint)).toBe(true);
    }
    for (const operation of [chmodSync, existsSync, mkdirSync, unlinkSync]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("keeps POSIX permission, existence and stale-entry operations", () => {
    const endpoint = "/tmp/isolated/control.sock";
    expect(isNamedPipeEndpoint(endpoint)).toBe(false);
    prepareLocalIpcEndpoint(endpoint);
    setLocalIpcEndpointPermissions(endpoint);
    removeLocalIpcEndpoint(endpoint);
    expect(localIpcEndpointMayExist(endpoint)).toBe(false);
    expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(chmodSync).toHaveBeenCalledWith(endpoint, 0o600);
    expect(unlinkSync).toHaveBeenCalledWith(endpoint);
    expect(existsSync).toHaveBeenCalledWith(endpoint);
  });

  it("does not hide unexpected filesystem permission errors", () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw error;
    });
    expect(() => removeLocalIpcEndpoint("/tmp/isolated/control.sock")).toThrow(error);
  });
});
