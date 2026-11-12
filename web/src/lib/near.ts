// Reads from NEAR (view calls over public RPC, failover) and the shapes the Airbag contract returns.
import { AIRBAG, RPC_URLS, USDC } from "./config";

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "airbag",
    method: "query",
    params: { request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  });
  let last: unknown;
  for (const url of RPC_URLS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      const j = await r.json();
      if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 200));
      return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export type Status =
  | "open"
  | { proposed: { outcome: "yes" | "no"; event_at: string; proposed_at: string; evidence: string } }
  | { resolved: { outcome: "yes" | "no"; event_at: string; resolved_at: string } };

export type Market = {
  id: string;
  question: string;
  source: { polymarket: { slug: string; pays_on: "yes" | "no" } };
  end: string;
  fee_bps: number;
  halt_bps: number;
  dispute_secs: string;
  late_grace_secs: string;
  halted: boolean;
  status: Status;
  price_bps: number;
  floor_bps: number;
  floor_at: string;
  pool_yes: string;
  pool_no: string;
  total_shares: string;
  open_cover: string;
  usdc_held: string;
  premiums: string;
  policies: string;
  payouts_done: string;
};

export type Quote = {
  amount: string;
  amm_cost: string;
  floor_cost: string;
  premium: string;
  price_before_bps: number;
  price_after_bps: number;
  floor_bps: number;
  blocked: string | null;
};

export type Policy = {
  id: string;
  market: string;
  owner: string;
  amount: string;
  premium: string;
  bought_at: string;
  payout_to: "near" | { evm: { chain_id: string; address: string } };
  state: "active" | "paid" | "refunded" | "expired";
};

export type Lp = { shares: string; share_bps: number; premiums_earned: string; left_yes: string; left_no: string; claimed: boolean } | null;

export type EvmPayout = {
  id: string;
  policy: string;
  chain_id: string;
  from: string;
  to: string;
  amount: string;
  status: "pending" | "signing" | "signed" | "relayed";
  relay_tx: string | null;
  signature: string | null;
};

export type PmConfig = { chain_id: string; name: string; ctf: string; collateral: string; wallet: string };
export type PmHedge = { market: string; question_id: string; condition_id: string; hedged: string; reported: "yes" | "no" | null };
export type PmTx = { id: string; market: string | null; kind: string; nonce: string | null; status: "pending" | "signing" | "signed"; hash: string | null };

export const airbag = {
  pmConfig: () => view<PmConfig | null>(AIRBAG, "pm_config", {}),
  pmHedges: () => view<PmHedge[]>(AIRBAG, "pm_hedges", {}),
  pmTxs: () => view<PmTx[]>(AIRBAG, "pm_txs", { limit: 200 }),
  markets: () => view<Market[]>(AIRBAG, "list_markets", {}),
  market: (id: string) => view<Market>(AIRBAG, "get_market", { market: id }),
  quote: (id: string, amount: bigint) => view<Quote>(AIRBAG, "quote", { market: id, amount: amount.toString() }),
  policiesOf: (account: string) => view<Policy[]>(AIRBAG, "policies_of", { account }),
  lpOf: (id: string, account: string) => view<Lp>(AIRBAG, "lp_of", { market: id, account }),
  claimable: (account: string) => view<string>(AIRBAG, "claimable_of", { account }),
  solvency: (id: string) => view<Record<string, string | boolean>>(AIRBAG, "solvency", { market: id }),
  evmPayouts: () => view<EvmPayout[]>(AIRBAG, "list_evm_payouts", {}),
  config: () => view<any>(AIRBAG, "get_config", {}),
  usdcBalance: (account: string) => view<string>(USDC, "ft_balance_of", { account_id: account }),
};

// ── formatting ──
export const USDC_DECIMALS = 6;
export const toUsdc = (base: string | bigint) => Number(BigInt(base)) / 1e6;
export const usd = (base: string | bigint, digits = 2) =>
  toUsdc(base).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const pct = (bps: number, digits = 1) => `${(bps / 100).toFixed(digits)}%`;
export function toBase(human: string): bigint {
  const s = human.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(s)) throw new Error("enter an amount like 100 or 12.5");
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}
export const statusOf = (s: Status) => (typeof s === "string" ? s : "proposed" in s ? "proposed" : "resolved");
export function timeLeft(endSecs: string | number): string {
  const s = Number(endSecs) - Math.floor(Date.now() / 1000);
  if (s <= 0) return "ended";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
export const ago = (secs: string | number) => {
  const s = Math.floor(Date.now() / 1000) - Number(secs);
  return s < 90 ? `${s}s ago` : s < 5_400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3_600)} h ago`;
};
