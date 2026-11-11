# Airbag on NEAR: spec

Status: draft 1 (2026-11-10). Source of truth for the contract. When code and spec disagree, fix the spec and say so.

## 1. One paragraph

Airbag sells **cover** for crypto risks (a stablecoin depeg, a DeFi hack) from a pool on NEAR. Underwriters add
USDC liquidity and earn the premiums. Buyers pay a premium and hold a **policy**: if the event happens before the
market's end date, the policy pays its full amount, automatically, on NEAR or on another chain (Base, Arbitrum) via
**NEAR Chain Signatures**. The price comes from an **AMM** (more cover sold → higher price) with a **floor**: never
below the odds Polymarket gives the same event, posted on-chain by an oracle that runs inside a **TEE** (OutLayer,
Intel TDX). Every dollar of cover is backed by a dollar locked in the contract.

Track: Open Innovation (main), Real-World Money.

## 2. Words

| Word | Meaning |
|---|---|
| Market | One event with an end date, e.g. "USDC below $0.97 before 2026-12-31". Own pool, own LPs, own policies |
| Set | 1 YES claim + 1 NO claim, minted for 1 USDC. YES pays $1 if the event happens, NO pays $1 if it doesn't |
| Pool | The market's AMM: holds `y` YES and `n` NO. Constant product `y·n` |
| Underwriter / LP | Adds USDC → sets go into the pool → gets LP shares |
| Policy | A buyer's cover: `amount` (pays this many USDC if YES), `premium` paid, `bought_at`, `owner`, `payout_to` |
| Floor | The oracle's latest YES probability (bps) from Polymarket. Premium per $1 of cover never goes below it |
| Oracle | Account allowed to post floors and propose resolutions. Its key lives only inside OutLayer's TEE |
| Guardian | Account that can veto a resolution during the dispute window (testnet: the deployer) |

## 3. Money flows

### Underwriter adds liquidity (`ft_transfer_call` USDC, msg `{"add_liquidity":{"market":id}}`)
- `d` USDC → mint `d` sets. Add to the pool in the pool's current ratio (like Gnosis FPMM): the side the pool has
  more of goes in fully, the rest comes back to the LP as a **leftover claim** (YES or NO), so the price doesn't move.
- First LP of a market: `d` YES + `d` NO, price 50% (then the floor lifts real premiums; see §4).
  Market creation can set an initial price instead: the creator's first deposit is split so `n/(y+n) = p0`.
- LP shares: first LP gets `d`; later `shares = d_in_pool_terms · total_shares / pool_size` (FPMM formula with the
  larger side).

### Buyer buys cover (`ft_transfer_call` USDC, msg `{"buy":{"market":id,"amount":"X","max_premium":"P","payout_to":…}}`)
1. Checks: market open, `now < end − min_cover_window`, floor fresh (`now − floor_at ≤ floor_max_age`), no
   resolution proposed, floor below `halt_bps` (e.g. 9000 = the market already thinks it's 90% likely: halt).
2. AMM cost `c` for exactly `X` YES (§4), then `premium = max(c, ceil(X · floor_bps / 10000)) · (1 + fee_bps)`.
3. `premium ≤ max_premium` and `≤` attached USDC; the rest is refunded via `ft_on_transfer`'s return value.
4. Mint `c` sets into the pool, take `X` YES out of it, record the policy. `premium − c` (fee + floor top-up) goes
   to the market's **surplus**, which belongs to LPs pro rata (accumulator `surplus_per_share`), and is never at risk.
5. Event `cover_bought`.

### Underwriter removes liquidity (`remove_liquidity(market, shares)`)
- Gets its share of the pool's `y` YES and `n` NO. Complete sets `min(y_i, n_i)` → USDC now. The excess (usually NO,
  i.e. the risk it underwrote) becomes a leftover claim, paid at resolution. Plus its surplus share in USDC.
- So capital that backs sold cover stays locked until the market resolves. No special rule needed: it falls out
  of the math.

### Resolution
1. Oracle: `propose_resolution(market, outcome: Yes{event_at} | No, evidence)` (`evidence`: source URL + sha256 of
   the fetched JSON). For `No`, only after `end`.
2. Dispute window `dispute_secs` (testnet 600 s; mainnet 48 h). Guardian may `veto` → back to open (halted) with a
   reason; the oracle re-proposes.
3. Anyone: `finalize(market)` after the window.

### Payout (automatic)
- `Yes`: every policy with `bought_at ≤ event_at − late_grace_secs` pays `amount`. A policy bought later (someone
  who saw the hack before the oracle did) gets its **premium refunded** instead, and its `amount − premium` goes
  to the LPs. LP-held YES (pool + leftover claims) pays LPs.
- `No`: policies pay nothing; NO (pool + leftover claims) pays LPs.
- Anyone (our keeper) calls `payout_batch(market, from, limit)`; payouts are pushed, not claimed.
- `payout_to`:
  - `Near(account)` → `ft_transfer` USDC (failed transfer → kept as a claimable balance, never lost).
  - `Evm{chain_id, address}` → the contract signs a USDC EIP-3009 `transferWithAuthorization` from **its own
    Chain Signatures address** (path `airbag-float`) on that chain; the keeper relays it. The same USDC on NEAR is
    moved to `evm_float_backing` so the books stay whole. On testnet the float on Base Sepolia is pre-funded by
    us (production would rebalance through NEAR Intents; labelled in the README).

## 4. AMM math (all integers, USDC 6 decimals)

Pool `(y, n)`; YES price `p = n / (y + n)`.

Buy exactly `X` YES for `c` USDC: mint `c` sets, then `(y + c − X)(n + c) = y·n`:

    c² + c·(y + n − X) − X·n = 0
    c = ( −(y + n − X) + sqrt((y + n − X)² + 4·X·n) ) / 2      (round up)

Requires `X < y + c` (always true for `X < y`, and buys are capped at `X ≤ y · max_take_bps`). Use U256 for the
square, integer sqrt, round in the pool's favour.

Premium with floor: `premium = max(c, ceil(X·floor/10000))`, then `+ fee_bps`. Shown to the buyer as
"you pay P for X cover = P/X per $1 (Polymarket: floor%)".

## 5. Solvency invariant (tested on every state change)

For each market, with `S` = sets minted and not yet redeemed:

    usdc_held(market) = S + surplus(market) + evm_float_backing(market)
    S = y_pool + Σ policy.amount (open) + Σ leftover_yes = n_pool + Σ leftover_no

So every policy is fully backed, whatever happens. Fuzz this with random add/buy/remove/resolve sequences.

## 6. The oracle (TEE)

- A WASI P2 module run by OutLayer inside Intel TDX. Input: the market's source (Polymarket slug, or a price feed
  + trigger). Output (≤ 900 bytes JSON): `{yes_bps, observed_at, resolved: null | "yes" | "no", event_at,
  source_sha256}`. Polymarket floor = max(midpoint, last trade) of the Yes token; resolution from Gamma
  `umaResolutionStatus` + `outcomePrices` (or CLOB `winner`).
- **The contract asks for it itself:** anyone calls `refresh(market)` with ~0.01 NEAR → `airbag` calls
  `outlayer.testnet` `request_execution` with the oracle's **wasm URL + sha256 pinned in config** →
  `on_oracle(market)` callback reads the output and posts the floor / proposes the resolution. No oracle key,
  no oracle account: the code hash on-chain *is* the oracle. (Details and the fallback: `docs/research.md`.)
- Parametric markets (our crashable demo depeg): the same module reads the configured price source and reports
  `resolved: "yes"` with `event_at` once the trigger held for `trigger_secs`.
- Contract-side checks: output parses, `yes_bps` in [1, 9999], `observed_at` not in the future and newer than the
  stored one, resolution only once per round. A failed run changes nothing.

## 7. Contract API (`airbag`)

Views: `get_market(id)`, `list_markets(from, limit)`, `get_pool(id)`, `quote(id, amount) → {amm_cost, floor_cost,
premium, price_before, price_after}`, `get_policy(id)`, `policies_of(account)`, `lp_of(id, account)`,
`solvency(id)`, `get_config()`, `float_address(chain_id)`.

Owner: `create_market(MarketArgs)` (question, polymarket slug or trigger, end, fee_bps, halt_bps, dispute_secs,
late_grace_secs, initial_price_bps), `set_oracle`, `set_guardian`, `pause(market)`.

Oracle: `refresh(market)` (anyone, pays the OutLayer run) → `on_oracle` callback; fallback `post_report(market,
report)` by `oracle.account`. Both apply the same checks. Guardian: `veto`. Owner or guardian: `set_halted`.
Anyone: `finalize`, `payout_batch(market, limit ≤ 10)` (each NEAR transfer is its own promise: NEAR can't return
joined promises; a failed one becomes claimable), `sign_evm_payout(payout)` (300 Tgas; again only after the
previous signature expired, same nonce). Owner: `set_evm_chain`, `report_relayed(payout, tx)`,
`withdraw_float_backing(to, amount)` (moves the NEAR USDC behind EVM payouts already queued, to refill the float).

FT entry: `ft_on_transfer` from the USDC contract only: `{"add_liquidity":{"market"}}`,
`{"buy":{"market","amount","max_premium","payout_to"?}}` (`payout_to`: `"near"` or
`{"evm":{"chain_id","address"}}`). Users: `remove_liquidity`, `claim_lp` (after resolution + all payouts),
`claim` (failed transfers), `transfer_policy(id, to)`, `set_payout_to(id, dest)`.

Tests: 23 unit tests (incl. a 40-round fuzz of add/buy/remove/resolve: books close at exactly 0) + a sandbox test
with the real NEP-141 USDC and a stand-in MPC signer (`cargo test -p integration-tests -- --test-threads 1`).

Events (NEP-297 `airbag`): `market_created`, `liquidity_added`, `liquidity_removed`, `cover_bought`, `floor_posted`,
`resolution_proposed`, `resolution_vetoed`, `market_resolved`, `policy_paid`, `policy_refunded`, `evm_payout_signed`.

## 8. Safety rules

1. Only the configured USDC contract's `ft_on_transfer` mints sets; everything else is refused.
2. State changes before cross-contract calls; every callback handles failure (refund or claimable balance).
3. No buy with a stale floor, after a proposal, past `halt_bps`, or inside `min_cover_window` of the end.
4. Invariant §5 checked in tests after every step; `solvency(id)` public.
5. Chain Signatures: the contract builds the EIP-712 digest itself (pay `to`, `value` = the policy's amount,
   fresh nonce = policy id); it can only ever sign payouts of finalized `Yes` policies.
6. One payout per policy (`paid` flag set before the transfer/sign).
7. Oracle can't move money; guardian can only delay. Owner can't touch pool funds.

## 9. Demo markets (testnet)

1. **"USDC depegs below $0.97 before Dec 31"**: parametric, mock price feed we can crash → full auto payout,
   one payout on Base Sepolia.
2. **One market linked to a live Polymarket event** (picked from the research): live floor from the TEE.
3. A small market resolved `No` early (end date in minutes) to show LPs keeping the premiums.

## 10. Build order

1. Contract: markets, AMM, LP, buy, invariant tests (near-workspaces sandbox).
2. Resolution + payout (NEAR) + late-buyer refund.
3. Chain Signatures payout (reuse Wayfare's `eip712.rs` and signature code) + relayer.
4. Oracle in OutLayer TEE (floor + resolution) + "verify the TEE" script.
5. Web app (markets, buy cover, LP, my policies, proof page) + testnet deploy + replay mode + video.
