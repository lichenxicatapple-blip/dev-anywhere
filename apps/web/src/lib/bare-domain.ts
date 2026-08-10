// Bare domains and bare filenames are syntactically ambiguous (package.json vs example.com).
// Keep the product's conservative TLD policy in one place so chat links, downloads and PTY
// selections cannot drift independently. Explicit URLs are handled before this heuristic.
const RECOGNIZED_BARE_DOMAIN_TLDS = new Set([
  "ai",
  "app",
  "biz",
  "cloud",
  "cn",
  "co",
  "com",
  "de",
  "dev",
  "fr",
  "in",
  "info",
  "io",
  "jp",
  "me",
  "net",
  "nl",
  "online",
  "org",
  "ru",
  "site",
  "tech",
  "tools",
  "top",
  "uk",
  "us",
  "xyz",
]);

export function isRecognizedBareDomain(value: string): boolean {
  const host = value.split(/[/?#]/, 1)[0] ?? "";
  const labels = host.split(".");
  if (labels.length < 2) return false;
  const tld = (labels.at(-1) ?? "").toLowerCase();
  if (!RECOGNIZED_BARE_DOMAIN_TLDS.has(tld)) return false;
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}
