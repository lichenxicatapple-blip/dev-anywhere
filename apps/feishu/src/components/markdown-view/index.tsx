// Markdown 渲染组件，使用 marked 解析 + highlight.js 语法高亮
// RichText 用于兼容飞书小程序运行时，inline style 替代 CSS class 着色
import { useMemo } from "react";
import { View, RichText } from "@tarojs/components";
import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import diff from "highlight.js/lib/languages/diff";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("diff", diff);

marked.setOptions({
  async: false,
  breaks: true,
  gfm: true,
});

// atom-one-dark 主题的 hljs class 到 inline style 映射
// RichText 不支持外部 CSS class 选择器，必须用 inline style
const HLJS_STYLES: Record<string, string> = {
  "hljs-comment": "color:#5c6370;font-style:italic",
  "hljs-quote": "color:#5c6370;font-style:italic",
  "hljs-doctag": "color:#c678dd",
  "hljs-keyword": "color:#c678dd",
  "hljs-formula": "color:#c678dd",
  "hljs-section": "color:#e06c75",
  "hljs-name": "color:#e06c75",
  "hljs-selector-tag": "color:#e06c75",
  "hljs-deletion": "color:#e06c75",
  "hljs-subst": "color:#e06c75",
  "hljs-literal": "color:#56b6c2",
  "hljs-string": "color:#98c379",
  "hljs-regexp": "color:#98c379",
  "hljs-addition": "color:#98c379",
  "hljs-attribute": "color:#98c379",
  "hljs-attr": "color:#d19a66",
  "hljs-variable": "color:#d19a66",
  "hljs-template-variable": "color:#d19a66",
  "hljs-type": "color:#d19a66",
  "hljs-selector-class": "color:#d19a66",
  "hljs-selector-attr": "color:#d19a66",
  "hljs-selector-pseudo": "color:#d19a66",
  "hljs-number": "color:#d19a66",
  "hljs-symbol": "color:#61afe2",
  "hljs-bullet": "color:#61afe2",
  "hljs-link": "color:#61afe2",
  "hljs-meta": "color:#61afe2",
  "hljs-selector-id": "color:#61afe2",
  "hljs-title": "color:#61afe2",
  "hljs-built_in": "color:#e6c07b",
  "hljs-emphasis": "font-style:italic",
  "hljs-strong": "font-weight:bold",
};

// 将 highlight.js 输出中的 class="hljs-xxx" 替换为 style="..." inline 属性
// 处理单 class 和多 class 的情况
function inlineHljsStyles(html: string): string {
  return html.replace(
    /class="([^"]+)"/g,
    (_match: string, classes: string) => {
      const styles = classes
        .split(/\s+/)
        .map((cls: string) => HLJS_STYLES[cls])
        .filter(Boolean);
      if (styles.length === 0) return "";
      return `style="${styles.join(";")}"`;
    },
  );
}

// 自定义 renderer：代码块使用 highlight.js 着色 + inline style
const renderer = new marked.Renderer();
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value;
  const inlined = inlineHljsStyles(highlighted);
  return `<pre style="background:#282c34;border-radius:6px;padding:10px 12px;overflow-x:auto;margin:8px 0"><code style="font-family:Sarasa Fixed SC,monospace,Menlo,Courier;font-size:13px;line-height:1.5;color:#abb2bf">${inlined}</code></pre>`;
};

renderer.codespan = function ({ text }: { text: string }) {
  return `<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;color:#e06c75;word-break:break-all">${text}</code>`;
};

interface MarkdownViewProps {
  text: string;
  className?: string;
}

export function MarkdownView({ text, className }: MarkdownViewProps) {
  const html = useMemo(() => {
    if (!text) return "";
    return marked.parse(text, { renderer }) as string;
  }, [text]);

  return (
    <View className={`markdown-view ${className || ""}`}>
      <RichText nodes={html} />
    </View>
  );
}
