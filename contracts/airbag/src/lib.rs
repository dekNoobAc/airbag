//! Airbag: cover for crypto risks, sold from an AMM pool on NEAR (spec: docs/spec.md).
//!
//! Underwriters add USDC → sets (1 YES + 1 NO = 1 USDC) go into the market's pool. Buyers take YES out of the
//! pool as a **policy**; its price is the AMM cost, never below the oracle's Polymarket floor, plus a fee.
//! If the event happens, timely policies pay their full amount; otherwise the NO side pays the underwriters.
//! Every policy is backed 1:1 by USDC held here (`solvency`).
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, Promise, PromiseOrValue};

pub mod amm;
pub mod eip712;
pub mod evm;
pub mod polymarket;
use amm::{mul_div, BPS};

const ACC: u128 = 1_000_000_000_000_000_000; // surplus-per-share precision (1e18)
const MIN_COVER: u128 = 1_000_000; // 1 USDC
const MAX_BATCH: u64 = 10;
const GAS_FT: Gas = Gas::from_tgas(10);
const GAS_CB: Gas = Gas::from_tgas(8);
const GAS_ORACLE_CB: Gas = Gas::from_tgas(30);
const GAS_SIGN: Gas = Gas::from_tgas(100);
const GAS_SIGN_CB: Gas = Gas::from_tgas(10);
/// The Chain Signatures path of Airbag's payout wallet on every EVM chain.
pub const FLOAT_PATH: &str = "airbag-float";
const SIG_VALID_SECS: u64 = 7 * 24 * 3600;

fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "airbag", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Markets,
    Policies,
    MarketPolicies,
    Lps,
    Claimable,
    Owned,
    EvmPayouts,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Yes,
    No,
}

/// Where the oracle reads the event from: a Polymarket market (Gamma slug). Cover pays when Polymarket's
/// `pays_on` outcome ("yes" or "no") wins; that outcome's odds are the price floor. E.g. "Bitcoin above $74k on
/// Nov 12?" with `pays_on: "no"` is crash cover.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Polymarket { slug: String, pays_on: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Open,
    Proposed { outcome: Outcome, event_at: U64, proposed_at: U64, evidence: String },
    Resolved { outcome: Outcome, event_at: U64, resolved_at: U64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PayoutTo {
    Near,
    /// USDC on an EVM chain, paid from Airbag's Chain Signatures wallet there.
    Evm { chain_id: U64, address: String },
}

/// An EVM chain Airbag pays out on: its USDC (EIP-3009) and Airbag's payout wallet there, i.e. the address of the
/// MPC key at path `airbag-float` for this contract (anyone can check it with the signer's `derived_public_key`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct EvmChain {
    pub chain_id: U64,
    pub name: String,
    pub usdc: String,
    pub usdc_name: String,
    pub usdc_version: String,
    pub float_address: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EvmStatus {
    Pending,
    Signing,
    Signed,
    Relayed,
}

/// A payout owed on an EVM chain: a USDC `transferWithAuthorization` from the payout wallet, signed by NEAR MPC
/// on this contract's request. The nonce is fixed per payout, so it can only ever settle once on-chain.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct EvmPayout {
    pub id: U64,
    pub policy: U64,
    pub chain_id: U64,
    pub from: String,
    pub to: String,
    pub amount: U128,
    pub nonce: String,
    pub valid_before: U64,
    pub signature: Option<String>,
    pub status: EvmStatus,
    /// Reported by the relayer (not verified on NEAR).
    pub relay_tx: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyState {
    Active,
    Paid,
    Refunded,
    Expired,
}

#[near(serializers = [json])]
pub struct MarketArgs {
    pub question: String,
    pub source: Source,
    /// End of cover, unix seconds.
    pub end: U64,
    pub initial_price_bps: u16,
    pub fee_bps: u16,
    /// No buys once the floor reaches this (the market already thinks it's likely).
    pub halt_bps: u16,
    pub dispute_secs: U64,
    /// Cover bought less than this before the event only gets its premium back.
    pub late_grace_secs: U64,
    /// No buys this close to the end.
    pub min_cover_window_secs: U64,
    /// Floors older than this stop buys.
    pub floor_max_age_secs: U64,
    /// One buy can take at most this share of the pool's YES.
    pub max_take_bps: u16,
}

#[near(serializers = [borsh])]
pub struct Market {
    pub id: u64,
    pub question: String,
    pub source: Source,
    pub end: u64,
    pub initial_price_bps: u16,
    pub fee_bps: u16,
    pub halt_bps: u16,
    pub dispute_secs: u64,
    pub late_grace_secs: u64,
    pub min_cover_window_secs: u64,
    pub floor_max_age_secs: u64,
    pub max_take_bps: u16,
    pub halted: bool,
    // pool
    pub y: u128,
    pub n: u128,
    pub total_shares: u128,
    // books (see `solvency`)
    pub sets: u128,
    pub open_cover: u128,
    pub leftover_yes: u128,
    pub leftover_no: u128,
    pub surplus_left: u128,
    pub acc: u128,
    pub usdc_held: u128,
    // oracle
    pub floor_bps: u16,
    pub floor_at: u64,
    pub status: Status,
    // payouts
    pub policy_count: u64,
    pub payout_cursor: u64,
    pub late_excess: u128,
    pub premiums: u128,
}

#[near(serializers = [borsh])]
pub struct Policy {
    pub id: u64,
    pub market: u64,
    pub owner: AccountId,
    pub amount: u128,
    pub premium: u128,
    pub bought_at: u64,
    pub payout_to: PayoutTo,
    pub state: PolicyState,
}

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Lp {
    pub shares: u128,
    pub acc_debt: u128,
    pub surplus_owed: u128,
    pub left_yes: u128,
    pub left_no: u128,
    pub settled: bool,
}

/// What the oracle module outputs (≤ 900 bytes).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OracleReport {
    pub yes_bps: u16,
    pub observed_at: U64,
    /// "yes" | "no" once the source says the event is decided.
    pub resolved: Option<String>,
    pub event_at: Option<U64>,
    pub source_sha256: String,
}

/// The oracle: an OutLayer WASI module pinned by URL + sha256 (the contract requests runs itself), and/or an
/// account allowed to post reports directly (sandbox tests; fallback).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct OracleConfig {
    pub outlayer: Option<AccountId>,
    pub wasm_url: String,
    pub wasm_hash: String,
    pub account: Option<AccountId>,
}

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum FtMsg {
    AddLiquidity { market: U64 },
    Buy { market: U64, amount: U128, max_premium: U128, payout_to: Option<PayoutTo> },
}

/// Polymarket's contracts on a Polygon chain, and Airbag's wallet there (MPC key at `airbag-float`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PmConfig {
    pub chain_id: U64,
    pub name: String,
    /// Polymarket's Conditional Tokens (CTF).
    pub ctf: String,
    /// The collateral Polymarket's exchange uses there (its `getCollateral()`).
    pub collateral: String,
    pub wallet: String,
    /// Cap on the gas price the keeper may ask for.
    pub max_fee_wei: U128,
    /// Testnet: the collateral has an open `mint`, standing in for premiums bridged over.
    pub testnet_mint: bool,
}

/// A NEAR market mirrored as a CTF condition: Airbag's wallet holds `hedged` YES + NO shares for the cover sold.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PmHedge {
    pub market: U64,
    pub question_id: String,
    pub condition_id: String,
    pub hedged: U128,
    /// Polymarket outcome reported to the CTF: "yes" or "no".
    pub reported: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PmStatus {
    Pending,
    Signing,
    Signed,
}

/// One Polygon transaction from Airbag's wallet, built by this contract. Nonces are assigned in order when first
/// signed and never change, so re-signing (e.g. a higher fee) replaces the transaction instead of repeating it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PmTx {
    pub id: U64,
    pub market: Option<U64>,
    pub kind: String,
    pub to: String,
    pub data: String,
    pub gas: U64,
    pub nonce: Option<U64>,
    pub max_fee: U128,
    pub max_priority_fee: U128,
    pub status: PmStatus,
    pub hash: Option<String>,
    pub raw: Option<String>,
}

/// Kept in its own storage slot (`pm`), so contracts deployed before this feature keep their state.
#[near(serializers = [borsh])]
#[derive(Default)]
struct PmState {
    cfg: Option<PmConfig>,
    hedges: Vec<PmHedge>,
    txs: Vec<PmTx>,
    next_nonce: u64,
}

const PM_KEY: &[u8] = b"pm";
const GAS_PM_SIGN_CB: Gas = Gas::from_tgas(20);

fn pm_load() -> PmState {
    env::storage_read(PM_KEY).map(|b| near_sdk::borsh::from_slice(&b).expect("pm state")).unwrap_or_default()
}

fn pm_save(s: &PmState) {
    env::storage_write(PM_KEY, &near_sdk::borsh::to_vec(s).unwrap());
}

impl PmState {
    fn queue(&mut self, market: Option<u64>, kind: &str, to: &str, data: Vec<u8>, gas: u64) {
        let id = self.txs.len() as u64;
        self.txs.push(PmTx {
            id: U64(id),
            market: market.map(U64),
            kind: kind.to_string(),
            to: to.to_string(),
            data: format!("0x{}", eip712::hex(&data)),
            gas: U64(gas),
            nonce: None,
            max_fee: U128(0),
            max_priority_fee: U128(0),
            status: PmStatus::Pending,
            hash: None,
            raw: None,
        });
        emit("pm_tx_queued", json!({ "id": U64(id), "market": market.map(U64), "kind": kind }));
    }
}

#[near(contract_state)]
pub struct Airbag {
    owner: AccountId,
    usdc: AccountId,
    guardian: AccountId,
    oracle: OracleConfig,
    markets: Vector<Market>,
    policies: Vector<Policy>,
    market_policies: LookupMap<(u64, u64), u64>,
    lps: LookupMap<(u64, AccountId), Lp>,
    claimable: LookupMap<AccountId, u128>,
    owned: LookupMap<AccountId, Vec<u64>>,
    mpc: Option<AccountId>,
    evm_chains: Vec<EvmChain>,
    evm_payouts: Vector<EvmPayout>,
    /// USDC kept here for payouts already sent on EVM chains (the owner moves it to refill the float there).
    evm_float_backing: u128,
}

impl Default for Airbag {
    fn default() -> Self {
        env::panic_str("not initialized")
    }
}

#[near]
impl Airbag {
    #[init]
    /// `mpc`: `v1.signer-prod.testnet` on testnet (None: no EVM payouts).
    pub fn new(owner: AccountId, usdc: AccountId, guardian: AccountId, oracle: OracleConfig, mpc: Option<AccountId>) -> Self {
        Self {
            owner,
            usdc,
            guardian,
            oracle,
            markets: Vector::new(Key::Markets),
            policies: Vector::new(Key::Policies),
            market_policies: LookupMap::new(Key::MarketPolicies),
            lps: LookupMap::new(Key::Lps),
            claimable: LookupMap::new(Key::Claimable),
            owned: LookupMap::new(Key::Owned),
            mpc,
            evm_chains: Vec::new(),
            evm_payouts: Vector::new(Key::EvmPayouts),
            evm_float_backing: 0,
        }
    }

    // ── owner ──

    pub fn create_market(&mut self, args: MarketArgs) -> U64 {
        self.only(&self.owner.clone());
        require!(args.end.0 > now(), "ERR_END_IN_PAST");
        require!((1..10_000).contains(&args.initial_price_bps), "ERR_PRICE");
        require!(args.fee_bps <= 1_000, "ERR_FEE");
        require!(args.halt_bps > 0 && args.halt_bps <= 9_000, "ERR_HALT");
        require!(args.max_take_bps > 0 && args.max_take_bps <= 5_000, "ERR_MAX_TAKE");
        require!(!args.question.is_empty() && args.question.len() <= 200, "ERR_QUESTION");
        let Source::Polymarket { slug, pays_on } = &args.source;
        require!(!slug.is_empty() && slug.len() <= 120 && slug.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'), "ERR_SLUG");
        require!(pays_on == "yes" || pays_on == "no", "ERR_PAYS_ON");
        let id = self.markets.len() as u64;
        emit("market_created", json!({ "market": id.to_string(), "question": args.question, "end": args.end }));
        self.markets.push(Market {
            id,
            question: args.question,
            source: args.source,
            end: args.end.0,
            initial_price_bps: args.initial_price_bps,
            fee_bps: args.fee_bps,
            halt_bps: args.halt_bps,
            dispute_secs: args.dispute_secs.0,
            late_grace_secs: args.late_grace_secs.0,
            min_cover_window_secs: args.min_cover_window_secs.0,
            floor_max_age_secs: args.floor_max_age_secs.0,
            max_take_bps: args.max_take_bps,
            halted: false,
            y: 0,
            n: 0,
            total_shares: 0,
            sets: 0,
            open_cover: 0,
            leftover_yes: 0,
            leftover_no: 0,
            surplus_left: 0,
            acc: 0,
            usdc_held: 0,
            floor_bps: 0,
            floor_at: 0,
            status: Status::Open,
            policy_count: 0,
            payout_cursor: 0,
            late_excess: 0,
            premiums: 0,
        });
        U64(id)
    }

    pub fn set_oracle(&mut self, oracle: OracleConfig) {
        self.only(&self.owner.clone());
        self.oracle = oracle;
    }

    pub fn set_evm_chain(&mut self, chain: EvmChain) {
        self.only(&self.owner.clone());
        let mut chain = chain;
        chain.usdc = eip712::addr_str(&eip712::address(&chain.usdc, "usdc"));
        chain.float_address = eip712::addr_str(&eip712::address(&chain.float_address, "float_address"));
        self.evm_chains.retain(|c| c.chain_id != chain.chain_id);
        self.evm_chains.push(chain);
    }

    /// Owner: take the USDC that backs EVM payouts already sent, to refill the payout wallet there.
    pub fn withdraw_float_backing(&mut self, to: AccountId, amount: U128) -> Promise {
        self.only(&self.owner.clone());
        require!(amount.0 <= self.evm_float_backing, "ERR_AMOUNT");
        self.evm_float_backing -= amount.0;
        emit("float_backing_withdrawn", json!({ "to": to, "usdc": amount }));
        self.pay(to, amount.0)
    }

    pub fn set_guardian(&mut self, guardian: AccountId) {
        self.only(&self.owner.clone());
        self.guardian = guardian;
    }

    /// Owner or guardian: stop new buys (e.g. news of an exploit before the oracle sees it), or allow them again.
    pub fn set_halted(&mut self, market: U64, halted: bool) {
        let who = env::predecessor_account_id();
        require!(who == self.owner || who == self.guardian, "ERR_NOT_ALLOWED");
        let m = self.market_mut(market.0);
        m.halted = halted;
        emit("market_halted", json!({ "market": market, "halted": halted }));
    }

    // ── USDC in ──

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "ERR_WRONG_TOKEN");
        let parsed: FtMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("ERR_MSG"));
        let refund = match parsed {
            FtMsg::AddLiquidity { market } => {
                self.add_liquidity(market.0, &sender_id, amount.0);
                0
            }
            FtMsg::Buy { market, amount: cover, max_premium, payout_to } => {
                let to = self.check_payout_to(payout_to.unwrap_or(PayoutTo::Near));
                amount.0 - self.buy(market.0, &sender_id, cover.0, max_premium.0.min(amount.0), to)
            }
        };
        PromiseOrValue::Value(U128(refund))
    }

    // ── underwriters ──

    /// Takes `shares` out of the pool: complete sets come back as USDC now (plus earned premiums); the excess side
    /// (the cover this LP still backs) stays as a leftover claim until the market resolves.
    pub fn remove_liquidity(&mut self, market: U64, shares: U128) -> Promise {
        let who = env::predecessor_account_id();
        let mid = market.0;
        let m = self.market_ref(mid);
        require!(!matches!(m.status, Status::Resolved { .. }), "ERR_RESOLVED_USE_CLAIM_LP");
        let (acc, total) = (m.acc, m.total_shares);
        let mut lp = self.lps.remove(&(mid, who.clone())).unwrap_or_else(|| env::panic_str("ERR_NO_LP"));
        require!(shares.0 > 0 && shares.0 <= lp.shares, "ERR_SHARES");
        settle(&mut lp, acc);
        let m = self.market_mut(mid);
        let yi = mul_div(m.y, shares.0, total);
        let ni = mul_div(m.n, shares.0, total);
        let sets_out = yi.min(ni);
        m.y -= yi;
        m.n -= ni;
        m.total_shares -= shares.0;
        m.sets -= sets_out;
        m.leftover_yes += yi - sets_out;
        m.leftover_no += ni - sets_out;
        let surplus = lp.surplus_owed;
        m.surplus_left -= surplus;
        let out = sets_out + surplus;
        m.usdc_held -= out;
        lp.shares -= shares.0;
        lp.left_yes += yi - sets_out;
        lp.left_no += ni - sets_out;
        lp.surplus_owed = 0;
        lp.acc_debt = amm::mul_div_up(lp.shares, acc, ACC);
        self.lps.insert((mid, who.clone()), lp);
        emit("liquidity_removed", json!({ "market": market, "account": who, "shares": shares, "usdc": U128(out) }));
        self.pay(who, out)
    }

    /// After resolution and all policy payouts: the LP's share of the winning side, its leftover claims on the
    /// winning side, and its unpaid premiums.
    pub fn claim_lp(&mut self, market: U64) -> Promise {
        let who = env::predecessor_account_id();
        let mid = market.0;
        let m = self.market_ref(mid);
        let Status::Resolved { outcome, .. } = m.status.clone() else { env::panic_str("ERR_NOT_RESOLVED") };
        require!(m.payout_cursor == m.policy_count, "ERR_PAYOUTS_PENDING");
        let (acc, total) = (m.acc, m.total_shares);
        let pool_win = match outcome {
            Outcome::Yes => m.y + m.late_excess,
            Outcome::No => m.n,
        };
        let mut lp = self.lps.remove(&(mid, who.clone())).unwrap_or_else(|| env::panic_str("ERR_NO_LP"));
        require!(!lp.settled, "ERR_CLAIMED");
        settle(&mut lp, acc);
        // the last LP takes the rounding dust too, so the books close at exactly zero
        let last = lp.shares > 0 && lp.shares == total;
        let from_pool = if total == 0 || lp.shares == 0 {
            0
        } else if last {
            pool_win
        } else {
            mul_div(pool_win, lp.shares, total)
        };
        let left = if outcome == Outcome::Yes { lp.left_yes } else { lp.left_no };
        let m = self.market_mut(mid);
        if last {
            lp.surplus_owed = m.surplus_left;
        }
        let out = from_pool + left + lp.surplus_owed;
        m.total_shares -= lp.shares;
        match outcome {
            Outcome::Yes => {
                // take from late_excess first, then the pool's YES
                let from_late = from_pool.min(m.late_excess);
                m.late_excess -= from_late;
                m.y -= from_pool - from_late;
                m.leftover_yes -= left;
            }
            Outcome::No => {
                m.n -= from_pool;
                m.leftover_no -= left;
            }
        }
        m.surplus_left -= lp.surplus_owed;
        m.usdc_held -= out;
        lp.shares = 0;
        lp.surplus_owed = 0;
        lp.settled = true;
        self.lps.insert((mid, who.clone()), lp);
        emit("lp_claimed", json!({ "market": market, "account": who, "usdc": U128(out) }));
        self.pay(who, out)
    }

    // ── policies ──

    pub fn transfer_policy(&mut self, policy: U64, to: AccountId) {
        let who = env::predecessor_account_id();
        let p = self.policies.get_mut(policy.0 as u32).unwrap_or_else(|| env::panic_str("ERR_NO_POLICY"));
        require!(p.owner == who, "ERR_NOT_OWNER");
        require!(p.state == PolicyState::Active, "ERR_NOT_ACTIVE");
        p.owner = to.clone();
        let mut mine = self.owned.get(&who).cloned().unwrap_or_default();
        mine.retain(|x| *x != policy.0);
        self.owned.insert(who.clone(), mine);
        let mut theirs = self.owned.get(&to).cloned().unwrap_or_default();
        theirs.push(policy.0);
        self.owned.insert(to.clone(), theirs);
        emit("policy_transferred", json!({ "policy": policy, "from": who, "to": to }));
    }

    /// Where this policy pays: on NEAR, or USDC on a configured EVM chain.
    pub fn set_payout_to(&mut self, policy: U64, payout_to: PayoutTo) {
        let to = self.check_payout_to(payout_to);
        let who = env::predecessor_account_id();
        let p = self.policies.get_mut(policy.0 as u32).unwrap_or_else(|| env::panic_str("ERR_NO_POLICY"));
        require!(p.owner == who, "ERR_NOT_OWNER");
        require!(p.state == PolicyState::Active, "ERR_NOT_ACTIVE");
        p.payout_to = to.clone();
        emit("payout_to_set", json!({ "policy": policy, "payout_to": to }));
    }

    /// Anyone (the relayer), with 300 Tgas: asks NEAR MPC to sign this EVM payout. Again after the signature
    /// expired unrelayed: the same nonce, so at most one of them can ever settle.
    pub fn sign_evm_payout(&mut self, payout: U64) -> Promise {
        let mpc = self.mpc.clone().unwrap_or_else(|| env::panic_str("ERR_NO_MPC"));
        let t = now();
        let p = self.evm_payouts.get_mut(payout.0 as u32).unwrap_or_else(|| env::panic_str("ERR_NO_PAYOUT"));
        let expired = p.status == EvmStatus::Signed && p.valid_before.0 <= t;
        require!(p.status == EvmStatus::Pending || expired, "ERR_NOT_SIGNABLE");
        let chain = self.evm_chains.iter().find(|c| c.chain_id == p.chain_id).cloned().unwrap_or_else(|| env::panic_str("ERR_CHAIN"));
        p.status = EvmStatus::Signing;
        p.valid_before = U64(t + SIG_VALID_SECS);
        let token = eip712::Token {
            chain_id: chain.chain_id.0,
            address: eip712::address(&chain.usdc, "usdc"),
            name: &chain.usdc_name,
            version: &chain.usdc_version,
        };
        let transfer = eip712::Transfer {
            from: eip712::address(&p.from, "from"),
            to: eip712::address(&p.to, "to"),
            value: p.amount.0,
            valid_after: 0,
            valid_before: p.valid_before.0,
            nonce: eip712::bytes32(&p.nonce, "nonce"),
        };
        let digest = eip712::hex(&eip712::digest(&token, &transfer));
        let args = json!({ "request": { "payload_v2": { "Ecdsa": digest }, "path": FLOAT_PATH, "domain_id": 0 } });
        Promise::new(mpc)
            .function_call_weight("sign", args.to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_SIGN, GasWeight(1))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SIGN_CB).on_evm_signed(payout))
    }

    #[private]
    pub fn on_evm_signed(&mut self, payout: U64) -> Option<String> {
        let sig = result_bytes(0).and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| evm::to_eth_signature(&v));
        let p = self.evm_payouts.get_mut(payout.0 as u32).unwrap();
        match &sig {
            Some(s) => {
                p.status = EvmStatus::Signed;
                p.signature = Some(s.clone());
                emit("evm_payout_signed", json!({ "payout": payout, "policy": p.policy, "chain_id": p.chain_id, "to": p.to, "usdc": p.amount }));
            }
            None => {
                p.status = EvmStatus::Pending;
                env::log_str("MPC did not sign: payout stays pending");
            }
        }
        sig
    }

    /// Owner (the relayer): the EVM transaction that settled this payout, for the record.
    pub fn report_relayed(&mut self, payout: U64, tx_hash: String) {
        self.only(&self.owner.clone());
        require!(tx_hash.len() == 66 && tx_hash.starts_with("0x"), "ERR_TX_HASH");
        let p = self.evm_payouts.get_mut(payout.0 as u32).unwrap_or_else(|| env::panic_str("ERR_NO_PAYOUT"));
        require!(p.status == EvmStatus::Signed, "ERR_NOT_SIGNED");
        p.status = EvmStatus::Relayed;
        p.relay_tx = Some(tx_hash.clone());
        emit("evm_payout_relayed", json!({ "payout": payout, "tx": tx_hash }));
    }

    /// Any balance a transfer couldn't deliver (e.g. the account had no USDC storage then).
    pub fn claim(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.claimable.remove(&who).unwrap_or(0);
        require!(amount > 0, "ERR_NOTHING");
        self.pay(who, amount)
    }

    // ── oracle ──

    /// Anyone, with ~0.01 NEAR: asks OutLayer to run the pinned oracle module for this market. The answer
    /// arrives in `on_oracle`; only answers from that run are accepted.
    #[payable]
    pub fn refresh(&mut self, market: U64) -> Promise {
        let outlayer = self.oracle.outlayer.clone().unwrap_or_else(|| env::panic_str("ERR_NO_OUTLAYER"));
        let m = self.market_ref(market.0);
        require!(!matches!(m.status, Status::Resolved { .. }), "ERR_RESOLVED");
        let input = json!({ "market": market, "source": m.source, "end": U64(m.end), "now": U64(now()) }).to_string();
        let args = json!({
            "source": { "WasmUrl": { "url": self.oracle.wasm_url, "hash": self.oracle.wasm_hash, "build_target": "wasm32-wasip2" } },
            // explicit limits: an empty object would mean zero instructions. Two HTTPS GETs + JSON need far less.
            "resource_limits": { "max_instructions": 2_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60 },
            "input_data": input,
            "response_format": "Json",
            "payer_account_id": env::predecessor_account_id(),
        });
        Promise::new(outlayer)
            .function_call("request_execution", args.to_string().into_bytes(), env::attached_deposit(), Gas::from_tgas(150))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ORACLE_CB).on_oracle(market))
    }

    #[private]
    pub fn on_oracle(&mut self, market: U64) -> bool {
        let Some(bytes) = result_bytes(0) else {
            env::log_str("oracle run failed: nothing changed");
            return false;
        };
        match parse_report(&bytes) {
            Some(r) => self.apply_report(market.0, r),
            None => {
                env::log_str("oracle output unreadable: nothing changed");
                false
            }
        }
    }

    /// The fallback path: a configured oracle account posts the report itself.
    pub fn post_report(&mut self, market: U64, report: OracleReport) -> bool {
        let who = env::predecessor_account_id();
        require!(self.oracle.account.as_ref() == Some(&who), "ERR_NOT_ORACLE");
        self.apply_report(market.0, report)
    }

    pub fn veto(&mut self, market: U64, reason: String) {
        self.only(&self.guardian.clone());
        let m = self.market_mut(market.0);
        require!(matches!(m.status, Status::Proposed { .. }), "ERR_NOT_PROPOSED");
        m.status = Status::Open;
        m.halted = true;
        emit("resolution_vetoed", json!({ "market": market, "reason": reason }));
    }

    pub fn finalize(&mut self, market: U64) {
        let m = self.market_mut(market.0);
        let Status::Proposed { outcome, event_at, proposed_at, .. } = m.status.clone() else {
            env::panic_str("ERR_NOT_PROPOSED")
        };
        require!(now() >= proposed_at.0 + m.dispute_secs, "ERR_DISPUTE_WINDOW");
        m.status = Status::Resolved { outcome: outcome.clone(), event_at, resolved_at: U64(now()) };
        let Source::Polymarket { pays_on, .. } = m.source.clone();
        emit("market_resolved", json!({ "market": market, "outcome": outcome, "event_at": event_at }));
        pm_on_final(market.0, (outcome == Outcome::Yes) == (pays_on == "yes"));
    }

    /// Anyone (our keeper): pushes up to `limit` policy payouts. Policies are paid, not claimed.
    pub fn payout_batch(&mut self, market: U64, limit: u64) {
        let mid = market.0;
        let m = self.market_ref(mid);
        let Status::Resolved { outcome, event_at, .. } = m.status.clone() else { env::panic_str("ERR_NOT_RESOLVED") };
        let (start, end) = (m.payout_cursor, (m.payout_cursor + limit.min(MAX_BATCH)).min(m.policy_count));
        for i in start..end {
            let pid = *self.market_policies.get(&(mid, i)).expect("policy index");
            let p = self.policies.get_mut(pid as u32).expect("policy");
            if p.state != PolicyState::Active {
                continue;
            }
            let (to, amount, dest) = (p.owner.clone(), p.amount, p.payout_to.clone());
            let (state, out, late) = match outcome {
                Outcome::No => (PolicyState::Expired, 0, 0),
                Outcome::Yes if p.bought_at + self.markets[mid as u32].late_grace_secs <= event_at.0 => (PolicyState::Paid, amount, 0),
                Outcome::Yes => (PolicyState::Refunded, p.premium, amount - p.premium),
            };
            p.state = state.clone();
            let m = self.markets.get_mut(mid as u32).unwrap();
            m.open_cover -= amount;
            m.late_excess += late;
            m.usdc_held -= out;
            emit(
                match state {
                    PolicyState::Paid => "policy_paid",
                    PolicyState::Refunded => "policy_refunded",
                    _ => "policy_expired",
                },
                json!({ "policy": U64(pid), "market": market, "owner": to, "usdc": U128(out) }),
            );
            if out == 0 {
                continue;
            }
            match dest {
                // each transfer runs on its own (NEAR can't return joined promises); a failed one is kept as claimable
                PayoutTo::Near => self.pay(to, out).detach(),
                PayoutTo::Evm { chain_id, address } => self.queue_evm_payout(pid, chain_id, address, out),
            }
        }
        self.markets.get_mut(mid as u32).unwrap().payout_cursor = end;
    }

    #[private]
    pub fn on_paid(&mut self, account: AccountId, amount: U128) {
        if result_bytes(0).is_none() {
            let have = self.claimable.get(&account).copied().unwrap_or(0);
            self.claimable.insert(account.clone(), have + amount.0);
            emit("payout_held", json!({ "account": account, "usdc": amount }));
        }
    }

    // ── Polymarket (Polygon) ──

    /// Owner: Polymarket's contracts and Airbag's wallet on a Polygon chain. Queues the collateral approval, and
    /// on testnet a mint of `mint` collateral to the wallet.
    pub fn pm_setup(&mut self, cfg: PmConfig, mint: Option<U128>) {
        self.only(&self.owner.clone());
        require!(self.mpc.is_some(), "ERR_NO_MPC");
        let ctf = eip712::address(&cfg.ctf, "ctf");
        let col = eip712::address(&cfg.collateral, "collateral");
        let wallet = eip712::address(&cfg.wallet, "wallet");
        let cfg = PmConfig { ctf: eip712::addr_str(&ctf), collateral: eip712::addr_str(&col), wallet: eip712::addr_str(&wallet), ..cfg };
        let mut s = pm_load();
        require!(s.cfg.is_none(), "ERR_ALREADY_SET");
        s.queue(None, "approve", &cfg.collateral, polymarket::approve_max(&ctf), 80_000);
        if let Some(m) = mint.filter(|m| m.0 > 0) {
            require!(cfg.testnet_mint, "ERR_MINT_TESTNET_ONLY");
            s.queue(None, "mint", &cfg.collateral, polymarket::mint(&wallet, m.0), 100_000);
        }
        emit("pm_setup", json!({ "chain_id": cfg.chain_id, "ctf": cfg.ctf, "wallet": cfg.wallet }));
        s.cfg = Some(cfg);
        pm_save(&s);
    }

    /// Owner: mirrors a market as a CTF condition whose oracle is Airbag's wallet, and backs the cover already
    /// sold with shares. From then on every policy bought is split into shares too.
    pub fn pm_link(&mut self, market: U64) {
        self.only(&self.owner.clone());
        let open_cover = self.market_ref(market.0).open_cover;
        let mut s = pm_load();
        let cfg = s.cfg.clone().unwrap_or_else(|| env::panic_str("ERR_NO_PM"));
        require!(!s.hedges.iter().any(|h| h.market == market), "ERR_LINKED");
        let (col, wallet) = (eip712::address(&cfg.collateral, "c"), eip712::address(&cfg.wallet, "w"));
        let qid = env::keccak256_array(format!("airbag:{}:market:{}", env::current_account_id(), market.0).as_bytes());
        let cond = polymarket::condition_id(&wallet, &qid);
        s.queue(Some(market.0), "prepare_condition", &cfg.ctf, polymarket::prepare_condition(&wallet, &qid), 150_000);
        if open_cover > 0 {
            s.queue(Some(market.0), "split", &cfg.ctf, polymarket::split_position(&col, &cond, open_cover), 300_000);
        }
        s.hedges.push(PmHedge {
            market,
            question_id: format!("0x{}", eip712::hex(&qid)),
            condition_id: format!("0x{}", eip712::hex(&cond)),
            hedged: U128(open_cover),
            reported: None,
        });
        emit("pm_linked", json!({ "market": market, "condition_id": format!("0x{}", eip712::hex(&cond)), "hedged": U128(open_cover) }));
        pm_save(&s);
    }

    /// Owner: re-sync the wallet's next nonce (only if a queued transaction was never broadcast).
    pub fn pm_set_nonce(&mut self, next: U64) {
        self.only(&self.owner.clone());
        let mut s = pm_load();
        s.next_nonce = next.0;
        pm_save(&s);
    }

    /// Owner: a transaction left "signing" because its callback failed (e.g. the account ran out of storage)
    /// goes back to pending. It keeps its nonce, so signing it again can only replace it, never repeat it.
    pub fn pm_unstick(&mut self, id: U64) {
        self.only(&self.owner.clone());
        let mut s = pm_load();
        let t = s.txs.get_mut(id.0 as usize).unwrap_or_else(|| env::panic_str("ERR_NO_TX"));
        require!(t.status == PmStatus::Signing, "ERR_NOT_SIGNING");
        t.status = PmStatus::Pending;
        pm_save(&s);
    }

    /// Anyone (the keeper), with 300 Tgas: asks NEAR MPC to sign queued Polygon transaction `id`, at most at
    /// the configured gas price. Again later with other fees: same nonce, so it replaces, never repeats.
    pub fn pm_sign(&mut self, id: U64, max_fee: U128, max_priority_fee: U128) -> Promise {
        let mpc = self.mpc.clone().unwrap_or_else(|| env::panic_str("ERR_NO_MPC"));
        let mut s = pm_load();
        let cfg = s.cfg.clone().unwrap_or_else(|| env::panic_str("ERR_NO_PM"));
        require!(max_fee.0 <= cfg.max_fee_wei.0 && max_priority_fee.0 <= max_fee.0, "ERR_FEE");
        let i = id.0 as usize;
        require!(i < s.txs.len(), "ERR_NO_TX");
        require!(s.txs[i].status != PmStatus::Signing, "ERR_SIGNING");
        if s.txs[i].nonce.is_none() {
            require!(i == 0 || s.txs[i - 1].nonce.is_some(), "ERR_SIGN_IN_ORDER");
            s.txs[i].nonce = Some(U64(s.next_nonce));
            s.next_nonce += 1;
        }
        let t = &mut s.txs[i];
        t.max_fee = max_fee;
        t.max_priority_fee = max_priority_fee;
        t.status = PmStatus::Signing;
        let (to, data) = (eip712::address(&t.to, "to"), eip712::unhex(&t.data, "data"));
        let tx = polymarket::Tx {
            chain_id: cfg.chain_id.0,
            nonce: t.nonce.unwrap().0,
            max_priority_fee: max_priority_fee.0,
            max_fee: max_fee.0,
            gas: t.gas.0,
            to: &to,
            data: &data,
        };
        let digest = eip712::hex(&polymarket::signing_hash(&tx));
        pm_save(&s);
        let args = json!({ "request": { "payload_v2": { "Ecdsa": digest }, "path": FLOAT_PATH, "domain_id": 0 } });
        Promise::new(mpc)
            .function_call_weight("sign", args.to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_SIGN, GasWeight(1))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_PM_SIGN_CB).on_pm_signed(id))
    }

    #[private]
    pub fn on_pm_signed(&mut self, id: U64) -> Option<String> {
        let sig = result_bytes(0).and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| evm::to_eth_signature(&v));
        let mut s = pm_load();
        let cfg = s.cfg.clone().unwrap();
        let t = &mut s.txs[id.0 as usize];
        let Some(sig) = sig else {
            t.status = PmStatus::Pending;
            env::log_str("MPC did not sign: transaction stays pending");
            pm_save(&s);
            return None;
        };
        let (to, data) = (eip712::address(&t.to, "to"), eip712::unhex(&t.data, "data"));
        let tx = polymarket::Tx {
            chain_id: cfg.chain_id.0,
            nonce: t.nonce.unwrap().0,
            max_priority_fee: t.max_priority_fee.0,
            max_fee: t.max_fee.0,
            gas: t.gas.0,
            to: &to,
            data: &data,
        };
        let raw = polymarket::signed(&tx, &eip712::unhex(&sig, "sig"));
        let hash = format!("0x{}", eip712::hex(&env::keccak256_array(&raw)));
        t.raw = Some(format!("0x{}", eip712::hex(&raw)));
        t.hash = Some(hash.clone());
        t.status = PmStatus::Signed;
        emit("pm_tx_signed", json!({ "id": id, "kind": t.kind, "nonce": t.nonce, "hash": hash }));
        pm_save(&s);
        Some(hash)
    }

    pub fn pm_config(&self) -> Option<PmConfig> {
        pm_load().cfg
    }

    pub fn pm_hedges(&self) -> Vec<PmHedge> {
        pm_load().hedges
    }

    pub fn pm_txs(&self, from: Option<U64>, limit: Option<u64>) -> Vec<PmTx> {
        let s = pm_load();
        let from = from.map_or(0, |x| x.0) as usize;
        s.txs.into_iter().skip(from).take(limit.unwrap_or(50) as usize).collect()
    }

    // ── views ──

    pub fn get_config(&self) -> Value {
        json!({ "owner": self.owner, "usdc": self.usdc, "guardian": self.guardian, "oracle": self.oracle })
    }

    pub fn get_market(&self, market: U64) -> Value {
        market_json(self.market_ref(market.0))
    }

    pub fn list_markets(&self, from: Option<U64>, limit: Option<u64>) -> Vec<Value> {
        let from = from.map_or(0, |x| x.0);
        (from..(from + limit.unwrap_or(50)).min(self.markets.len() as u64))
            .map(|i| market_json(&self.markets[i as u32]))
            .collect()
    }

    /// What `amount` of cover costs right now (and why).
    pub fn quote(&self, market: U64, amount: U128) -> Value {
        let m = self.market_ref(market.0);
        let blocked = self.buy_blocked(m, amount.0);
        let q = amm::premium(m.y, m.n, amount.0, m.floor_bps as u128, m.fee_bps as u128);
        let (c, p) = q.unwrap_or((0, 0));
        let after = if q.is_some() { amm::price_bps(m.y + c - amount.0, m.n + c) } else { 0 };
        json!({
            "amount": amount, "amm_cost": U128(c), "floor_cost": U128(amm::mul_div_up(amount.0, m.floor_bps as u128, BPS)),
            "premium": U128(p), "price_before_bps": amm::price_bps(m.y, m.n), "price_after_bps": after,
            "floor_bps": m.floor_bps, "blocked": blocked,
        })
    }

    pub fn get_policy(&self, policy: U64) -> Value {
        policy_json(self.policies.get(policy.0 as u32).unwrap_or_else(|| env::panic_str("ERR_NO_POLICY")))
    }

    pub fn policies_of(&self, account: AccountId) -> Vec<Value> {
        self.owned
            .get(&account)
            .map(|ids| ids.iter().map(|i| policy_json(&self.policies[*i as u32])).collect())
            .unwrap_or_default()
    }

    pub fn lp_of(&self, market: U64, account: AccountId) -> Value {
        let m = self.market_ref(market.0);
        match self.lps.get(&(market.0, account)) {
            None => Value::Null,
            Some(lp) => {
                let pending = mul_div(lp.shares, m.acc, ACC) - lp.acc_debt.min(mul_div(lp.shares, m.acc, ACC));
                json!({
                    "shares": U128(lp.shares), "share_bps": if m.total_shares == 0 { 0 } else { mul_div(lp.shares, BPS, m.total_shares) },
                    "premiums_earned": U128(lp.surplus_owed + pending), "left_yes": U128(lp.left_yes), "left_no": U128(lp.left_no),
                    "claimed": lp.settled,
                })
            }
        }
    }

    pub fn get_evm_chains(&self) -> Vec<EvmChain> {
        self.evm_chains.clone()
    }

    pub fn get_evm_payout(&self, payout: U64) -> Option<EvmPayout> {
        self.evm_payouts.get(payout.0 as u32).cloned()
    }

    pub fn list_evm_payouts(&self, from: Option<U64>, limit: Option<u64>) -> Vec<EvmPayout> {
        let from = from.map_or(0, |x| x.0);
        (from..(from + limit.unwrap_or(50)).min(self.evm_payouts.len() as u64)).map(|i| self.evm_payouts[i as u32].clone()).collect()
    }

    pub fn evm_float_backing(&self) -> U128 {
        U128(self.evm_float_backing)
    }

    pub fn claimable_of(&self, account: AccountId) -> U128 {
        U128(self.claimable.get(&account).copied().unwrap_or(0))
    }

    /// Anyone can check: every open policy is backed by USDC held here.
    pub fn solvency(&self, market: U64) -> Value {
        let m = self.market_ref(market.0);
        json!({
            "usdc_held": U128(m.usdc_held), "sets": U128(m.sets), "open_cover": U128(m.open_cover),
            "premiums_unpaid_to_lps": U128(m.surplus_left), "pool_yes": U128(m.y), "pool_no": U128(m.n),
            "fully_backed": m.usdc_held >= m.open_cover,
        })
    }
}

impl Airbag {
    fn only(&self, who: &AccountId) {
        require!(&env::predecessor_account_id() == who, "ERR_NOT_ALLOWED");
    }

    fn market_ref(&self, id: u64) -> &Market {
        self.markets.get(id as u32).unwrap_or_else(|| env::panic_str("ERR_NO_MARKET"))
    }

    fn market_mut(&mut self, id: u64) -> &mut Market {
        self.markets.get_mut(id as u32).unwrap_or_else(|| env::panic_str("ERR_NO_MARKET"))
    }

    fn pay(&mut self, to: AccountId, amount: u128) -> Promise {
        Promise::new(self.usdc.clone())
            .function_call(
                "ft_transfer",
                json!({ "receiver_id": to, "amount": U128(amount) }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB).on_paid(to, U128(amount)))
    }

    fn add_liquidity(&mut self, mid: u64, who: &AccountId, d: u128) {
        let m = self.market_ref(mid);
        require!(matches!(m.status, Status::Open) && now() < m.end, "ERR_MARKET_CLOSED");
        require!(d >= MIN_COVER, "ERR_TOO_SMALL");
        let acc = m.acc;
        let mut lp = self.lps.remove(&(mid, who.clone())).unwrap_or_default();
        require!(!lp.settled, "ERR_CLAIMED");
        settle(&mut lp, acc);
        let m = self.market_mut(mid);
        let (ay, an, ly, ln, shares) = if m.total_shares == 0 {
            let (y, n, ly, ln) = amm::initial_split(d, m.initial_price_bps as u128);
            (y, n, ly, ln, d)
        } else {
            amm::add_split(d, m.y, m.n, m.total_shares)
        };
        require!(shares > 0, "ERR_TOO_SMALL");
        m.y += ay;
        m.n += an;
        m.total_shares += shares;
        m.sets += d;
        m.usdc_held += d;
        m.leftover_yes += ly;
        m.leftover_no += ln;
        lp.shares += shares;
        lp.left_yes += ly;
        lp.left_no += ln;
        lp.acc_debt = amm::mul_div_up(lp.shares, acc, ACC);
        self.lps.insert((mid, who.clone()), lp);
        emit("liquidity_added", json!({ "market": U64(mid), "account": who, "usdc": U128(d), "shares": U128(shares) }));
    }

    fn buy_blocked(&self, m: &Market, amount: u128) -> Option<&'static str> {
        let t = now();
        if !matches!(m.status, Status::Open) {
            return Some("resolution in progress");
        }
        if m.halted {
            return Some("halted");
        }
        if t + m.min_cover_window_secs >= m.end {
            return Some("too close to the end");
        }
        if m.floor_at == 0 || t > m.floor_at + m.floor_max_age_secs {
            return Some("oracle price is stale");
        }
        if m.floor_bps >= m.halt_bps {
            return Some("market thinks the event is likely: cover halted");
        }
        if amount < MIN_COVER {
            return Some("minimum cover is 1 USDC");
        }
        if amount > mul_div(m.y, m.max_take_bps as u128, BPS) {
            return Some("larger than this pool can cover in one buy");
        }
        None
    }

    fn check_payout_to(&self, to: PayoutTo) -> PayoutTo {
        match to {
            PayoutTo::Near => PayoutTo::Near,
            PayoutTo::Evm { chain_id, address } => {
                require!(self.mpc.is_some() && self.evm_chains.iter().any(|c| c.chain_id == chain_id), "ERR_CHAIN_NOT_SUPPORTED");
                let a = eip712::address(&address, "address");
                require!(a != [0u8; 20], "ERR_ZERO_ADDRESS");
                PayoutTo::Evm { chain_id, address: eip712::addr_str(&a) }
            }
        }
    }

    fn queue_evm_payout(&mut self, policy: u64, chain_id: U64, to: String, amount: u128) {
        let chain = self.evm_chains.iter().find(|c| c.chain_id == chain_id).cloned().unwrap_or_else(|| env::panic_str("ERR_CHAIN"));
        let id = self.evm_payouts.len() as u64;
        let nonce = eip712::hex(&env::keccak256_array(format!("airbag:{}:payout:{id}", env::current_account_id()).as_bytes()));
        self.evm_payouts.push(EvmPayout {
            id: U64(id),
            policy: U64(policy),
            chain_id,
            from: chain.float_address,
            to: to.clone(),
            amount: U128(amount),
            nonce: format!("0x{nonce}"),
            valid_before: U64(0),
            signature: None,
            status: EvmStatus::Pending,
            relay_tx: None,
        });
        self.evm_float_backing += amount;
        emit("evm_payout_queued", json!({ "payout": U64(id), "policy": U64(policy), "chain_id": chain_id, "to": to, "usdc": U128(amount) }));
    }

    /// Returns the premium taken.
    fn buy(&mut self, mid: u64, who: &AccountId, x: u128, max_premium: u128, payout_to: PayoutTo) -> u128 {
        let m = self.market_ref(mid);
        if let Some(why) = self.buy_blocked(m, x) {
            env::panic_str(&format!("ERR_BUY_BLOCKED: {why}"));
        }
        let (c, premium) = amm::premium(m.y, m.n, x, m.floor_bps as u128, m.fee_bps as u128)
            .unwrap_or_else(|| env::panic_str("ERR_POOL"));
        require!(premium <= max_premium, "ERR_SLIPPAGE");
        let pid = self.policies.len() as u64;
        let m = self.market_mut(mid);
        m.y = m.y + c - x;
        m.n += c;
        m.sets += c;
        m.open_cover += x;
        let extra = premium - c;
        m.surplus_left += extra;
        m.acc += mul_div(extra, ACC, m.total_shares);
        m.usdc_held += premium;
        m.premiums += premium;
        let idx = m.policy_count;
        m.policy_count += 1;
        let price_after = amm::price_bps(m.y, m.n);
        self.market_policies.insert((mid, idx), pid);
        self.policies.push(Policy {
            id: pid,
            market: mid,
            owner: who.clone(),
            amount: x,
            premium,
            bought_at: now(),
            payout_to,
            state: PolicyState::Active,
        });
        pm_on_buy(mid, x);
        let mut mine = self.owned.get(who).cloned().unwrap_or_default();
        mine.push(pid);
        self.owned.insert(who.clone(), mine);
        emit(
            "cover_bought",
            json!({ "policy": U64(pid), "market": U64(mid), "owner": who, "amount": U128(x), "premium": U128(premium), "price_after_bps": price_after }),
        );
        premium
    }

    fn apply_report(&mut self, mid: u64, r: OracleReport) -> bool {
        let t = now();
        let m = self.market_mut(mid);
        if !matches!(m.status, Status::Open) {
            env::log_str("market not open: report ignored");
            return false;
        }
        if r.yes_bps == 0 || r.yes_bps >= 10_000 || r.observed_at.0 > t || r.observed_at.0 <= m.floor_at {
            env::log_str("report rejected: bad price or not newer");
            return false;
        }
        m.floor_bps = r.yes_bps;
        m.floor_at = r.observed_at.0;
        emit("floor_posted", json!({ "market": U64(mid), "yes_bps": r.yes_bps, "observed_at": r.observed_at, "source_sha256": r.source_sha256 }));
        let outcome = match r.resolved.as_deref() {
            Some("yes") => Outcome::Yes,
            Some("no") => Outcome::No,
            _ => return true,
        };
        let event_at = match outcome {
            Outcome::Yes => match r.event_at {
                Some(e) if e.0 <= t && e.0 <= m.end => e.0,
                _ => {
                    env::log_str("yes without a valid event time: not proposed");
                    return true;
                }
            },
            Outcome::No => {
                if t < m.end {
                    env::log_str("no before the end date: not proposed");
                    return true;
                }
                m.end
            }
        };
        m.status = Status::Proposed { outcome: outcome.clone(), event_at: U64(event_at), proposed_at: U64(t), evidence: r.source_sha256 };
        emit("resolution_proposed", json!({ "market": U64(mid), "outcome": outcome, "event_at": U64(event_at) }));
        true
    }
}

/// A policy was bought on a linked market: split the same amount into CTF shares.
fn pm_on_buy(mid: u64, x: u128) {
    let mut s = pm_load();
    let Some(cfg) = s.cfg.clone() else { return };
    let Some(h) = s.hedges.iter_mut().find(|h| h.market.0 == mid && h.reported.is_none()) else { return };
    h.hedged = U128(h.hedged.0 + x);
    let cond = eip712::bytes32(&h.condition_id, "condition");
    s.queue(Some(mid), "split", &cfg.ctf, polymarket::split_position(&eip712::address(&cfg.collateral, "c"), &cond, x), 300_000);
    pm_save(&s);
}

/// A linked market is final: report Polymarket's outcome to the CTF condition, then redeem the shares.
fn pm_on_final(mid: u64, yes_won: bool) {
    let mut s = pm_load();
    let Some(cfg) = s.cfg.clone() else { return };
    let Some(h) = s.hedges.iter_mut().find(|h| h.market.0 == mid && h.reported.is_none()) else { return };
    h.reported = Some(if yes_won { "yes" } else { "no" }.to_string());
    let (qid, cond) = (eip712::bytes32(&h.question_id, "q"), eip712::bytes32(&h.condition_id, "c"));
    s.queue(Some(mid), "report_payouts", &cfg.ctf, polymarket::report_payouts(&qid, yes_won), 150_000);
    s.queue(Some(mid), "redeem", &cfg.ctf, polymarket::redeem_positions(&eip712::address(&cfg.collateral, "c"), &cond), 250_000);
    pm_save(&s);
}

/// Raw bytes of promise result `i`, or None if it failed or doesn't exist.
fn result_bytes(i: u64) -> Option<Vec<u8>> {
    if i >= env::promise_results_count() {
        return None;
    }
    env::promise_result_checked(i, 4_096).ok()
}

fn settle(lp: &mut Lp, acc: u128) {
    // owed = floor(now) − ceil(then): each LP's share rounds down, so the sum never exceeds what came in
    lp.surplus_owed += mul_div(lp.shares, acc, ACC).saturating_sub(lp.acc_debt);
    lp.acc_debt = amm::mul_div_up(lp.shares, acc, ACC);
}

/// The oracle output may arrive as the JSON object, as a JSON string holding it, or wrapped as `{"output": …}`.
fn parse_report(bytes: &[u8]) -> Option<OracleReport> {
    fn from(v: Value) -> Option<OracleReport> {
        match v {
            Value::String(s) => from(serde_json::from_str(&s).ok()?),
            Value::Object(ref o) if o.contains_key("yes_bps") => serde_json::from_value(v).ok(),
            Value::Object(mut o) => from(o.remove("output").or_else(|| o.remove("result"))?),
            _ => None,
        }
    }
    from(serde_json::from_slice(bytes).ok()?)
}

fn market_json(m: &Market) -> Value {
    json!({
        "id": U64(m.id), "question": m.question, "source": m.source, "end": U64(m.end),
        "fee_bps": m.fee_bps, "halt_bps": m.halt_bps, "dispute_secs": U64(m.dispute_secs), "late_grace_secs": U64(m.late_grace_secs),
        "halted": m.halted, "status": m.status,
        "price_bps": amm::price_bps(m.y, m.n), "floor_bps": m.floor_bps, "floor_at": U64(m.floor_at),
        "pool_yes": U128(m.y), "pool_no": U128(m.n), "total_shares": U128(m.total_shares),
        "open_cover": U128(m.open_cover), "usdc_held": U128(m.usdc_held), "premiums": U128(m.premiums),
        "policies": U64(m.policy_count), "payouts_done": U64(m.payout_cursor),
    })
}

fn policy_json(p: &Policy) -> Value {
    json!({
        "id": U64(p.id), "market": U64(p.market), "owner": p.owner, "amount": U128(p.amount), "premium": U128(p.premium),
        "bought_at": U64(p.bought_at), "payout_to": p.payout_to, "state": p.state,
    })
}

#[cfg(test)]
mod tests;
