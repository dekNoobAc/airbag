// Shared helpers for Airbag on NEAR testnet. Testnet only.
// Secrets (account keys) live in airbag-near/.env.testnet (git-ignored); public ids and tx hashes in testnet/deployment.json.
import fs from "node:fs";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, getTransactionLastResult, nearToYocto, type KeyPairString } from "near-api-js";

export const ROOT_DIR = path.resolve(import.meta.dirname, "../..");
export const ENV_FILE = path.join(ROOT_DIR, ".env.testnet");
export const DEPLOY_FILE = path.join(ROOT_DIR, "testnet", "deployment.json");
// rpc.testnet.near.org is deprecated; FastNEAR's free tier rate-limits. dRPC first.
export const RPC = process.env.TESTNET_RPC ?? "https://near-testnet.drpc.org";
export const provider = new JsonRpcProvider({ url: RPC }, { retries: 6, wait: 1000, backoff: 1.6 });
export const TGAS = 1_000_000_000_000n;
export const near = (n: string | number) => BigInt(nearToYocto(String(n) as `${number}`));
export const fmt = (y: bigint) => (Number(y / 10n ** 21n) / 1000).toFixed(3);
export const say = (s: string) => console.log(`▸ ${s}`);

// ── .env.testnet (secrets) ──
export function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}
export function setEnv(k: string, v: string) {
  const e = readEnv();
  e[k] = v;
  fs.writeFileSync(ENV_FILE, "# Airbag testnet accounts (git-ignored). Testnet only: never put mainnet keys here.\n" + Object.entries(e).map(([a, b]) => `${a}=${b}`).join("\n") + "\n", { mode: 0o600 });
}

// ── deployment.json (public) ──
export type Deployment = Record<string, any>;
export function readDeploy(): Deployment {
  return fs.existsSync(DEPLOY_FILE) ? JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8")) : {};
}
export function setDeploy(patch: Deployment) {
  fs.mkdirSync(path.dirname(DEPLOY_FILE), { recursive: true });
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify({ ...readDeploy(), ...patch }, null, 2) + "\n");
}
/** Records a proof transaction (shown in the README table). */
export function proof(key: string, label: string, tx: string, chain?: "base" | "amoy") {
  const d = readDeploy();
  setDeploy({ proof: { ...(d.proof ?? {}), [key]: chain ? { label, tx, chain } : { label, tx } } });
}

// ── accounts ──
export function acct(id: string, secret: string): Account {
  return new Account(id, provider, KeyPairSigner.fromSecretKey(secret as KeyPairString));
}
export async function exists(id: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId: id, blockQuery: { finality: "optimistic" } });
    return true;
  } catch {
    return false;
  }
}
export async function balance(id: string): Promise<bigint> {
  const a = await provider.viewAccount({ accountId: id, blockQuery: { finality: "optimistic" } });
  return BigInt(a.amount);
}

/** A new top-level testnet account funded by the public faucet helper. Returns its secret key. */
export async function faucetAccount(id: string): Promise<string> {
  const kp = KeyPair.fromRandom("ed25519");
  const r = await fetch("https://helper.nearprotocol.com/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`testnet faucet: ${r.status} ${await r.text()}`);
  for (let i = 0; i < 20 && !(await exists(id)); i++) await new Promise((s) => setTimeout(s, 1500));
  return kp.toString();
}

export type Sent = { tx: string; value: unknown; logs: string[] };
/** One transaction; throws if any receipt failed. */
export const fallback = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }, { retries: 4, wait: 1500, backoff: 1.6 });

/** The final outcome of a sent transaction; tries dRPC, then FastNEAR, until it's final. */
export async function waitFinal(tx: string, sender: string): Promise<any> {
  for (let i = 0; i < 60; i++) {
    for (const p of [provider, fallback]) {
      try {
        const o: any = await p.viewTransactionStatusWithReceipts({ txHash: tx, accountId: sender, waitUntil: "FINAL" });
        if (o?.final_execution_status === "FINAL") return o;
      } catch {
        /* not final yet, or this RPC is struggling */
      }
    }
    await new Promise((s) => setTimeout(s, 3000));
  }
  throw new Error(`no final status for ${tx}`);
}

/** One transaction; throws if any receipt failed. Sends and gets the hash first, then waits: a slow RPC can't lose it. */
export async function send(from: Account, receiverId: string, acts: ReturnType<typeof actions.transfer>[]): Promise<Sent> {
  const sent = await from.signAndSendTransaction({ receiverId, actions: acts, waitUntil: "INCLUDED", throwOnFailure: false });
  const o = await waitFinal(sent.transaction.hash, from.accountId);
  const top = o.status as any;
  if (top && typeof top === "object" && "Failure" in top) throw new Error(`tx ${sent.transaction.hash} failed: ${JSON.stringify(top.Failure).slice(0, 400)}`);
  for (const r of o.receipts_outcome) {
    const st = r.outcome.status as any;
    if (st && typeof st === "object" && "Failure" in st) throw new Error(`receipt failed in ${o.transaction_outcome.id}: ${JSON.stringify(st.Failure).slice(0, 400)}`);
  }
  let value: unknown;
  try {
    value = getTransactionLastResult(o);
  } catch {
    /* empty */
  }
  return { tx: o.transaction_outcome.id, value, logs: o.receipts_outcome.flatMap((r: any) => r.outcome.logs) };
}
export const call = (from: Account, contract: string, method: string, args: Record<string, unknown> | Uint8Array, opts: { deposit?: bigint; tgas?: number } = {}) =>
  send(from, contract, [actions.functionCall(method, args as any, BigInt(opts.tgas ?? 100) * TGAS, opts.deposit ?? 0n)]);
export const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction({ contractId, method, args, blockQuery: { finality: "optimistic" } }) as Promise<T>;

/** Airbag's NEP-297 events from a transaction's logs. */
export function events(logs: string[]): { event: string; data: any }[] {
  return logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11))).filter((e) => e.standard === "airbag").map((e) => ({ event: e.event, data: e.data[0] }));
}
