import type { ServerResponse } from "node:http";

export const PREVIEW_GATEWAY_MARKER_HEADER = "x-dev-anywhere-preview";

export function setPreviewResponseHeaders(response: ServerResponse): void {
  response.setHeader("X-Dev-Anywhere-Preview", "1");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Cache-Control", "no-store, private, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
}

export function sendPreviewError(response: ServerResponse, status: number, title: string): void {
  setPreviewResponseHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title><body><main><h1>${title}</h1><p>请返回 DEV Anywhere 检查预览状态。</p></main></body></html>`,
  );
}
