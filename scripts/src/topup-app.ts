// Tops up the Airbag contract account's NEAR (storage) from the testnet root account.
//   pnpm -C scripts exec tsx src/topup-app.ts [near]
import { actions } from "near-api-js";
import { acct, near, provider, readDeploy, readEnv, say, send } from "./lib.ts";
const env = readEnv();
const d = readDeploy();
const show = async () => {
  const a: any = await provider.viewAccount({ accountId: d.airbag, blockQuery: { finality: "final" } });
  say(`${d.airbag}: ${(Number(BigInt(a.amount)) / 1e24).toFixed(3)} NEAR, storage ${a.storage_usage} bytes (~${(a.storage_usage / 1e5).toFixed(3)} NEAR locked)`);
};
await show();
const amt = process.argv[2] ?? "3";
const r = await send(acct(env.ROOT_ACCOUNT!, env.ROOT_KEY!), d.airbag, [actions.transfer(near(amt))]);
say(`sent ${amt} NEAR (${r.tx})`);
await show();
