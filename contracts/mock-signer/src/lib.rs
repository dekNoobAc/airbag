//! A stand-in for NEAR's MPC signer (`v1.signer`) in sandbox tests. Same method and answer shape; the signature is
//! a fixed value, not a real one. It refuses any path containing "fail", to test what happens when signing fails.
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, NearToken};

#[near(contract_state)]
#[derive(Default)]
pub struct MockSigner {
    signed: u64,
}

#[near]
impl MockSigner {
    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach a deposit");
        let path = request["path"].as_str().unwrap_or_default();
        let payload = request["payload_v2"]["Ecdsa"].as_str().unwrap_or_default();
        require!(payload.len() == 64, "payload must be 32 bytes hex");
        require!(!path.contains("fail"), "mock signer: refusing this path");
        self.signed += 1;
        json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": format!("02{}", "11".repeat(32)) },
            "s": { "scalar": "22".repeat(32) },
            "recovery_id": 0
        })
    }

    pub fn signed(&self) -> u64 {
        self.signed
    }
}
