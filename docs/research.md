# Research (checked 2026-11-10)

## OutLayer (TEE oracle)

- WASI **P2** modules (`wasm32-wasip2`) can make outbound HTTPS (`wasi-http-client = "0.2"`). P1 can't. Per-request
  timeout 30 s (manifest max 180 s); 2 timeouts abort the run; private/internal IPs blocked; no raw TCP/UDP.
  Docs: https://app.outlayer.ai/docs/wasi. Reference: https://github.com/out-layer/oracle-example.
- **Not yet tested:** whether Polymarket (Cloudflare) answers requests from OutLayer's worker IPs. Test first.
- Contract-requested run (`outlayer.testnet`):
  `request_execution(source, resource_limits, input_data, secrets_ref, response_format, payer_account_id, params)`
  - `source`: `{"WasmUrl":{"url","hash":"<sha256 hex>","build_target":"wasm32-wasip2"}}` or `{"Project":{…}}`.
  - `resource_limits` must be passed (even `{}`), else nothing runs. Defaults 1e9 instr / 128 MB / 60 s.
  - Result: yield/resume; our `.then(callback)` reads `env::promise_result(0)`. Output ≤ 900 bytes.
  - Cost ~0.004 NEAR for 1e9 instr / 128 MB / 30 s (`estimate_execution_cost`); unused deposit refunded.
  - Old docs say `code_source`; the live contract uses `source`.
- Module-signed path: TEE-generated `PROTECTED_*` ed25519 secret (oracle-example) or Signing Keys
  (`bind:"wasm"`, verify with `env::ed25519_verify`). Attestation per run: `/attestations/by-tx/{tx}`.
- Testnet live: health ok, 4 active workers.
- Build: `cargo build --target wasm32-wasip2 --release` → `outlayer upload` (test.fastfs.io) → URL + sha256.

**Choice: contract-requested run (A2).** `airbag` itself calls `request_execution` with the oracle's **wasm URL
and sha256 pinned in its config**, and only accepts floors/resolutions that arrive in that callback. So the
code that produced each number is fixed on-chain (anyone can rebuild the wasm and compare the hash), there's no
oracle key to manage and no account to fund. Anyone can trigger a refresh by paying the ~0.004 NEAR. Trust that
remains: OutLayer's workers (TDX-attested) and its `outlayer.testnet` contract resuming with the real output.
Fallback if the callback path is blocked: oracle-example's module-signed tx (A3a).

## Polymarket (public, no auth)

- Gamma: `GET https://gamma-api.polymarket.com/markets?slug=<slug>` → `outcomePrices` (["Yes","No"] order),
  `clobTokenIds` (index 0 = Yes), `closed`, `umaResolutionStatus`, `endDate`, `bestBid`, `bestAsk`,
  `lastTradePrice`. Closed markets need `&closed=true`.
- CLOB: `/midpoint?token_id=` → `{"mid"}`, `/price?token_id=&side=BUY`, `/last-trade-price`, `/book`.
  Resolved: `GET /markets/{conditionId}` → `tokens[].winner`.
- Thin books (USDC depeg: bid 0.003 / ask 0.019) → floor = **max(mid, last trade)**, capped by a spread check;
  the floor only ever raises our price, so manipulation downwards can't make cover cheap.
- Rate limits per IP: Gamma 300/10 s, CLOB 1500/10 s (throttled, not rejected).

Open markets to link (Yes price, 2026-11-10; all end 2027-01-01):

| Slug | Yes |
|---|---|
| `usdc-depeg-by-december-31-968` | 0.011 |
| `usde-depeg-by-december-31-434` | 0.022 |
| `dai-depeg-by-december-31-286` | 0.029 |
| `usd1-depeg-by-december-31-842` | 0.085 |

The USDC market resolves YES if Pyth 1-minute USDC/USD stays below **$0.98 for 24 h**: our linked market uses the
same rule so the Polymarket odds are for the same event. No open USDT-depeg or exchange-hack market exists.
