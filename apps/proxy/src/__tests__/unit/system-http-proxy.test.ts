import { describe, expect, it, vi } from "vitest";
import { withSystemHttpProxy } from "../../common/system-http-proxy.js";

const macProxy = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 10.0.0.0/8
    2 : localhost
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 3128
  HTTPSProxy : ::1
  ProxyAutoConfigEnable : 0
  __SCOPED__ : <dictionary> {
    en1 : <dictionary> {
      HTTPSProxy : different.invalid
    }
  }
}`;

describe("withSystemHttpProxy", () => {
  it("inherits static HTTP and HTTPS routes and preserves bypasses in both casings", () => {
    const base = { HOME: "/home/dev" };
    expect(withSystemHttpProxy(base, "darwin", () => macProxy)).toEqual({
      HOME: "/home/dev",
      HTTP_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://[::1]:3128",
      https_proxy: "http://[::1]:3128",
      NO_PROXY: "localhost,127.0.0.1,::1,.local,10.0.0.0/8",
      no_proxy: "localhost,127.0.0.1,::1,.local,10.0.0.0/8",
    });
    expect(base).toEqual({ HOME: "/home/dev" });
  });

  it.each(["HTTPS_PROXY", "http_proxy", "ALL_PROXY"])("honors an explicit %s", (key) => {
    const reader = vi.fn(() => macProxy);
    const env = { [key]: "" };
    expect(withSystemHttpProxy(env, "darwin", reader)).toBe(env);
    expect(reader).not.toHaveBeenCalled();
  });

  it("keeps an explicit bypass list", () => {
    const result = withSystemHttpProxy({ no_proxy: "internal.example" }, "darwin", () => macProxy);
    expect(result.no_proxy).toBe("internal.example");
    expect(result.HTTPS_PROXY).toBe("http://[::1]:3128");
  });

  it("leaves dynamic, disabled, missing or non-Mac settings alone", () => {
    const env = { HOME: "/home/dev" };
    const reader = vi.fn(() => macProxy);
    expect(withSystemHttpProxy(env, "win32", reader)).toBe(env);
    expect(reader).not.toHaveBeenCalled();
    expect(
      withSystemHttpProxy(env, "darwin", () => macProxy.replace("Enable : 0", "Enable : 1")),
    ).toBe(env);
    expect(withSystemHttpProxy(env, "darwin", () => "<dictionary> {\n  HTTPSEnable : 0\n}")).toBe(
      env,
    );
    expect(
      withSystemHttpProxy(env, "darwin", () => {
        throw new Error("scutil unavailable");
      }),
    ).toBe(env);
  });
});
