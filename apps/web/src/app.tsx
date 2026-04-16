import { RouterProvider } from "react-router";
import { router } from "@/lib/router";
import { useRelaySetup } from "@/hooks/use-relay-setup";
import { Toast } from "@/components/toast";

export function App() {
  useRelaySetup();
  return (
    <>
      <RouterProvider router={router} />
      <Toast />
    </>
  );
}
