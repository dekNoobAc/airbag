// NEAR + test USDC balances of the testnet accounts.   pnpm -C scripts exec tsx src/balances.ts
import { balance, readDeploy, view } from "./lib.ts";
const d = readDeploy();
for (const id of [d.root, d.airbag, `lp.${d.root}`, `alice.${d.root}`, `bob.${d.root}`, d.usdc]) {
  const usdc = await view<string>(d.usdc, "ft_balance_of", { account_id: id }).catch(() => "0");
  console.log(id.padEnd(34), (Number(await balance(id)) / 1e24).toFixed(2), "NEAR", (Number(usdc) / 1e6).toFixed(2), "USDC");
}
