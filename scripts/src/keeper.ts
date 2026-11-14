// Airbag's keeper on testnet: runs the markets with no human in the loop. Anyone could run this; it holds no power
// over funds (every action is a public method the contract checks).
//   pnpm -C scripts testnet:keeper          (Ctrl-C to stop; safe to restart)
// Every minute:
//   1. refresh the Polymarket floor through the TEE oracle when it's getting old (BTC markets every ~20 min,
//      the long USDC market every ~6 h), and every 5 min after a market's end, to pick up Polymarket's result
//   2. finalize a proposed result once the dispute window is over
//   3. push policy payouts (NEAR transfers, or queued for Base)
//   4. ask NEAR MPC to sign each queued Base payout, relay it to Base Sepolia's USDC, record the tx on NEAR
//   5. demo only: the test underwriter (lp.<root>) collects its share once a market is fully paid out
//   6. Polymarket on Polygon Amoy: NEAR MPC signs each queued CTF transaction (split / report / redeem), broadcast in order
import { actions } from "near-api-js";
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { TGAS, acct, call, events, near, proof, readDeploy, readEnv, send, view } from "./lib.ts";
import { pmTick } from "./pm.ts";

const env = readEnv();
const d = readDeploy();
const root = acct(env.ROOT_ACCOUNT!, env.ROOT_KEY!);
const lp = env.KEY_LP ? acct(`lp.${d.root}`, env.KEY_LP) : null;
const BASE_RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const base = createPublicClient({ chain: baseSepolia, transport: http(BASE_RPC) });
const relayer = env.RELAYER_EVM_KEY ? createWalletClient({ account: privateKeyToAccount(env.RELAYER_EVM_KEY as Hex), chain: baseSepolia, transport: http(BASE_RPC) }) : null;
const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
const TICK = Number(process.env.KEEPER_TICK_MS ?? 60_000);
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const lastRefresh: Record<string, number> = {};

async function refresh(id: string) {
  const sent = await root.signAndSendTransaction({ receiverId: d.airbag, actions: [actions.functionCall("refresh", { market: id }, 300n * TGAS, near("0.05"))], waitUntil: "INCLUDED", throwOnFailure: false });
  lastRefresh[id] = Date.now();
  const { waitFinal } = await import("./lib.ts");
  const o = await waitFinal(sent.transaction.hash, root.accountId);
  const ev = events(o.receipts_outcome.flatMap((r: any) => r.outcome.logs));
  const floor = ev.find((e) => e.event === "floor_posted");
  const prop = ev.find((e) => e.event === "resolution_proposed");
  log(`market ${id}: ${floor ? `floor ${floor.data.yes_bps} bps` : "no new floor"}${prop ? ` · RESULT PROPOSED: ${prop.data.outcome}` : ""} (tx ${sent.transaction.hash})`);
  if (prop) proof(`proposed_${id}`, `TEE oracle reads Polymarket's result for market ${id}: ${prop.data.outcome}`, sent.transaction.hash);
}

async function tick() {
  const now = Math.floor(Date.now() / 1000);
  const markets = await view<any[]>(d.airbag, "list_markets", {});
  for (const m of markets) {
    const id = String(m.id);
    const status = typeof m.status === "string" ? m.status : Object.keys(m.status)[0];
    const end = Number(m.end);
    if (status === "open") {
      const age = now - Number(m.floor_at);
      const every = now >= end ? 300 : end - now < 3 * 86_400 ? 1_200 : 6 * 3_600;
      const since = (Date.now() - (lastRefresh[id] ?? 0)) / 1000;
      if (age >= every && since >= Math.min(every, 300)) await refresh(id).catch((e) => log(`market ${id}: refresh failed: ${(e as Error).message.slice(0, 120)}`));
    } else if (status === "proposed") {
      const p = m.status.proposed;
      if (now >= Number(p.proposed_at) + Number(m.dispute_secs) + 5) {
        const r = await call(root, d.airbag, "finalize", { market: id });
        proof(`finalized_${id}`, `Market ${id} finalized after the dispute window: ${p.outcome}`, r.tx);
        log(`market ${id}: finalized (${p.outcome})`);
      } else log(`market ${id}: ${p.outcome} proposed, dispute window open`);
    } else if (status === "resolved") {
      if (Number(m.payouts_done) < Number(m.policies)) {
        const r = await call(root, d.airbag, "payout_batch", { market: id, limit: 10 }, { tgas: 300 });
        for (const e of events(r.logs)) if (e.event.startsWith("policy_") || e.event === "evm_payout_queued") log(`market ${id}: ${e.event} ${JSON.stringify(e.data)}`);
        proof(`payouts_${id}_${m.payouts_done}`, `Market ${id}: automatic payouts (batch from policy ${m.payouts_done})`, r.tx);
      } else if (lp && !readDeploy().proof?.[`lp_claim_${id}`]) {
        const mine = await view<any>(d.airbag, "lp_of", { market: id, account: lp.accountId });
        if (mine && !mine.claimed) {
          const r = await call(lp, d.airbag, "claim_lp", { market: id }, { tgas: 100 });
          const got = events(r.logs).find((e) => e.event === "lp_claimed");
          proof(`lp_claim_${id}`, `Underwriter collects ${Number(got?.data.usdc ?? 0) / 1e6} USDC from market ${id}`, r.tx);
          log(`market ${id}: underwriter collected ${Number(got?.data.usdc ?? 0) / 1e6} USDC`);
        }
      }
    }
  }
  // Base payouts
  const payouts = await view<any[]>(d.airbag, "list_evm_payouts", {});
  for (const p of payouts) {
    if (p.status === "pending") {
      const r = await call(root, d.airbag, "sign_evm_payout", { payout: p.id }, { tgas: 300 });
      const signed = events(r.logs).some((e) => e.event === "evm_payout_signed");
      log(`Base payout ${p.id}: ${signed ? "signed by NEAR MPC" : "MPC didn't sign yet"} (tx ${r.tx})`);
      if (signed) proof(`evm_signed_${p.id}`, `NEAR MPC signs Base payout ${p.id}: ${Number(p.amount) / 1e6} USDC to ${p.to}`, r.tx);
    } else if (p.status === "signed" && relayer) {
      const usdc = d.base_sepolia_usdc as Hex;
      if (await base.readContract({ address: usdc, abi: USDC_ABI, functionName: "authorizationState", args: [p.from, p.nonce] })) {
        log(`Base payout ${p.id}: already settled on Base`);
        continue;
      }
      const have = await base.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [p.from] });
      if (have < BigInt(p.amount)) {
        log(`Base payout ${p.id}: payout wallet ${p.from} has ${Number(have) / 1e6} USDC, needs ${Number(p.amount) / 1e6}: waiting for a refill`);
        continue;
      }
      const sig = p.signature as string;
      const [r, s, v] = [`0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`, parseInt(sig.slice(130, 132), 16)];
      const hash = await relayer.writeContract({
        address: usdc,
        abi: USDC_ABI,
        functionName: "transferWithAuthorization",
        args: [p.from, p.to, BigInt(p.amount), 0n, BigInt(p.valid_before), p.nonce, v, r as Hex, s as Hex],
      });
      const rec = await base.waitForTransactionReceipt({ hash });
      if (rec.status !== "success") {
        log(`Base payout ${p.id}: reverted on Base (${hash})`);
        continue;
      }
      log(`Base payout ${p.id}: ${Number(p.amount) / 1e6} USDC paid on Base Sepolia → ${p.to} (${hash})`);
      proof(`evm_relayed_${p.id}`, `Base Sepolia: ${Number(p.amount) / 1e6} USDC arrives at ${p.to} (relayed MPC signature)`, hash);
      const rr = await call(root, d.airbag, "report_relayed", { payout: p.id, tx_hash: hash });
      proof(`evm_reported_${p.id}`, `Base payout ${p.id} recorded on NEAR`, rr.tx);
    }
  }
}

log(`keeper for ${d.airbag} (every ${TICK / 1000}s)${relayer ? `, relaying Base payouts from ${relayer.account.address}` : ""}`);
void send;
for (;;) {
  await tick().catch((e) => log(`tick failed: ${(e as Error).message.slice(0, 160)}`));
  await pmTick(log).catch((e) => log(`polymarket tick failed: ${(e as Error).message.slice(0, 160)}`));
  await new Promise((s) => setTimeout(s, TICK));
}
