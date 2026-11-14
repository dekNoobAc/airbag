// The demo video's buyer: alice buys cover on a market at the live quote (+1% slippage room), paid on NEAR.
// Tops alice up from the testnet root first if she's low.   pnpm -C scripts exec tsx src/demo-buy.ts [market] [usdc]
import { actions } from "near-api-js";
import { acct, balance, call, events, near, readDeploy, readEnv, say, send, view } from "./lib.ts";
const env = readEnv();
const d = readDeploy();
const [market = "1", usdc = "100"] = process.argv.slice(2);
const root = acct(env.ROOT_ACCOUNT!, env.ROOT_KEY!);
const alice = acct(`alice.${d.root}`, env.KEY_ALICE!);
const amount = BigInt(usdc) * 1_000_000n;
if ((await balance(alice.accountId)) < near("0.5")) await send(root, alice.accountId, [actions.transfer(near("1"))]);
if (BigInt(await view<string>(d.usdc, "ft_balance_of", { account_id: alice.accountId })) < 300_000_000n)
  await call(root, d.usdc, "ft_transfer", { receiver_id: alice.accountId, amount: "1000000000" }, { deposit: 1n });
const q = await view<any>(d.airbag, "quote", { market, amount: amount.toString() });
if (q.blocked) throw new Error(`market ${market} not selling: ${q.blocked}`);
const max = BigInt(q.premium) + BigInt(q.premium) / 100n + 1n;
const r = await call(alice, d.usdc, "ft_transfer_call", {
  receiver_id: d.airbag, amount: max.toString(),
  msg: JSON.stringify({ buy: { market, amount: amount.toString(), max_premium: max.toString(), payout_to: "near" } }),
}, { deposit: 1n, tgas: 150 });
const ev = events(r.logs).find((e) => e.event === "cover_bought");
if (!ev) throw new Error(`buy failed (${r.tx})`);
say(`alice bought ${usdc} USDC of cover on market ${market} for ${Number(ev.data.premium) / 1e6} USDC: policy ${ev.data.policy} (${r.tx})`);
