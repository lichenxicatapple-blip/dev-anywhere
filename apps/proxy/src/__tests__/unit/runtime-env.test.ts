import { describe, expect, it } from "vitest";
import { loadProxyRuntimeEnv } from "../../common/runtime-env.js";

describe("loadProxyRuntimeEnv", () => {
  it("returns all-undefined / falsy defaults for an empty env", () => {
    const env = loadProxyRuntimeEnv({});
    expect(env).toEqual({
      relayUrl: undefined,
      relayProxyToken: undefined,
      hookPort: undefined,
      claudeBin: undefined,
      codexBin: undefined,
      logLevel: undefined,
      isVitest: false,
    });
  });

  it("trims empty strings to undefined", () => {
    const env = loadProxyRuntimeEnv({
      RELAY_URL: "",
      CLAUDE_BIN: "",
    });
    expect(env.relayUrl).toBeUndefined();
    expect(env.claudeBin).toBeUndefined();
  });

  it("parses HOOK_PORT and rejects out-of-range values", () => {
    expect(loadProxyRuntimeEnv({ DEV_ANYWHERE_HOOK_PORT: "8000" }).hookPort).toBe(8000);
    expect(() => loadProxyRuntimeEnv({ DEV_ANYWHERE_HOOK_PORT: "0" })).toThrow(/TCP port/);
    expect(() => loadProxyRuntimeEnv({ DEV_ANYWHERE_HOOK_PORT: "70000" })).toThrow(/TCP port/);
    expect(() => loadProxyRuntimeEnv({ DEV_ANYWHERE_HOOK_PORT: "abc" })).toThrow(/TCP port/);
  });

  it("validates LOG_LEVEL against the allowed set", () => {
    expect(loadProxyRuntimeEnv({ LOG_LEVEL: "debug" }).logLevel).toBe("debug");
    expect(loadProxyRuntimeEnv({ LOG_LEVEL: "silent" }).logLevel).toBe("silent");
    expect(() => loadProxyRuntimeEnv({ LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("flags VITEST as truthy whenever the var is set", () => {
    expect(loadProxyRuntimeEnv({ VITEST: "true" }).isVitest).toBe(true);
    expect(loadProxyRuntimeEnv({ VITEST: "1" }).isVitest).toBe(true);
    expect(loadProxyRuntimeEnv({ VITEST: "" }).isVitest).toBe(false);
  });
});
