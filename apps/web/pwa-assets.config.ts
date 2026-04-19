// 从 public/brand-icon.svg 生成全套 PWA 图标 (any/maskable/apple-touch)
// 命令: pnpm --filter @cc-anywhere/web exec pwa-assets-generator
import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

export default defineConfig({
  preset: minimal2023Preset,
  images: ["public/brand-icon.svg"],
});
