import { describe, it, expect } from "vitest";
import {
  HeartbeatPayloadSchema,
  ErrorPayloadSchema,
  AuthPayloadSchema,
  SyncRequestPayloadSchema,
  SyncResponsePayloadSchema,
} from "../system.js";

describe("HeartbeatPayloadSchema", () => {
  it("accepts empty object", () => {
    const result = HeartbeatPayloadSchema.parse({});
    expect(result).toEqual({});
  });

  it("strips extra fields", () => {
    const result = HeartbeatPayloadSchema.parse({ extra: "field" });
    expect(result).toEqual({});
  });
});

describe("ErrorPayloadSchema", () => {
  it("accepts valid error payload", () => {
    const result = ErrorPayloadSchema.parse({
      code: "AUTH_FAILED",
      message: "Invalid token",
    });
    expect(result).toEqual({ code: "AUTH_FAILED", message: "Invalid token" });
  });

  it("rejects missing code", () => {
    expect(() =>
      ErrorPayloadSchema.parse({ message: "something" }),
    ).toThrow();
  });

  it("rejects missing message", () => {
    expect(() => ErrorPayloadSchema.parse({ code: "UNKNOWN" })).toThrow();
  });
});

describe("AuthPayloadSchema", () => {
  it("accepts auth with pairing code", () => {
    const result = AuthPayloadSchema.parse({ pairingCode: "123456" });
    expect(result).toEqual({ pairingCode: "123456" });
  });

  it("accepts auth with token", () => {
    const result = AuthPayloadSchema.parse({ token: "jwt-token-here" });
    expect(result).toEqual({ token: "jwt-token-here" });
  });

  it("accepts auth with both pairing code and token", () => {
    const result = AuthPayloadSchema.parse({
      pairingCode: "123456",
      token: "jwt-token",
    });
    expect(result).toEqual({ pairingCode: "123456", token: "jwt-token" });
  });

  it("accepts auth with neither", () => {
    const result = AuthPayloadSchema.parse({});
    expect(result).toEqual({});
  });
});

describe("SyncRequestPayloadSchema", () => {
  it("accepts valid sync request", () => {
    const result = SyncRequestPayloadSchema.parse({ lastSeq: 0 });
    expect(result).toEqual({ lastSeq: 0 });
  });

  it("accepts positive lastSeq", () => {
    const result = SyncRequestPayloadSchema.parse({ lastSeq: 42 });
    expect(result).toEqual({ lastSeq: 42 });
  });

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
