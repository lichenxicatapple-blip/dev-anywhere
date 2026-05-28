import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { installTestHooks } from "./test-hooks";
import { installPtyRenderDebug } from "./lib/pty-render-debug";
import { installPtyInputLatencyTrace } from "./lib/pty-input-latency-trace";
import { applyStoredThemePreference } from "./lib/theme-preference";
import "./app.css";

applyStoredThemePreference();
installTestHooks();
installPtyRenderDebug();
installPtyInputLatencyTrace();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
