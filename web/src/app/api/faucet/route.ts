// Test USDC for anyone trying Airbag on NEAR testnet: registers the account on the mock USDC contract and sends
// 1,000. Testnet only; the key is a server env var (FAUCET_ACCOUNT / FAUCET_KEY). Accounts that already hold
// 500+ test USDC are turned away, so it can't be drained in a loop by one account.
import { Account, JsonRpcProvider, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import { NETWORK, USDC } from "@/lib/config";

export const runtime = "nodejs";
const GIFT = 1_000_000_000n; // 1,000 USDC
const RPC = "https://test.rpc.fastnear.com";

export async function POST(req: Request) {
  if (NETWORK !== "testnet") return Response.json({ error: "testnet only" }, { status: 404 });
  const { FAUCET_ACCOUNT, FAUCET_KEY } = process.env;
  if (!FAUCET_ACCOUNT || !FAUCET_KEY) return Response.json({ error: "faucet not configured" }, { status: 503 });
  const { account } = (await req.json().catch(() => ({}))) as { account?: string };
  if (!account || !/^[a-z0-9._-]{2,64}$/.test(account)) return Response.json({ error: "bad account id" }, { status: 400 });
  const provider = new JsonRpcProvider({ url: RPC }, { retries: 3, wait: 800, backoff: 1.6 });
  const view = async (method: string, args: Record<string, unknown>) => provider.callFunction({ contractId: USDC, method, args, blockQuery: { finality: "optimistic" } });
  try {
    await provider.viewAccount({ accountId: account, blockQuery: { finality: "optimistic" } });
  } catch {
    return Response.json({ error: "that account doesn't exist on NEAR testnet" }, { status: 400 });
  }
  const bal = BigInt(((await view("ft_balance_of", { account_id: account })) as string) ?? "0");
  if (bal >= 500_000_000n) return Response.json({ error: "you already have 500+ test USDC" }, { status: 429 });
  const faucet = new Account(FAUCET_ACCOUNT, provider, KeyPairSigner.fromSecretKey(FAUCET_KEY as KeyPairString));
  const registered = await view("storage_balance_of", { account_id: account });
  const acts = [
    ...(registered ? [] : [actions.functionCall("storage_deposit", { account_id: account, registration_only: true }, 30_000_000_000_000n, 12_500_000_000_000_000_000_000n)]),
    actions.functionCall("ft_transfer", { receiver_id: account, amount: GIFT.toString(), memo: "Airbag testnet faucet" }, 30_000_000_000_000n, 1n),
  ];
  const o = await faucet.signAndSendTransaction({ receiverId: USDC, actions: acts, waitUntil: "FINAL", throwOnFailure: false });
  const failed = [o.status, ...o.receipts_outcome.map((r) => r.outcome.status)].some((s: any) => s && typeof s === "object" && "Failure" in s);
  if (failed) return Response.json({ error: "transfer failed", tx: o.transaction_outcome.id }, { status: 502 });
  return Response.json({ ok: true, usdc: 1000, tx: o.transaction_outcome.id });
}
