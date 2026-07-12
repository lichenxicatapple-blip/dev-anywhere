import type { ReactNode } from "react";
import { evaluateCurrentBrowserSupport } from "@/lib/browser-support";
import { UnsupportedIpadBrowserPage } from "@/pages/unsupported-ipad-browser";

export function BrowserSupportBoundary({ children }: { children: ReactNode }) {
  const support = evaluateCurrentBrowserSupport();
  if (!support.supported) {
    return <UnsupportedIpadBrowserPage browserName={support.browserName} />;
  }
  return children;
}
