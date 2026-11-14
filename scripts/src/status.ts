// Prints every market's pool, floor and books (read-only).
//   pnpm -C scripts testnet:status
import { readDeploy, view } from "./lib.ts";
const d = readDeploy();
const ms = await view<any[]>(d.airbag, "list_markets", {});
for (const m of ms) {
  console.log(`market ${m.id}: ${m.question}`);
  console.log(`  status ${JSON.stringify(m.status)} · floor ${m.floor_bps} bps · AMM ${m.price_bps} bps · held ${Number(m.usdc_held) / 1e6} USDC · open cover ${Number(m.open_cover) / 1e6} · policies ${m.policies}`);
}
