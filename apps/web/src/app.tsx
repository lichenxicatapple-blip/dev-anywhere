import { RouterProvider } from "react-router";
import { router } from "@/lib/router";
import { useRelaySetup } from "@/hooks/use-relay-setup";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserSupportBoundary } from "@/components/shell/browser-support-boundary";

export function App() {
  return (
    <BrowserSupportBoundary>
      <SupportedApp />
    </BrowserSupportBoundary>
  );
}

function SupportedApp() {
  useRelaySetup();
  return (
    <TooltipProvider delayDuration={200}>
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
