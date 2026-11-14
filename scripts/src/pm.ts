// The keeper's Polygon side: every queued Polymarket transaction is signed by NEAR MPC (the contract builds it, the
// keeper only picks the gas price within the contract's cap) and broadcast on Polygon Amoy, in nonce order.
import { createPublicClient, http, type Hex } from "viem";
import { polygonAmoy } from "viem/chains";
import { acct, call, events, proof, readDeploy, readEnv, view } from "./lib.ts";

const AMOY_RPC = process.env.AMOY_RPC ?? "https://polygon-amoy-bor-rpc.publicnode.com";
const amoy = createPublicClient({ chain: polygonAmoy, transport: http(AMOY_RPC) });
const GWEI = 1_000_000_000n;
const LABEL: Record<string, string> = {
  approve: "approves Polymarket's CTF to use its USDC",
  mint: "mints test USDC (testnet stand-in for bridged premiums)",
  prepare_condition: "creates the market's YES/NO condition on Polymarket's CTF",
  split: "splits USDC into real Polymarket YES + NO shares for the cover sold",
  report_payouts: "reports the final result to Polymarket's CTF",
  redeem: "redeems the winning Polymarket shares for USDC",
};

async function fees() {
  const block = await amoy.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  let tip = 30n * GWEI;
  try {
    tip = (await amoy.estimateMaxPriorityFeePerGas()) > tip ? await amoy.estimateMaxPriorityFeePerGas() : tip;
  } catch {}
  let max = base * 2n + tip;
  if (max > 450n * GWEI) max = 450n * GWEI;
  return { max, tip: tip > max ? max : tip };
}

export async function pmTick(log: (s: string) => void) {
  const d = readDeploy();
  const env = readEnv();
  const root = acct(env.ROOT_ACCOUNT!, env.ROOT_KEY!);
  const cfg = await view<any>(d.airbag, "pm_config").catch(() => null);
  if (!cfg) return;
  const wallet = cfg.wallet as Hex;
  const txs = await view<any[]>(d.airbag, "pm_txs", { limit: 200 });
  if (!txs.length) return;
  const onchainNonce = await amoy.getTransactionCount({ address: wallet, blockTag: "pending" });
  const minedNonce = await amoy.getTransactionCount({ address: wallet, blockTag: "latest" });
  const pol = await amoy.getBalance({ address: wallet });
  let done = 0;
  for (const t of txs) {
    if (done >= 4) break;
    const nonce = t.nonce == null ? null : Number(t.nonce);
    if (nonce != null && nonce < minedNonce) {
      // mined: record once
      if (t.hash && !d.proof?.[`pm_${t.id}`]) {
        const rec = await amoy.getTransactionReceipt({ hash: t.hash }).catch(() => null);
        if (rec) {
          proof(`pm_${t.id}`, `Polygon Amoy: Airbag's MPC wallet ${LABEL[t.kind] ?? t.kind}${t.market != null ? ` (market ${t.market})` : ""}${rec.status === "success" ? "" : " [REVERTED]"}`, t.hash, "amoy");
          log(`Polymarket tx ${t.id} (${t.kind}) ${rec.status} on Amoy: ${t.hash}`);
        }
      }
      continue;
    }
    if (pol < 10n ** 16n) {
      log(`Polymarket: wallet ${wallet} has ${Number(pol) / 1e18} POL on Amoy; fund it to broadcast ${txs.length - minedNonce} queued transactions`);
      return;
    }
    if (t.status === "pending") {
      const f = await fees();
      const r = await call(root, d.airbag, "pm_sign", { id: t.id, max_fee: f.max.toString(), max_priority_fee: f.tip.toString() }, { tgas: 300 });
      const ev = events(r.logs).find((e) => e.event === "pm_tx_signed");
      log(`Polymarket tx ${t.id} (${t.kind}): ${ev ? `signed by NEAR MPC, nonce ${ev.data.nonce}` : "MPC didn't sign yet"} (${r.tx})`);
      if (!ev) return;
      if (!d.proof?.[`pm_sign_${t.id}`]) proof(`pm_sign_${t.id}`, `NEAR MPC signs Polygon tx ${t.id}: ${t.kind}${t.market != null ? ` (market ${t.market})` : ""}`, r.tx);
      done++;
      // read it back to get the raw transaction
      const [fresh] = await view<any[]>(d.airbag, "pm_txs", { from: t.id, limit: 1 });
      await broadcast(fresh, log);
    } else if (t.status === "signed") {
      if (nonce != null && nonce < onchainNonce) continue; // already in the mempool
      await broadcast(t, log);
      done++;
    } else return; // signing in progress
  }
}

async function broadcast(t: any, log: (s: string) => void) {
  try {
    const hash = await amoy.sendRawTransaction({ serializedTransaction: t.raw as Hex });
    log(`Polymarket tx ${t.id} (${t.kind}) broadcast on Amoy: ${hash}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/already known|nonce too low/i.test(msg)) return;
    log(`Polymarket tx ${t.id} broadcast failed: ${msg.slice(0, 160)}`);
  }
}
