"use client";
// One market: buy cover (live quote from the contract), underwrite, and the books. `?id=` instead of a [param] route.
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNearWallet } from "near-connect-hooks";
import { airbag, ago, pct, statusOf, timeLeft, toBase, usd, type Market } from "@/lib/near";
import { BASE_SEPOLIA, polymarketUrl, txUrl } from "@/lib/config";
import { airbagCall, usdcCall, useSend, type TxResult } from "@/lib/wallet";
import { FaucetButton } from "@/components/Faucet";
import PolymarketPanel from "@/components/PolymarketPanel";

function Result({ r }: { r: TxResult | null }) {
  if (!r) return null;
  return (
    <div className={`log`}>
      <div className={r.ok ? "ok" : "err"}>
        {r.ok ? "✓ done" : `✗ ${r.error}`}{" "}
        {r.hash && (
          <a href={txUrl(r.hash)} target="_blank" rel="noreferrer">
            tx {r.hash.slice(0, 10)}… ↗
          </a>
        )}
      </div>
    </div>
  );
}

function Buy({ m, account }: { m: Market; account: string }) {
  const [amt, setAmt] = useState("100");
  const [dest, setDest] = useState<"near" | "base">("near");
  const [evm, setEvm] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TxResult | null>(null);
  const send = useSend();
  const qc = useQueryClient();
  let base: bigint | null = null;
  try {
    base = toBase(amt);
  } catch {
    base = null;
  }
  const quote = useQuery({ queryKey: ["quote", m.id, base?.toString()], queryFn: () => airbag.quote(m.id, base!), enabled: !!base && base > 0n, refetchInterval: 10_000 });
  const q = quote.data;
  const evmOk = /^0x[0-9a-fA-F]{40}$/.test(evm);
  const premium = q ? BigInt(q.premium) : null;
  const maxPremium = premium ? premium + premium / 100n + 1n : null; // 1% slippage room
  async function buy() {
    if (!base || !maxPremium) return;
    setBusy(true);
    setRes(null);
    const payout_to = dest === "base" ? { evm: { chain_id: String(BASE_SEPOLIA), address: evm } } : "near";
    const r = await send(usdcCall(maxPremium, { buy: { market: m.id, amount: base.toString(), max_premium: maxPremium.toString(), payout_to } }));
    setRes(r);
    setBusy(false);
    qc.invalidateQueries();
  }
  const { pays_on, slug } = m.source.polymarket;
  return (
    <div className="pnl col">
      <div className="pnl-head">
        <span className="pnl-title"><span className="n">01</span>Buy cover</span>
      </div>
      <div className="pnl-body grow">
        <div className="field">
          <label><span>Cover amount: you get this much USDC if it happens</span></label>
          <div className="amt">
            <input value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
            <span className="unit">USDC</span>
          </div>
          <div className="chips">
            {["10", "100", "500", "1000"].map((v) => (
              <button key={v} className={`chip ${amt === v ? "on" : ""}`} onClick={() => setAmt(v)}>{v}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label><span>Get paid on</span></label>
          <div className="chips">
            <button className={`chip ${dest === "near" ? "on" : ""}`} onClick={() => setDest("near")}>NEAR (this account)</button>
            <button className={`chip ${dest === "base" ? "on" : ""}`} onClick={() => setDest("base")}>Base Sepolia (Chain Signatures)</button>
          </div>
          {dest === "base" && (
            <div className="amt">
              <input placeholder="0x… your Base address" value={evm} onChange={(e) => setEvm(e.target.value.trim())} />
              <span className="unit">EVM</span>
            </div>
          )}
        </div>
        <div className="price-card">
          <div className="pc-k">You pay</div>
          <div className="pc-v">{q && !q.blocked ? usd(q.premium) : "—"}<small>USDC</small></div>
          <div className="pc-s">
            for <b>{amt || 0} USDC</b> of cover · {q && base ? pct(Number((BigInt(q.premium) * 10_000n) / (base || 1n)), 2) : "—"} per $1
          </div>
          <div className="pc-rule"><span>✓ pays automatically if Polymarket resolves <b>{pays_on.toUpperCase()}</b></span></div>
        </div>
        {q && (
          <div className="quote">
            <div className="quote-row"><span>AMM price</span><b>{usd(q.amm_cost)} USDC <span className="dim">({pct(q.price_before_bps)} → {pct(q.price_after_bps)})</span></b></div>
            <div className="quote-row"><span>Polymarket floor (TEE)</span><b>{usd(q.floor_cost)} USDC <span className="dim">({pct(q.floor_bps, 2)})</span></b></div>
            <div className="quote-row"><span>Charged</span><b>the higher one + {pct(m.fee_bps)} fee</b></div>
          </div>
        )}
        {q?.blocked && <div className="banner"><b>Not selling right now:</b> {q.blocked}</div>}
        <div className="actions">
          <button className="btn btn-primary" disabled={!account || busy || !q || !!q.blocked || (dest === "base" && !evmOk)} onClick={buy}>
            {busy ? "Waiting for wallet…" : `Buy cover${q && !q.blocked ? ` · ${usd(q.premium)} USDC` : ""} →`}
          </button>
        </div>
        <Result r={res} />
        <div className="pnl-note">
          {!account && "Connect a NEAR testnet wallet to buy. "}
          Your premium goes to the market&apos;s pool; your cover is backed 1:1 by USDC held in the contract. Cover bought
          within {Number(m.late_grace_secs) / 60} min before the event only gets its premium back (no buying after the news).
        </div>
      </div>
    </div>
  );
}

function Underwrite({ m, account }: { m: Market; account: string }) {
  const [amt, setAmt] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TxResult | null>(null);
  const send = useSend();
  const qc = useQueryClient();
  const lp = useQuery({ queryKey: ["lp", m.id, account], queryFn: () => airbag.lpOf(m.id, account), enabled: !!account });
  const resolved = statusOf(m.status) === "resolved";
  async function run(p: Promise<TxResult>) {
    setBusy(true);
    setRes(null);
    setRes(await p);
    setBusy(false);
    qc.invalidateQueries();
  }
  const l = lp.data;
  return (
    <div className="pnl col">
      <div className="pnl-head">
        <span className="pnl-title"><span className="n">02</span>Underwrite</span>
      </div>
      <div className="pnl-body grow">
        <div className="pnl-note">Add USDC to the pool and earn the premiums. If the event happens, the pool pays the policies.</div>
        {!resolved && (
          <div className="field">
            <label><span>Add liquidity</span></label>
            <div className="amt">
              <input value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
              <span className="unit">USDC</span>
            </div>
            <div className="actions">
              <button className="btn btn-primary" disabled={!account || busy} onClick={() => run(send(usdcCall(toBase(amt), { add_liquidity: { market: m.id } })))}>
                Add {amt} USDC →
              </button>
            </div>
          </div>
        )}
        {l && (
          <div className="quote">
            <div className="quote-row"><span>Your share of the pool</span><b>{pct(l.share_bps, 2)}</b></div>
            <div className="quote-row"><span>Premiums earned</span><b className="green">{usd(l.premiums_earned)} USDC</b></div>
            {(BigInt(l.left_no) > 0n || BigInt(l.left_yes) > 0n) && (
              <div className="quote-row"><span>Locked until the end</span><b>{usd(BigInt(l.left_no) + BigInt(l.left_yes))} claims</b></div>
            )}
          </div>
        )}
        {l && BigInt(l.shares) > 0n && !resolved && (
          <div className="actions">
            <button className="btn btn-ghost" disabled={busy} onClick={() => run(send(airbagCall("remove_liquidity", { market: m.id, shares: l.shares }, 100)))}>
              Withdraw what isn&apos;t backing cover
            </button>
          </div>
        )}
        {l && resolved && !l.claimed && (
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || m.payouts_done !== m.policies} onClick={() => run(send(airbagCall("claim_lp", { market: m.id }, 100)))}>
              Collect your share →
            </button>
          </div>
        )}
        <Result r={res} />
      </div>
    </div>
  );
}

function MarketView() {
  const id = useSearchParams().get("id") ?? "0";
  const { signedAccountId } = useNearWallet();
  const { data: m, error } = useQuery({ queryKey: ["market", id], queryFn: () => airbag.market(id) });
  const solv = useQuery({ queryKey: ["solvency", id], queryFn: () => airbag.solvency(id) });
  if (error) return <div className="container"><div className="banner"><b>Can&apos;t load market {id}.</b> {(error as Error).message}</div></div>;
  if (!m) return <div className="container"><div className="empty">loading…</div></div>;
  const s = statusOf(m.status);
  const { slug, pays_on } = m.source.polymarket;
  return (
    <div className="container">
      <div className="console-head">
        <div>
          <div className="crumbs">Airbag / <b>Market #{m.id}</b></div>
          <h1 className="console-title">{m.question}</h1>
          <div className="console-sub">
            <span className="net"><i />NEAR testnet</span>
            {s === "open" && !m.halted && <span className="pill ok">selling cover</span>}
            {m.halted && <span className="pill bad">halted</span>}
            {s === "proposed" && <span className="pill warn">result proposed: {(m.status as any).proposed.outcome} · dispute window</span>}
            {s === "resolved" && <span className="pill bad">resolved: {(m.status as any).resolved.outcome === "yes" ? "event happened, policies paid" : "no event, underwriters keep premiums"}</span>}
            <a className="pill" href={polymarketUrl(slug)} target="_blank" rel="noreferrer">Polymarket: {slug} · pays on {pays_on.toUpperCase()} ↗</a>
          </div>
        </div>
        {signedAccountId && <FaucetButton account={signedAccountId} />}
      </div>

      <div className="kpis">
        <div className="kpi"><div className="k">Polymarket odds (TEE)</div><div className="v purple">{pct(m.floor_bps, 2)}</div><div className="s">read {Number(m.floor_at) ? ago(m.floor_at) : "never"}</div></div>
        <div className="kpi"><div className="k">AMM price</div><div className="v">{pct(m.price_bps, 2)}</div><div className="s">rises as cover sells</div></div>
        <div className="kpi"><div className="k">Pool</div><div className="v">{usd(m.usdc_held, 0)}</div><div className="s">USDC held</div></div>
        <div className="kpi"><div className="k">Cover in force</div><div className="v">{usd(m.open_cover, 0)}</div><div className="s">{m.policies} policies</div></div>
        <div className="kpi"><div className="k">Ends</div><div className="v red">{timeLeft(m.end)}</div><div className="s">{new Date(Number(m.end) * 1000).toUTCString().slice(5, 22)} UTC</div></div>
      </div>

      <div className="row2">
        <Buy m={m} account={signedAccountId} />
        <Underwrite m={m} account={signedAccountId} />
      </div>

      <PolymarketPanel m={m} />

      <div className="pnl row-full">
        <div className="pnl-head"><span className="pnl-title"><span className="n">//</span>Solvency (read live from the contract)</span></div>
        <div className="pnl-body">
          {solv.data && (
            <div className="facts">
              <div><span>USDC held</span><b>{usd(solv.data.usdc_held as string)}</b></div>
              <div><span>Cover it must pay at most</span><b>{usd(solv.data.open_cover as string)}</b></div>
              <div><span>Fees + Polymarket top-ups set aside for underwriters</span><b>{usd(solv.data.premiums_unpaid_to_lps as string)}</b></div>
              <div><span>Fully backed</span><b className={solv.data.fully_backed ? "green" : "red"}>{solv.data.fully_backed ? "yes ✓" : "NO"}</b></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MarketPage() {
  return (
    <main className="console calm">
      <Suspense fallback={<div className="container"><div className="empty">loading…</div></div>}>
        <MarketView />
      </Suspense>
    </main>
  );
}
