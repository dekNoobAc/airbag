//! Pool math. A pool holds `y` YES and `n` NO; YES price = n / (y + n). All amounts are USDC base units
//! (1 set = 1 YES + 1 NO = 1 USDC). Every rounding goes in the pool's favour.
use uint::construct_uint;

construct_uint! {
    pub struct U256(4);
}

pub const BPS: u128 = 10_000;

fn isqrt(v: U256) -> U256 {
    if v.is_zero() {
        return v;
    }
    let mut x = v;
    let mut y = (x + U256::one()) >> 1;
    while y < x {
        x = y;
        y = (x + v / x) >> 1;
    }
    x
}

/// USDC needed to take exactly `x` YES out of the pool: mint `c` sets into it, then keep `y·n` constant:
/// (y + c − x)(n + c) ≥ y·n. Smallest such `c`. `None` if `x ≥ y` (the pool can't give that much).
pub fn buy_cost(y: u128, n: u128, x: u128) -> Option<u128> {
    if x == 0 || x >= y || n == 0 {
        return None;
    }
    let (y2, n2, x2) = (U256::from(y), U256::from(n), U256::from(x));
    let b = y2 + n2 - x2; // > n > 0 because x < y
    let d = b * b + U256::from(4u8) * x2 * n2;
    let s = isqrt(d);
    let mut c = if s > b { (s - b + U256::one()) >> 1 } else { U256::zero() };
    let k = y2 * n2;
    // integer sqrt can land one short: step up until the invariant holds
    while (y2 + c - x2) * (n2 + c) < k {
        c += U256::one();
    }
    Some(c.as_u128())
}

/// YES price in bps (rounded down).
pub fn price_bps(y: u128, n: u128) -> u128 {
    if y + n == 0 {
        return 0;
    }
    (U256::from(n) * U256::from(BPS) / U256::from(y + n)).as_u128()
}

/// ceil(a · b / d)
pub fn mul_div_up(a: u128, b: u128, d: u128) -> u128 {
    let p = U256::from(a) * U256::from(b);
    let d = U256::from(d);
    ((p + d - U256::one()) / d).as_u128()
}

/// floor(a · b / d)
pub fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(d)).as_u128()
}

/// Premium for `x` cover: the AMM cost, raised to the floor if the floor is higher, plus the fee.
/// Returns (amm_cost, premium).
pub fn premium(y: u128, n: u128, x: u128, floor_bps: u128, fee_bps: u128) -> Option<(u128, u128)> {
    let c = buy_cost(y, n, x)?;
    let base = c.max(mul_div_up(x, floor_bps, BPS));
    Some((c, base + mul_div_up(base, fee_bps, BPS)))
}

/// First liquidity: `d` sets, priced at `p0_bps` (YES). Returns (pool_y, pool_n, leftover_yes, leftover_no).
/// The side that must be smaller keeps only part of its `d`; the rest goes back to the LP as a leftover claim.
pub fn initial_split(d: u128, p0_bps: u128) -> (u128, u128, u128, u128) {
    // p = n / (y + n)  →  n / y = p / (1 − p)
    if p0_bps <= BPS / 2 {
        let n = mul_div(d, p0_bps, BPS - p0_bps);
        (d, n, 0, d - n)
    } else {
        let y = mul_div(d, BPS - p0_bps, p0_bps);
        (y, d, d - y, 0)
    }
}

/// Later liquidity: `d` sets into a pool `(y, n)` with `total` shares, at the pool's current ratio.
/// Returns (add_y, add_n, leftover_yes, leftover_no, new_shares).
pub fn add_split(d: u128, y: u128, n: u128, total: u128) -> (u128, u128, u128, u128, u128) {
    if y >= n {
        let add_n = mul_div(d, n, y);
        (d, add_n, 0, d - add_n, mul_div(d, total, y))
    } else {
        let add_y = mul_div(d, y, n);
        (add_y, d, d - add_y, 0, mul_div(d, total, n))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const U: u128 = 1_000_000; // 1 USDC

    #[test]
    fn cost_keeps_product_and_is_minimal() {
        for &(y, n, x) in &[(1000 * U, 1000 * U, 10 * U), (1000 * U, 20 * U, 100 * U), (5 * U, 5_000 * U, 4 * U), (U, U, 1)] {
            let c = buy_cost(y, n, x).unwrap();
            let k = U256::from(y) * U256::from(n);
            assert!(U256::from(y + c - x) * U256::from(n + c) >= k);
            assert!(c == 0 || U256::from(y + c - 1 - x) * U256::from(n + c - 1) < k, "not minimal");
        }
    }

    #[test]
    fn cost_matches_price_for_small_buys_and_rises_with_size() {
        // 2% YES: 1 USDC of cover costs ~0.02 USDC
        let (y, n) = (980_000 * U, 20_000 * U);
        let c = buy_cost(y, n, U).unwrap();
        assert!((19_900..=20_100).contains(&c), "{c}");
        let c_big = buy_cost(y, n, 100_000 * U).unwrap();
        assert!(c_big > 100_000 * 20_000, "big buys pay more per dollar");
        assert!(price_bps(y + c_big - 100_000 * U, n + c_big) > price_bps(y, n));
    }

    #[test]
    fn cannot_take_whole_pool() {
        assert!(buy_cost(10 * U, 10 * U, 10 * U).is_none());
        assert!(buy_cost(10 * U, 10 * U, 0).is_none());
    }

    #[test]
    fn floor_and_fee() {
        let (y, n) = (1000 * U, 1000 * U); // 50%
        let (c, p) = premium(y, n, U, 100, 0).unwrap();
        assert_eq!(p, c, "floor below AMM price: AMM price");
        let (y, n) = (990_000 * U, 10_000 * U); // 1%
        let (c, p) = premium(y, n, 100 * U, 300, 200).unwrap(); // floor 3%, fee 2%
        assert!(c < 2 * U);
        assert_eq!(p, 3 * U + 60_000);
    }

    #[test]
    fn splits_keep_price_and_sum_to_deposit() {
        let (y, n, ly, ln) = initial_split(1000 * U, 200);
        assert_eq!((y + ly, n + ln), (1000 * U, 1000 * U));
        assert!((199..=200).contains(&price_bps(y, n)));
        let (ay, an, lx, lz, s) = add_split(50 * U, y, n, 1000 * U);
        assert_eq!((ay + lx, an + lz), (50 * U, 50 * U));
        assert_eq!(price_bps(y + ay, n + an), price_bps(y, n));
        assert_eq!(s, 50 * U);
    }
}
