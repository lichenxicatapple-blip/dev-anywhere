// Markdown 渲染组件，使用 marked 解析 + highlight.js 语法高亮
// RichText 用于兼容飞书小程序运行时，inline style 替代 CSS class 着色
import { useMemo } from "react";
import { View, RichText, ScrollView } from "@tarojs/components";
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

// 基础文字颜色，小程序 rich-text 不继承外部 CSS，必须 inline
const BASE_COLOR = "rgba(255,255,255,0.85)";
const MUTED_COLOR = "rgba(255,255,255,0.5)";
const LINK_COLOR = "#1890FF";
const BORDER_COLOR = "rgba(255,255,255,0.12)";
const THEAD_BG = "rgba(255,255,255,0.08)";

// 自定义 renderer：所有样式 inline 化，兼容小程序 rich-text
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

renderer.paragraph = function ({ text }: { text: string }) {
  return `<p style="color:${BASE_COLOR};margin:0 0 8px 0">${text}</p>`;
};

renderer.heading = function ({ text, depth }: { text: string; depth: number }) {
  const sizes = { 1: "18px", 2: "16px", 3: "15px", 4: "14px" } as const;
  const size = sizes[depth as keyof typeof sizes] || "14px";
  return `<h${depth} style="color:${BASE_COLOR};font-size:${size};font-weight:600;line-height:1.3;margin:12px 0 6px 0">${text}</h${depth}>`;
};

// table/tablerow/tablecell 不覆盖 renderer（marked v18 传 token 对象而非 HTML 字符串）
// 改为 inlineTableStyles 后处理注入样式

function inlineStructuralStyles(html: string): string {
  return html
    // 表格（不加外层 div，由 ScrollView 组件提供横向滚动）
    .replace(/<table>/g, `<table style="border-collapse:collapse;font-size:13px;color:${BASE_COLOR}">`)
    .replace(/<thead>/g, `<thead style="background:${THEAD_BG}">`)
    .replace(/<th align="([^"]*)">/g, `<th style="border:1px solid ${BORDER_COLOR};padding:6px 8px;text-align:$1;font-weight:600;color:${BASE_COLOR};white-space:nowrap">`)
    .replace(/<th>/g, `<th style="border:1px solid ${BORDER_COLOR};padding:6px 8px;text-align:left;font-weight:600;color:${BASE_COLOR};white-space:nowrap">`)
    .replace(/<td align="([^"]*)">/g, `<td style="border:1px solid ${BORDER_COLOR};padding:6px 8px;text-align:$1;color:${BASE_COLOR};white-space:nowrap">`)
    .replace(/<td>/g, `<td style="border:1px solid ${BORDER_COLOR};padding:6px 8px;text-align:left;color:${BASE_COLOR};white-space:nowrap">`)
    // 列表
    .replace(/<ul>/g, `<ul style="margin:6px 0;padding-left:20px;color:${BASE_COLOR}">`)
    .replace(/<ol>/g, `<ol style="margin:6px 0;padding-left:20px;color:${BASE_COLOR}">`)
    .replace(/<li>/g, `<li style="margin:2px 0;color:${BASE_COLOR}">`)
    // 引用块
    .replace(/<blockquote>/g, `<blockquote style="margin:8px 0;padding:4px 12px;border-left:3px solid rgba(255,255,255,0.2);color:${MUTED_COLOR}">`)
    // 分割线
    .replace(/<hr>/g, `<hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:12px 0">`)
    // 链接
    .replace(/<a href="/g, `<a style="color:${LINK_COLOR};text-decoration:none" href=`)
    // 加粗、斜体
    .replace(/<strong>/g, `<strong style="font-weight:600">`)
    .replace(/<em>/g, `<em style="font-style:italic">`);
}

// blockquote/hr/link/list/listitem/strong/em 不覆盖 renderer
// marked v18 部分 renderer 传 token 对象而非字符串，统一用后处理注入样式

// 将 HTML 按 <table>...</table> 边界拆分成多段
// 表格段需要用 ScrollView 包裹才能在小程序中横向滚动
type Segment = { type: "html"; content: string } | { type: "table"; content: string };

function splitTableSegments(html: string): Segment[] {
  const segments: Segment[] = [];
  const tableRe = /<table[\s>][\s\S]*?<\/table>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tableRe.exec(html)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "html", content: html.slice(lastIndex, match.index) });
    }
    segments.push({ type: "table", content: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < html.length) {
    segments.push({ type: "html", content: html.slice(lastIndex) });
  }
  return segments;
}

interface MarkdownViewProps {
  text: string;
  className?: string;
}

export function MarkdownView({ text, className }: MarkdownViewProps) {
  const segments = useMemo(() => {
    if (!text) return [];
    const raw = marked.parse(text, { renderer }) as string;
    const styled = inlineStructuralStyles(raw);
    return splitTableSegments(styled);
  }, [text]);

  if (segments.length === 0) return null;

  // 没有表格时直接渲染单个 RichText
  if (segments.length === 1 && segments[0].type === "html") {
    return (
      <View className={`markdown-view ${className || ""}`}>
        <RichText nodes={segments[0].content} />
      </View>
    );
  }

  return (
    <View className={`markdown-view ${className || ""}`}>
      {segments.map((seg, i) =>
        seg.type === "table" ? (
          <ScrollView key={i} scrollX style={{ margin: "8px 0" }}>
            <RichText nodes={seg.content} style={{ display: "inline-block" }} />
          </ScrollView>
        ) : (
          <RichText key={i} nodes={seg.content} />
        ),
      )}
    </View>
  );
}
