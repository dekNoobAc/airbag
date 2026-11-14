// Moves spare NEAR from the demo accounts (lp / alice / bob) back to the testnet root, keeping 1 NEAR each.
//   pnpm -C scripts exec tsx src/sweep-near.ts
import { actions } from "near-api-js";
import { acct, balance, readDeploy, readEnv, say, send } from "./lib.ts";
const env = readEnv();
const d = readDeploy();
const KEEP = 10n ** 24n;
for (const [name, key] of [["lp", env.KEY_LP], ["alice", env.KEY_ALICE], ["bob", env.KEY_BOB]] as const) {
  if (!key) continue;
  const id = `${name}.${d.root}`;
  const have = await balance(id);
  const spare = have - KEEP - 10n ** 23n; // leave room for storage + gas
  if (spare <= 0n) { say(`${id}: ${Number(have) / 1e24} NEAR, nothing spare`); continue; }
  const r = await send(acct(id, key), d.root, [actions.transfer(spare)]);
  say(`${id}: sent ${(Number(spare) / 1e24).toFixed(2)} NEAR to ${d.root} (${r.tx})`);
}
say(`${d.root}: ${(Number(await balance(d.root)) / 1e24).toFixed(2)} NEAR`);
