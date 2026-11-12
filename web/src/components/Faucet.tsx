"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { airbag, usd } from "@/lib/near";
import { txUrl } from "@/lib/config";

/** The connected account's test USDC, and a button to get 1,000 more (testnet faucet). */
export function FaucetButton({ account }: { account: string }) {
  const qc = useQueryClient();
  const bal = useQuery({ queryKey: ["usdc", account], queryFn: () => airbag.usdcBalance(account) });
  const [state, setState] = useState<{ busy?: boolean; msg?: string; tx?: string }>({});
  async function get() {
    setState({ busy: true });
    const r = await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account }) });
    const j = await r.json().catch(() => ({}));
    setState({ msg: j.ok ? "+1,000 test USDC" : j.error ?? `error ${r.status}`, tx: j.tx });
    qc.invalidateQueries();
  }
  return (
    <div className="acct">
      <div className="acct-bal">
        <span>Your test USDC</span>
        <b>{bal.data !== undefined ? usd(bal.data) : "…"}</b>
      </div>
      <button className="btn btn-sm btn-ghost" onClick={get} disabled={state.busy}>
        {state.busy ? "Sending…" : "Get 1,000 test USDC"}
      </button>
      {state.msg && (
        <span className="dim">
          {state.msg}{" "}
          {state.tx && (
            <a href={txUrl(state.tx)} target="_blank" rel="noreferrer">↗</a>
          )}
        </span>
      )}
    </div>
  );
}
