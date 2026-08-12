import { isFileDownloadPath } from "./file-download-path";
import { isImagePreviewPath } from "./image-preview-path";
import type { InlinePathLinkKind } from "./inline-path-links";

export interface UserMessageAttachment {
  kind: InlinePathLinkKind;
  path: string;
}

interface UserMessageAttachmentContent {
  bodyText: string;
  attachments: UserMessageAttachment[];
}

interface ExplicitAttachmentMatch extends UserMessageAttachment {
  start: number;
  end: number;
}

// 上传流程的 `@<path>` 后缀是结构化附件的历史 wire format，不属于
// 正文自动链接识别。只在消息尾部解析它，以保留已上传的空格文件名预览卡；
// Markdown / PTY 里的普通路径仍以空白为硬边界。
function findExplicitAttachmentSuffixMatches(text: string): ExplicitAttachmentMatch[] {
  const matches: ExplicitAttachmentMatch[] = [];
  for (const match of text.matchAll(/(?<!\S)@(.+?)(?=\s+@|\s*$)/gu)) {
    const path = match[1] ?? "";
    const start = match.index ?? -1;
    if (start < 0 || !path) continue;
    const kind = isImagePreviewPath(path)
      ? "image"
      : isFileDownloadPath(path, { allowBare: true })
        ? "file"
        : null;
    if (!kind) continue;
    matches.push({ kind, path, start, end: start + (match[0]?.length ?? 0) });
  }
  return matches;
}

// 上传流程会把附件以连续的 `@<path>` 追加到消息末尾。只折叠这段明确的后缀，
// 正文中用于讨论代码的普通路径仍交给 MarkdownView 保持原来的内联链接行为。
export function extractUserMessageAttachments(text: string): UserMessageAttachmentContent {
  const matches = findExplicitAttachmentSuffixMatches(text);
  const attachments: UserMessageAttachment[] = [];
  let suffixStart = text.trimEnd().length;

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (!match) continue;
    if (!/^\s*$/u.test(text.slice(match.end, suffixStart))) break;
    if (text[match.start] !== "@") break;
    attachments.unshift({ kind: match.kind, path: match.path });
    suffixStart = match.start;
  }

  if (attachments.length === 0) return { bodyText: text, attachments: [] };
  return { bodyText: text.slice(0, suffixStart).trimEnd(), attachments };
}
