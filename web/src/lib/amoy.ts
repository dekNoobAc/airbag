// Reads Polymarket's Conditional Tokens on Polygon Amoy straight from the chain (no backend): the YES/NO shares
// Airbag's wallet holds for a condition, and whether a transaction has been mined.
import { AMOY_RPC } from "@/lib/config";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(AMOY_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const num = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const ethCall = (to: string, data: string) => rpc<string>("eth_call", [{ to, data }, "latest"]);

/** CTF position id of outcome `indexSet` (1 = YES, 2 = NO) for `collateral`. */
async function positionId(ctf: string, collateral: string, condition: string, indexSet: number) {
  const coll = await ethCall(ctf, `0x856296f7${word("0")}${word(condition)}${num(indexSet)}`);
  return ethCall(ctf, `0x39dd7530${word(collateral)}${word(coll)}`);
}

export async function shares(ctf: string, collateral: string, condition: string, wallet: string) {
  const [yes, no] = await Promise.all([1, 2].map(async (i) => {
    const pos = await positionId(ctf, collateral, condition, i);
    return BigInt(await ethCall(ctf, `0x00fdd58e${word(wallet)}${word(pos)}`));
  }));
  const resolved = BigInt(await ethCall(ctf, `0xdd34de67${word(condition)}`)) > 0n;
  return { yes, no, resolved };
}

export async function receipt(hash: string): Promise<"success" | "reverted" | null> {
  const r = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
  return r ? (r.status === "0x1" ? "success" : "reverted") : null;
}

export async function polBalance(addr: string) {
  return Number(BigInt(await rpc<string>("eth_getBalance", [addr, "latest"]))) / 1e18;
}
