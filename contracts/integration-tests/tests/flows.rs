//! Airbag end to end in a NEAR sandbox: real NEP-141 USDC transfers, a stand-in MPC signer.
//! Build the wasms first: `cargo near build non-reproducible-wasm` in airbag/ and mock-signer/.
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::{json, Value};

const FT_WASM: &[u8] = include_bytes!("../res/fungible_token.wasm");
const AIRBAG_WASM: &str = "../target/near/airbag/airbag.wasm";
const SIGNER_WASM: &str = "../target/near/mock_signer/mock_signer.wasm";
const U: u128 = 1_000_000;
const BOB_EVM: &str = "0x1111111111111111111111111111111111111111";
const FLOAT: &str = "0xac901defd711ca8ca01b3d35e6dda85ea300ef13";

/// Every receipt failure in a transaction (a top-level success can hide failed inner receipts).
fn failures(r: &ExecutionFinalResult) -> Vec<String> {
    r.receipt_failures().iter().map(|f| format!("{:?}", f)).collect()
}

async fn ft_balance(usdc: &Contract, who: &AccountId) -> anyhow::Result<u128> {
    let v: String = usdc.view("ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
    Ok(v.parse()?)
}

async fn register(payer: &Account, usdc: &Contract, who: &AccountId) -> anyhow::Result<()> {
    payer
        .call(usdc.id(), "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(125))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn send_usdc(from: &Account, usdc: &Contract, to: &AccountId, amount: u128) -> anyhow::Result<()> {
    from.call(usdc.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": to, "amount": amount.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn transfer_call(from: &Account, usdc: &Contract, airbag: &AccountId, amount: u128, msg: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": airbag, "amount": amount.to_string(), "msg": msg.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?)
}

async fn now_secs(worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>) -> anyhow::Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000_000)
}

#[tokio::test]
async fn cover_lifecycle_with_real_transfers() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mk = |name: &'static str| {
        let root = root.clone();
        async move { anyhow::Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(20)).transact().await?.into_result()?) }
    };
    let (lp, alice, bob, oracle, dave) = (mk("lp").await?, mk("alice").await?, mk("bob").await?, mk("oracle").await?, mk("dave").await?);

    let usdc = mk("usdc").await?.deploy(FT_WASM).await?.into_result()?;
    usdc.call("new")
        .args_json(json!({ "owner_id": root.id(), "total_supply": (1_000_000 * U).to_string(),
            "metadata": { "spec": "ft-1.0.0", "name": "Mock USDC", "symbol": "USDC", "decimals": 6 } }))
        .transact()
        .await?
        .into_result()?;
    let signer = mk("signer").await?.deploy(&std::fs::read(SIGNER_WASM)?).await?.into_result()?;
    let airbag = mk("airbag").await?.deploy(&std::fs::read(AIRBAG_WASM)?).await?.into_result()?;
    airbag
        .call("new")
        .args_json(json!({ "owner": root.id(), "usdc": usdc.id(), "guardian": root.id(),
            "oracle": { "outlayer": null, "wasm_url": "", "wasm_hash": "", "account": oracle.id() }, "mpc": signer.id() }))
        .transact()
        .await?
        .into_result()?;
    for a in [airbag.id(), lp.id(), alice.id(), bob.id()] {
        register(&root, &usdc, a).await?;
    }
    send_usdc(&root, &usdc, lp.id(), 10_000 * U).await?;
    send_usdc(&root, &usdc, alice.id(), 1_000 * U).await?;
    send_usdc(&root, &usdc, bob.id(), 1_000 * U).await?;

    let t = now_secs(&worker).await?;
    root.call(airbag.id(), "set_evm_chain")
        .args_json(json!({ "chain": { "chain_id": "84532", "name": "Base Sepolia", "usdc": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "usdc_name": "USDC", "usdc_version": "2", "float_address": FLOAT } }))
        .transact()
        .await?
        .into_result()?;
    root.call(airbag.id(), "create_market")
        .args_json(json!({ "args": {
            "question": "USDC below $0.98 for 24h before Dec 31?",
            "source": { "polymarket": { "slug": "usdc-depeg-by-december-31-968", "pays_on": "yes" } },
            "end": (t + 86_400).to_string(), "initial_price_bps": 200, "fee_bps": 100, "halt_bps": 9000,
            "dispute_secs": "0", "late_grace_secs": "0", "min_cover_window_secs": "60", "floor_max_age_secs": "100000", "max_take_bps": 2000 } }))
        .transact()
        .await?
        .into_result()?;

    // Polymarket on Polygon Amoy: Airbag's wallet holds real CTF shares for the cover it sells
    root.call(airbag.id(), "pm_setup")
        .args_json(json!({ "cfg": { "chain_id": "80002", "name": "Polygon Amoy", "ctf": "0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB",
            "collateral": "0x9c4E1703476E875070EE25b56A58B008CFb8FA78", "wallet": FLOAT, "max_fee_wei": "500000000000", "testnet_mint": true },
            "mint": (1_000_000 * U).to_string() }))
        .transact()
        .await?
        .into_result()?;
    root.call(airbag.id(), "pm_link").args_json(json!({ "market": "0" })).transact().await?.into_result()?;
    let r = alice.call(airbag.id(), "pm_link").args_json(json!({ "market": "0" })).transact().await?;
    assert!(r.is_failure(), "only the owner links markets");

    // a token that isn't the configured USDC can't mint anything: the FT refunds the sender
    let fake = mk("fake").await?.deploy(FT_WASM).await?.into_result()?;
    fake.call("new")
        .args_json(json!({ "owner_id": lp.id(), "total_supply": "1000000000", "metadata": { "spec": "ft-1.0.0", "name": "Fake", "symbol": "FAKE", "decimals": 6 } }))
        .transact()
        .await?
        .into_result()?;
    register(&root, &fake, airbag.id()).await?;
    let r = transfer_call(&lp, &fake, airbag.id(), 1_000 * U, json!({ "add_liquidity": { "market": "0" } })).await?;
    assert!(!failures(&r).is_empty(), "fake token must be refused");
    assert_eq!(ft_balance(&fake, lp.id()).await?, 1_000 * U, "and refunded");

    // underwriter adds 10,000 USDC
    let r = transfer_call(&lp, &usdc, airbag.id(), 10_000 * U, json!({ "add_liquidity": { "market": "0" } })).await?;
    assert!(failures(&r).is_empty(), "{:?}", failures(&r));

    // no fresh floor yet: a buy fails and the whole amount comes back
    let r = transfer_call(&alice, &usdc, airbag.id(), 100 * U, json!({ "buy": { "market": "0", "amount": (100 * U).to_string(), "max_premium": (100 * U).to_string() } })).await?;
    assert!(!failures(&r).is_empty());
    assert_eq!(ft_balance(&usdc, alice.id()).await?, 1_000 * U);

    let report = |resolved: Value, event_at: Value, at: u64| json!({ "market": "0", "report": { "yes_bps": 150, "observed_at": at.to_string(), "resolved": resolved, "event_at": event_at, "source_sha256": "ab12" } });
    let t = now_secs(&worker).await?;
    oracle.call(airbag.id(), "post_report").args_json(report(Value::Null, Value::Null, t)).transact().await?.into_result()?;

    // alice: 500 cover paid on NEAR; bob: 200 on Base; alice also buys 100 and gives it to dave (no USDC storage)
    let quote: Value = airbag.view("quote").args_json(json!({ "market": "0", "amount": (500 * U).to_string() })).await?.json()?;
    let premium: u128 = quote["premium"].as_str().unwrap().parse()?;
    assert!(quote["blocked"].is_null(), "{quote}");
    let r = transfer_call(&alice, &usdc, airbag.id(), 600 * U, json!({ "buy": { "market": "0", "amount": (500 * U).to_string(), "max_premium": (premium + U).to_string() } })).await?;
    assert!(failures(&r).is_empty(), "{:?}", failures(&r));
    assert_eq!(ft_balance(&usdc, alice.id()).await?, 1_000 * U - premium, "only the premium is kept");
    let r = transfer_call(&bob, &usdc, airbag.id(), 200 * U, json!({ "buy": { "market": "0", "amount": (200 * U).to_string(), "max_premium": (200 * U).to_string(),
        "payout_to": { "evm": { "chain_id": "84532", "address": BOB_EVM } } } })).await?;
    assert!(failures(&r).is_empty(), "{:?}", failures(&r));
    let r = transfer_call(&alice, &usdc, airbag.id(), 100 * U, json!({ "buy": { "market": "0", "amount": (100 * U).to_string(), "max_premium": (100 * U).to_string() } })).await?;
    assert!(failures(&r).is_empty());
    alice.call(airbag.id(), "transfer_policy").args_json(json!({ "policy": "2", "to": dave.id() })).transact().await?.into_result()?;

    let solv: Value = airbag.view("solvency").args_json(json!({ "market": "0" })).await?.json()?;
    assert_eq!(solv["fully_backed"], json!(true));
    let held: u128 = solv["usdc_held"].as_str().unwrap().parse()?;
    assert_eq!(ft_balance(&usdc, airbag.id()).await?, held, "books match the token balance");

    // the event happens; the oracle proposes YES; no dispute window in this test
    worker.fast_forward(5).await?;
    let t = now_secs(&worker).await?;
    oracle.call(airbag.id(), "post_report").args_json(report(json!("yes"), json!(t.to_string()), t)).transact().await?.into_result()?;
    root.call(airbag.id(), "finalize").args_json(json!({ "market": "0" })).transact().await?.into_result()?;

    // the Polygon side: approve, mint, prepareCondition, 3 splits (one per policy), then reportPayouts + redeem
    let txs: Vec<Value> = airbag.view("pm_txs").args_json(json!({})).await?.json()?;
    let kinds: Vec<&str> = txs.iter().map(|t| t["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["approve", "mint", "prepare_condition", "split", "split", "split", "report_payouts", "redeem"]);
    let hedges: Value = airbag.view("pm_hedges").await?.json()?;
    assert_eq!((hedges[0]["hedged"].as_str(), hedges[0]["reported"].as_str()), (Some("800000000"), Some("yes")));
    assert!(txs[6]["data"].as_str().unwrap().ends_with(&format!("{}{}", format!("{:064x}", 1), format!("{:064x}", 0))), "pays_on yes + event happened → Polymarket YES won");
    let r = root.call(airbag.id(), "pm_sign").args_json(json!({ "id": "3", "max_fee": "60000000000", "max_priority_fee": "30000000000" })).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_failure(), "transactions are signed in order");
    let r = root.call(airbag.id(), "pm_sign").args_json(json!({ "id": "0", "max_fee": "600000000000", "max_priority_fee": "1" })).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_failure(), "gas price is capped");
    for id in 0..8 {
        let r = bob.call(airbag.id(), "pm_sign").args_json(json!({ "id": id.to_string(), "max_fee": "60000000000", "max_priority_fee": "30000000000" })).gas(Gas::from_tgas(300)).transact().await?;
        assert!(failures(&r).is_empty(), "{:?}", failures(&r));
    }
    let txs: Vec<Value> = airbag.view("pm_txs").args_json(json!({})).await?.json()?;
    for (i, t) in txs.iter().enumerate() {
        assert_eq!((t["status"].as_str(), t["nonce"].as_str()), (Some("signed"), Some(i.to_string().as_str())));
        assert!(t["raw"].as_str().unwrap().starts_with("0x02f8") || t["raw"].as_str().unwrap().starts_with("0x02f9"), "a type-2 Polygon transaction");
    }

    let r = root.call(airbag.id(), "payout_batch").args_json(json!({ "market": "0", "limit": 10 })).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(ft_balance(&usdc, alice.id()).await?, 1_000 * U - premium - (r_premium(&airbag, 2).await?) + 500 * U, "alice paid automatically");
    let dave_owed: String = airbag.view("claimable_of").args_json(json!({ "account": dave.id() })).await?.json()?;
    assert_eq!(dave_owed, (100 * U).to_string(), "a transfer that can't be delivered is kept for dave");
    register(&root, &usdc, dave.id()).await?;
    dave.call(airbag.id(), "claim").gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    assert_eq!(ft_balance(&usdc, dave.id()).await?, 100 * U);

    // bob's payout on Base: queued, then signed by the (stand-in) MPC signer
    let p: Value = airbag.view("get_evm_payout").args_json(json!({ "payout": "0" })).await?.json()?;
    assert_eq!((p["status"].as_str(), p["to"].as_str(), p["amount"].as_str()), (Some("pending"), Some(BOB_EVM), Some("200000000")));
    let r = root.call(airbag.id(), "sign_evm_payout").args_json(json!({ "payout": "0" })).gas(Gas::from_tgas(300)).transact().await?;
    assert!(failures(&r).is_empty(), "{:?}", failures(&r));
    let p: Value = airbag.view("get_evm_payout").args_json(json!({ "payout": "0" })).await?.json()?;
    assert_eq!(p["status"], json!("signed"));
    assert_eq!(p["signature"], json!(format!("0x{}{}1b", "11".repeat(32), "22".repeat(32))));
    let n: u64 = signer.view("signed").await?.json()?;
    assert_eq!(n, 9, "8 Polygon transactions + 1 Base payout");

    // the underwriter takes the rest: what's left on NEAR is exactly bob's payout, kept for the Base float
    let r = lp.call(airbag.id(), "claim_lp").args_json(json!({ "market": "0" })).gas(Gas::from_tgas(100)).transact().await?;
    assert!(failures(&r).is_empty(), "{:?}", failures(&r));
    let float: String = airbag.view("evm_float_backing").await?.json()?;
    assert_eq!(ft_balance(&usdc, airbag.id()).await?.to_string(), float);
    assert_eq!(float, (200 * U).to_string());
    let lp_got = ft_balance(&usdc, lp.id()).await?;
    println!("LP: put in 10,000 USDC, got back {} after paying 800 of cover", lp_got as f64 / 1e6);
    Ok(())
}

async fn r_premium(airbag: &Contract, policy: u64) -> anyhow::Result<u128> {
    let p: Value = airbag.view("get_policy").args_json(json!({ "policy": policy.to_string() })).await?.json()?;
    Ok(p["premium"].as_str().unwrap().parse()?)
}
