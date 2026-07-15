import { describe, expect, it } from "vitest";
import {
  SESSION_CREATE_CLIENT_TIMEOUT_MS,
  SESSION_CREATE_RESPONSE_GRACE_MS,
  SESSION_CREATE_SERVER_DEADLINE_MS,
} from "./session-create.js";

describe("session create deadline contract", () => {
  it("keeps the browser deadline after the proxy deadline by the response grace", () => {
    expect(SESSION_CREATE_CLIENT_TIMEOUT_MS).toBe(
      SESSION_CREATE_SERVER_DEADLINE_MS + SESSION_CREATE_RESPONSE_GRACE_MS,
    );
    expect(SESSION_CREATE_RESPONSE_GRACE_MS).toBeGreaterThan(0);
  });
});
