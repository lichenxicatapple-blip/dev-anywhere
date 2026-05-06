// Markdown kitchen-sink 调试页, 不进 AppShell, 用于可视化验证每种 markdown 元素在气泡内的渲染
// 访问: /#/markdown-test
// 覆盖: heading / emphasis / strikethrough / inline code / link / autolink / image
//       list (ul/ol) / task list / blockquote / hr / code block (含超宽) / table (含超宽)
import { MarkdownView } from "@/components/chat/markdown-view";

const SAMPLE = `# Heading 1
## Heading 2
### Heading 3

这是一个普通段落, 含 **加粗** 与 *斜体* 与 ~~删除线~~ 与 \`inline code\` 与 [带名字的链接](https://example.com), autolink: https://auto.example.com。

> blockquote: 引用一段长文本, 看看 dark bubble 里的对比度是否足够, 左侧条的颜色是否清晰可见。

---

## 列表

- 无序项 A
- 无序项 B
  - 嵌套项 B.1
  - 嵌套项 B.2
- 无序项 C

1. 有序第一项
2. 有序第二项
3. 有序第三项

## Task list (GFM)

- [x] 已完成任务
- [ ] 待办任务 1
- [ ] 待办任务 2

## 图片

![占位图](https://placehold.co/200x80/252526/D4A574?text=img)

## Code (short)

\`\`\`ts
const greet = (name: string) => \`hello, \${name}\`;
\`\`\`

## Code (long, 验证横向滚动)

\`\`\`ts
// 这是一行超长的 TypeScript 代码用来触发代码块横向滚动: 期望 <pre> 不换行, 外层出滚动条
export async function veryLongFunctionName(argumentA: string, argumentB: number, argumentC: { nested: { deeply: { field: string } } }): Promise<Array<{ id: string; value: number; meta: Record<string, unknown> }>> { return []; }
\`\`\`

## Rust fenced highlight

\`\`\`rust
fn main() {
    let s = String::from("hello");
    let len = calc_len(&s);
    println!("{s} 长度是 {len}");
}
\`\`\`

## Table (GFM, 窄)

| 维度 | 值 |
| --- | --- |
| 名称 | dev-anywhere |
| 语言 | TypeScript |
| Runtime | Node >= 20 |

## Table (GFM, 超宽 — 验证横向滚动)

| 维度 | Rust | C/C++ | Go | Java/Kotlin | Python | TypeScript/JS | Swift |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 内存管理 | 所有权+借用 | 手动 | GC(三色) | GC(分代) | GC(引用计数) | GC(V8) | ARC |
| 类型系统 | 静态强 ADT | 静态弱 | 静态弱 | 静态强 OOP | 动态 | 静态可选 | 静态强 protocol |
| 并发模型 | Send/Sync | 线程+锁 | goroutine+channel | 线程+Future | GIL | 事件循环 | GCD + async/await |
| 错误处理 | Result<T,E>+? | 返回码/异常 | 多返回值 err | 异常 | 异常 | 异常 | throws/Result |

---

_End of sample._
`;

export function MarkdownTest() {
  return (
    <div className="min-h-dvh bg-background text-foreground p-6">
      <div className="mx-auto max-w-[720px] space-y-6">
        <header>
          <h1 className="text-lg font-semibold">Markdown 渲染走查</h1>
          <p className="text-sm text-muted-foreground">
            下方模拟 assistant 气泡容器 (max-w 约束), 验证所有 markdown 元素在气泡内的实际渲染。
          </p>
        </header>
        <article className="flex justify-start">
          <div className="max-w-[80%] rounded-md bg-card text-foreground px-4 py-2 text-sm">
            <MarkdownView text={SAMPLE} />
          </div>
        </article>
      </div>
    </div>
  );
}
