import { useState, useEffect } from "react";
import { TokenShowcase } from "./pages/token-showcase";
import { PtyTest } from "./pages/pty-test";

export function App() {
  const [route, setRoute] = useState(window.location.hash);

  useEffect(() => {
    const handler = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  if (route === "#/pty-test") {
    return <PtyTest />;
  }

  return <TokenShowcase />;
}
