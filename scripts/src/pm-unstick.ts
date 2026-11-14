// Upgrades the Airbag contract to the freshly built wasm (state kept) and puts stuck "signing" Polygon
// transactions back to pending.   pnpm -C scripts exec tsx src/pm-unstick.ts
import fs from "node:fs";
import path from "node:path";
import { actions } from "near-api-js";
import { ROOT_DIR, acct, call, proof, readDeploy, readEnv, say, send, view } from "./lib.ts";
const env = readEnv();
const d = readDeploy();
const root = acct(env.ROOT_ACCOUNT!, env.ROOT_KEY!);
const up = await send(acct(d.airbag, env.KEY_APP!), d.airbag, [actions.deployContract(fs.readFileSync(path.join(ROOT_DIR, "contracts/target/near/airbag/airbag.wasm")))]);
proof("upgrade_pm_unstick", "Airbag contract upgraded: owner can reset a Polygon tx stuck in signing (state kept)", up.tx);
say(`upgraded (${up.tx}); ${(await view<any[]>(d.airbag, "list_markets", {})).length} markets intact`);
for (const t of await view<any[]>(d.airbag, "pm_txs", { limit: 200 })) {
  if (t.status !== "signing") continue;
  await call(root, d.airbag, "pm_unstick", { id: t.id });
  say(`tx ${t.id} (${t.kind}) back to pending, nonce ${t.nonce}`);
}
