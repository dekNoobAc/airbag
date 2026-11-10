//! Polymarket's own contracts, driven from NEAR. Airbag's Polygon wallet (the MPC key at `airbag-float`) holds real
//! Conditional Tokens (Polymarket's CTF, ERC-1155 YES/NO shares) for the cover it sells, and the contract builds
//! every Polygon transaction itself: the keeper can only get MPC signatures for these exact calls.
//!
//! Calls (Gnosis CTF, as deployed by Polymarket):
//!   prepareCondition(oracle, questionId, 2)          a YES/NO condition whose oracle is Airbag's wallet
//!   splitPosition(usdc, 0, conditionId, [1,2], x)     x USDC → x YES + x NO shares
//!   reportPayouts(questionId, [1,0] | [0,1])          the result, once the NEAR market is final
//!   redeemPositions(usdc, 0, conditionId, [1,2])      winning shares → USDC
//! plus the collateral's approve, and (testnet only) its open `mint`.
use crate::eip712::{keccak_pub as keccak, Address};

pub const YES: u128 = 1; // index set of outcome 0 ("Yes"), as on Polymarket
pub const NO: u128 = 2; // index set of outcome 1 ("No")

fn selector(sig: &str) -> [u8; 4] {
    keccak(sig.as_bytes())[..4].try_into().unwrap()
}

fn w_u(n: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&n.to_be_bytes());
    w
}

fn w_addr(a: &Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn call(sig: &str, words: &[[u8; 32]]) -> Vec<u8> {
    let mut out = selector(sig).to_vec();
    for w in words {
        out.extend_from_slice(w);
    }
    out
}

pub fn approve_max(spender: &Address) -> Vec<u8> {
    call("approve(address,uint256)", &[w_addr(spender), [0xff; 32]])
}

pub fn mint(to: &Address, amount: u128) -> Vec<u8> {
    call("mint(address,uint256)", &[w_addr(to), w_u(amount)])
}

pub fn prepare_condition(oracle: &Address, question_id: &[u8; 32]) -> Vec<u8> {
    call("prepareCondition(address,bytes32,uint256)", &[w_addr(oracle), *question_id, w_u(2)])
}

pub fn split_position(collateral: &Address, condition_id: &[u8; 32], amount: u128) -> Vec<u8> {
    call(
        "splitPosition(address,bytes32,bytes32,uint256[],uint256)",
        &[w_addr(collateral), [0; 32], *condition_id, w_u(5 * 32), w_u(amount), w_u(2), w_u(YES), w_u(NO)],
    )
}

/// `yes_won`: Polymarket's "Yes" outcome won.
pub fn report_payouts(question_id: &[u8; 32], yes_won: bool) -> Vec<u8> {
    let (a, b) = if yes_won { (1, 0) } else { (0, 1) };
    call("reportPayouts(bytes32,uint256[])", &[*question_id, w_u(2 * 32), w_u(2), w_u(a), w_u(b)])
}

pub fn redeem_positions(collateral: &Address, condition_id: &[u8; 32]) -> Vec<u8> {
    call(
        "redeemPositions(address,bytes32,bytes32,uint256[])",
        &[w_addr(collateral), [0; 32], *condition_id, w_u(4 * 32), w_u(2), w_u(YES), w_u(NO)],
    )
}

/// CTF `getConditionId`: keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount)).
pub fn condition_id(oracle: &Address, question_id: &[u8; 32]) -> [u8; 32] {
    keccak(&[&oracle[..], &question_id[..], &w_u(2)[..]].concat())
}

// ── RLP + EIP-1559 ──

fn rlp_len(prefix: u8, len: usize) -> Vec<u8> {
    if len <= 55 {
        vec![prefix + len as u8]
    } else {
        let lb: Vec<u8> = (len as u64).to_be_bytes().into_iter().skip_while(|b| *b == 0).collect();
        let mut v = vec![prefix + 55 + lb.len() as u8];
        v.extend(lb);
        v
    }
}

fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut v = rlp_len(0x80, b.len());
    v.extend_from_slice(b);
    v
}

fn rlp_uint(n: u128) -> Vec<u8> {
    let b: Vec<u8> = n.to_be_bytes().into_iter().skip_while(|x| *x == 0).collect();
    rlp_bytes(&b)
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = items.concat();
    let mut v = rlp_len(0xc0, body.len());
    v.extend(body);
    v
}

pub struct Tx<'a> {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee: u128,
    pub max_fee: u128,
    pub gas: u64,
    pub to: &'a Address,
    pub data: &'a [u8],
}

fn fields(t: &Tx) -> Vec<Vec<u8>> {
    vec![
        rlp_uint(t.chain_id as u128),
        rlp_uint(t.nonce as u128),
        rlp_uint(t.max_priority_fee),
        rlp_uint(t.max_fee),
        rlp_uint(t.gas as u128),
        rlp_bytes(t.to),
        rlp_uint(0),
        rlp_bytes(t.data),
        rlp_list(&[]),
    ]
}

/// The hash MPC signs for an EIP-1559 (type 2) transaction.
pub fn signing_hash(t: &Tx) -> [u8; 32] {
    keccak(&[&[2u8][..], &rlp_list(&fields(t))].concat())
}

/// The broadcastable transaction, from a 65-byte r‖s‖v signature (v = 27/28, low s).
pub fn signed(t: &Tx, sig: &[u8]) -> Vec<u8> {
    let strip = |b: &[u8]| -> Vec<u8> { b.iter().copied().skip_while(|x| *x == 0).collect() };
    let mut f = fields(t);
    f.push(rlp_uint((sig[64] - 27) as u128));
    f.push(rlp_bytes(&strip(&sig[..32])));
    f.push(rlp_bytes(&strip(&sig[32..64])));
    [&[2u8][..], &rlp_list(&f)].concat()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eip712::{address, bytes32, hex, unhex};

    const W: &str = "0x85e23ae7103502b421a5fb856c36def4f6bbb8cb";
    const COL: &str = "0x9c4E1703476E875070EE25b56A58B008CFb8FA78";
    const CTF: &str = "0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB";
    const Q1: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";

    fn h(b: &[u8]) -> String {
        format!("0x{}", hex(b))
    }

    #[test]
    fn condition_id_matches_polymarket_ctf_on_amoy() {
        // eth_call getConditionId(W, 1, 2) on Polymarket's CTF at 0x69308FB…, Polygon Amoy
        assert_eq!(
            h(&condition_id(&address(W, "w"), &bytes32(Q1, "q"))),
            "0xc2550cc9608423b5f2154901ad94173ee1424097b13d05b21c4307e49548f6ef"
        );
    }

    #[test]
    fn calldata_matches_cast() {
        let (w, col, ctf, q) = (address(W, "w"), address(COL, "c"), address(CTF, "t"), bytes32(Q1, "q"));
        let c = condition_id(&w, &q);
        assert_eq!(h(&split_position(&col, &c, 410_000_000)), "0x72ce42750000000000000000000000009c4e1703476e875070ee25b56a58b008cfb8fa780000000000000000000000000000000000000000000000000000000000000000c2550cc9608423b5f2154901ad94173ee1424097b13d05b21c4307e49548f6ef00000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000018701a80000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002");
        assert_eq!(h(&report_payouts(&q, false)), "0xc49298ac00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001");
        assert_eq!(h(&redeem_positions(&col, &c)), "0x01b7037c0000000000000000000000009c4e1703476e875070ee25b56a58b008cfb8fa780000000000000000000000000000000000000000000000000000000000000000c2550cc9608423b5f2154901ad94173ee1424097b13d05b21c4307e49548f6ef0000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002");
        assert_eq!(h(&prepare_condition(&w, &q)), "0xd96ee75400000000000000000000000085e23ae7103502b421a5fb856c36def4f6bbb8cb00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002");
        assert_eq!(h(&mint(&w, 1_000_000)), "0x40c10f1900000000000000000000000085e23ae7103502b421a5fb856c36def4f6bbb8cb00000000000000000000000000000000000000000000000000000000000f4240");
        assert_eq!(h(&approve_max(&ctf)), "0x095ea7b300000000000000000000000069308fb512518e39f9b16112fa8d994f4e2bf8bbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    }

    #[test]
    fn signed_eip1559_tx_matches_cast_mktx() {
        // `cast mktx` with anvil's public dev key #0: chain 80002, nonce 7, gas 150000, tip 30 gwei, max 60 gwei
        let ctf = address(CTF, "t");
        let data = report_payouts(&bytes32(Q1, "q"), false);
        let tx = Tx { chain_id: 80002, nonce: 7, max_priority_fee: 30_000_000_000, max_fee: 60_000_000_000, gas: 150_000, to: &ctf, data: &data };
        let sig = unhex("0xb0ed6b5c9a00f53ffee079c6712599e466c9cf0fd7d7b83995133f94f4a286843e20f374be66070363fe2c0767bb7fb2df2a2276b5e2fafcb875e0e439042fe41b", "sig");
        let raw = signed(&tx, &sig);
        assert_eq!(h(&raw), "0x02f9011583013882078506fc23ac00850df8475800830249f09469308fb512518e39f9b16112fa8d994f4e2bf8bb80b8a4c49298ac00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c080a0b0ed6b5c9a00f53ffee079c6712599e466c9cf0fd7d7b83995133f94f4a28684a03e20f374be66070363fe2c0767bb7fb2df2a2276b5e2fafcb875e0e439042fe4");
        assert_eq!(h(&keccak(&raw)), "0x83eba507f8b39eb4662f65b28b85ed0008b4398d744c26feff543921f88e09ca");
    }
}
