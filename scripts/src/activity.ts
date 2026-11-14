// Real activity on the testnet markets, before they stop selling cover. Safe to re-run: done steps are skipped.
//   pnpm -C scripts testnet:activity
//   1. Airbag's payout wallet on Base Sepolia = the EVM address of NEAR MPC's key for (app contract, "airbag-float");
//      registered on the contract with Base Sepolia's real USDC (Circle, EIP-3009)
//   2. test accounts: lp (underwriter), alice (paid on NEAR), bob (paid on Base Sepolia, to a fresh EVM address)
//   3. lp adds liquidity to every market; fresh Polymarket floors from the TEE oracle; alice and bob buy cover
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { KeyPair, actions, baseDecode } from "near-api-js";
import { acct, call, events, exists, near, proof, readDeploy, readEnv, say, send, setDeploy, setEnv, view } from "./lib.ts";

const U = 1_000_000n;
const MPC = "v1.signer-prod.testnet";
const BASE_SEPOLIA = { chain_id: "84532", name: "Base Sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", usdc_name: "USDC", usdc_version: "2" };
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const evmAddress = (uncompressed64: Uint8Array) => hex(keccak_256(uncompressed64).slice(12));

const env = readEnv();
const d = readDeploy();
const ROOT = env.ROOT_ACCOUNT!;
const root = acct(ROOT, env.ROOT_KEY!);

// ── 1. payout wallet on Base Sepolia ──
if (!d.float_address) {
  const pk = await view<string>(MPC, "derived_public_key", { path: "airbag-float", predecessor: d.airbag, domain_id: 0 });
  const raw = baseDecode(pk.replace("secp256k1:", "")); // 64 bytes: x ‖ y
  const float = evmAddress(raw);
  const r = await call(root, d.airbag, "set_evm_chain", { chain: { ...BASE_SEPOLIA, float_address: float } });
  setDeploy({ float_address: float, base_sepolia_usdc: BASE_SEPOLIA.usdc });
  proof("evm_chain", `Base Sepolia registered; payout wallet ${float} = NEAR MPC key (app, "airbag-float")`, r.tx);
  say(`Airbag's payout wallet on Base Sepolia: ${float}`);
}

// ── 2. test accounts ──
async function user(name: string): Promise<ReturnType<typeof acct>> {
  const id = `${name}.${ROOT}`;
  const envKey = `KEY_${name.toUpperCase()}`;
  if (!(await exists(id))) {
    const kp = KeyPair.fromRandom("ed25519");
    setEnv(envKey, kp.toString());
    await send(root, id, [actions.createAccount(), actions.transfer(near("0.3")), actions.addFullAccessKey(kp.getPublicKey())]);
    await call(root, d.usdc, "storage_deposit", { account_id: id, registration_only: true }, { deposit: near("0.0125") });
  }
  return acct(id, readEnv()[envKey]!);
}
const lp = await user("lp");
const alice = await user("alice");
const bob = await user("bob");
if (!readEnv().BOB_EVM_KEY) {
  const sk = secp256k1.utils.randomSecretKey();
  setEnv("BOB_EVM_KEY", hex(sk));
  setDeploy({ bob_evm: evmAddress(secp256k1.getPublicKey(sk, false).slice(1)) });
}
const bobEvm: string = readDeploy().bob_evm;
if (!readDeploy().funded) {
  for (const [who, amt] of [[lp, 30_000n], [alice, 1_000n], [bob, 1_000n]] as const) {
    await call(root, d.usdc, "ft_transfer", { receiver_id: who.accountId, amount: (amt * U).toString() }, { deposit: 1n });
  }
  setDeploy({ funded: true });
  say(`funded ${lp.accountId} (30,000 USDC), alice and bob (1,000 each); bob's Base address ${bobEvm}`);
}

const transferCall = (from: typeof lp, amount: bigint, msg: object) =>
  call(from, d.usdc, "ft_transfer_call", { receiver_id: d.airbag, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: 1n, tgas: 150 });

// ── 3. liquidity ──
const markets: Record<string, string> = readDeploy().markets;
const LIQ: Record<string, bigint> = { usdc: 10_000n, btc74: 10_000n, btc70: 10_000n };
for (const [key, id] of Object.entries(markets)) {
  if (readDeploy().proof?.[`lp_${key}`]) continue;
  const r = await transferCall(lp, LIQ[key]! * U, { add_liquidity: { market: id } });
  proof(`lp_${key}`, `Underwriter adds ${LIQ[key]} USDC to market ${id}`, r.tx);
  say(`lp added ${LIQ[key]} USDC to market ${id}`);
}

// ── 4. cover ──
const BUYS = [
  { key: "buy_alice_btc74", who: alice, market: markets.btc74!, amount: 300n, to: "near" as const },
  { key: "buy_bob_btc74", who: bob, market: markets.btc74!, amount: 100n, to: "base" as const },
  { key: "buy_alice_btc70", who: alice, market: markets.btc70!, amount: 500n, to: "near" as const },
  { key: "buy_bob_usdc", who: bob, market: markets.usdc!, amount: 400n, to: "near" as const },
];
for (const b of BUYS) {
  if (readDeploy().proof?.[b.key]) continue;
  const q = await view<any>(d.airbag, "quote", { market: b.market, amount: (b.amount * U).toString() });
  if (q.blocked) {
    say(`market ${b.market}: ${q.blocked}. Run \`pnpm testnet:refresh ${b.market}\` first, then re-run this.`);
    continue;
  }
  const premium = BigInt(q.premium);
  const payout_to = b.to === "base" ? { evm: { chain_id: "84532", address: bobEvm } } : "near";
  const r = await transferCall(b.who, premium + U, { buy: { market: b.market, amount: (b.amount * U).toString(), max_premium: (premium + U).toString(), payout_to } });
  const ev = events(r.logs).find((e) => e.event === "cover_bought");
  const paid = Number(BigInt(ev?.data.premium ?? premium)) / 1e6;
  proof(b.key, `${b.who.accountId.split(".")[0]} buys ${b.amount} USDC of cover on market ${b.market} for ${paid.toFixed(2)} USDC (paid ${b.to === "base" ? "on Base Sepolia" : "on NEAR"})`, r.tx);
  say(`${b.who.accountId.split(".")[0]}: ${b.amount} cover on market ${b.market} for ${paid.toFixed(2)} USDC (floor ${q.floor_bps} bps, AMM ${q.price_before_bps} bps)`);
}
for (const id of Object.values(markets)) {
  const s = await view<any>(d.airbag, "solvency", { market: id });
  say(`market ${id}: held ${Number(s.usdc_held) / 1e6} USDC, open cover ${Number(s.open_cover) / 1e6}, fully backed: ${s.fully_backed}`);
}
