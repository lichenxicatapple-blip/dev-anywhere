import { afterEach, describe, expect, it } from "vitest";
import { getRelayClientToken, RELAY_CLIENT_TOKEN_KEY, toClientWsUrl } from "./relay-client-token";

describe("relay client token handling", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("persists a relay client token from the URL for PWA relaunches", () => {
    window.history.replaceState(null, "", "/?relayToken=client-secret");

    expect(getRelayClientToken()).toBe("client-secret");
    expect(localStorage.getItem(RELAY_CLIENT_TOKEN_KEY)).toBe("client-secret");
    expect(sessionStorage.getItem(RELAY_CLIENT_TOKEN_KEY)).toBe("client-secret");

    window.history.replaceState(null, "", "/");
    sessionStorage.clear();

    expect(getRelayClientToken()).toBe("client-secret");
  });

  it("adds the stored relay client token to the client websocket URL", () => {
    localStorage.setItem(RELAY_CLIENT_TOKEN_KEY, "token with spaces");

    expect(toClientWsUrl("https://relay.example.com")).toBe(
      "wss://relay.example.com/client?token=token%20with%20spaces",
    );
  });
});
