/** macOS services may inherit no locale, causing shells to escape UTF-8 filenames. */
export function withPtyLocaleFallback(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "darwin" || env.LANG || env.LC_ALL || env.LC_CTYPE) return env;
  // LANG has lower precedence than LC_* and can still be replaced by shell startup files.
  return { ...env, LANG: "en_US.UTF-8" };
}
