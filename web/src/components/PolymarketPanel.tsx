"use client";
// How a market uses Polymarket: its odds (read in the TEE) and its hedge, real YES/NO shares on Polymarket's own
// Conditional Tokens contract (Polygon Amoy), held by a wallet only this NEAR contract can sign for.
import { useQuery } from "@tanstack/react-query";
import { airbag, ago, pct, usd, type Market } from "@/lib/near";
import { AMOY_EXPLORER, polymarketUrl, txUrl } from "@/lib/config";
import { receipt, shares } from "@/lib/amoy";

const KIND: Record<string, string> = {
  approve: "Approve CTF",
  mint: "Mint test USDC",
  prepare_condition: "Create condition",
  split: "Split USDC → YES + NO",
  report_payouts: "Report result",
  redeem: "Redeem shares",
};

export default function PolymarketPanel({ m }: { m: Market }) {
  const { slug, pays_on } = m.source.polymarket;
  const cfg = useQuery({ queryKey: ["pm-config"], queryFn: airbag.pmConfig });
  const hedges = useQuery({ queryKey: ["pm-hedges"], queryFn: airbag.pmHedges });
  const txs = useQuery({ queryKey: ["pm-txs"], queryFn: airbag.pmTxs });
  const h = hedges.data?.find((x) => x.market === m.id);
  const c = cfg.data;
  const held = useQuery({
    queryKey: ["pm-shares", h?.condition_id],
    queryFn: () => shares(c!.ctf, c!.collateral, h!.condition_id, c!.wallet),
    enabled: !!c && !!h,
    refetchInterval: 30_000,
  });
  const mine = (txs.data ?? []).filter((t) => t.market === m.id);
  const mined = useQuery({
    queryKey: ["pm-receipts", mine.map((t) => t.hash).join()],
    queryFn: async () => Object.fromEntries(await Promise.all(mine.filter((t) => t.hash).map(async (t) => [t.id, await receipt(t.hash!).catch(() => null)]))),
    enabled: mine.length > 0,
    refetchInterval: 30_000,
  });

  return (
    <div className="pnl row-full">
      <div className="pnl-head">
        <span className="pnl-title"><span className="n">PM</span>Built on Polymarket</span>
        <a className="pill" href={polymarketUrl(slug)} target="_blank" rel="noreferrer">open on Polymarket ↗</a>
      </div>
      <div className="pnl-body">
        <div className="pm-steps">
          <div><b>1 · Read</b>A pinned oracle runs in an OutLayer TEE and reads Polymarket&apos;s odds for <code>{slug}</code>: now <b className="purple inline">{pct(m.floor_bps, 2)}</b> ({Number(m.floor_at) ? ago(m.floor_at) : "never"}).</div>
          <div><b>2 · Price</b>Cover is never sold below those odds: you pay max(AMM price, Polymarket odds) + fee.</div>
          <div><b>3 · Hedge</b>Every policy is split into real YES + NO shares on Polymarket&apos;s own CTF contract, held by a wallet only this NEAR contract can sign for.</div>
          <div><b>4 · Settle</b>When Polymarket resolves {pays_on.toUpperCase()}, the result is reported to the CTF and the shares redeemed; policies pay out automatically.</div>
        </div>

        {c && h ? (
          <>
            <div className="facts">
              <div><span>Polymarket CTF ({c.name})</span><b><a href={`${AMOY_EXPLORER}/address/${c.ctf}`} target="_blank" rel="noreferrer">{c.ctf.slice(0, 10)}…{c.ctf.slice(-4)} ↗</a></b></div>
              <div><span>Condition ID</span><b>{h.condition_id.slice(0, 14)}…{h.condition_id.slice(-6)}</b></div>
              <div><span>Airbag&apos;s wallet (NEAR MPC, no private key)</span><b><a href={`${AMOY_EXPLORER}/address/${c.wallet}`} target="_blank" rel="noreferrer">{c.wallet.slice(0, 10)}…{c.wallet.slice(-4)} ↗</a></b></div>
              <div><span>Cover to hedge (contract)</span><b>{usd(h.hedged)} USDC</b></div>
              <div>
                <span>Shares held on Polygon (read live)</span>
                <b>{held.data ? <>{usd(held.data.yes)} YES · {usd(held.data.no)} NO{held.data.resolved && " · resolved"}</> : held.isError ? "can't reach Amoy" : "…"}</b>
              </div>
              {h.reported && <div><span>Result reported to Polymarket&apos;s CTF</span><b>{h.reported.toUpperCase()} won</b></div>}
            </div>
            <table className="dtable">
              <thead><tr><th>Polygon transaction</th><th className="num">Nonce</th><th>Status</th></tr></thead>
              <tbody>
                {mine.map((t) => {
                  const r = mined.data?.[t.id];
                  return (
                    <tr key={t.id}>
                      <td>{KIND[t.kind] ?? t.kind}</td>
                      <td className="num">{t.nonce ?? "—"}</td>
                      <td>
                        {t.hash ? (
                          <a href={txUrl(t.hash, "amoy")} target="_blank" rel="noreferrer">
                            {r === "success" ? "✓ on Polygon" : r === "reverted" ? "✗ reverted" : "signed by NEAR MPC"} ↗
                          </a>
                        ) : t.status === "signing" ? "signing…" : "queued"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : (
          <div className="empty">This market isn&apos;t hedged on Polymarket yet.</div>
        )}
        <div className="pnl-note">
          Testnet: Polymarket&apos;s own contracts on Polygon Amoy, with the test USDC their exchange uses. The contract builds every
          Polygon transaction; the keeper only asks NEAR MPC to sign it and broadcasts it. On mainnet the unneeded side would be sold on
          Polymarket&apos;s order book.
        </div>
      </div>
    </div>
  );
}
