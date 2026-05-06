import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 定位 apps/web 包根，确保断言不依赖测试运行目录
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../../..");

const appCss = readFileSync(resolve(webRoot, "src/app.css"), "utf-8");
const buttonSrc = readFileSync(resolve(webRoot, "src/components/ui/button.tsx"), "utf-8");
const sonnerSrc = readFileSync(resolve(webRoot, "src/components/ui/sonner.tsx"), "utf-8");

describe("theme tokens", () => {
  it("app.css: --primary 锁定为琥珀 #D4A574", () => {
    expect(appCss).toMatch(/--primary:\s*#D4A574;/i);
  });

  it("app.css: --ring 与 --primary 同步为 #D4A574", () => {
    expect(appCss).toMatch(/--ring:\s*#D4A574;/i);
  });

  it("app.css: --radius 收到 0.375rem", () => {
    expect(appCss).toMatch(/--radius:\s*0\.375rem;/);
  });

  it("app.css: --color-status-success 保持 teal #00D4AA (Deviation Log 保留项)", () => {
    expect(appCss).toMatch(/--color-status-success:\s*#00D4AA;/i);
  });

  it("app.css: 不再存在 --primary: #00D4AA teal 旧值", () => {
    expect(appCss).not.toMatch(/--primary:\s*#00D4AA;/i);
  });
});

describe("button font-weight override", () => {
  it("button cva base 使用 font-normal 取代 font-medium (typography 仅 400/600 契约)", () => {
    expect(buttonSrc).toMatch(/font-normal/);
    // 不允许 cva 第一参数字符串中残留 font-medium
    expect(buttonSrc).not.toMatch(/"[^"]*\bfont-medium\b[^"]*"/);
  });
});

describe("Sonner wrapper status styling", () => {
  it("锁定 dark 主题", () => {
    expect(sonnerSrc).toMatch(/theme="dark"/);
  });

  it("position 固定为 top-center", () => {
    expect(sonnerSrc).toMatch(/position="top-center"/);
  });

  it("四种状态均走 --color-status-* CSS 变量，不硬编码 hex", () => {
    expect(sonnerSrc).toMatch(/color-status-success/);
    expect(sonnerSrc).toMatch(/color-status-error/);
    expect(sonnerSrc).toMatch(/color-status-warning/);
    expect(sonnerSrc).toMatch(/color-status-working/);
  });

  it("使用 border-l-4 作为状态视觉锚（UI-SPEC Sonner mapping）", () => {
    expect(sonnerSrc).toMatch(/border-l-4/);
  });
});
