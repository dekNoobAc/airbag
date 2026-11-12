"use client";
// Everything a judge can check: the oracle's code, where it runs, the payout wallet, and every proof transaction.
import { useQuery } from "@tanstack/react-query";
import { airbag, usd } from "@/lib/near";
import { AIRBAG, BASE_EXPLORER, DEPLOYMENT as D, USDC, accountUrl, txUrl } from "@/lib/config";

export default function Proof() {
  const cfg = useQuery({ queryKey: ["config"], queryFn: airbag.config });
  const payouts = useQuery({ queryKey: ["evm-payouts"], queryFn: airbag.evmPayouts });
  const o = cfg.data?.oracle;
  const proofs = Object.entries((D.proof ?? {}) as Record<string, { label: string; tx: string; chain?: string }>);
  return (
    <main className="console calm">
      <div className="container">
        <div className="console-head">
          <div>
            <div className="crumbs">Airbag / <b>Proof</b></div>
            <h1 className="console-title">Don&apos;t trust us. Check.</h1>
            <div className="console-sub"><span className="net"><i />NEAR testnet</span></div>
          </div>
        </div>

        <div className="pnl">
          <div className="pnl-head"><span className="pnl-title"><span className="n">01</span>The oracle is a code hash, not a server</span></div>
          <div className="pnl-body">
            <div className="facts">
              <div><span>Pinned in the contract (read live)</span><b>{o ? `${o.wasm_hash.slice(0, 16)}…` : "…"}</b></div>
              <div><span>Stored on NEAR (FastFS)</span><b>{o ? <a href={o.wasm_url} target="_blank" rel="noreferrer">download wasm ↗</a> : "…"}</b></div>
              <div><span>Runs in</span><b>OutLayer · Intel TDX ({o?.outlayer ?? "…"})</b></div>
              <div><span>Oracle key</span><b>none: only results from that run are accepted</b></div>
            </div>
            <p className="pnl-note">
              Rebuild it yourself: <code>cd airbag-near/oracle && cargo build --target wasm32-wasip2 --release && shasum -a 256 target/wasm32-wasip2/release/airbag-oracle.wasm</code>.
              Anyone can call <code>refresh(market)</code> (≈0.001 NEAR); the contract asks OutLayer to run exactly that hash, the
              module reads Polymarket, and <code>on_oracle</code> stores the odds with the sha256 of the response it saw.
            </p>
          </div>
        </div>

        <div className="pnl">
          <div className="pnl-head"><span className="pnl-title"><span className="n">02</span>Payouts on Base: a wallet nobody holds</span></div>
          <div className="pnl-body">
            <div className="facts">
              <div><span>Base Sepolia payout wallet</span><b><a href={`${BASE_EXPLORER}/address/${D.float_address}`} target="_blank" rel="noreferrer">{D.float_address} ↗</a></b></div>
              <div><span>Its key</span><b>NEAR MPC, path &quot;airbag-float&quot;, only for {AIRBAG}</b></div>
              <div><span>What it can sign</span><b>USDC transfers of finalized payouts (the contract builds the message)</b></div>
            </div>
            {payouts.data?.length ? (
              <table className="dtable">
                <thead><tr><th>#</th><th>Policy</th><th>To</th><th className="num">USDC</th><th>Status</th></tr></thead>
                <tbody>
                  {payouts.data.map((p) => (
                    <tr key={p.id}>
                      <td>{p.id}</td><td>{p.policy}</td><td>{p.to.slice(0, 10)}…</td><td className="num">{usd(p.amount)}</td>
                      <td>{p.status}{p.relay_tx && <> · <a href={txUrl(p.relay_tx)} target="_blank" rel="noreferrer">Base tx ↗</a></>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="pnl-note">No Base payouts yet: they appear here when a market pays out a policy set to Base.</p>
            )}
          </div>
        </div>

        <div className="pnl">
          <div className="pnl-head"><span className="pnl-title"><span className="n">03</span>Contracts</span></div>
          <div className="pnl-body">
            <div className="facts">
              <div><span>Airbag</span><b><a href={accountUrl(AIRBAG)} target="_blank" rel="noreferrer">{AIRBAG} ↗</a></b></div>
              <div><span>Mock USDC (testnet)</span><b><a href={accountUrl(USDC)} target="_blank" rel="noreferrer">{USDC} ↗</a></b></div>
              <div><span>MPC signer</span><b>{D.mpc}</b></div>
              <div><span>Guardian (can only delay)</span><b>{cfg.data?.guardian ?? "…"}</b></div>
            </div>
          </div>
        </div>

        <div className="pnl">
          <div className="pnl-head"><span className="pnl-title"><span className="n">04</span>Every step, on-chain</span></div>
          <div className="pnl-body">
            <table className="dtable">
              <thead><tr><th>What happened</th><th>Transaction</th></tr></thead>
              <tbody>
                {proofs.map(([k, p]) => (
                  <tr key={k}>
                    <td>{p.label}</td>
                    <td><a href={txUrl(p.tx, p.chain)} target="_blank" rel="noreferrer">{p.chain === "amoy" ? "Polygon · " : p.tx.startsWith("0x") ? "Base · " : ""}{p.tx.slice(0, 12)}… ↗</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
