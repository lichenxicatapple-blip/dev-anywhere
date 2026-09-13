import { isRecognizedBareDomain } from "./bare-domain";

interface UrlTextRange {
  start: number;
  end: number;
}

// Detect a URL start, then keep its path/query/fragment together. The left boundary excludes
// email addresses and local path components; bare hosts use the existing conservative TLD policy.
const URL_TOKEN_PATTERN =
  /(?<![\p{L}\p{N}_@/\\.-])(?:[a-z][a-z0-9+.-]*:\/\/|(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,})[^\s`"'<>\\|，。；：！？、“”‘’]*/giu;
const CLOSING_PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function trimTrailingProse(token: string): string {
  let end = token.length;
  while (end > 0) {
    const last = token[end - 1];
    if (/[.,;:!?]/.test(last)) {
      end -= 1;
      continue;
    }
    const opening = CLOSING_PAIRS[last];
    if (!opening) break;
    let balance = 0;
    for (const char of token.slice(0, end)) {
      if (char === opening) balance += 1;
      else if (char === last) balance -= 1;
    }
    if (balance >= 0) break;
    end -= 1;
  }
  return token.slice(0, end);
}

export function findUrlTextRanges(text: string): UrlTextRange[] {
  const ranges: UrlTextRange[] = [];
  for (const match of text.matchAll(URL_TOKEN_PATTERN)) {
    const token = trimTrailingProse(match[0]);
    const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(token);
    try {
      const url = new URL(explicit ? token : `https://${token}`);
      if (!url.hostname && url.protocol !== "file:") continue;
      if (!explicit && !isRecognizedBareDomain(url.hostname)) continue;
    } catch {
      continue;
    }
    ranges.push({ start: match.index, end: match.index + token.length });
  }
  return ranges;
}
