"use client";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNearWallet } from "near-connect-hooks";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { airbag, usd, type Policy } from "@/lib/near";
import { BASE_EXPLORER, txUrl } from "@/lib/config";
import { airbagCall, useSend } from "@/lib/wallet";
import { FaucetButton } from "@/components/Faucet";

const STATE: Record<Policy["state"], string> = {
  active: "covered",
  paid: "PAID ✓",
  refunded: "premium refunded",
  expired: "ended, no event",
};

export default function MePage() {
  return (
    <Suspense fallback={<main className="console calm"><div className="container"><div className="empty">loading…</div></div></main>}>
      <Me />
    </Suspense>
  );
}

function Me() {
  const { signedAccountId, signIn } = useNearWallet();
  // `?account=` shows any account read-only (no wallet needed)
  const viewAs = useSearchParams().get("account");
  const account = viewAs || signedAccountId;
  const readOnly = !!viewAs && viewAs !== signedAccountId;
  const send = useSend();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const markets = useQuery({ queryKey: ["markets"], queryFn: airbag.markets });
  const policies = useQuery({ queryKey: ["policies", account], queryFn: () => airbag.policiesOf(account), enabled: !!account });
  const claimable = useQuery({ queryKey: ["claimable", account], queryFn: () => airbag.claimable(account), enabled: !!account });
  const payouts = useQuery({ queryKey: ["evm-payouts"], queryFn: airbag.evmPayouts });
  const lps = useQuery({
    queryKey: ["lps", account, markets.data?.length],
    queryFn: async () => Promise.all((markets.data ?? []).map(async (m) => ({ m, lp: await airbag.lpOf(m.id, account) }))),
    enabled: !!account && !!markets.data,
  });
  const q = (id: string) => markets.data?.find((m) => m.id === id)?.question ?? `#${id}`;

  if (!account)
    return (
      <main className="console calm">
        <div className="container">
          <div className="empty">
            <p>Connect a NEAR testnet wallet to see your cover and underwriting.</p>
            <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => signIn()}>Connect NEAR wallet →</button>
          </div>
        </div>
      </main>
    );
  return (
    <main className="console calm">
      <div className="container">
        <div className="console-head">
          <div>
            <div className="crumbs">Airbag / <b>My cover</b></div>
            <h1 className="console-title">{account}</h1>
          </div>
          {readOnly ? <span className="pill">read-only view</span> : <FaucetButton account={account} />}
        </div>

        {!readOnly && claimable.data && BigInt(claimable.data) > 0n && (
          <div className="deployed">
            <div>
              <div className="deployed-title">{usd(claimable.data)} USDC waiting for you</div>
              <div className="deployed-sub">A payout couldn&apos;t be delivered (no USDC storage yet). Claim it now.</div>
            </div>
            <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); await send(airbagCall("claim", {}, 100)); setBusy(false); qc.invalidateQueries(); }}>Claim →</button>
          </div>
        )}

        <div className="pnl">
          <div className="pnl-head"><span className="pnl-title"><span className="n">01</span>Your policies</span></div>
          <div className="pnl-body">
            {policies.data?.length ? (
              <table className="dtable">
                <thead><tr><th>#</th><th>Market</th><th className="num">Cover</th><th className="num">Premium</th><th>Paid on</th><th>Status</th></tr></thead>
                <tbody>
                  {policies.data.map((p) => {
                    const evm = typeof p.payout_to === "object" ? p.payout_to.evm : null;
                    const out = evm ? payouts.data?.find((x) => x.policy === p.id) : undefined;
                    return (
                      <tr key={p.id}>
                        <td>{p.id}</td>
                        <td><Link href={`/market?id=${p.market}`}>{q(p.market)}</Link></td>
                        <td className="num">{usd(p.amount)}</td>
                        <td className="num">{usd(p.premium)}</td>
                        <td>{evm ? <a href={`${BASE_EXPLORER}/address/${evm.address}`} target="_blank" rel="noreferrer">Base {evm.address.slice(0, 8)}… ↗</a> : "NEAR"}</td>
                        <td>
                          <span className={p.state === "paid" ? "green" : p.state === "active" ? "" : "dim"}>{STATE[p.state]}</span>
                          {out && <span className="dim"> · Base: {out.status}{out.relay_tx && <> <a href={txUrl(out.relay_tx)} target="_blank" rel="noreferrer">↗</a></>}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="empty">No cover yet. <Link className="u" href="/#markets">Pick a market →</Link></div>
            )}
          </div>
        </div>

        <div className="pnl">
          <div className="pnl-head"><span className="pnl-title"><span className="n">02</span>Your underwriting</span></div>
          <div className="pnl-body">
            {lps.data?.some((x) => x.lp) ? (
              <table className="dtable">
                <thead><tr><th>Market</th><th className="num">Pool share</th><th className="num">Premiums earned</th><th>Status</th></tr></thead>
                <tbody>
                  {lps.data.filter((x) => x.lp).map(({ m, lp }) => (
                    <tr key={m.id}>
                      <td><Link href={`/market?id=${m.id}`}>{m.question}</Link></td>
                      <td className="num">{(lp!.share_bps / 100).toFixed(2)}%</td>
                      <td className="num green">{usd(lp!.premiums_earned)}</td>
                      <td>{lp!.claimed ? "collected" : "active"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty">Not underwriting yet. Add liquidity on any market page.</div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
