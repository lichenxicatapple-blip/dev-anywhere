import { afterEach, describe, expect, it } from "vitest";
import {
  clearRelayClientToken,
  consumeRelayClientTokenFromFragment,
  getRelayClientToken,
  hasStoredRelayClientToken,
  persistRelayClientToken,
  RELAY_CLIENT_TOKEN_KEY,
  toClientWsUrl,
} from "./relay-client-token";

describe("relay client token handling", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("ignores relayToken query and only reads storage", () => {
    window.history.replaceState(null, "", "/?relayToken=client-secret");

    expect(getRelayClientToken()).toBeNull();
    expect(hasStoredRelayClientToken()).toBe(false);
    expect(localStorage.getItem(RELAY_CLIENT_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(RELAY_CLIENT_TOKEN_KEY)).toBeNull();
  });

  it("imports a relay token from the URL fragment and removes it from the address", () => {
    window.history.replaceState(null, "", "/#/chat/session-1?mode=pty&relayToken=quick-secret");

    expect(consumeRelayClientTokenFromFragment()).toBe("quick-secret");
    expect(getRelayClientToken()).toBe("quick-secret");
    expect(window.location.hash).toBe("#/chat/session-1?mode=pty");
  });

  it("lets a Quick Tunnel fragment replace a stale stored token", () => {
    persistRelayClientToken("stale-token");
    window.history.replaceState(null, "", "/#/?relayToken=fresh-token");

    consumeRelayClientTokenFromFragment();

    expect(getRelayClientToken()).toBe("fresh-token");
    expect(window.location.hash).toBe("#/");
  });

  it("persists explicitly via persistRelayClientToken and survives URL strip", () => {
    persistRelayClientToken("client-secret");

    expect(localStorage.getItem(RELAY_CLIENT_TOKEN_KEY)).toBe("client-secret");
    expect(sessionStorage.getItem(RELAY_CLIENT_TOKEN_KEY)).toBe("client-secret");

    window.history.replaceState(null, "", "/");
    sessionStorage.clear();

    expect(getRelayClientToken()).toBe("client-secret");
  });

  it("stored token wins over relayToken query", () => {
    persistRelayClientToken("old-stored");
    window.history.replaceState(null, "", "/?relayToken=new-from-url");

    expect(getRelayClientToken()).toBe("old-stored");
    expect(hasStoredRelayClientToken()).toBe(true);
  });

  it("clearRelayClientToken removes from both storages", () => {
    persistRelayClientToken("doomed");
    clearRelayClientToken();

    expect(localStorage.getItem(RELAY_CLIENT_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(RELAY_CLIENT_TOKEN_KEY)).toBeNull();
  });

  it("adds the stored relay client token to the client websocket URL", () => {
    persistRelayClientToken("token with spaces");

    expect(toClientWsUrl("https://relay.example.com")).toBe(
      "wss://relay.example.com/client?token=token%20with%20spaces",
    );
  });
});
