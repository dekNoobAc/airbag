//! Airbag's oracle. OutLayer runs this inside an Intel TDX enclave when the Airbag contract calls `refresh`:
//! stdin = the market (from the contract), stdout = one report (back to the contract's `on_oracle`).
//!   cargo build --target wasm32-wasip2 --release
//!   echo '{"market":"0","source":{"polymarket":{"slug":"usdc-depeg-by-december-31-968","pays_on":"yes"}},"end":"1798761600","now":"0"}' \
//!     | wasmtime run -S http target/wasm32-wasip2/release/airbag-oracle.wasm
use std::io::{self, Read, Write};

mod logic;
use logic::{from_gamma, gamma_url, gamma_url_open, Input, Source};

#[cfg(target_os = "wasi")]
fn get(url: &str) -> Result<Vec<u8>, String> {
    use std::time::Duration;
    use wasi_http_client::Client;
    let resp = Client::new()
        .get(url)
        .header("accept", "application/json")
        .header("user-agent", "airbag-oracle/0.1")
        .connect_timeout(Duration::from_secs(10))
        .send()
        .map_err(|e| format!("GET {url}: {e}"))?;
    if resp.status() != 200 {
        return Err(format!("GET {url}: HTTP {}", resp.status()));
    }
    resp.body().map_err(|e| format!("GET {url}: body: {e}"))
}

#[cfg(not(target_os = "wasi"))]
fn get(_url: &str) -> Result<Vec<u8>, String> {
    Err("HTTP only in the wasm build (wasm32-wasip2)".into())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn run(input: &str) -> Result<String, String> {
    let input: Input = serde_json::from_str(input).map_err(|e| format!("input: {e}"))?;
    let end: u64 = input.end.parse().map_err(|_| "input: end")?;
    let called_at: u64 = input.now.parse().map_err(|_| "input: now")?;
    // a few seconds back, so the report is never "from the future" for the block that reads it
    let observed_at = unix_now().saturating_sub(5).max(called_at);
    let Source::Polymarket { slug, pays_on } = &input.source;
    if !slug.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err("input: bad slug".into());
    }
    // open markets first (the common case), then closed ones
    let body = get(&gamma_url_open(slug))?;
    let body = if body.starts_with(b"[]") { get(&gamma_url(slug))? } else { body };
    let report = from_gamma(&body, pays_on, observed_at, end)?;
    let _ = &input.market;
    serde_json::to_string(&report).map_err(|e| e.to_string())
}

fn main() {
    let mut input = String::new();
    let out = match io::stdin().read_to_string(&mut input) {
        Ok(_) => run(&input),
        Err(e) => Err(format!("stdin: {e}")),
    };
    // errors are output too (the contract can't parse them as a report, so it changes nothing)
    let line = out.unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string());
    print!("{line}");
    let _ = io::stdout().flush();
}
