import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { installTestHooks } from "./test-hooks";
import { installPtyRenderDebug } from "./lib/pty-render-debug";
import "./app.css";

installTestHooks();
installPtyRenderDebug();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
