import { RouterProvider } from "react-router";
import { router } from "@/lib/router";
import { useRelaySetup } from "@/hooks/use-relay-setup";
import { TooltipProvider } from "@/components/ui/tooltip";

export function App() {
  useRelaySetup();
  return (
    <TooltipProvider delayDuration={200}>
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
