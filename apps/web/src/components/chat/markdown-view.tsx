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

function CodeBlock({ children, ...rest }: { children?: ReactNode }) {
  return (
    <pre className="my-3 rounded-md bg-muted p-3 overflow-x-auto text-[13px]">
      <code {...rest}>{children}</code>
    </pre>
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
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
