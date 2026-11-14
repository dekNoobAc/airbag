// Asks the Airbag contract to refresh a market's Polymarket floor: the contract requests a run of the pinned oracle
// wasm on OutLayer (Intel TDX); OutLayer's worker runs it and resumes the request; Airbag's `on_oracle` reads it.
//   pnpm -C scripts testnet:refresh [market]
// The OutLayer round trip takes longer than an RPC will hold a request open, so this sends the transaction, then
// polls its status until every receipt (including the resumed callback) is done.
import { actions } from "near-api-js";
import { TGAS, acct, events, near, proof, provider, readDeploy, readEnv, say, view } from "./lib.ts";

const env = readEnv();
const d = readDeploy();
const market = process.argv[2] ?? "0";
const root = acct(env.ROOT_ACCOUNT!, env.ROOT_KEY!);

const before = await view<any>(d.airbag, "get_market", { market });
say(`market ${market}: floor ${before.floor_bps} bps (observed ${before.floor_at})`);
say("refresh → OutLayer request_execution (oracle wasm pinned by sha256) …");
const sent = await root.signAndSendTransaction({
  receiverId: d.airbag,
  actions: [actions.functionCall("refresh", { market }, 300n * TGAS, near("0.05"))],
  waitUntil: "INCLUDED",
  throwOnFailure: false,
});
const tx = sent.transaction.hash;
say(`  tx ${tx}; waiting for OutLayer's worker to run it and resume …`);
let o: any;
for (let i = 0; i < 60; i++) {
  await new Promise((s) => setTimeout(s, 5000));
  try {
    o = await provider.viewTransactionStatusWithReceipts({ txHash: tx, accountId: root.accountId, waitUntil: "FINAL" });
    if (o?.final_execution_status === "FINAL") break;
  } catch {
    /* not final yet */
  }
}
if (!o) throw new Error(`no final status for ${tx} yet; check it on testnet.nearblocks.io`);
const logs: string[] = o.receipts_outcome.flatMap((r: any) => r.outcome.logs);
for (const l of logs) if (!l.startsWith("EVENT_JSON")) say(`  log: ${l.slice(0, 200)}`);
const posted = events(logs).find((e) => e.event === "floor_posted");
const after = await view<any>(d.airbag, "get_market", { market });
if (posted) {
  say(`floor ${after.floor_bps} bps = Polymarket ${(after.floor_bps / 100).toFixed(2)}% · source sha256 ${posted.data.source_sha256.slice(0, 16)}…`);
  proof(`oracle_refresh_${market}`, `OutLayer TEE run reads Polymarket, contract posts the floor for market ${market}: ${after.floor_bps} bps`, tx);
} else {
  say(`no floor posted (tx ${tx})`);
}
