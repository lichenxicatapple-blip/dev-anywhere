import { findInlinePathLinks, type InlinePathLinkKind } from "./inline-path-links";

export interface UserMessageAttachment {
  kind: InlinePathLinkKind;
  path: string;
}

export interface UserMessageAttachmentContent {
  bodyText: string;
  attachments: UserMessageAttachment[];
}

// 上传流程会把附件以连续的 `@<path>` 追加到消息末尾。只折叠这段明确的后缀，
// 正文中用于讨论代码的普通路径仍交给 MarkdownView 保持原来的内联链接行为。
export function extractUserMessageAttachments(text: string): UserMessageAttachmentContent {
  const matches = findInlinePathLinks(text);
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
