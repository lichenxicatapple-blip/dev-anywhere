// 从 public/brand-icon.svg 生成全套 PWA 图标 (any/maskable/apple-touch)
// 命令: pnpm --filter @dev-anywhere/web exec pwa-assets-generator
import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

const brandIconBackground = "#111312";

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    apple: {
      sizes: [180],
      padding: 0,
      resizeOptions: {
        fit: "contain",
        background: brandIconBackground,
      },
    },
    maskable: {
      sizes: [512],
      padding: 0.12,
      resizeOptions: {
        fit: "contain",
        background: brandIconBackground,
      },
    },
  },
  images: ["public/brand-icon.svg"],
});
