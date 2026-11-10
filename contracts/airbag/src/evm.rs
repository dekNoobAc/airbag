//! The MPC signer's answer → an Ethereum signature r‖s‖v (from Wayfare).
use crate::eip712;
use near_sdk::serde_json::Value;

/// secp256k1 order n and n/2: Ethereum (and USDC) only accept the low-s form of a signature.
const N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc,
    0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
const HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x5d, 0x57, 0x6e,
    0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

fn sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = a[i] as i16 - b[i] as i16 - borrow;
        borrow = if d < 0 { d += 256; 1 } else { 0 };
        out[i] = d as u8;
    }
    out
}


/// The MPC signer's answer → 65-byte Ethereum signature r‖s‖v, normalized to low s.
pub fn to_eth_signature(v: &Value) -> Option<String> {
    let big_r = v.get("big_r")?.get("affine_point")?.as_str()?;
    let s = v.get("s")?.get("scalar")?.as_str()?;
    let rec = v.get("recovery_id")?.as_u64()?;
    if big_r.len() != 66 || s.len() != 64 || rec > 1 {
        return None;
    }
    let ok_hex = |x: &str| x.bytes().all(|c| c.is_ascii_hexdigit());
    if !ok_hex(big_r) || !ok_hex(s) {
        return None;
    }
    let r = &big_r[2..];
    let mut s_bytes: [u8; 32] = (0..32).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect::<Vec<_>>().try_into().ok()?;
    let mut rec = rec as u8;
    if s_bytes > HALF_N {
        s_bytes = sub(&N, &s_bytes);
        rec ^= 1;
    }
    Some(format!("0x{}{}{:02x}", r.to_lowercase(), eip712::hex(&s_bytes), 27 + rec))
}
