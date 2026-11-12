"use client";
// near-connect-hooks ships no "use client" and defaults to testnet: mounted here with the network set explicitly.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NearProvider } from "near-connect-hooks";
import { useState, type ComponentProps, type ReactNode } from "react";
import { NETWORK, RPC_URLS } from "@/lib/config";

const NEAR_CONFIG: ComponentProps<typeof NearProvider>["config"] = {
  network: NETWORK,
  providers: NETWORK === "mainnet" ? { mainnet: RPC_URLS } : { testnet: RPC_URLS },
  footerBranding: { heading: "Airbag", link: "https://near.org", linkText: "What is NEAR?" },
};

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchInterval: 15_000, staleTime: 5_000 } } }));
  return (
    <QueryClientProvider client={qc}>
      <NearProvider config={NEAR_CONFIG}>{children}</NearProvider>
    </QueryClientProvider>
  );
}
