# Airbag

**Insure what Polymarket predicts.** Airbag sells cover for crypto events (a Bitcoin crash, a stablecoin depeg) from an AMM on NEAR. The price is never below Polymarket's odds, every policy is backed 1:1 in USDC, and payouts go out automatically on NEAR or on Base.

Every policy is also mirrored as **real YES/NO shares on Polymarket's own contracts on Polygon**. The NEAR contract writes those Polygon transactions itself, and NEAR's MPC network signs them, so no private key exists anywhere.

- **Live on NEAR testnet:** `app.airbag-mw9otkyz.testnet`
- **Demo video:** `demo/airbag-crash-test.mp4` (2:12)
- **Tracks:** Open Innovation (main), Real-World Money

---

## The problem

Polymarket tells you how likely a crash is. On Nov 10, 2026 it gave Bitcoin a **68%** chance of closing below $74,000 on Nov 12. But odds don't protect you. If you hold BTC, or a loan backed by it, you want something that **pays you** when it happens.

## What Airbag does

1. **Underwriters add USDC** to a market's pool on NEAR and earn every premium.
2. **Buyers take cover**, for example "pay me 100 USDC if Bitcoin closes below $74k on Nov 12". The AMM sets the price, and it is never cheaper than Polymarket's odds for the same event.
3. **The cover is mirrored on Polymarket's contracts.** The NEAR contract splits the same amount into YES + NO shares on Polymarket's Conditional Tokens contract (CTF) on Polygon.
4. **Polymarket decides the outcome.** A TEE oracle reads the result, a dispute window runs, and then every policy pays out automatically, in USDC on NEAR or on Base. There is no claim form.

---

## How it works

```
                 Polymarket (Gamma API: odds, result, close time)
                        │ read
                        ▼
   ┌──────────── OutLayer TEE (Intel TDX) ────────────┐
   │  oracle.wasm, its sha256 pinned in the contract  │   no oracle key: only answers from
   └──────────────────────┬───────────────────────────┘   that exact code are accepted
                          │ on_oracle()
                          ▼
 NEAR   ┌───────────────── Airbag contract (Rust) ─────────────────┐
        │ cover AMM · policies · underwriter pool · solvency       │
        │ premium = max(AMM cost, Polymarket odds) + fee           │
        │ builds Polygon + Base transactions itself                │
        └───────────────┬──────────────────────────┬───────────────┘
                        │ sign(payload, "airbag-float")   (Chain Signatures)
                        ▼                          ▼
 POLYGON  Polymarket CTF (Polymarket's own       BASE  USDC transferWithAuthorization
          contract): prepareCondition,                 (EIP-3009) to the buyer's address
          splitPosition, reportPayouts, redeem
```

### 1. Pricing: never below Polymarket
- Each market is a YES/NO constant-product pool (an FPMM). Underwriters' USDC becomes YES + NO sets, and a buyer takes YES out of the pool as a **policy** (non-fungible: amount, premium, time bought, payout destination).
- **Premium = max(AMM cost, Polymarket floor) + fee.** The AMM price rises as cover sells. The floor is Polymarket's own odds, read on-chain by the TEE oracle. When the floor is above the AMM, the difference is set aside for underwriters.
- A buy is refused when the oracle reading is stale, when Polymarket's odds reach 90% (the event is too likely to insure), within 2 hours of the end, or when one buy would take more than 20% of the pool.

### 2. The oracle: a code hash, not a server
- `oracle/` is a WASI program. It reads Polymarket's Gamma API and returns the odds and, once resolved, the result and the time it happened.
- It runs on **OutLayer** inside Intel TDX. The wasm is stored on NEAR (FastFS), and its **sha256 is pinned in the contract**. `refresh(market)` asks OutLayer to run exactly that hash. The contract only accepts the answer in its own callback, and stores the sha256 of the Polymarket response the TEE saw.
- Anyone can call `refresh` (about 0.001 NEAR). No oracle key exists.

### 3. The Polymarket hook: NEAR drives Polymarket's contracts on Polygon
- The contract's Polygon wallet is the **NEAR MPC key** at path `airbag-float`: `0x85e23ae7103502b421a5fb856c36def4f6bbb8cb`.
- `contracts/airbag/src/polymarket.rs` ABI-encodes Polymarket's CTF calls and builds the full **EIP-1559 transaction** (RLP) on NEAR.
  - `pm_link(market)` creates a condition mirroring the market (`prepareCondition`) and splits the cover already sold.
  - **Every policy bought** queues `splitPosition`: x USDC → x YES + x NO shares on Polymarket's CTF.
  - `finalize` queues `reportPayouts` (Polymarket's outcome) and `redeemPositions`.
- `pm_sign(id, fees)` sends that exact transaction's hash to NEAR's MPC signer. The keeper only chooses the gas price, under a cap set in the contract.
  - Nonces are assigned in order and never change, so re-signing replaces a transaction, never repeats it.
  - The keeper broadcasts the signed transaction to Polygon.
- Every encoding is tested byte-for-byte:
  - the calldata against Foundry's `cast`;
  - the signed transaction against `cast mktx`;
  - the condition id against Polymarket's live CTF on Amoy.

### 4. Payouts: automatic, on NEAR or Base
- After the dispute window (10 minutes on testnet; the guardian can only delay, never change the result), `payout_batch` pays every policy. There is nothing to claim.
- Policies set to Base are paid with a USDC `transferWithAuthorization` signed by the same MPC key. The contract builds the EIP-712 message and fixes its nonce, so a payout can only settle once. Any relayer can submit it.
- **Late buyers:** cover bought within 1 hour of the event only gets its premium back, so nobody can buy after the news.

### Safety rules the contract enforces
- **Fully backed.** Every policy is backed 1:1 by USDC held in the contract. `solvency(market)` shows the books live (`usdc_held ≥ open_cover`). A fuzz test checks the books close at exactly 0 after every random sequence.
- Underwriters can only withdraw what isn't backing cover already sold.
- The oracle is a pinned code hash. MPC only signs transactions the contract built. There are no admin keys over funds.

---

## Try it

### On the live app (NEAR testnet)
1. Open the web app (Vercel link: *add after deploy*), or run it locally (see below).
2. Connect any **NEAR testnet** wallet, then click **Get 1,000 test USDC** (testnet faucet built into the app).
3. Open a market, for example **"BTC crash cover: Bitcoin closes below $74,000 on Nov 12"**.
4. Buy cover. Choose to be paid on NEAR, or on Base Sepolia (paste an EVM address).
5. Scroll to **Built on Polymarket**. Within a minute the keeper gets NEAR MPC to sign the split, and the share count on Polygon goes up.
6. **My cover** shows your policies. **Proof** shows the oracle hash, the MPC wallets and every transaction.

Any account can be viewed read-only: `/me?account=alice.airbag-mw9otkyz.testnet`.

### Live markets

| # | Market | Polymarket market | Pays when Polymarket resolves | Ends (UTC) |
|---|---|---|---|---|
| 0 | USDC depegs (below $0.98 for 24h) before Dec 31, 2026 | `usdc-depeg-by-december-31-968` | YES | 2027-01-01 05:00 |
| 1 | Bitcoin closes below $74,000 on Nov 12 | `bitcoin-above-74k-on-november-12-2026` | NO | 2026-11-12 17:00 |
| 2 | Bitcoin closes below $70,000 on Nov 13 | `bitcoin-above-70k-on-november-13-2026` | NO | 2026-11-13 17:00 |

### Deployed

| What | Where |
|---|---|
| Airbag contract | [`app.airbag-mw9otkyz.testnet`](https://testnet.nearblocks.io/address/app.airbag-mw9otkyz.testnet) |
| Test USDC (NEP-141) | [`usdc.airbag-mw9otkyz.testnet`](https://testnet.nearblocks.io/address/usdc.airbag-mw9otkyz.testnet) |
| Oracle wasm (FastFS, on NEAR) | sha256 `b756ccda7574d02da72bf6f603c79ff7bd31e8b7fe5f668b6174c507a11c3182` · [download](https://test.fastfs.io/airbag-mw9otkyz.testnet/outlayer.testnet/b756ccda7574d02da72bf6f603c79ff7bd31e8b7fe5f668b6174c507a11c3182.wasm) |
| TEE runner | `outlayer.testnet` |
| MPC signer | `v1.signer-prod.testnet` (path `airbag-float`) |
| Airbag's Polygon + Base wallet (MPC, no key) | [`0x85e23ae7103502b421a5fb856c36def4f6bbb8cb`](https://amoy.polygonscan.com/address/0x85e23ae7103502b421a5fb856c36def4f6bbb8cb) |
| Polymarket CTF Exchange (Amoy) | [`0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40`](https://amoy.polygonscan.com/address/0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40) |
| Polymarket Conditional Tokens (Amoy, from the exchange's `getCtf()`) | [`0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB`](https://amoy.polygonscan.com/address/0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB) |
| Polymarket's collateral (Amoy, from `getCollateral()`) | [`0x9c4E1703476E875070EE25b56A58B008CFb8FA78`](https://amoy.polygonscan.com/address/0x9c4E1703476E875070EE25b56A58B008CFb8FA78) |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

---

## Proof: every step on-chain

Generated from `testnet/deployment.json`. The web app's **Proof** page shows the same list, live.

**Setup: contract, oracle, markets**

| What happened | Transaction |
|---|---|
| Oracle wasm stored on NEAR (FastFS) | [NEAR `CzYpuBPtrR…`](https://testnet.nearblocks.io/txns/CzYpuBPtrRcRsVVH1gZ6LwnR49URGBWN4m1Rgk9wboJq) |
| Airbag contract deployed | [NEAR `7PTXEQXKZK…`](https://testnet.nearblocks.io/txns/7PTXEQXKZK1zrDBrA5LAyZHb3ZPMrUqyvRxZWXbrk9Yb) |
| Airbag initialised: oracle pinned to the FastFS wasm (url + sha256) | [NEAR `9VEPm1R9rH…`](https://testnet.nearblocks.io/txns/9VEPm1R9rHMGsvgN6cdWvc43CYRStPxR6bSrukR6ryNu) |
| Market 0 created: USDC depegs (below $0.98 for 24h) before Dec 31, 2026 (Polymarket usdc-depeg-by-december-31-968, pays on yes) | [NEAR `BCnftH1M41…`](https://testnet.nearblocks.io/txns/BCnftH1M41bA5feWFZvvftj6ToaRWpCndKk4ohnasMXR) |
| Market 1 created: BTC crash cover: Bitcoin closes below $74,000 on Nov 12 (Polymarket bitcoin-above-74k-on-november-12-2026, pays on no) | [NEAR `GMMf8uqxrs…`](https://testnet.nearblocks.io/txns/GMMf8uqxrsyGqY4PX1a92vyimNddaW9K8GFwRFfmWgUE) |
| Market 2 created: BTC crash cover: Bitcoin closes below $70,000 on Nov 13 (Polymarket bitcoin-above-70k-on-november-13-2026, pays on no) | [NEAR `BqvCYUPrmZ…`](https://testnet.nearblocks.io/txns/BqvCYUPrmZEcVfDS2qTSt88C99tczsbvU11tQprnPzAh) |
| Base Sepolia registered; payout wallet 0x85e23ae7103502b421a5fb856c36def4f6bbb8cb = NEAR MPC key (app, "airbag-float") | [NEAR `DX3Ux1wNuK…`](https://testnet.nearblocks.io/txns/DX3Ux1wNuKPxbqeCEi2PRz3tqLmGj4tLk2d6wDnqmBCu) |

**The TEE oracle reads Polymarket**

| What happened | Transaction |
|---|---|
| OutLayer TEE run reads Polymarket, contract posts the floor for market 0: 200 bps | [NEAR `BbPd98PEYx…`](https://testnet.nearblocks.io/txns/BbPd98PEYxoV4zJrn7Zm7rcBpqif8puuWYYrw6mDZ4Mg) |
| OutLayer TEE run reads Polymarket, contract posts the floor for market 1: 3700 bps | [NEAR `34nCPueppR…`](https://testnet.nearblocks.io/txns/34nCPueppRffoHSZ87mznATT5LDiwg4cyaTwwaqGWosR) |
| OutLayer TEE run reads Polymarket, contract posts the floor for market 2: 701 bps | [NEAR `2XyEHy7VE6…`](https://testnet.nearblocks.io/txns/2XyEHy7VE6oe1JskHrnnk9tyvxHTa5o4mVZZ47MpLxFS) |

**Underwriters and buyers**

| What happened | Transaction |
|---|---|
| Underwriter adds 10000 USDC to market 0 | [NEAR `7JwqEXQyVZ…`](https://testnet.nearblocks.io/txns/7JwqEXQyVZwj1B6DTmWWKyCk68qMkia1ww4Pw1JBcN4u) |
| Underwriter adds 10000 USDC to market 1 | [NEAR `7wbH6QLxTz…`](https://testnet.nearblocks.io/txns/7wbH6QLxTzgknXC3dp79W2yn9s5bAYLXH94x78S5XXg) |
| Underwriter adds 10000 USDC to market 2 | [NEAR `4nirLfbtYN…`](https://testnet.nearblocks.io/txns/4nirLfbtYNL9xFGu1jHAaYrfw7QgQnbzxYMXXfLJKJSu) |
| alice buys 300 USDC of cover on market 1 for 113.45 USDC (paid on NEAR) | [NEAR `2yiyfzYHxr…`](https://testnet.nearblocks.io/txns/2yiyfzYHxry7oUP3JTZbfB5aaxPm3oC9monhXckrBaZY) |
| bob buys 100 USDC of cover on market 1 for 38.42 USDC (paid on Base Sepolia) | [NEAR `9TpH5Mvk6h…`](https://testnet.nearblocks.io/txns/9TpH5Mvk6hux3AVVxnrxUu1ssv6fQSj5dPugmAGy7RHH) |
| alice buys 500 USDC of cover on market 2 for 36.94 USDC (paid on NEAR) | [NEAR `GkuYHCURAj…`](https://testnet.nearblocks.io/txns/GkuYHCURAjxhsiNsCbHTug9i3V7qdCciTG3dpFXeUd64) |
| bob buys 400 USDC of cover on market 0 for 8.40 USDC (paid on NEAR) | [NEAR `2DaP2ajpFF…`](https://testnet.nearblocks.io/txns/2DaP2ajpFFdHUNjbTqeuNHJ8a3gBs9G4YkqkaogD581t) |
| bob switches policy 1 (100 USDC) to pay on NEAR | [NEAR `59UiRZNecA…`](https://testnet.nearblocks.io/txns/59UiRZNecA9twbCKhCpTyEuBeUpEnHwagKvsnpKrWbZs) |
| bob buys 10 USDC of cover on market 1 for 3.86 USDC, paid on Base Sepolia | [NEAR `2JsGBu9cuf…`](https://testnet.nearblocks.io/txns/2JsGBu9cufPLrs22iwpP1hGd4kkP43WiUNMcMTyAynpZ) |

**Polymarket on Polygon, driven from NEAR**

| What happened | Transaction |
|---|---|
| Airbag contract upgraded: Polymarket CTF hedging (state kept) | [NEAR `3dCEMuNVKq…`](https://testnet.nearblocks.io/txns/3dCEMuNVKqZJWAhh4wFB3EKkCU46Y6HxHtRPoC1BkaH8) |
| Polymarket on Polygon Amoy configured: CTF + collateral, Airbag's MPC wallet | [NEAR `2iFYSf2coq…`](https://testnet.nearblocks.io/txns/2iFYSf2coqqvnbqZNZpG9vhxAN3ec3bLTr1RHUuyBxpF) |
| Market 0 mirrored as a Polymarket CTF condition (cover so far: 400 USDC) | [NEAR `6kf3r57nXJ…`](https://testnet.nearblocks.io/txns/6kf3r57nXJDsAcTPUVDRy8PHVfjRtmacATwShAuCsSYy) |
| Market 1 mirrored as a Polymarket CTF condition (cover so far: 410 USDC) | [NEAR `9gkxggpsP3…`](https://testnet.nearblocks.io/txns/9gkxggpsP3z9EojbFP7ofvrfXA9bkTz7u2vdyvzUxdG8) |
| Market 2 mirrored as a Polymarket CTF condition (cover so far: 500 USDC) | [NEAR `9ehxvJCopK…`](https://testnet.nearblocks.io/txns/9ehxvJCopK6ErvB8VUP3cEYcabw78CPw1d8szu59sqKZ) |
| NEAR MPC signs Polygon tx 0: approve | [NEAR `2kfkAJj3EK…`](https://testnet.nearblocks.io/txns/2kfkAJj3EKTQva1Z4tA95hFau7yCLzgr3WfM3zYG2JqB) |
| Polygon Amoy: Airbag's MPC wallet approves Polymarket's CTF to use its USDC | [Polygon Amoy `0x3a3fc518…`](https://amoy.polygonscan.com/tx/0x3a3fc518f8aadab5ae74ffb22a21539669062a3d0bcbe90cbabd8b27a9c745d1) |
| NEAR MPC signs Polygon tx 1: mint | [NEAR `E6j9HYZx3N…`](https://testnet.nearblocks.io/txns/E6j9HYZx3N8Lr7VCxKGwTXXhqPDsFzKM2gLyhLUfr7i8) |
| NEAR MPC signs Polygon tx 2: prepare_condition (market 0) | [NEAR `5T2P6qjZYq…`](https://testnet.nearblocks.io/txns/5T2P6qjZYqxCyEjuvM6cErdwaUx6PR5yrbeMQBooP8LS) |
| NEAR MPC signs Polygon tx 3: split (market 0) | [NEAR `6wGmuXtzfs…`](https://testnet.nearblocks.io/txns/6wGmuXtzfsaiPix6VmXkP9jMhV172buyBGpVis93L7iE) |
| NEAR MPC signs Polygon tx 4: prepare_condition (market 1) | [NEAR `HKpM8sZ3ey…`](https://testnet.nearblocks.io/txns/HKpM8sZ3ey6ipnrvRYDTqBkFUzZH5eqtuK2dFVKEnSFU) |
| Polygon Amoy: Airbag's MPC wallet mints test USDC (testnet stand-in for bridged premiums) | [Polygon Amoy `0xbff419ee…`](https://amoy.polygonscan.com/tx/0xbff419ee14e2cdd4a7642bc84615fdc61e3c284e66493a50c508f42860200879) |
| Polygon Amoy: Airbag's MPC wallet creates the market's YES/NO condition on Polymarket's CTF (market 0) | [Polygon Amoy `0x71f01b2f…`](https://amoy.polygonscan.com/tx/0x71f01b2f34cdcd2a8f008dfe91ed7d132d11d044c6caae2d5db6ee53bdb657bb) |
| Polygon Amoy: Airbag's MPC wallet splits USDC into real Polymarket YES + NO shares for the cover sold (market 0) | [Polygon Amoy `0xb82feb0c…`](https://amoy.polygonscan.com/tx/0xb82feb0cfe7797c64b7a829ae27b30b1272fc9282295fbda985075abe259eee7) |
| Polygon Amoy: Airbag's MPC wallet creates the market's YES/NO condition on Polymarket's CTF (market 1) | [Polygon Amoy `0x0a952806…`](https://amoy.polygonscan.com/tx/0x0a952806b9fe9abbe20d2eefd0637c01d2f3bae4b5b386cd108b8290280b2f59) |
| NEAR MPC signs Polygon tx 5: split (market 1) | [NEAR `GQMZaYWSQh…`](https://testnet.nearblocks.io/txns/GQMZaYWSQhiLSekLQeLouHn4aMZqguhMSe3LAM1b2cQM) |
| NEAR MPC signs Polygon tx 6: prepare_condition (market 2) | [NEAR `A2yABsMWQv…`](https://testnet.nearblocks.io/txns/A2yABsMWQvTh5bMnVUw7nRGMNoiHeZzfX3dnoU3sKunV) |
| NEAR MPC signs Polygon tx 7: split (market 2) | [NEAR `7WiVnL8fHo…`](https://testnet.nearblocks.io/txns/7WiVnL8fHo6X2iskn6dB3Y8mguYQEMhocDa2btjF64Mo) |
| Polygon Amoy: Airbag's MPC wallet splits USDC into real Polymarket YES + NO shares for the cover sold (market 1) | [Polygon Amoy `0x58052ce9…`](https://amoy.polygonscan.com/tx/0x58052ce954732d66e3ff750da30f8743fd9c6497ab58d35ed55ac50871b4d959) |
| Polygon Amoy: Airbag's MPC wallet creates the market's YES/NO condition on Polymarket's CTF (market 2) | [Polygon Amoy `0xa8a7f852…`](https://amoy.polygonscan.com/tx/0xa8a7f852c6af507007bb864fcec4a7940e84306bfb2898b7f5acf0dec5996c4a) |
| Polygon Amoy: Airbag's MPC wallet splits USDC into real Polymarket YES + NO shares for the cover sold (market 2) | [Polygon Amoy `0xd137f063…`](https://amoy.polygonscan.com/tx/0xd137f0637c092b910d553bb9d9b47dbb6a138157f1890158e537395ec505005a) |
| NEAR MPC signs Polygon tx 8: split (market 1) | [NEAR `5n98dGeRxh…`](https://testnet.nearblocks.io/txns/5n98dGeRxh9utnKqgrJ98Z4FTe5UBkJSjR8EfnxmFQ5b) |
| Polygon Amoy: Airbag's MPC wallet splits USDC into real Polymarket YES + NO shares for the cover sold (market 1) | [Polygon Amoy `0x32f5b852…`](https://amoy.polygonscan.com/tx/0x32f5b852ac667f1659a0a3e82d5c49d57b66ff8a8d7d34e7de313e33281fe93f) |
| NEAR MPC signs Polygon tx 9: split (market 1) | [NEAR `61S1h21bzD…`](https://testnet.nearblocks.io/txns/61S1h21bzDrkhnt9gD4rL3963puxaL4vdoDqj6TmpCTj) |
| Polygon Amoy: Airbag's MPC wallet splits USDC into real Polymarket YES + NO shares for the cover sold (market 1) | [Polygon Amoy `0x48748373…`](https://amoy.polygonscan.com/tx/0x487483739ddd51fe0c3c1824a9eb9f82b63ada7117d632fe0ee727ee1ae6b6de) |

**Other**

| What happened | Transaction |
|---|---|
| Airbag contract upgraded: owner can reset a Polygon tx stuck in signing (state kept) | [NEAR `NoDzf4xRrd…`](https://testnet.nearblocks.io/txns/NoDzf4xRrdLjwbi9NoJ57Byo83AcPkjxRbjF9EgUbgg) |


---

## Run it yourself

**Needs:** Rust with `wasm32-unknown-unknown` and `wasm32-wasip2`, `cargo-near` 0.22, Node 20+, pnpm, and Foundry (`cast`, only for the encoding checks).

### 1. Contract and tests
```bash
cd contracts
cargo test -p airbag                       # 26 unit tests: AMM math, books fuzz, EVM payouts, Polymarket encoding
(cd airbag && cargo near build non-reproducible-wasm)
(cd mock-signer && cargo near build non-reproducible-wasm)
cargo test -p integration-tests            # sandbox: real FT transfers, buys, payouts, the whole Polymarket flow
```

### 2. Oracle
```bash
cd oracle
cargo test                                 # Polymarket parsing: odds floor, resolution, close time
cargo build --target wasm32-wasip2 --release
shasum -a 256 target/wasm32-wasip2/release/airbag-oracle.wasm   # must match the hash pinned in the contract
```

### 3. Testnet: deploy, activity, keeper
```bash
cd scripts && pnpm install
pnpm testnet:setup        # root account (faucet), test USDC, oracle wasm → FastFS, contract, 3 markets
pnpm testnet:activity     # Base chain + MPC payout wallet, underwriters, buyers
pnpm testnet:polymarket   # Polymarket on Polygon Amoy: config + link every market
pnpm testnet:keeper       # refresh odds · finalize · payouts · sign + broadcast Polygon and Base txs
pnpm testnet:status       # print the markets
```
- Keys are created by the scripts and saved in `.env.testnet`, which is git-ignored and never printed.
- The Polygon wallet needs a little Amoy POL for gas.
- The Base relayer needs a little Base Sepolia ETH.

### 4. Web app
```bash
cd web && pnpm install
pnpm sync                 # copy testnet/deployment.json into the app
pnpm build && pnpm start -p 3108
```
Env: `NEXT_PUBLIC_NEAR_NETWORK=testnet`. For the test-USDC faucet route, also set `FAUCET_ACCOUNT` and `FAUCET_KEY` (server only, testnet only). See `web/.env.example`.

### 5. Demo video
`bash demo/make-crash.sh` records the real app (a 100 USDC buy, the MPC-signed split on Polygon), then composes and renders the video with HyperFrames.

---

## Repository

| Path | What |
|---|---|
| `contracts/airbag/src/lib.rs` | The contract: markets, AMM, policies, underwriters, oracle callback, payouts, Base payouts, Polymarket queue |
| `contracts/airbag/src/amm.rs` | FPMM math (U256, rounding against the buyer), premium, splits |
| `contracts/airbag/src/polymarket.rs` | Polymarket CTF calls, RLP, EIP-1559 signing hash and signed transaction |
| `contracts/airbag/src/eip712.rs`, `evm.rs` | EIP-3009 USDC authorization, MPC signature → Ethereum signature (low-s) |
| `contracts/integration-tests` | Sandbox test with a real NEP-141 and a stand-in MPC signer |
| `oracle/` | The TEE oracle (WASI P2): Polymarket Gamma API → odds floor and result |
| `scripts/` | Testnet setup, activity, the keeper (`keeper.ts`, `pm.ts`) |
| `web/` | Next.js app: markets, buy and underwrite, My cover, Proof, testnet faucet |
| `docs/spec.md`, `docs/research.md` | Design spec, plus findings on OutLayer and Polymarket |
| `demo/` | Video scenario and composer |

## Testnet notes
- **USDC on NEAR is a test token** (`usdc.airbag-mw9otkyz.testnet`). The app's faucet hands it out.
- **Polygon side:**
  - It uses Polymarket's real contracts on Amoy, with the test USDC their exchange uses. Its open `mint` stands in for premiums bridged over from NEAR.
  - The wallet holds **both** YES and NO shares. On mainnet the unneeded side would be sold on Polymarket's order book. Matching orders there needs Polymarket's operator, so on testnet the hedge is split and hold.
  - On testnet the mirrored condition is resolved by the NEAR contract after its own dispute window. On mainnet Airbag would use Polymarket's live condition, resolved by UMA.
- **Base payouts** are signed by NEAR MPC and relayed by the keeper's relayer account, which only pays gas. It can't change a payout.
