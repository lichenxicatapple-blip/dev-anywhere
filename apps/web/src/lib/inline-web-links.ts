import { isRecognizedBareDomain } from "./bare-domain";

interface InlineWebLinkMatch {
  text: string;
  url: string;
  start: number;
  end: number;
}

const BARE_WEB_LINK_RE =
  /(?<![A-Za-z0-9@:/])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?(?=[\s`"'<>),.;:!?,。；：！？、]|$)/gi;

function trimWebToken(value: string): string {
  return value.replace(/[)\].,;:!?，。；：！？、]+$/u, "");
}

export function findInlineWebLinks(text: string): InlineWebLinkMatch[] {
  const matches: InlineWebLinkMatch[] = [];
  for (const match of text.matchAll(BARE_WEB_LINK_RE)) {
    const raw = match[0] ?? "";
    const start = match.index ?? -1;
    if (start < 0) continue;

    const token = trimWebToken(raw);
    if (!isRecognizedBareDomain(token)) continue;
    matches.push({ text: token, url: `https://${token}`, start, end: start + raw.length });
  }
  return matches;
}
