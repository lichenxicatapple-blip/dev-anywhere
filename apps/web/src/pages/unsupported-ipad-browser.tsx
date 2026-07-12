import { useState } from "react";
import { Check, Compass, Copy } from "lucide-react";
import { BrandMark } from "@/components/brand/brand-mark";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy-text";

type CopyStatus = "idle" | "copied" | "failed";

export function UnsupportedIpadBrowserPage({ browserName }: { browserName: string }) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");

  const handleCopy = async () => {
    const result = await copyText(window.location.href, { allowLegacyFallback: true });
    setCopyStatus(result === "failed" ? "failed" : "copied");
  };

  return (
    <div
      className="flex min-h-[100dvh] flex-col overflow-hidden bg-background text-foreground"
      data-slot="unsupported-ipad-browser"
    >
      <header className="mx-auto flex w-full max-w-5xl items-center px-6 py-5 sm:px-10">
        <BrandMark className="text-sm" slot="unsupported-browser-brand" />
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 items-center px-6 pb-20 sm:px-10 sm:pb-24">
        <section className="max-w-xl" aria-labelledby="unsupported-browser-title">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Compass className="size-4 text-primary" aria-hidden="true" />
            <span>iPad 浏览器支持</span>
          </div>
          <h1
            id="unsupported-browser-title"
            className="mt-4 text-3xl font-semibold tracking-normal sm:text-4xl"
          >
            请使用 Safari 打开
          </h1>
          <p className="mt-4 max-w-lg text-base leading-7 text-muted-foreground">
            DEV Anywhere 暂不支持 iPad 上的 {browserName}。当前版本仅支持
            Safari，以保证终端输入和实体键盘行为稳定。
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button className="h-11 px-4" onClick={handleCopy}>
              {copyStatus === "copied" ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              {copyStatus === "copied" ? "链接已复制" : "复制当前链接"}
            </Button>
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {copyStatus === "copied"
                ? "请切换到 Safari 后粘贴打开"
                : copyStatus === "failed"
                  ? "复制失败，请从地址栏复制"
                  : "复制后在 Safari 中打开"}
            </span>
          </div>
        </section>
      </main>
    </div>
  );
}
