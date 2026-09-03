import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientOperationId } from "./client-operation-id";

describe("createClientOperationId", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses randomUUID when the browser provides it", () => {
    expect(
      createClientOperationId("preview", {
        randomUUID: () => "12345678-1234-4234-8234-123456789abc",
      }),
    ).toBe("preview-12345678-1234-4234-8234-123456789abc");
  });

  it("uses getRandomValues when randomUUID is unavailable on a LAN HTTP origin", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0);
      return bytes;
    });

    expect(
      createClientOperationId("device-preview", {
        getRandomValues: getRandomValues as Crypto["getRandomValues"],
      }),
    ).toBe("device-preview-00000000-0000-4000-8000-000000000000");
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it("uses getRandomValues when an embedded browser exposes but rejects randomUUID", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(1);
      return bytes;
    });

    expect(
      createClientOperationId("device-preview", {
        randomUUID: () => {
          throw new DOMException("Not allowed", "SecurityError");
        },
        getRandomValues: getRandomValues as Crypto["getRandomValues"],
      }),
    ).toBe("device-preview-01010101-0101-4101-8101-010101010101");
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it("rejects environments without Web Crypto", () => {
    expect(() => createClientOperationId("preview", null)).toThrow(
      "当前浏览器无法生成预览操作标识",
    );
  });
});
