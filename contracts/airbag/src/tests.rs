use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};

const U: u128 = 1_000_000; // 1 USDC
const T0: u64 = 1_800_000_000; // unix seconds

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(who: &str, secs: u64) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acct(who)).current_account_id(acct("airbag")).block_timestamp(secs * 1_000_000_000);
    testing_env!(b.build());
}

fn setup() -> Airbag {
    at("owner", T0);
    let oracle = OracleConfig { outlayer: None, wasm_url: String::new(), wasm_hash: String::new(), account: Some(acct("oracle")) };
    Airbag::new(acct("owner"), acct("usdc"), acct("guard"), oracle, Some(acct("signer")))
}

fn market(c: &mut Airbag, price_bps: u16, fee_bps: u16) -> U64 {
    at("owner", T0);
    c.create_market(MarketArgs {
        question: "USDC below $0.98 for 24h before Dec 31?".into(),
        source: Source::Polymarket { slug: "usdc-depeg-by-december-31-968".into(), pays_on: "yes".into() },
        end: U64(T0 + 100_000),
        initial_price_bps: price_bps,
        fee_bps,
        halt_bps: 9_000,
        dispute_secs: U64(600),
        late_grace_secs: U64(3_600),
        min_cover_window_secs: U64(1_000),
        floor_max_age_secs: U64(900),
        max_take_bps: 2_000,
    })
}

fn deposit(c: &mut Airbag, who: &str, secs: u64, amount: u128, msg: Value) -> u128 {
    at("usdc", secs);
    match c.ft_on_transfer(acct(who), U128(amount), msg.to_string()) {
        PromiseOrValue::Value(r) => r.0,
        _ => panic!("expected a value"),
    }
}

fn add(c: &mut Airbag, m: U64, who: &str, secs: u64, amount: u128) {
    deposit(c, who, secs, amount, json!({ "add_liquidity": { "market": m } }));
}

/// Returns the premium paid.
fn buy(c: &mut Airbag, m: U64, who: &str, secs: u64, cover: u128) -> u128 {
    let sent = cover; // send the full cover amount; the rest comes back
    sent - deposit(c, who, secs, sent, json!({ "buy": { "market": m, "amount": U128(cover), "max_premium": U128(sent), "payout_to": null } }))
}

fn floor(c: &mut Airbag, m: U64, secs: u64, bps: u16) -> bool {
    at("oracle", secs);
    c.post_report(m, OracleReport { yes_bps: bps, observed_at: U64(secs), resolved: None, event_at: None, source_sha256: "h".into() })
}

fn resolve(c: &mut Airbag, m: U64, secs: u64, outcome: &str, event_at: Option<u64>) {
    at("oracle", secs);
    assert!(c.post_report(
        m,
        OracleReport { yes_bps: 5_000, observed_at: U64(secs), resolved: Some(outcome.into()), event_at: event_at.map(U64), source_sha256: "evidence".into() }
    ));
    at("anyone", secs + 600);
    c.finalize(m);
}

/// The books (spec §5): sets = YES claims = NO claims; USDC held = sets + premiums owed to LPs.
fn check_books(c: &Airbag, m: U64) {
    let k = &c.markets[m.0 as u32];
    if let Status::Resolved { .. } = k.status {
        return;
    }
    assert_eq!(k.sets, k.y + k.open_cover + k.leftover_yes, "YES side");
    assert_eq!(k.sets, k.n + k.leftover_no, "NO side");
    assert_eq!(k.usdc_held, k.sets + k.surplus_left, "USDC held");
    assert!(k.usdc_held >= k.open_cover, "every policy backed");
}

fn payout_all(c: &mut Airbag, m: U64, secs: u64) {
    at("keeper", secs);
    while c.markets[m.0 as u32].payout_cursor < c.markets[m.0 as u32].policy_count {
        c.payout_batch(m, 10);
    }
}

#[test]
fn buy_cover_at_amm_price_with_fee() {
    let mut c = setup();
    let m = market(&mut c, 200, 200); // 2% YES, 2% fee
    add(&mut c, m, "lp1", T0 + 10, 10_000 * U);
    assert!(floor(&mut c, m, T0 + 20, 100)); // Polymarket says 1%: below the AMM, no effect
    let p = buy(&mut c, m, "alice", T0 + 30, 100 * U);
    // ~2% of 100 = 2 USDC, plus 2% fee
    assert!((2_000_000..2_100_000).contains(&p), "{p}");
    check_books(&c, m);
    let pol = c.get_policy(U64(0));
    assert_eq!(pol["amount"], json!(U128(100 * U)));
    assert_eq!(pol["state"], json!("active"));
    // the price rose for the next buyer
    assert!(c.markets[0].y < 10_000 * U);
}

#[test]
fn polymarket_floor_raises_cheap_cover() {
    let mut c = setup();
    let m = market(&mut c, 100, 0); // AMM 1%
    add(&mut c, m, "lp1", T0, 10_000 * U);
    floor(&mut c, m, T0 + 1, 500); // Polymarket 5%
    let p = buy(&mut c, m, "alice", T0 + 2, 100 * U);
    assert_eq!(p, 5 * U, "pays the floor, not the AMM's 1%");
    // the floor top-up belongs to the LPs
    let lp = c.lp_of(m, acct("lp1"));
    let earned: U128 = serde_json::from_value(lp["premiums_earned"].clone()).unwrap();
    assert!(earned.0 >= 3 * U, "{}", earned.0);
    check_books(&c, m);
}

#[test]
fn buys_are_blocked_when_unsafe() {
    let mut c = setup();
    let m = market(&mut c, 200, 0);
    add(&mut c, m, "lp1", T0, 1_000 * U);
    let blocked = |c: &Airbag, amount: u128| c.quote(m, U128(amount))["blocked"].clone();
    at("viewer", T0 + 1);
    assert_eq!(blocked(&c, 10 * U), json!("oracle price is stale"));
    floor(&mut c, m, T0 + 1, 200);
    at("viewer", T0 + 2);
    assert_eq!(blocked(&c, 10 * U), Value::Null);
    assert_eq!(blocked(&c, 500 * U), json!("larger than this pool can cover in one buy"));
    at("viewer", T0 + 1 + 901);
    assert_eq!(blocked(&c, 10 * U), json!("oracle price is stale"));
    floor(&mut c, m, T0 + 1000, 9_500);
    at("viewer", T0 + 1001);
    assert_eq!(blocked(&c, 10 * U), json!("market thinks the event is likely: cover halted"));
    floor(&mut c, m, T0 + 1002, 300);
    at("guard", T0 + 1003);
    c.set_halted(m, true);
    assert_eq!(blocked(&c, 10 * U), json!("halted"));
}

#[test]
#[should_panic(expected = "ERR_BUY_BLOCKED")]
fn buy_with_stale_floor_panics() {
    let mut c = setup();
    let m = market(&mut c, 200, 0);
    add(&mut c, m, "lp1", T0, 1_000 * U);
    buy(&mut c, m, "alice", T0 + 1, 10 * U);
}

#[test]
#[should_panic(expected = "ERR_WRONG_TOKEN")]
fn other_tokens_are_refused() {
    let mut c = setup();
    let m = market(&mut c, 200, 0);
    at("fake-usdc", T0);
    let _ = c.ft_on_transfer(acct("lp1"), U128(1_000 * U), json!({ "add_liquidity": { "market": m } }).to_string());
}

#[test]
#[should_panic(expected = "ERR_NOT_ORACLE")]
fn only_the_oracle_posts() {
    let mut c = setup();
    let m = market(&mut c, 200, 0);
    at("mallory", T0);
    c.post_report(m, OracleReport { yes_bps: 1, observed_at: U64(T0), resolved: Some("yes".into()), event_at: Some(U64(T0)), source_sha256: String::new() });
}

#[test]
fn yes_pays_policies_refunds_late_buyers_and_closes_books() {
    let mut c = setup();
    let m = market(&mut c, 200, 200);
    add(&mut c, m, "lp1", T0, 10_000 * U);
    floor(&mut c, m, T0 + 10, 150);
    let p1 = buy(&mut c, m, "alice", T0 + 20, 500 * U);
    floor(&mut c, m, T0 + 5_000, 150);
    // bob buys 10 minutes before the event: inside the 1 h grace → only his premium back
    let p2 = buy(&mut c, m, "bob", T0 + 5_010, 200 * U);
    let event_at = T0 + 5_610;
    resolve(&mut c, m, T0 + 6_000, "yes", Some(event_at));
    let held = c.markets[0].usdc_held;
    payout_all(&mut c, m, T0 + 7_000);
    assert_eq!(c.get_policy(U64(0))["state"], json!("paid"));
    assert_eq!(c.get_policy(U64(1))["state"], json!("refunded"));
    assert_eq!(held - c.markets[0].usdc_held, 500 * U + p2, "alice gets 500, bob his premium");
    at("lp1", T0 + 7_001);
    let _ = c.claim_lp(m);
    let k = &c.markets[0];
    assert_eq!(k.usdc_held, 0, "everything paid out");
    assert_eq!((k.y, k.late_excess, k.leftover_yes, k.surplus_left), (0, 0, 0, 0));
    // LP: deposited 10,000, lost 500 of cover, kept premiums
    let _ = p1;
}

#[test]
fn no_lets_underwriters_keep_premiums() {
    let mut c = setup();
    let m = market(&mut c, 200, 200);
    add(&mut c, m, "lp1", T0, 6_000 * U);
    add(&mut c, m, "lp2", T0 + 1, 4_000 * U);
    floor(&mut c, m, T0 + 2, 100);
    let p = buy(&mut c, m, "alice", T0 + 3, 1_000 * U);
    at("oracle", T0 + 50_000);
    // "no" before the end is not proposed
    c.post_report(m, OracleReport { yes_bps: 100, observed_at: U64(T0 + 50_000), resolved: Some("no".into()), event_at: None, source_sha256: "e".into() });
    assert!(matches!(c.markets[0].status, Status::Open));
    resolve(&mut c, m, T0 + 100_000, "no", None);
    payout_all(&mut c, m, T0 + 100_700);
    assert_eq!(c.get_policy(U64(0))["state"], json!("expired"));
    let before = c.markets[0].usdc_held;
    assert_eq!(before, 10_000 * U + p, "LPs share the deposits plus the premium");
    at("lp1", T0 + 100_701);
    let _ = c.claim_lp(m);
    let lp1_got = before - c.markets[0].usdc_held;
    at("lp2", T0 + 100_702);
    let _ = c.claim_lp(m);
    assert_eq!(c.markets[0].usdc_held, 0);
    assert!(lp1_got > 6_000 * U, "lp1 earned premiums: {lp1_got}");
}

#[test]
fn removing_liquidity_keeps_sold_cover_locked() {
    let mut c = setup();
    let m = market(&mut c, 200, 0);
    add(&mut c, m, "lp1", T0, 1_000 * U);
    floor(&mut c, m, T0 + 1, 100);
    buy(&mut c, m, "alice", T0 + 2, 150 * U);
    let held = c.markets[0].usdc_held;
    at("lp1", T0 + 3);
    let shares = c.markets[0].total_shares;
    let _ = c.remove_liquidity(m, U128(shares));
    let k = &c.markets[0];
    assert!(held - k.usdc_held < 1_000 * U, "can't take out what backs alice's cover");
    assert!(k.usdc_held >= 150 * U);
    check_books(&c, m);
    resolve(&mut c, m, T0 + 10_000, "yes", Some(T0 + 9_000));
    payout_all(&mut c, m, T0 + 11_000);
    at("lp1", T0 + 11_001);
    let _ = c.claim_lp(m);
    assert_eq!(c.markets[0].usdc_held, 0);
}

#[test]
fn guardian_veto_reopens_halted() {
    let mut c = setup();
    let m = market(&mut c, 200, 0);
    at("oracle", T0 + 10);
    c.post_report(m, OracleReport { yes_bps: 5000, observed_at: U64(T0 + 10), resolved: Some("yes".into()), event_at: Some(U64(T0 + 5)), source_sha256: "e".into() });
    assert!(matches!(c.markets[0].status, Status::Proposed { .. }));
    at("guard", T0 + 20);
    c.veto(m, "wrong market read".into());
    assert!(matches!(c.markets[0].status, Status::Open));
    assert!(c.markets[0].halted);
}

#[test]
#[should_panic(expected = "ERR_DISPUTE_WINDOW")]
fn cannot_finalize_inside_dispute_window() {
    let mut c = setup();
    let m = market(&mut c, 200, 0);
    at("oracle", T0 + 10);
    c.post_report(m, OracleReport { yes_bps: 5000, observed_at: U64(T0 + 10), resolved: Some("yes".into()), event_at: Some(U64(T0 + 5)), source_sha256: "e".into() });
    at("anyone", T0 + 100);
    c.finalize(m);
}

#[test]
fn oracle_output_shapes() {
    let r = br#"{"yes_bps":110,"observed_at":"5","resolved":null,"event_at":null,"source_sha256":"ab"}"#;
    assert_eq!(parse_report(r).unwrap().yes_bps, 110);
    let s = serde_json::to_vec(&Value::String(String::from_utf8(r.to_vec()).unwrap())).unwrap();
    assert_eq!(parse_report(&s).unwrap().yes_bps, 110);
    let w = format!(r#"{{"output":{}}}"#, String::from_utf8(r.to_vec()).unwrap());
    assert_eq!(parse_report(w.as_bytes()).unwrap().yes_bps, 110);
    assert!(parse_report(b"garbage").is_none());
}

/// Random add / buy / remove sequences, books checked after every step, then a random ending: every USDC
/// that came in goes out to someone, exactly.
#[test]
fn fuzz_books_always_balance() {
    let mut seed: u64 = 42;
    let mut rnd = |n: u64| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    for round in 0..40 {
        let mut c = setup();
        let m = market(&mut c, (50 + rnd(3000)) as u16, rnd(500) as u16);
        // unit-test storage outlives the contract object: fresh names per round
        let names: Vec<String> = (1..=3).map(|i| format!("lp{i}-r{round}")).collect();
        let lps: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
        let mut t = T0;
        add(&mut c, m, lps[0], t, (100 + rnd(10_000) as u128) * U);
        for _ in 0..30 {
            t += 1 + rnd(200);
            match rnd(4) {
                0 => add(&mut c, m, lps[rnd(3) as usize], t, (1 + rnd(5_000) as u128) * U),
                1 => {
                    let lp = lps[rnd(3) as usize];
                    if let Some(l) = c.lps.get(&(m.0, acct(lp))) {
                        if l.shares > 0 {
                            let s = 1 + rnd(1000) as u128 * l.shares / 1000;
                            at(lp, t);
                            let _ = c.remove_liquidity(m, U128(s.min(l.shares)));
                        }
                    }
                }
                _ => {
                    floor(&mut c, m, t, (1 + rnd(4_000)) as u16);
                    let cover = (1 + rnd(400) as u128) * U;
                    at("viewer", t + 1);
                    if c.quote(m, U128(cover))["blocked"].is_null() {
                        buy(&mut c, m, ["alice", "bob"][rnd(2) as usize], t + 1, cover);
                    }
                    t += 1;
                }
            }
            check_books(&c, m);
        }
        let yes = round % 2 == 0;
        if yes {
            resolve(&mut c, m, t + 10, "yes", Some(t + 5 - rnd(4_000).min(t - T0)));
        } else {
            resolve(&mut c, m, T0 + 100_000, "no", None);
        }
        payout_all(&mut c, m, T0 + 200_000);
        for &lp in &lps {
            if c.lps.get(&(m.0, acct(lp))).is_some() {
                at(lp, T0 + 200_001);
                let _ = c.claim_lp(m);
            }
        }
        assert_eq!(c.markets[0].usdc_held, 0, "round {round}: books didn't close");
    }
}


// ── payouts on EVM chains (Chain Signatures) ──

const BASE_SEPOLIA: u64 = 84532;
const FLOAT: &str = "0xac901defd711ca8ca01b3d35e6dda85ea300ef13";
const BOB_EVM: &str = "0x1111111111111111111111111111111111111111";

fn base_chain(c: &mut Airbag) {
    at("owner", T0);
    c.set_evm_chain(EvmChain {
        chain_id: U64(BASE_SEPOLIA),
        name: "Base Sepolia".into(),
        usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e".into(),
        usdc_name: "USDC".into(),
        usdc_version: "2".into(),
        float_address: FLOAT.into(),
    });
}

fn buy_to(c: &mut Airbag, m: U64, who: &str, secs: u64, cover: u128, payout_to: Value) -> u128 {
    cover - deposit(c, who, secs, cover, json!({ "buy": { "market": m, "amount": U128(cover), "max_premium": U128(cover), "payout_to": payout_to } }))
}

fn callback(results: Vec<near_sdk::PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acct("airbag")).current_account_id(acct("airbag")).block_timestamp((T0 + 20_000) * 1_000_000_000);
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), results);
}

#[test]
fn digest_matches_viem() {
    // same vector as Wayfare (viem hashTypedData)
    let t = eip712::Token { chain_id: BASE_SEPOLIA, address: eip712::address("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "t"), name: "USDC", version: "2" };
    let x = eip712::Transfer { from: eip712::address(FLOAT, "f"), to: eip712::address(BOB_EVM, "t"), value: 120 * U, valid_after: 0, valid_before: 1_700_000_900, nonce: [0xab; 32] };
    assert_eq!(eip712::hex(&eip712::digest(&t, &x)), "59f8b8893cbd2bf3e8f336a4c35c9babaadf39bb84401dbb804c975fb1a52acf");
}

#[test]
fn yes_pays_on_base_via_chain_signatures() {
    let mut c = setup();
    base_chain(&mut c);
    let m = market(&mut c, 200, 0);
    add(&mut c, m, "lp1", T0, 1_000 * U);
    floor(&mut c, m, T0 + 1, 100);
    buy_to(&mut c, m, "bob", T0 + 2, 100 * U, json!({ "evm": { "chain_id": U64(BASE_SEPOLIA), "address": BOB_EVM.to_uppercase().replace("0X", "0x") } }));
    assert_eq!(c.get_policy(U64(0))["payout_to"]["evm"]["address"], json!(BOB_EVM), "address stored lowercase");
    resolve(&mut c, m, T0 + 10_000, "yes", Some(T0 + 9_000));
    payout_all(&mut c, m, T0 + 11_000);
    let p = c.get_evm_payout(U64(0)).unwrap();
    assert_eq!((p.status.clone(), p.amount, p.to.as_str(), p.from.as_str()), (EvmStatus::Pending, U128(100 * U), BOB_EVM, FLOAT));
    assert_eq!(c.evm_float_backing(), U128(100 * U), "the USDC stays here, earmarked for the float");
    at("lp1", T0 + 11_001);
    let _ = c.claim_lp(m);
    assert_eq!(c.markets[0].usdc_held, 0);

    // the relayer asks MPC to sign; the answer is stored as an Ethereum signature
    at("relayer", T0 + 20_000);
    let _ = c.sign_evm_payout(U64(0));
    assert_eq!(c.get_evm_payout(U64(0)).unwrap().status, EvmStatus::Signing);
    let mpc = json!({ "big_r": { "affine_point": format!("02{}", "11".repeat(32)) }, "s": { "scalar": "22".repeat(32) }, "recovery_id": 0 });
    callback(vec![near_sdk::PromiseResult::Successful(mpc.to_string().into_bytes())]);
    let sig = c.on_evm_signed(U64(0)).unwrap();
    assert_eq!(sig, format!("0x{}{}1b", "11".repeat(32), "22".repeat(32)));
    let p = c.get_evm_payout(U64(0)).unwrap();
    assert_eq!(p.status, EvmStatus::Signed);
    assert_eq!(p.valid_before, U64(T0 + 20_000 + 7 * 24 * 3600));
    // can't be signed again while that signature is valid
    at("relayer", T0 + 20_001);
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.sign_evm_payout(U64(0));
    }));
    assert!(again.is_err());
}

#[test]
fn failed_signing_leaves_payout_pending() {
    let mut c = setup();
    base_chain(&mut c);
    let m = market(&mut c, 200, 0);
    add(&mut c, m, "lp1", T0, 1_000 * U);
    floor(&mut c, m, T0 + 1, 100);
    buy_to(&mut c, m, "bob", T0 + 2, 50 * U, json!({ "evm": { "chain_id": U64(BASE_SEPOLIA), "address": BOB_EVM } }));
    resolve(&mut c, m, T0 + 10_000, "yes", Some(T0 + 9_000));
    payout_all(&mut c, m, T0 + 11_000);
    at("relayer", T0 + 20_000);
    let _ = c.sign_evm_payout(U64(0));
    callback(vec![near_sdk::PromiseResult::Failed]);
    assert!(c.on_evm_signed(U64(0)).is_none());
    assert_eq!(c.get_evm_payout(U64(0)).unwrap().status, EvmStatus::Pending);
}

#[test]
#[should_panic(expected = "ERR_CHAIN_NOT_SUPPORTED")]
fn unknown_chain_is_refused() {
    let mut c = setup();
    let m = market(&mut c, 200, 0);
    add(&mut c, m, "lp1", T0, 1_000 * U);
    floor(&mut c, m, T0 + 1, 100);
    buy_to(&mut c, m, "bob", T0 + 2, 50 * U, json!({ "evm": { "chain_id": "1", "address": BOB_EVM } }));
}

#[test]
fn late_evm_buyer_gets_premium_back_on_base() {
    let mut c = setup();
    base_chain(&mut c);
    let m = market(&mut c, 200, 100);
    add(&mut c, m, "lp1", T0, 1_000 * U);
    floor(&mut c, m, T0 + 8_900, 100);
    let premium = buy_to(&mut c, m, "bob", T0 + 8_950, 50 * U, json!({ "evm": { "chain_id": U64(BASE_SEPOLIA), "address": BOB_EVM } }));
    resolve(&mut c, m, T0 + 10_000, "yes", Some(T0 + 9_000));
    payout_all(&mut c, m, T0 + 11_000);
    assert_eq!(c.get_policy(U64(0))["state"], json!("refunded"));
    assert_eq!(c.get_evm_payout(U64(0)).unwrap().amount, U128(premium));
    at("lp1", T0 + 11_001);
    let _ = c.claim_lp(m);
    assert_eq!(c.markets[0].usdc_held, 0);
}
