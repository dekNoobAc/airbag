"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import HeroBag from "@/components/HeroBag";
import { airbag, pct, statusOf, timeLeft, usd, type Market } from "@/lib/near";
import { polymarketUrl } from "@/lib/config";

const STEPS = [
  { no: "01", title: "Underwriters add USDC", body: "Their USDC goes into the market's pool on NEAR and earns every premium. Money that backs cover already sold stays locked until the market ends.", mech: "ft_transfer_call → add_liquidity" },
  { no: "02", title: "You buy cover at a fair price", body: "An AMM prices it: the more cover sold, the higher the price. It never goes below the odds Polymarket gives the same event, read inside a TEE.", mech: "premium = max(AMM, Polymarket) + fee" },
  { no: "03", title: "Polymarket decides, a TEE reads it", body: "OutLayer runs our pinned oracle (code hash on-chain) inside Intel TDX. It reads Polymarket's result; a dispute window follows.", mech: "refresh → OutLayer → on_oracle" },
  { no: "04", title: "The airbag deploys", body: "Policies pay their full amount automatically: USDC on NEAR, or on Base, signed by NEAR's MPC network. No claim form.", mech: "payout_batch · sign_evm_payout" },
];

function Status({ m }: { m: Market }) {
  const s = statusOf(m.status);
  if (s === "resolved") {
    const o = (m.status as any).resolved.outcome;
    return <span className={`pill ${o === "yes" ? "bad" : "ok"}`}>{o === "yes" ? "event happened · paid" : "ended · no event"}</span>;
  }
  if (s === "proposed") return <span className="pill warn">result in dispute window</span>;
  return <span className="pill ok">selling cover</span>;
}

function MarketCard({ m }: { m: Market }) {
  const { slug, pays_on } = m.source.polymarket;
  return (
    <Link className="product" href={`/market?id=${m.id}`}>
      <div className="product-top">
        <span className="product-n">#{m.id}</span>
        <Status m={m} />
      </div>
      <div className="product-name">{m.question}</div>
      <div className="product-rule">
        Polymarket <b>{slug}</b> · pays on <b>{pays_on.toUpperCase()}</b>
      </div>
      <div className="product-stats">
        <span>Polymarket <b>{pct(m.floor_bps)}</b></span>
        <span>AMM <b>{pct(m.price_bps)}</b></span>
        <span>pool <b>{usd(m.usdc_held, 0)}</b></span>
        <span className="red">{timeLeft(m.end)}</span>
      </div>
    </Link>
  );
}

export default function Home() {
  const { data: markets, error } = useQuery({ queryKey: ["markets"], queryFn: airbag.markets });
  const total = (k: keyof Market) => (markets ?? []).reduce((a, m) => a + BigInt(m[k] as string), 0n);
  return (
    <main>
      <header className="hero" id="top">
        <div className="container hero-grid">
          <div className="hero-text">
            <span className="hero-tag">Cover AMM · Polymarket floor in a TEE · NEAR · Chain Signatures</span>
            <h1>
              Insure what
              <br />
              <span className="hl">Polymarket</span>
              <br />
              predicts<span className="dot">.</span>
            </h1>
            <p className="lede">
              Polymarket tells you the odds of a crash or a depeg. <b>Airbag lets you insure against it.</b> Underwriters on
              NEAR back every policy 1:1, the price is <b>never below Polymarket&apos;s odds</b>, and when Polymarket says it
              happened, the payout lands <span className="u">automatically</span>, on NEAR or on Base.
            </p>
            <div className="cta-row">
              <a className="btn btn-primary" href="#markets">See live markets ↓</a>
              <Link className="btn btn-ghost" href="/proof">How we prove it →</Link>
            </div>
            <div className="hero-foot">
              <span>fully backed</span>
              <span className="sep">/</span>
              <span>Polymarket-priced</span>
              <span className="sep">/</span>
              <span>TEE oracle</span>
              <span className="sep">/</span>
              <span>paid on any chain</span>
            </div>
          </div>
          <div className="hero-visual">
            <HeroBag />
          </div>
        </div>
      </header>

      <section className="section" id="markets">
        <div className="container">
          <span className="kicker">// live on NEAR testnet</span>
          <h2 className="sec-title">Markets</h2>
          {error && <div className="banner"><b>Can&apos;t reach NEAR testnet.</b> {(error as Error).message}</div>}
          <div className="kpis">
            <div className="kpi"><div className="k">Underwritten</div><div className="v">{markets ? usd(total("usdc_held"), 0) : "…"}</div><div className="s">USDC held by the pools</div></div>
            <div className="kpi"><div className="k">Cover in force</div><div className="v">{markets ? usd(total("open_cover"), 0) : "…"}</div><div className="s">USDC paid if events happen</div></div>
            <div className="kpi"><div className="k">Premiums</div><div className="v green">{markets ? usd(total("premiums"), 2) : "…"}</div><div className="s">earned by underwriters</div></div>
            <div className="kpi"><div className="k">Policies</div><div className="v">{markets ? markets.reduce((a, m) => a + Number(m.policies), 0) : "…"}</div><div className="s">across {markets?.length ?? "…"} markets</div></div>
          </div>
          <div className="catalog">{markets?.map((m) => <MarketCard key={m.id} m={m} />)}</div>
          <p className="sec-intro">
            Every market mirrors a Polymarket market:{" "}
            {markets?.map((m, i) => (
              <span key={m.id}>
                {i > 0 && " · "}
                <a className="u" href={polymarketUrl(m.source.polymarket.slug)} target="_blank" rel="noreferrer">#{m.id} on Polymarket ↗</a>
              </span>
            ))}
          </p>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <span className="kicker">// lifecycle</span>
          <h2 className="sec-title">From underwriter to payout.</h2>
          <div className="steps">
            {STEPS.map((s) => (
              <div className="step" key={s.no}>
                <div className="step-no">{s.no}</div>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
                <div className="mech">{s.mech}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
