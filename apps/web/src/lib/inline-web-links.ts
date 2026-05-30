interface InlineWebLinkMatch {
  text: string;
  url: string;
  start: number;
  end: number;
}

const DOMAIN_TLD_RE =
  /^(?:com|net|org|io|dev|app|top|cn|ai|co|me|xyz|site|online|cloud|tools|tech|info|biz|us|uk|de|jp|fr|ru|nl|in)$/i;
const BARE_WEB_LINK_RE =
  /(?<![A-Za-z0-9@:/])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?(?=[\s`"'<>),.;:!?,。；：！？、]|$)/gi;

function trimWebToken(value: string): string {
  return value.replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

function isBareDomainLike(value: string): boolean {
  const host = value.split(/[/?#]/, 1)[0] ?? "";
  const labels = host.split(".");
  if (labels.length < 2) return false;
  const tld = labels.at(-1) ?? "";
  if (!DOMAIN_TLD_RE.test(tld)) return false;
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

export function findInlineWebLinks(text: string): InlineWebLinkMatch[] {
  const matches: InlineWebLinkMatch[] = [];
  for (const match of text.matchAll(BARE_WEB_LINK_RE)) {
    const raw = match[0] ?? "";
    const start = match.index ?? -1;
    if (start < 0) continue;

    const token = trimWebToken(raw);
    if (!isBareDomainLike(token)) continue;
    matches.push({ text: token, url: `https://${token}`, start, end: start + raw.length });
  }
  return matches;
}
