// Contract ids and public RPCs (NEAR testnet). Defaults match airbag-near/testnet/deployment.json.
import deployment from "@/data/deployment.json";

export const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const AIRBAG = process.env.NEXT_PUBLIC_AIRBAG ?? deployment.airbag;
export const USDC = process.env.NEXT_PUBLIC_USDC ?? deployment.usdc;
// rpc.testnet.near.org is deprecated; dRPC first, FastNEAR second.
export const RPC_URLS = ["https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"];
export const EXPLORER = "https://testnet.nearblocks.io";
export const BASE_EXPLORER = "https://sepolia.basescan.org";
export const BASE_SEPOLIA = 84532;
export const DEPLOYMENT = deployment as Record<string, any>;

export const AMOY_EXPLORER = "https://amoy.polygonscan.com";
export const AMOY_RPC = "https://polygon-amoy-bor-rpc.publicnode.com";

/** NEAR hashes go to NearBlocks; 0x hashes to Base Sepolia, or Polygon Amoy when `chain` says so. */
export const txUrl = (hash: string, chain?: string) =>
  !hash.startsWith("0x") ? `${EXPLORER}/txns/${hash}` : chain === "amoy" ? `${AMOY_EXPLORER}/tx/${hash}` : `${BASE_EXPLORER}/tx/${hash}`;
export const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;
export const polymarketUrl = (slug: string) => `https://polymarket.com/market/${slug}`;
