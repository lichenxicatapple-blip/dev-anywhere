import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { installTestHooks } from "./test-hooks";
import "./app.css";

installTestHooks();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
