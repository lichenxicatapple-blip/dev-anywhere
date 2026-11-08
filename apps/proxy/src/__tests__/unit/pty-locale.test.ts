import { describe, expect, it } from "vitest";
import { withPtyLocaleFallback } from "#src/common/pty-locale.js";

describe("PTY locale fallback", () => {
  it("adds a macOS UTF-8 default without mutating the inherited environment", () => {
    const env = Object.freeze({ PATH: "/usr/bin:/bin", KEEP_ME: "yes" });
    expect(withPtyLocaleFallback(env, "darwin")).toEqual({ ...env, LANG: "en_US.UTF-8" });
    expect(env).not.toHaveProperty("LANG");
  });

  it("treats empty character locale settings as unset and preserves other categories", () => {
    const env = Object.freeze({
      LANG: "",
      LC_ALL: "",
      LC_CTYPE: "",
      LC_TIME: "de_DE.UTF-8",
      LANGUAGE: "fr",
    });
    expect(withPtyLocaleFallback(env, "darwin")).toEqual({ ...env, LANG: "en_US.UTF-8" });
    expect(env.LANG).toBe("");
  });

  it.each([
    { LANG: "zh_CN.UTF-8" },
    { LANG: "C" },
    { LC_ALL: "POSIX" },
    { LC_CTYPE: "en_US.ISO8859-1" },
    { LANG: "", LC_ALL: "", LC_CTYPE: "UTF-8" },
  ])("preserves an explicitly configured locale: %j", (locale) => {
    const env = Object.freeze({ PATH: "/usr/bin:/bin", ...locale });
    expect(withPtyLocaleFallback(env, "darwin")).toBe(env);
  });

  it.each(["linux", "win32", "freebsd"] as const)(
    "leaves %s environments unchanged when no locale is configured",
    (platform) => {
      const env = Object.freeze({ PATH: "keep-path" });
      expect(withPtyLocaleFallback(env, platform)).toBe(env);
    },
  );
});
