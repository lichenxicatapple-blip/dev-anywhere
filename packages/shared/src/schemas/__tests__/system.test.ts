import { describe, it, expect } from "vitest";
import { SyncRequestPayloadSchema, SyncResponsePayloadSchema } from "../system.js";

describe("SyncRequestPayloadSchema", () => {
  it("rejects negative lastSeq", () => {
    expect(() => SyncRequestPayloadSchema.parse({ lastSeq: -1 })).toThrow();
  });

  it("rejects non-integer lastSeq", () => {
    expect(() => SyncRequestPayloadSchema.parse({ lastSeq: 1.5 })).toThrow();
  });

  it("rejects missing lastSeq", () => {
    expect(() => SyncRequestPayloadSchema.parse({})).toThrow();
  });
});

describe("SyncResponsePayloadSchema", () => {
  it("accepts valid sync response with messages", () => {
    const result = SyncResponsePayloadSchema.parse({
      messages: [{ some: "message" }],
    });
    expect(result.messages).toHaveLength(1);
  });

  it("accepts empty messages array", () => {
    const result = SyncResponsePayloadSchema.parse({ messages: [] });
    expect(result.messages).toEqual([]);
  });

  it("rejects missing messages", () => {
    expect(() => SyncResponsePayloadSchema.parse({})).toThrow();
  });
});
