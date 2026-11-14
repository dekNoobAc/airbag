// Deploys Airbag on NEAR testnet. Safe to re-run: every step is skipped once done.
//   pnpm -C scripts testnet:setup
//   1. a root account from the public faucet (airbag-xxxx.testnet)
//   2. usdc.<root>: mock USDC (6 decimals; Circle has no USDC on NEAR testnet)
//   3. the oracle wasm uploaded to FastFS (stored on NEAR itself) and checked byte for byte
//   4. app.<root>: the Airbag contract, its oracle pinned to that wasm's URL + sha256, MPC = v1.signer-prod.testnet
//   5. a market linked to Polymarket's "USDC depeg by December 31?"
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import { DEPLOY_FILE, ROOT_DIR, TGAS, acct, balance, call, exists, faucetAccount, fmt, near, proof, readDeploy, readEnv, say, send, setDeploy, setEnv } from "./lib.ts";

const WASM = {
  airbag: path.join(ROOT_DIR, "contracts/target/near/airbag/airbag.wasm"),
  ft: path.join(ROOT_DIR, "contracts/integration-tests/res/fungible_token.wasm"),
  oracle: path.join(ROOT_DIR, "oracle/target/wasm32-wasip2/release/airbag-oracle.wasm"),
};
for (const [k, f] of Object.entries(WASM)) if (!fs.existsSync(f)) throw new Error(`missing ${k} wasm: ${f} (build it first)`);
const OUTLAYER = "outlayer.testnet";
const MPC = "v1.signer-prod.testnet";
const U = 1_000_000n;

// ── 1. root ──
let env = readEnv();
if (!env.ROOT_ACCOUNT) {
  const id = `airbag-${Date.now().toString(36)}.testnet`;
  say(`creating ${id} from the testnet faucet`);
  setEnv("ROOT_KEY", await faucetAccount(id));
  setEnv("ROOT_ACCOUNT", id);
  env = readEnv();
}
const ROOT = env.ROOT_ACCOUNT!;
const root = acct(ROOT, env.ROOT_KEY!);
say(`root ${ROOT}: ${fmt(await balance(ROOT))} NEAR`);
const ids = { usdc: `usdc.${ROOT}`, app: `app.${ROOT}` };
setDeploy({ network: "testnet", root: ROOT, usdc: ids.usdc, airbag: ids.app, outlayer: OUTLAYER, mpc: MPC });

/** A subaccount holding its own key (stored in .env.testnet). */
async function sub(id: string, nearAmount: number) {
  const envKey = `KEY_${id.split(".")[0]!.toUpperCase()}`;
  if (await exists(id)) return acct(id, readEnv()[envKey]!);
  const kp = KeyPair.fromRandom("ed25519");
  setEnv(envKey, kp.toString());
  await send(root, id, [actions.createAccount(), actions.transfer(near(nearAmount)), actions.addFullAccessKey(kp.getPublicKey())]);
  return acct(id, kp.toString());
}

// ── 2. mock USDC ──
const usdc = await sub(ids.usdc, 2.5);
if (!readDeploy().usdc_ready) {
  await send(usdc, ids.usdc, [actions.deployContract(fs.readFileSync(WASM.ft))]);
  await call(usdc, ids.usdc, "new", {
    owner_id: ROOT,
    total_supply: (10_000_000n * U).toString(),
    metadata: { spec: "ft-1.0.0", name: "Mock USDC (Airbag testnet)", symbol: "USDC", decimals: 6 },
  });
  setDeploy({ usdc_ready: true });
  say("mock USDC deployed (10M to root)");
}

// ── 3. oracle wasm on FastFS ──
const oracle = fs.readFileSync(WASM.oracle);
const hash = createHash("sha256").update(oracle).digest("hex");
const url = `https://test.fastfs.io/${ROOT}/${OUTLAYER}/${hash}.wasm`;
if (readDeploy().oracle_hash !== hash) {
  // FastFS: borsh enum Simple(0) { relative_path, Some(content { mime_type, content }) }, sent as the args of a
  // `__fastdata_fastfs` call with gas = 1. The call fails by design; the indexer reads the data from the tx.
  const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const payload = Buffer.concat([Buffer.from([0]), str(`${hash}.wasm`), Buffer.from([1]), str("application/wasm"), u32(oracle.length), oracle]);
  say(`uploading the oracle (${oracle.length} bytes, sha256 ${hash.slice(0, 12)}…) to FastFS`);
  // big transaction: dRPC refuses bodies this large, FastNEAR takes them
  const uploader = new Account(ROOT, new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }, { retries: 4, wait: 1500, backoff: 1.6 }), KeyPairSigner.fromSecretKey(env.ROOT_KEY as KeyPairString));
  const o = await uploader.signAndSendTransaction({ receiverId: OUTLAYER, actions: [actions.functionCall("__fastdata_fastfs", payload, 1n, 0n)], waitUntil: "INCLUDED_FINAL", throwOnFailure: false });
  const tx = o.transaction_outcome.id;
  say(`  upload tx ${tx}; waiting for the FastFS indexer`);
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    await new Promise((s) => setTimeout(s, 6000));
    const r = await fetch(url).catch(() => null);
    if (r?.ok) ok = createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex") === hash;
  }
  if (!ok) throw new Error(`FastFS didn't serve ${url} with the right hash yet; re-run in a minute`);
  setDeploy({ oracle_hash: hash, oracle_url: url });
  proof("oracle_upload", "Oracle wasm stored on NEAR (FastFS)", tx);
  say(`  served at ${url} (hash matches)`);
}

// ── 4. Airbag ──
// --fresh: delete the contract account (its NEAR goes back to root) and deploy again, e.g. after a state change
if (process.argv.includes("--fresh") && (await exists(ids.app))) {
  await send(acct(ids.app, readEnv().KEY_APP!), ids.app, [actions.deleteAccount(ROOT)]);
  // RPC nodes can still report it for a few seconds
  for (let i = 0; i < 20 && (await exists(ids.app)); i++) await new Promise((r) => setTimeout(r, 1500));
  const d0 = readDeploy();
  delete d0.market_usdc;
  for (const k of ["market_usdc", "deploy", "init", "oracle_refresh"]) delete d0.proof?.[k];
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify({ ...d0, app_ready: false, oracle_pinned: null, markets: {} }, null, 2) + "\n");
  say("old Airbag contract account deleted");
}
const app = await sub(ids.app, 4);
if (!readDeploy().app_ready) {
  const d = await send(app, ids.app, [actions.deployContract(fs.readFileSync(WASM.airbag))]);
  const i = await call(app, ids.app, "new", {
    owner: ROOT,
    usdc: ids.usdc,
    guardian: ROOT,
    oracle: { outlayer: OUTLAYER, wasm_url: url, wasm_hash: hash, account: null },
    mpc: MPC,
  });
  await call(root, ids.usdc, "storage_deposit", { account_id: ids.app, registration_only: true }, { deposit: near("0.0125") });
  setDeploy({ app_ready: true });
  proof("deploy", "Airbag contract deployed", d.tx);
  proof("init", "Airbag initialised: oracle pinned to the FastFS wasm (url + sha256)", i.tx);
  say("Airbag deployed");
} else if (readDeploy().oracle_pinned !== hash) {
  await call(root, ids.app, "set_oracle", { oracle: { outlayer: OUTLAYER, wasm_url: url, wasm_hash: hash, account: null } });
}
setDeploy({ oracle_pinned: hash });

// ── 5. markets, each linked to a Polymarket market ──
// Ends at Polymarket's own end time. Buys stop `min_cover_window` before it; a buy within `late_grace` of the event
// only gets its premium back. Daily markets move fast, so their floor must be fresh (30 min).
const MARKETS = [
  { key: "usdc", question: "USDC depegs (below $0.98 for 24h) before Dec 31, 2026", slug: "usdc-depeg-by-december-31-968", pays_on: "yes", end: "2027-01-01T05:00:00Z", price: 200, maxAge: 86_400 },
  { key: "btc74", question: "BTC crash cover: Bitcoin closes below $74,000 on Nov 12", slug: "bitcoin-above-74k-on-november-12-2026", pays_on: "no", end: "2026-11-12T17:00:00Z", price: 3_700, maxAge: 1_800 },
  { key: "btc70", question: "BTC crash cover: Bitcoin closes below $70,000 on Nov 13", slug: "bitcoin-above-70k-on-november-13-2026", pays_on: "no", end: "2026-11-13T17:00:00Z", price: 700, maxAge: 1_800 },
];
const markets: Record<string, string> = { ...(readDeploy().markets ?? {}) };
for (const m of MARKETS) {
  if (markets[m.key] !== undefined) continue;
  const r = await call(root, ids.app, "create_market", {
    args: {
      question: m.question,
      source: { polymarket: { slug: m.slug, pays_on: m.pays_on } },
      end: String(Math.floor(Date.parse(m.end) / 1000)),
      initial_price_bps: m.price,
      fee_bps: 100,
      halt_bps: 9000,
      dispute_secs: "600",
      late_grace_secs: "3600",
      min_cover_window_secs: "7200",
      floor_max_age_secs: String(m.maxAge),
      max_take_bps: 2000,
    },
  });
  markets[m.key] = String(r.value);
  setDeploy({ markets });
  proof(`market_${m.key}`, `Market ${r.value} created: ${m.question} (Polymarket ${m.slug}, pays on ${m.pays_on})`, r.tx);
  say(`market ${r.value}: ${m.question}`);
}
say(`done. root has ${fmt(await balance(ROOT))} NEAR. Next: pnpm -C scripts testnet:refresh <market>`);
void TGAS;
