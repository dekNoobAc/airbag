// Airbag × Polymarket on Polygon Amoy, one-time:
//   1. upgrades the Airbag contract's code (its state is kept: the Polymarket part lives in its own storage slot)
//   2. pm_setup: Polymarket's Conditional Tokens + collateral on Amoy (read from Polymarket's CTF Exchange there),
//      Airbag's wallet = the MPC address at path "airbag-float"; queues the approval and a testnet mint
//   3. pm_link: each market becomes a CTF condition; the cover already sold is queued to be split into shares
// The keeper then signs (NEAR MPC) and broadcasts the queued Polygon transactions.
//   pnpm -C scripts exec tsx src/pm-setup.ts
import fs from "node:fs";
import path from "node:path";
import { actions } from "near-api-js";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { polygonAmoy } from "viem/chains";
import { ROOT_DIR, acct, call, proof, readDeploy, readEnv, say, send, setDeploy, view } from "./lib.ts";

const env = readEnv();
const d = readDeploy();
const root = acct(env.ROOT_ACCOUNT!, env.ROOT_KEY!);
const app = acct(d.airbag, env.KEY_APP!);
const AMOY_RPC = process.env.AMOY_RPC ?? "https://polygon-amoy-bor-rpc.publicnode.com";
const amoy = createPublicClient({ chain: polygonAmoy, transport: http(AMOY_RPC) });
const EXCHANGE = "0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40" as Hex; // Polymarket CTF Exchange, Amoy
const ABI = parseAbi(["function getCtf() view returns (address)", "function getCollateral() view returns (address)"]);

const ctf = await amoy.readContract({ address: EXCHANGE, abi: ABI, functionName: "getCtf" });
const collateral = await amoy.readContract({ address: EXCHANGE, abi: ABI, functionName: "getCollateral" });
say(`Polymarket on Amoy: CTF ${ctf}, collateral ${collateral} (from the CTF Exchange ${EXCHANGE})`);

// 1. code upgrade
const wasm = fs.readFileSync(path.join(ROOT_DIR, "contracts/target/near/airbag/airbag.wasm"));
if (!(await view<unknown>(d.airbag, "pm_config").then(() => true).catch(() => false))) {
  const up = await send(app, d.airbag, [actions.deployContract(wasm)]);
  proof("upgrade_pm", "Airbag contract upgraded: Polymarket CTF hedging (state kept)", up.tx);
  say(`contract upgraded (${up.tx})`);
}
const before = await view<any[]>(d.airbag, "list_markets", {});
say(`state intact: ${before.length} markets, ${before.reduce((a, m) => a + Number(m.policies), 0)} policies`);

// 2. setup
if (!(await view<any>(d.airbag, "pm_config"))) {
  const r = await call(root, d.airbag, "pm_setup", {
    cfg: { chain_id: "80002", name: "Polygon Amoy", ctf, collateral, wallet: d.float_address, max_fee_wei: "500000000000", testnet_mint: true },
    mint: String(1_000_000n * 1_000_000n),
  });
  proof("pm_setup", "Polymarket on Polygon Amoy configured: CTF + collateral, Airbag's MPC wallet", r.tx);
  say("pm_setup done");
}

// 3. link every market
const linked = new Set((await view<any[]>(d.airbag, "pm_hedges")).map((h) => String(h.market)));
for (const m of before) {
  if (linked.has(String(m.id))) continue;
  const r = await call(root, d.airbag, "pm_link", { market: String(m.id) });
  proof(`pm_link_${m.id}`, `Market ${m.id} mirrored as a Polymarket CTF condition (cover so far: ${Number(m.open_cover) / 1e6} USDC)`, r.tx);
  say(`market ${m.id} linked`);
}
setDeploy({ polymarket: { chain: "Polygon Amoy", chain_id: 80002, exchange: EXCHANGE, ctf, collateral, wallet: d.float_address } });
const txs = await view<any[]>(d.airbag, "pm_txs", {});
say(`${txs.length} Polygon transactions queued: ${txs.map((t) => t.kind).join(", ")}`);
const pol = await amoy.getBalance({ address: d.float_address as Hex });
say(`wallet ${d.float_address} has ${Number(pol) / 1e18} POL on Amoy${pol === 0n ? ": fund it so the keeper can broadcast" : ""}`);
