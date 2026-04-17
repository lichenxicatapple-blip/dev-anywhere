import { RouterProvider } from "react-router";
import { router } from "@/lib/router";
import { useRelaySetup } from "@/hooks/use-relay-setup";
import { Toaster } from "@/components/toast";

export function App() {
  useRelaySetup();
  return (
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>
  );
}
