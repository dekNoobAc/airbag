//! What the oracle decides from what it fetched. No I/O here, so it's tested on any machine.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// What the Airbag contract sends (`refresh`): the market's source and times.
#[derive(Deserialize, Debug)]
pub struct Input {
    pub market: String,
    pub source: Source,
    pub end: String,
    pub now: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// Cover pays when Polymarket's `pays_on` outcome ("yes" | "no") wins.
    Polymarket { slug: String, pays_on: String },
}

/// The report the contract reads in `on_oracle` (≤ 900 bytes). `yes_bps` = odds that the cover pays.
#[derive(Serialize, Debug, PartialEq)]
pub struct Report {
    pub yes_bps: u16,
    pub observed_at: String,
    pub resolved: Option<String>,
    pub event_at: Option<String>,
    pub source_sha256: String,
}

pub fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

pub fn gamma_url_open(slug: &str) -> String {
    format!("https://gamma-api.polymarket.com/markets?slug={slug}")
}

/// Closed markets only come back with `closed=true`.
pub fn gamma_url(slug: &str) -> String {
    format!("https://gamma-api.polymarket.com/markets?slug={slug}&closed=true")
}

/// Gamma sends some fields as JSON strings holding arrays ("[\"0.011\", \"0.989\"]").
fn str_array(v: &Value) -> Option<Vec<String>> {
    let arr: Vec<Value> = match v {
        Value::String(s) => serde_json::from_str(s).ok()?,
        Value::Array(a) => a.clone(),
        _ => return None,
    };
    arr.into_iter().map(|x| x.as_str().map(String::from).or_else(|| x.as_f64().map(|f| f.to_string()))).collect()
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.parse().ok())
}

fn to_bps(p: f64) -> u16 {
    ((p * 10_000.0).ceil() as i64).clamp(1, 9_999) as u16
}

/// Polymarket → report, for cover that pays on outcome `pays_on`.
/// Floor = max(that outcome's midpoint, its last trade): on a thin book the higher of the two, and the floor can only
/// ever raise Airbag's price, so pushing Polymarket down can't make cover cheap.
pub fn from_gamma(body: &[u8], pays_on: &str, observed_at: u64, end: u64) -> Result<Report, String> {
    let v: Value = serde_json::from_slice(body).map_err(|e| format!("gamma: not json: {e}"))?;
    let m = v.as_array().and_then(|a| a.first()).ok_or("gamma: market not found")?;
    let outcomes = str_array(&m["outcomes"]).ok_or("gamma: no outcomes")?;
    let prices = str_array(&m["outcomePrices"]).ok_or("gamma: no prices")?;
    if outcomes.len() != 2 || prices.len() != 2 {
        return Err("gamma: not a yes/no market".into());
    }
    let i = outcomes.iter().position(|o| o.eq_ignore_ascii_case(pays_on)).ok_or("gamma: no such outcome")?;
    let mid: f64 = prices[i].parse().map_err(|_| "gamma: bad price")?;
    // Gamma's last trade is quoted for the first outcome ("Yes")
    let last_yes = num(&m["lastTradePrice"]).unwrap_or(0.0);
    let last = if i == 0 { last_yes } else if last_yes > 0.0 { 1.0 - last_yes } else { 0.0 };
    let p = mid.max(last);
    let closed = m["closed"].as_bool().unwrap_or(false);
    let uma = m["umaResolutionStatus"].as_str().unwrap_or("");
    let (resolved, event_at) = if closed && uma == "resolved" {
        if mid >= 0.99 {
            // Gamma gives no event time; the market's close time is the best public one (cover also halts once the
            // odds pass the halt line, and buys stop before the end)
            let t = m["closedTime"].as_str().and_then(parse_time).unwrap_or(observed_at).min(observed_at).min(end);
            (Some("yes".to_string()), Some(t.to_string()))
        } else if mid <= 0.01 {
            (Some("no".to_string()), None)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };
    Ok(Report { yes_bps: to_bps(p), observed_at: observed_at.to_string(), resolved, event_at, source_sha256: sha256_hex(body) })
}

fn parse_time(s: &str) -> Option<u64> {
    // "2026-03-31 16:00:00+00" or "2026-03-31T16:00:00Z": date and time are enough (UTC)
    let s = s.replace('T', " ");
    let (date, rest) = s.split_once(' ')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>());
    let (y, mo, da) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let mut t = rest.get(..8)?.split(':').map(|x| x.parse::<i64>());
    let (h, mi, se) = (t.next()?.ok()?, t.next()?.ok()?, t.next()?.ok()?);
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + h * 3_600 + mi * 60 + se).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN: &str = r#"[{"outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"0.011\", \"0.989\"]","lastTradePrice":0.02,"closed":false,"umaResolutionStatus":null}]"#;
    const BTC: &str = r#"[{"outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"0.635\", \"0.365\"]","lastTradePrice":0.62,"closed":false,"umaResolutionStatus":null}]"#;
    const RESOLVED_YES: &str = r#"[{"outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"1\", \"0\"]","lastTradePrice":0.999,"closed":true,"umaResolutionStatus":"resolved","closedTime":"2026-03-12 09:30:00+00"}]"#;
    const RESOLVED_NO: &str = r#"[{"outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"0\", \"1\"]","lastTradePrice":0.001,"closed":true,"umaResolutionStatus":"resolved","closedTime":"2026-11-12 17:05:00+00"}]"#;

    #[test]
    fn floor_is_the_higher_of_mid_and_last() {
        let r = from_gamma(OPEN.as_bytes(), "yes", 1_800_000_000, 1_900_000_000).unwrap();
        assert_eq!(r.yes_bps, 200, "last trade 2% beats the 1.1% midpoint");
        assert_eq!(r.resolved, None);
        assert_eq!(r.source_sha256.len(), 64);
        assert!(serde_json::to_vec(&r).unwrap().len() < 900);
    }

    #[test]
    fn crash_cover_uses_the_no_side() {
        // BTC above $74k: Yes 63.5%, last 0.62 → "No" (crash) mid 36.5%, last 38% → 38%
        let r = from_gamma(BTC.as_bytes(), "no", 1, 2).unwrap();
        assert_eq!(r.yes_bps, 3_800);
    }

    #[test]
    fn resolved_markets() {
        let r = from_gamma(RESOLVED_YES.as_bytes(), "yes", 1_800_000_000, 1_900_000_000).unwrap();
        assert_eq!((r.resolved.as_deref(), r.event_at.as_deref()), (Some("yes"), Some("1773307800")));
        assert_eq!(r.yes_bps, 9_999);
        let r = from_gamma(RESOLVED_YES.as_bytes(), "no", 1_800_000_000, 1_900_000_000).unwrap();
        assert_eq!(r.resolved.as_deref(), Some("no"), "cover on No: Yes won, so no payout");
        // BTC closed below: the No side won → crash cover pays
        let r = from_gamma(RESOLVED_NO.as_bytes(), "no", 1_900_000_000, 1_900_000_000).unwrap();
        assert_eq!((r.resolved.as_deref(), r.event_at.as_deref()), (Some("yes"), Some("1794503100")));
    }

    #[test]
    fn bad_bodies_are_errors() {
        assert!(from_gamma(b"[]", "yes", 1, 2).is_err());
        assert!(from_gamma(b"<html>blocked</html>", "yes", 1, 2).is_err());
        assert!(from_gamma(OPEN.as_bytes(), "maybe", 1, 2).is_err());
    }

    #[test]
    fn dates() {
        assert_eq!(parse_time("2026-03-12 09:30:00+00"), Some(1_773_307_800));
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
    }
}
