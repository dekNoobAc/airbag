// For the demo video's transaction ticker: the newest Polymarket split as JSON
// { id, market, polygon: <Polygon tx hash>, near_sign: <NEAR tx where MPC signed it> }.
import { readDeploy, view } from "./lib.ts";
const d = readDeploy();
const txs = await view<any[]>(d.airbag, "pm_txs", { limit: 500 });
const t = [...txs].reverse().find((x) => x.kind === "split" && x.hash);
console.log(JSON.stringify(t ? { id: t.id, market: t.market, polygon: t.hash, near_sign: d.proof?.[`pm_sign_${t.id}`]?.tx ?? null } : null));
