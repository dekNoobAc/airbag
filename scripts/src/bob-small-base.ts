// Bob's Base Sepolia payout, made small: his 100 USDC policy on market 1 now pays on NEAR, and he buys a new
// 10 USDC policy that pays on Base Sepolia (so one faucet request funds the payout wallet).
import { acct, call, events, proof, readDeploy, readEnv, say, view } from "./lib.ts";
const env = readEnv();
const d = readDeploy();
const bob = acct(`bob.${d.root}`, env.KEY_BOB!);
const m = d.markets.btc74;
const mine = await view<any[]>(d.airbag, "policies_of", { account: bob.accountId });
const big = mine.find((p) => p.market === m && p.payout_to?.evm);
if (big) {
  const r = await call(bob, d.airbag, "set_payout_to", { policy: big.id, payout_to: "near" });
  proof("bob_payout_near", `bob switches policy ${big.id} (100 USDC) to pay on NEAR`, r.tx);
  say(`policy ${big.id} now pays on NEAR`);
}
if (!d.proof?.buy_bob_btc74_base) {
  const q = await view<any>(d.airbag, "quote", { market: m, amount: "10000000" });
  if (q.blocked) throw new Error(`market ${m}: ${q.blocked} (run testnet:refresh ${m})`);
  const max = BigInt(q.premium) + 1_000_000n;
  const r = await call(bob, d.usdc, "ft_transfer_call", { receiver_id: d.airbag, amount: max.toString(),
    msg: JSON.stringify({ buy: { market: m, amount: "10000000", max_premium: max.toString(), payout_to: { evm: { chain_id: "84532", address: d.bob_evm } } } }) }, { deposit: 1n, tgas: 150 });
  const ev = events(r.logs).find((e) => e.event === "cover_bought");
  proof("buy_bob_btc74_base", `bob buys 10 USDC of cover on market ${m} for ${(Number(ev?.data.premium) / 1e6).toFixed(2)} USDC, paid on Base Sepolia`, r.tx);
  say(`bob: 10 USDC cover on market ${m}, paid on Base Sepolia to ${d.bob_evm}`);
}
