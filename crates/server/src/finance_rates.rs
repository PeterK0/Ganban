//! The ECB reference rates fetch for Finance, run by the `ecb_rates` routine (the host's
//! catch-up runner, daily). The first fetch takes the full history; later ones the last 90
//! days. A host where nobody uses Finance fetches nothing.

use ganban_core::error::AppError;
use ganban_core::finance::rates;
use ganban_core::Db;
use serde_json::{json, Value};

/// Fetch the feed the cache needs and store it. Returns a summary for the routine ledger.
pub async fn refresh(db: &Db) -> Result<Value, AppError> {
    if !rates::in_use(db).await? {
        return Ok(json!({ "skipped": "finance is not in use" }));
    }
    let url = rates::feed_url(db).await?;
    let xml = fetch(url).await?;
    let rows = rates::parse_ecb_xml(&xml);
    if rows.is_empty() {
        return Err(AppError::InvalidInput("the ECB feed held no rates".into()));
    }
    let stored = rates::store_rates(db, &rows, "ecb").await?;
    let latest = rows.iter().map(|r| r.0.as_str()).max().unwrap_or_default().to_string();
    Ok(json!({ "feed": if url == rates::ECB_HIST_URL { "history" } else { "90 days" }, "rates": stored, "latest": latest }))
}

/// Register the host's fetcher, so a translation that misses the cache (an import before
/// the routine has run) fetches the feed on demand.
pub fn register_on_demand() {
    rates::set_fetcher(std::sync::Arc::new(|url| {
        Box::pin(async move {
            fetch(url).await.map_err(|e| {
                tracing::warn!("{e}");
                e.to_string()
            })
        })
    }));
}

async fn fetch(url: &str) -> Result<String, AppError> {
    let failed = |e: reqwest::Error| AppError::Io(std::io::Error::other(format!("ECB rates fetch failed: {e}")));
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().map_err(failed)?;
    client.get(url).send().await.and_then(|r| r.error_for_status()).map_err(failed)?.text().await.map_err(failed)
}
