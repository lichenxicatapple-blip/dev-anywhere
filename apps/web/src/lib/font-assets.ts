const SARASA_FIXED_SC_BASE = "/fonts/sarasa-fixed-sc";
const CRITICAL_FONT_SHARDS = [
  // Provider 状态行高频使用 "•"，对应 unicode-range: U+2022。
  "58e7c2324d8d292d58534d9f236f1552.woff2",
];

// Sarasa Fixed SC 按 cn-font-split 分片托管在 relay, 按 unicode-range 按需下载。
// relay 静态目录 ~/.dev-anywhere/relay-data/fonts/sarasa-fixed-sc/result.css 由 package 内置字体资产安装生成。
export function loadFontCSS(relayUrl: string): void {
  const base = relayUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/(proxy|client)$/, "");
  for (const shard of CRITICAL_FONT_SHARDS) {
    const fontHref = `${base}${SARASA_FIXED_SC_BASE}/${shard}`;
    if (document.querySelector(`link[href="${fontHref}"]`)) continue;
    const preload = document.createElement("link");
    preload.rel = "preload";
    preload.as = "font";
    preload.setAttribute("as", "font");
    preload.type = "font/woff2";
    preload.crossOrigin = "anonymous";
    preload.href = fontHref;
    document.head.appendChild(preload);
  }

  const href = `${base}${SARASA_FIXED_SC_BASE}/result.css`;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}
