// Markdown 视图: react-markdown + GFM + rehype-highlight (github-dark)
// 强制 skipHtml + disallowedElements 防御 XSS (RESEARCH §2.7)
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { memo, type ReactNode } from "react";

interface MarkdownViewProps {
  text: string;
}

// 代码块: 与表格同策略, 外包 not-prose + overflow-x-auto 容器承担滚动
// 直接在 <pre> 上加 overflow-x 会被 prose / highlight.js 注入样式干扰, 分层更稳
function CodeBlock({ children, ...rest }: { children?: ReactNode }) {
  return (
    <div className="not-prose my-3 overflow-x-auto rounded-md bg-popover">
      <pre className="p-3 text-[13px]">
        <code {...rest}>{children}</code>
      </pre>
    </div>
  );
}

export const MarkdownView = memo(function MarkdownView({
  text,
}: MarkdownViewProps) {
  return (
    <div className="prose prose-invert prose-sm max-w-none">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        skipHtml
        disallowedElements={["script", "iframe", "object", "embed"]}
        components={{
          a: ({ href, children, ...rest }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...rest}
            >
              {children}
            </a>
          ),
          code: ({ className, children, ...rest }) => {
            const isBlock =
              typeof className === "string" && className.includes("language-");
            if (isBlock) {
              return (
                <CodeBlock {...rest}>
                  <span className={className}>{children}</span>
                </CodeBlock>
              );
            }
            return (
              <code
                className="rounded bg-muted px-1 py-0.5 text-[0.9em]"
                {...rest}
              >
                {children}
              </code>
            );
          },
          // GFM 表格: prose 默认样式弱且被 bubble 挤压, 自定义带边框 + 外层 overflow-x-auto
          // not-prose 禁用 prose 对 table/th/td 的默认规则, 避免与自定义冲突
          // th/td 用 whitespace-nowrap 让宽度按内容撑开, 超过 bubble 宽度时外层滚动
          table: ({ children, ...rest }) => (
            <div className="not-prose my-3 w-fit max-w-full overflow-x-auto rounded-md border border-border/60">
              <table className="border-collapse text-[13px]" {...rest}>
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
        {text}
      </Markdown>
    </div>
  );
});
