import { afterEach, describe, expect, it, vi } from "vitest";
import { RELAY_CONTROL_PROTOCOL_VERSION } from "@dev-anywhere/shared";
import { checkRelayClientPreflight } from "./relay-client-auth";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("relay client auth preflight", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not require a token when relay client auth is disabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        controlProtocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        auth: { clientTokenRequired: false },
      }),
    );

    await expect(checkRelayClientPreflight("https://relay.example.com", null)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a missing client token before opening the websocket", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        controlProtocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        auth: { clientTokenRequired: true },
      }),
    );

    await expect(checkRelayClientPreflight("https://relay.example.com", null)).resolves.toBe(
      "missing_client_token",
    );
  });

  it("reports an invalid stored client token", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          controlProtocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
          auth: { clientTokenRequired: true },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "invalid_client_token" }, { status: 401 }));

    await expect(
      checkRelayClientPreflight("https://relay.example.com", "stale-token"),
    ).resolves.toBe("invalid_client_token");
  });

  it("accepts a valid stored client token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          controlProtocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
          auth: { clientTokenRequired: true },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      checkRelayClientPreflight("https://relay.example.com", "client-secret"),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://relay.example.com/api/auth/client",
      expect.objectContaining({
        headers: { authorization: "Bearer client-secret" },
      }),
    );
  });

  it.each([
    [undefined, "service_outdated"],
    [0, "protocol_mismatch"],
    [RELAY_CONTROL_PROTOCOL_VERSION + 1, "page_outdated"],
  ] as const)(
    "classifies Relay control protocol %s as %s before authentication or WebSocket setup",
    async (controlProtocolVersion, expectedIssue) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          ...(controlProtocolVersion !== undefined ? { controlProtocolVersion } : {}),
          auth: { clientTokenRequired: true },
        }),
      );

      await expect(
        checkRelayClientPreflight("https://relay.example.com", "client-secret"),
      ).resolves.toBe(expectedIssue);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a malformed advertised version distinct from either update direction", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        controlProtocolVersion: "newest",
        auth: { clientTokenRequired: false },
      }),
    );

    await expect(checkRelayClientPreflight("https://relay.example.com", null)).resolves.toBe(
      "protocol_mismatch",
    );
  });
});
