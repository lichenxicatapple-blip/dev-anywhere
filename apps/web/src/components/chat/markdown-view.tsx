// Markdown 视图: react-markdown + GFM + rehype-highlight (github-dark)
// 强制 skipHtml + disallowedElements 防御 XSS (RESEARCH §2.7)
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Children, cloneElement, isValidElement, memo, type ReactNode } from "react";
import { Download, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { findInlinePathLinks, type InlinePathLinkKind } from "@/lib/inline-path-links";
import { useFileDownload } from "./file-download-link";
import { useImagePreview } from "./image-preview";

interface MarkdownViewProps {
  text: string;
  tone?: "default" | "on-primary";
  trailingInline?: ReactNode;
}

const TRAILING_INLINE_MARKER = "\uE000";
const INLINE_PATH_SCHEME = "dev-anywhere-path:";

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MarkdownAstNode[];
};

function replaceTrailingInlineMarker(node: ReactNode, trailingInline: ReactNode): ReactNode {
  if (typeof node === "string") {
    const markerIndex = node.indexOf(TRAILING_INLINE_MARKER);
    if (markerIndex === -1) return node;
    return (
      <>
        {node.slice(0, markerIndex)}
        {trailingInline}
        {node.slice(markerIndex + TRAILING_INLINE_MARKER.length)}
      </>
    );
  }

  if (Array.isArray(node)) {
    return node.map((child) => replaceTrailingInlineMarker(child, trailingInline));
  }

  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children) {
    return cloneElement(
      node,
      undefined,
      replaceTrailingInlineMarker(node.props.children, trailingInline),
    );
  }

  return node;
}

function renderWithTrailingInline(children: ReactNode, trailingInline?: ReactNode): ReactNode {
  if (!trailingInline) return children;
  return Children.map(children, (child) => replaceTrailingInlineMarker(child, trailingInline));
}

function encodeInlinePathHref(kind: InlinePathLinkKind, path: string): string {
  return `${INLINE_PATH_SCHEME}${kind}:${encodeURIComponent(path)}`;
}

function decodeInlinePathHref(href: string): { kind: InlinePathLinkKind; path: string } | null {
  if (!href.startsWith(INLINE_PATH_SCHEME)) return null;
  const rest = href.slice(INLINE_PATH_SCHEME.length);
  const separator = rest.indexOf(":");
  if (separator === -1) return null;
  const kind = rest.slice(0, separator);
  if (kind !== "file" && kind !== "image") return null;
  return { kind, path: decodeURIComponent(rest.slice(separator + 1)) };
}

function markdownUrlTransform(value: string, key: string, node: unknown): string {
  if (value.startsWith(INLINE_PATH_SCHEME)) return value;
  void key;
  void node;
  return defaultUrlTransform(value);
}

function linkifyTextNode(value: string): MarkdownAstNode[] {
  const matches = findInlinePathLinks(value);
  if (matches.length === 0) return [{ type: "text", value }];

  const nodes: MarkdownAstNode[] = [];
  let offset = 0;
  for (const match of matches) {
    if (match.start > offset) {
      nodes.push({ type: "text", value: value.slice(offset, match.start) });
    }
    nodes.push({
      type: "link",
      url: encodeInlinePathHref(match.kind, match.path),
      title: null,
      children: [{ type: "text", value: match.path }],
    });
    offset = match.end;
  }
  if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
  return nodes;
}

function linkifyInlinePathNodes(node: MarkdownAstNode): void {
  if (!node.children) return;
  const nextChildren: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      nextChildren.push(...linkifyTextNode(child.value));
      continue;
    }
    if (
      !["link", "linkReference", "definition", "inlineCode", "code", "html", "yaml"].includes(
        child.type,
      )
    ) {
      linkifyInlinePathNodes(child);
    }
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

function remarkInlinePathLinks() {
  return (tree: MarkdownAstNode) => {
    linkifyInlinePathNodes(tree);
  };
}

function InlinePathAction({
  href,
  children,
  tone,
}: {
  href: string;
  children: ReactNode;
  tone: "default" | "on-primary";
}) {
  const decoded = decodeInlinePathHref(href);
  const { download } = useFileDownload();
  const { openImagePreview } = useImagePreview();

  if (!decoded) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  const isImage = decoded.kind === "image";
  const Icon = isImage ? ImageIcon : Download;
  return (
    <button
      type="button"
      data-slot={isImage ? "inline-image-preview-link" : "inline-file-download-link"}
      title={decoded.path}
      aria-label={`${isImage ? "预览" : "下载"} ${decoded.path}`}
      className={cn(
        "inline cursor-pointer items-baseline rounded-sm border-0 bg-transparent p-0 font-mono text-[0.95em] underline decoration-dotted underline-offset-2 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "on-primary"
          ? "text-primary-foreground hover:bg-primary-foreground/10"
          : "text-[var(--color-status-working)] hover:bg-accent/70",
      )}
      onClick={() => {
        if (isImage) openImagePreview(decoded.path);
        else download(decoded.path);
      }}
    >
      <Icon className="mr-1 inline size-3 align-[-0.125em]" aria-hidden="true" />
      {children}
    </button>
  );
}

// 代码块: 与表格同策略, 外包 not-prose + overflow-x-auto 容器承担滚动
// 直接在 <pre> 上加 overflow-x 会被 prose / highlight.js 注入样式干扰, 分层更稳
function CodeBlock({ children, ...rest }: { children?: ReactNode }) {
  return (
    <div className="dev-render-scroll not-prose my-3 overflow-x-auto rounded-md bg-popover">
      <pre className="p-3 text-[0.92em]">
        <code {...rest}>{children}</code>
      </pre>
    </div>
  );
}

export const MarkdownView = memo(function MarkdownView({
  text,
  tone = "default",
  trailingInline,
}: MarkdownViewProps) {
  const markdownText = trailingInline ? `${text}${TRAILING_INLINE_MARKER}` : text;

  return (
    <div
      className={cn(
        "prose prose-invert prose-sm max-w-none",
        tone === "on-primary" && "dev-markdown-on-primary",
      )}
      style={{ fontSize: "inherit" }}
    >
      <Markdown
        remarkPlugins={[remarkGfm, remarkInlinePathLinks]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={markdownUrlTransform}
        skipHtml
        disallowedElements={["script", "iframe", "object", "embed"]}
        components={{
          // react-markdown 默认把 fenced code 包成 <pre><code>, 外层 <pre> 落在 .not-prose 之外
          // 会吃上 prose 默认的 rgba(0,0,0,.5) 黑底, 与 CodeBlock 内部 wrapper 形成两层
          // 这里让 <pre> 透传, 由 code 分支的 CodeBlock 独占包装
          pre: ({ children }) => <>{children}</>,
          p: ({ children, ...rest }) => (
            <p {...rest}>{renderWithTrailingInline(children, trailingInline)}</p>
          ),
          li: ({ children, ...rest }) => (
            <li {...rest}>{renderWithTrailingInline(children, trailingInline)}</li>
          ),
          a: ({ href = "", children }) => (
            <InlinePathAction href={href} tone={tone}>
              {children}
            </InlinePathAction>
          ),
          code: ({ className, children, ...rest }) => {
            const isBlock = typeof className === "string" && className.includes("language-");
            if (isBlock) {
              return (
                <CodeBlock {...rest}>
                  <span className={className}>{children}</span>
                </CodeBlock>
              );
            }
            return (
              <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]" {...rest}>
                {children}
              </code>
            );
          },
          // GFM 表格: prose 默认样式弱且被 bubble 挤压, 自定义带边框 + 外层 overflow-x-auto
          // not-prose 禁用 prose 对 table/th/td 的默认规则, 避免与自定义冲突
          // th/td 用 whitespace-nowrap 让宽度按内容撑开, 超过 bubble 宽度时外层滚动
          table: ({ children, ...rest }) => (
            <div className="dev-render-scroll not-prose my-3 w-fit max-w-full overflow-x-auto rounded-md border border-border/60">
              <table className="border-collapse text-[0.92em]" {...rest}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...rest }) => (
            <thead className="bg-foreground/5" {...rest}>
              {children}
            </thead>
          ),
          th: ({ children, style, ...rest }) => (
            <th
              className="border border-border/60 px-3 py-1.5 text-left font-semibold whitespace-nowrap"
              style={style}
              {...rest}
            >
              {children}
            </th>
          ),
          td: ({ children, style, ...rest }) => (
            <td
              className="border border-border/60 px-3 py-1.5 whitespace-nowrap align-top"
              style={style}
              {...rest}
            >
              {children}
            </td>
          ),
        }}
      >
        {markdownText}
      </Markdown>
    </div>
  );
});
