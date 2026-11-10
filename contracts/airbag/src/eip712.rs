//! The EIP-712 hash of a USDC `TransferWithAuthorization` (EIP-3009): the exact message x402's "exact" scheme
//! asks a payer to sign. The contract builds it itself, so the agent can never get a signature for anything else.
use near_sdk::{env, require};

pub type Address = [u8; 20];

const DOMAIN_TYPE: &[u8] = b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const TRANSFER_TYPE: &[u8] =
    b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

pub struct Token<'a> {
    pub chain_id: u64,
    pub address: Address,
    pub name: &'a str,
    pub version: &'a str,
}

pub struct Transfer {
    pub from: Address,
    pub to: Address,
    pub value: u128,
    pub valid_after: u64,
    pub valid_before: u64,
    pub nonce: [u8; 32],
}

fn keccak(b: &[u8]) -> [u8; 32] {
    env::keccak256_array(b)
}

pub fn keccak_pub(b: &[u8]) -> [u8; 32] {
    keccak(b)
}

fn word_u(n: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&n.to_be_bytes());
    w
}

fn word_addr(a: &Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

pub fn digest(t: &Token, x: &Transfer) -> [u8; 32] {
    let domain = keccak(
        &[
            keccak(DOMAIN_TYPE),
            keccak(t.name.as_bytes()),
            keccak(t.version.as_bytes()),
            word_u(t.chain_id as u128),
            word_addr(&t.address),
        ]
        .concat(),
    );
    let body = keccak(
        &[
            keccak(TRANSFER_TYPE),
            word_addr(&x.from),
            word_addr(&x.to),
            word_u(x.value),
            word_u(x.valid_after as u128),
            word_u(x.valid_before as u128),
            x.nonce,
        ]
        .concat(),
    );
    keccak(&[&[0x19u8, 0x01][..], &domain, &body].concat())
}

pub fn unhex(s: &str, what: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    require!(s.len() % 2 == 0 && s.bytes().all(|c| c.is_ascii_hexdigit()), format!("{what}: not hex"));
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

pub fn hex(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(D[(x >> 4) as usize] as char);
        s.push(D[(x & 15) as usize] as char);
    }
    s
}

pub fn address(s: &str, what: &str) -> Address {
    let b = unhex(s, what);
    require!(b.len() == 20, format!("{what}: must be a 20-byte address"));
    b.try_into().unwrap()
}

pub fn bytes32(s: &str, what: &str) -> [u8; 32] {
    let b = unhex(s, what);
    require!(b.len() == 32, format!("{what}: must be 32 bytes"));
    b.try_into().unwrap()
}

/// `0x` + lowercase hex, the one spelling the contract stores.
pub fn addr_str(a: &Address) -> String {
    format!("0x{}", hex(a))
}
