"use client";
// Signing with the connected NEAR wallet (NEAR Connect). A transaction can report success while a later receipt
// failed (e.g. the refund inside ft_transfer_call), so every receipt is checked.
import { useNearWallet } from "near-connect-hooks";
import { useCallback } from "react";
import { AIRBAG, USDC } from "./config";

type Action = { type: "FunctionCall"; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } };
export type Tx = { receiverId: string; actions: Action[] };
export type TxResult = { ok: boolean; hash?: string; error?: string; logs?: string[] };

const tgas = (n: number) => (BigInt(n) * 10n ** 12n).toString();
export const fc = (methodName: string, args: Record<string, unknown>, gasTgas = 30, deposit = "0"): Action => ({
  type: "FunctionCall",
  params: { methodName, args, gas: tgas(gasTgas), deposit },
});

/** USDC into Airbag with a message (add liquidity / buy cover). */
export const usdcCall = (amount: bigint, msg: object): Tx => ({
  receiverId: USDC,
  actions: [fc("ft_transfer_call", { receiver_id: AIRBAG, amount: amount.toString(), msg: JSON.stringify(msg) }, 150, "1")],
});
export const airbagCall = (method: string, args: Record<string, unknown>, gasTgas = 100): Tx => ({
  receiverId: AIRBAG,
  actions: [fc(method, args, gasTgas)],
});

function failure(f: unknown): string {
  const s = JSON.stringify(f);
  const m = s.match(/(ERR_[A-Z_]+[^"\\]*)/) ?? s.match(/"(?:ExecutionError|panic_msg|PanicMsg)"\s*:\s*"([^"]+)"/);
  return (m?.[1] ?? s).slice(0, 200);
}

export function outcome(o: any): TxResult {
  const hash = o?.transaction?.hash ?? o?.transaction_outcome?.id;
  const logs: string[] = (o?.receipts_outcome ?? []).flatMap((r: any) => r.outcome.logs);
  if (o?.status && typeof o.status === "object" && "Failure" in o.status) return { ok: false, hash, error: failure(o.status.Failure), logs };
  for (const r of o?.receipts_outcome ?? []) {
    const st = r.outcome.status;
    if (st && typeof st === "object" && "Failure" in st) return { ok: false, hash, error: failure(st.Failure), logs };
  }
  return { ok: true, hash, logs };
}

export function useSend() {
  const { signAndSendTransactions } = useNearWallet();
  return useCallback(
    async (tx: Tx): Promise<TxResult> => {
      try {
        const outs = await signAndSendTransactions({ transactions: [tx] as any });
        return outs?.[0] ? outcome(outs[0]) : { ok: false, error: "the wallet returned nothing" };
      } catch (e) {
        return { ok: false, error: (e as Error).message?.slice(0, 200) ?? "cancelled" };
      }
    },
    [signAndSendTransactions],
  );
}
