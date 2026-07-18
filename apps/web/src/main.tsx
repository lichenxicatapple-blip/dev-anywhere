import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { installTestHooks } from "./test-hooks";
import { installPtyInputLatencyTrace } from "./lib/pty-input-latency-trace";
import { applyStoredThemePreference } from "./lib/theme-preference";
import { takeControlOfBrowserScrollRestoration } from "./lib/browser-scroll-restoration";
import "./app.css";

takeControlOfBrowserScrollRestoration();
applyStoredThemePreference();
installTestHooks();
installPtyInputLatencyTrace();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
