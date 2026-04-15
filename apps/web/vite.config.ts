import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/client": {
        target: "ws://localhost:3100",
        ws: true,
      },
      "/proxy": {
        target: "ws://localhost:3100",
        ws: true,
      },
      "/fonts": {
        target: "http://localhost:3100",
      },
      "/health": {
        target: "http://localhost:3100",
      },
    },
  },
});
