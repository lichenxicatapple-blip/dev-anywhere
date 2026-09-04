import { createContext, useContext, type ReactNode } from "react";

const RelayInteractionBlockedContext = createContext(false);

export function RelayInteractionBoundary({
  blocked,
  children,
}: {
  blocked: boolean;
  children: ReactNode;
}) {
  return (
    <RelayInteractionBlockedContext.Provider value={blocked}>
      {children}
    </RelayInteractionBlockedContext.Provider>
  );
}

export function useRelayInteractionBlocked(): boolean {
  return useContext(RelayInteractionBlockedContext);
}
