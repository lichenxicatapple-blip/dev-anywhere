import { describe, it, expect } from "vitest";
import type { ProxyInfo } from "@cc-anywhere/shared";
import { resolveColdStart } from "@/pages/proxy-select/cold-start";

const onlineProxy: ProxyInfo = { proxyId: "p1", name: "my-mac", online: true };
const offlineProxy: ProxyInfo = { proxyId: "p1", name: "my-mac", online: false };
const otherProxy: ProxyInfo = { proxyId: "p2", name: "work", online: true };

describe("resolveColdStart", () => {
  it("returns null when no saved proxyId", () => {
    expect(resolveColdStart("", "", [onlineProxy])).toBeNull();
  });

  it("returns null when saved proxy is offline", () => {
    expect(resolveColdStart("p1", "", [offlineProxy])).toBeNull();
  });

  it("returns null when saved proxy not in list", () => {
    expect(resolveColdStart("p1", "", [otherProxy])).toBeNull();
  });

  it("navigates to session-list when proxy online but no saved session", () => {
    const result = resolveColdStart("p1", "", [onlineProxy, otherProxy]);
    expect(result).toEqual({
      proxy: onlineProxy,
      url: "/pages/session-list/index",
    });
  });

  it("navigates to chat when proxy online and session saved", () => {
    const result = resolveColdStart("p1", "s123", [onlineProxy]);
    expect(result).toEqual({
      proxy: onlineProxy,
      url: "/pages/chat/index?sessionId=s123",
    });
  });

  it("ignores offline proxy even with saved session", () => {
    expect(resolveColdStart("p1", "s123", [offlineProxy])).toBeNull();
  });
});
