const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'，。；：！？、）】》」』]+/giu;
const AUTOLINK_PATTERN = /<https?:\/\/[^>]+>/giu;
const REFERENCE_DEFINITION_PATTERN =
  /^\s{0,3}\[[^\]]+\]:\s*https?:\/\/\S+(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gimu;
const TRAILING_URL_PUNCTUATION = /[),.;:!?，。；：！？、）】》」』]+$/u;

interface MarkdownDestination {
  end: number;
}

function findClosingBracket(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "]") return index;
  }
  return -1;
}

function findMarkdownDestination(text: string, start: number): MarkdownDestination | null {
  if (text[start] !== "(") return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return { end: index + 1 };
    }
  }
  return null;
}

function replaceInlineMarkdownLinks(text: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < text.length) {
    const image = text.startsWith("![", cursor);
    const labelStart = image ? cursor + 2 : text[cursor] === "[" ? cursor + 1 : -1;
    if (labelStart < 0) {
      result += text[cursor];
      cursor += 1;
      continue;
    }

    const labelEnd = findClosingBracket(text, labelStart);
    const destination = labelEnd >= 0 ? findMarkdownDestination(text, labelEnd + 1) : null;
    if (!destination) {
      result += text[cursor];
      cursor += 1;
      continue;
    }

    const label = text.slice(labelStart, labelEnd).replace(/\\([\[\]])/gu, "$1").trim();
    result += image ? (label ? `图片：${label}` : "图片") : label || "链接";
    cursor = destination.end;
  }

  return result;
}

function replaceBareUrl(url: string): string {
  const trailing = url.match(TRAILING_URL_PUNCTUATION)?.[0] ?? "";
  return `链接${trailing}`;
}

export function prepareSpeechText(text: string): string {
  return replaceInlineMarkdownLinks(text)
    .replace(REFERENCE_DEFINITION_PATTERN, "")
    .replace(AUTOLINK_PATTERN, "链接")
    .replace(URL_PATTERN, replaceBareUrl)
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/(^|\s)(?:#{1,6}|>|[-*+])\s+/gmu, "$1")
    .replace(/(\*\*|__|~~)(.*?)\1/gu, "$2")
    .replace(/[*_]/gu, "")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*\n\s*/gu, "，")
    .replace(/，{2,}/gu, "，")
    .replace(/^[，\s]+|[，\s]+$/gu, "")
    .trim();
}
