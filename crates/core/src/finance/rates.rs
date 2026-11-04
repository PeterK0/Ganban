//! ECB reference rates (IAS 21 spot rates). The host fetches the eurofxref feeds (a routine,
//! `ecb_rates`) and caches them in `fin_rates`, global to the host. A rate is units of the
//! currency per 1 EUR, as the ECB publishes it. Translation uses the latest rate on or before
//! the date.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{currency, Conn};
use crate::error::{AppError, Result};
use crate::Db;

/// The last 90 days, fetched daily.
pub const ECB_90D_URL: &str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
/// The full history since 1999, fetched on first use (while `fin_rates` is empty).
pub const ECB_HIST_URL: &str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";

/// One cached rate.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rate {
    /// Units of the currency per 1 EUR.
    pub rate: f64,
    pub date: String,
    pub source: String,
}

/// One parsed ECB observation: (date, currency, rate).
pub type Observation = (String, String, f64);

/// The value of attribute `name` in a tag's text (`name='v'` or `name="v"`).
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut at = 0;
    while let Some(i) = tag[at..].find(name).map(|i| i + at) {
        at = i + name.len();
        if tag[..i].chars().next_back().is_some_and(|c| c.is_alphanumeric()) {
            continue;
        }
        let rest = tag[at..].trim_start().strip_prefix('=')?.trim_start();
        let quote = rest.chars().next().filter(|q| *q == '\'' || *q == '"')?;
        let body = &rest[1..];
        return body.find(quote).map(|end| &body[..end]);
    }
    None
}

/// Parse an ECB eurofxref XML document: `<Cube time='YYYY-MM-DD'>` days holding
/// `<Cube currency='USD' rate='1.0812'/>` rows. Malformed rows are skipped.
pub fn parse_ecb_xml(xml: &str) -> Vec<Observation> {
    let mut out = Vec::new();
    let mut day: Option<String> = None;
    for tag in xml.split('<').skip(1) {
        let Some(tag) = tag.split('>').next() else { continue };
        if !tag.starts_with("Cube") {
            continue;
        }
        if let Some(t) = attr(tag, "time") {
            day = super::check_date(t).ok();
        } else if let (Some(d), Some(c), Some(r)) = (&day, attr(tag, "currency"), attr(tag, "rate")) {
            if let (Ok(c), Ok(r)) = (currency::normalise(c), r.trim().parse::<f64>()) {
                if r.is_finite() && r > 0.0 {
                    out.push((d.clone(), c, r));
                }
            }
        }
    }
    out
}

/// Cache observations (an existing day is overwritten). Returns how many were written.
pub async fn store_rates(db: &Db, rows: &[Observation], source: &str) -> Result<usize> {
    let mut tx = db.begin().await?;
    let n = store_rates_in(&mut tx, rows, source).await?;
    tx.commit().await?;
    Ok(n)
}

pub async fn store_rates_in(conn: &mut Conn, rows: &[Observation], source: &str) -> Result<usize> {
    // Many rows per statement: the full history is some 200,000.
    for chunk in rows.chunks(250) {
        let mut q = sqlx::QueryBuilder::new("INSERT OR REPLACE INTO fin_rates (currency, date, rate, source) ");
        q.push_values(chunk, |mut b, (date, cur, rate)| {
            b.push_bind(cur).push_bind(date).push_bind(rate).push_bind(source);
        });
        q.build().execute(&mut *conn).await?;
    }
    Ok(rows.len())
}

// ============== Fetching on a cache miss ==============

/// Reads a feed URL's body. The host registers one ([`set_fetcher`]); tests scope their
/// own ([`with_fetcher`]). The error text is for the host's log, never shown.
pub type Fetcher = Arc<dyn Fn(&'static str) -> Pin<Box<dyn Future<Output = std::result::Result<String, String>> + Send>> + Send + Sync>;

/// How long a fetched feed is reused instead of fetched again.
const REUSE: Duration = Duration::from_secs(10 * 60);

/// A fetcher with its guard: one fetch at a time, and a feed fetched in the last
/// [`REUSE`] is served from memory (a second import waiting on the first gets its rows).
struct OnDemand {
    fetch: Fetcher,
    guard: tokio::sync::Mutex<()>,
    recent: Mutex<HashMap<&'static str, (Instant, Arc<Vec<Observation>>)>>,
}

impl OnDemand {
    fn new(fetch: Fetcher) -> Arc<Self> {
        Arc::new(OnDemand { fetch, guard: tokio::sync::Mutex::new(()), recent: Mutex::new(HashMap::new()) })
    }

    fn recent(&self, url: &'static str) -> Option<Arc<Vec<Observation>>> {
        let recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        recent.get(url).filter(|(at, _)| at.elapsed() < REUSE).map(|(_, rows)| rows.clone())
    }

    fn remember(&self, url: &'static str, rows: Arc<Vec<Observation>>) {
        self.recent.lock().unwrap_or_else(|e| e.into_inner()).insert(url, (Instant::now(), rows));
    }
}

static HOST_FETCHER: OnceLock<Arc<OnDemand>> = OnceLock::new();

tokio::task_local! {
    static SCOPED: Arc<OnDemand>;
}

/// Register the host's fetcher (once per process; later calls are ignored).
pub fn set_fetcher(fetch: Fetcher) {
    let _ = HOST_FETCHER.set(OnDemand::new(fetch));
}

/// Run `f` with `fetch` as the fetcher (tests: no network).
pub async fn with_fetcher<F: Future>(fetch: Fetcher, f: F) -> F::Output {
    SCOPED.scope(OnDemand::new(fetch), f).await
}

fn current_fetcher() -> Option<Arc<OnDemand>> {
    SCOPED.try_with(Arc::clone).ok().or_else(|| HOST_FETCHER.get().cloned())
}

fn unreachable(cur: &str, date: &str) -> AppError {
    AppError::InvalidInput(format!("no exchange rate for {cur} on {date}: the ECB feed couldn't be reached"))
}

/// Fill the cache for a miss on (`cur`, `date`), inside the caller's transaction: the full
/// history when the cache is empty or the date is older than the 90-day feed, else that
/// feed. An import fetches before it writes ([`ensure_rates`]), so this is the fallback.
async fn fetch_on_demand(conn: &mut Conn, cur: &str, date: &str) -> Result<()> {
    let Some(od) = current_fetcher() else { return Err(unreachable(cur, date)) };
    let _one_at_a_time = od.guard.lock().await;
    if let Some(rows) = feed_for_miss(conn, &od, cur, date).await? {
        store_rates_in(conn, &rows, "ecb").await?;
    }
    Ok(())
}

/// The feed rows that fill a miss on (`cur`, `date`), or `None` when the rate is there
/// after all (another caller filled it). The caller holds the fetcher's guard.
async fn feed_for_miss(conn: &mut Conn, od: &OnDemand, cur: &str, date: &str) -> Result<Option<Arc<Vec<Observation>>>> {
    if lookup(conn, cur, date).await?.is_some() {
        return Ok(None);
    }
    let cached: i64 = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM fin_rates)").fetch_one(&mut *conn).await?;
    let recent_enough = (chrono::Utc::now().date_naive() - chrono::Duration::days(85)).format("%Y-%m-%d").to_string();
    let url = if cached == 0 || date < recent_enough.as_str() { ECB_HIST_URL } else { ECB_90D_URL };
    if let Some(rows) = od.recent(url) {
        return Ok(Some(rows));
    }
    let xml = (od.fetch)(url).await.map_err(|_| unreachable(cur, date))?;
    let rows = Arc::new(parse_ecb_xml(&xml));
    if rows.is_empty() {
        return Err(unreachable(cur, date));
    }
    od.remember(url, rows.clone());
    Ok(Some(rows))
}

/// Makes sure a rate is cached for each (currency, date), fetching the ECB feed for a
/// miss *before* the caller opens a write transaction: no network wait while holding
/// the database's write lock. The rows are stored in short transactions of their own.
pub async fn ensure_rates(db: &Db, needs: &[(String, String)]) -> Result<()> {
    let mut conn = db.acquire().await?;
    let mut seen = std::collections::HashSet::new();
    for (cur, date) in needs {
        let cur = currency::normalise(cur)?;
        let date = super::check_date(date)?;
        if !seen.insert((cur.clone(), date.clone())) || lookup(&mut conn, &cur, &date).await?.is_some() {
            continue;
        }
        let Some(od) = current_fetcher() else { return Err(unreachable(&cur, &date)) };
        let _one_at_a_time = od.guard.lock().await;
        let Some(rows) = feed_for_miss(&mut conn, &od, &cur, &date).await? else { continue };
        // Short transactions with a gap between, so other writes get in (see
        // `ImportOptions::pause`).
        for chunk in rows.chunks(20_000) {
            store_rates(db, chunk, "ecb").await?;
            tokio::time::sleep(Duration::from_millis(110)).await;
        }
        if lookup(&mut conn, &cur, &date).await?.is_none() {
            return Err(AppError::InvalidInput(format!("no ECB rate for {cur} on or before {date}")));
        }
    }
    Ok(())
}

/// Whether any rate is cached (else the next fetch takes the full history).
pub async fn has_rates(db: &Db) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT EXISTS (SELECT 1 FROM fin_rates)").fetch_one(db).await? == 1)
}

/// Which feed the next fetch reads.
pub async fn feed_url(db: &Db) -> Result<&'static str> {
    Ok(if has_rates(db).await? { ECB_90D_URL } else { ECB_HIST_URL })
}

/// Whether the host needs rates at all: someone uses Finance.
pub async fn in_use(db: &Db) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT EXISTS (SELECT 1 FROM fin_entities)").fetch_one(db).await? == 1)
}

/// The latest rate on or before `date`. The euro is 1.
pub async fn rate_on(db: &Db, currency: &str, date: &str) -> Result<Rate> {
    let mut conn = db.acquire().await?;
    rate_on_in(&mut conn, currency, date).await
}

/// The latest rate on or before `date`; on a cache miss the ECB feed is fetched once
/// (inside the caller's transaction) and the lookup retried.
pub async fn rate_on_in(conn: &mut Conn, currency: &str, date: &str) -> Result<Rate> {
    let cur = currency::normalise(currency)?;
    let date = super::check_date(date)?;
    if let Some(r) = lookup(conn, &cur, &date).await? {
        return Ok(r);
    }
    fetch_on_demand(conn, &cur, &date).await?;
    lookup(conn, &cur, &date).await?.ok_or_else(|| AppError::InvalidInput(format!("no ECB rate for {cur} on or before {date}")))
}

async fn lookup(conn: &mut Conn, cur: &str, date: &str) -> Result<Option<Rate>> {
    if cur == "EUR" {
        return Ok(Some(Rate { rate: 1.0, date: date.to_string(), source: "ecb".into() }));
    }
    let row: Option<(f64, String, String)> = sqlx::query_as(
        "SELECT rate, date, source FROM fin_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1",
    )
    .bind(cur)
    .bind(date)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(rate, date, source)| Rate { rate, date, source }))
}

/// Translate `amount_minor` of `from` into `to` at the spot rate of `date`. Returns the
/// translated minor units and the rate applied (units of `to` per unit of `from`).
pub async fn translate(db: &Db, amount_minor: i64, from: &str, to: &str, date: &str) -> Result<(i64, f64)> {
    let mut conn = db.acquire().await?;
    translate_in(&mut conn, amount_minor, from, to, date).await
}

pub async fn translate_in(conn: &mut Conn, amount_minor: i64, from: &str, to: &str, date: &str) -> Result<(i64, f64)> {
    let (from, to) = (currency::normalise(from)?, currency::normalise(to)?);
    if from == to {
        return Ok((amount_minor, 1.0));
    }
    let r_from = rate_on_in(conn, &from, date).await?.rate;
    let r_to = rate_on_in(conn, &to, date).await?.rate;
    let rate = r_to / r_from;
    Ok((convert(amount_minor, &from, &to, rate), rate))
}

/// `amount_minor` of `from` at `rate` (units of `to` per unit of `from`), in `to`'s minor units.
pub fn convert(amount_minor: i64, from: &str, to: &str, rate: f64) -> i64 {
    let shift = currency::exponent(to) as i32 - currency::exponent(from) as i32;
    (amount_minor as f64 * rate * 10f64.powi(shift)).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trimmed feed in the ECB's layout, with made-up rates.
    const FIXTURE: &str = "<?xml version='1.0' encoding='UTF-8'?>\n\
<gesmes:Envelope xmlns:gesmes='http://www.gesmes.org/xml/2002-08-01' xmlns='http://www.ecb.int/vocabulary/2002-08-01/eurofxref'>\n\
  <gesmes:subject>Reference rates</gesmes:subject>\n\
  <Cube>\n\
    <Cube time='2026-10-30'>\n\
      <Cube currency='USD' rate='1.1000'/>\n\
      <Cube currency='JPY' rate='160.00'/>\n\
      <Cube currency='GBP' rate='0.8500'/>\n\
    </Cube>\n\
    <Cube time=\"2026-10-28\">\n\
      <Cube currency=\"USD\" rate=\"1.0500\"/>\n\
      <Cube currency='XXX' rate='nope'/>\n\
    </Cube>\n\
  </Cube>\n\
</gesmes:Envelope>";

    async fn test_db(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("ganban_fin_rates_{}_{}.db", std::process::id(), tag));
        for ext in ["db", "db-wal", "db-shm"] {
            let _ = std::fs::remove_file(path.with_extension(ext));
        }
        crate::init_db(&path).await.unwrap()
    }

    #[test]
    fn parses_the_ecb_layout() {
        let rows = parse_ecb_xml(FIXTURE);
        assert_eq!(
            rows,
            vec![
                ("2026-10-30".into(), "USD".into(), 1.1),
                ("2026-10-30".into(), "JPY".into(), 160.0),
                ("2026-10-30".into(), "GBP".into(), 0.85),
                ("2026-10-28".into(), "USD".into(), 1.05),
            ]
        );
    }

    /// A fetcher serving the fixture, counting its calls and the URLs asked for.
    fn fixture_fetcher(calls: Arc<Mutex<Vec<&'static str>>>, ok: bool) -> Fetcher {
        Arc::new(move |url| {
            calls.lock().unwrap().push(url);
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(20)).await; // let a second caller queue up
                if ok { Ok(FIXTURE.to_string()) } else { Err("offline".into()) }
            })
        })
    }

    #[tokio::test]
    async fn a_cache_miss_fetches_once_then_translates() {
        let db = test_db("on_demand").await;
        let calls = Arc::new(Mutex::new(Vec::new()));
        with_fetcher(fixture_fetcher(calls.clone(), true), async {
            // Two translations at once on an empty cache: one fetch, of the full history.
            let (a, b) = tokio::join!(
                translate(&db, 11_000, "USD", "EUR", "2026-10-30"),
                translate(&db, 8_500, "GBP", "EUR", "2026-10-31"),
            );
            assert_eq!((a.unwrap().0, b.unwrap().0), (10_000, 10_000));
            assert_eq!(*calls.lock().unwrap(), vec![ECB_HIST_URL]);
            // A currency the feed lacks: reused from memory, not fetched again, then refused.
            let err = translate(&db, 100, "CHF", "EUR", "2020-01-01").await.unwrap_err();
            assert_eq!(err.to_string(), "Invalid input: no ECB rate for CHF on or before 2020-01-01");
            assert_eq!(calls.lock().unwrap().len(), 1);
        })
        .await;
    }

    #[tokio::test]
    async fn an_unreachable_feed_says_so() {
        let db = test_db("unreachable").await;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let err = with_fetcher(fixture_fetcher(calls.clone(), false), translate(&db, 100, "GBP", "EUR", "2026-11-02")).await.unwrap_err();
        assert_eq!(err.to_string(), "Invalid input: no exchange rate for GBP on 2026-11-02: the ECB feed couldn't be reached");
        assert_eq!(calls.lock().unwrap().len(), 1);
        // No fetcher at all (a test, or a host before it registered one): the same answer.
        assert!(translate(&db, 100, "GBP", "EUR", "2026-11-02").await.unwrap_err().to_string().contains("couldn't be reached"));
    }

    #[test]
    fn converts_across_exponents() {
        // 10.00 USD at 0.5 EUR/USD = 5.00 EUR; 1000 JPY at 0.01 EUR/JPY = 10.00 EUR.
        assert_eq!(convert(1000, "USD", "EUR", 0.5), 500);
        assert_eq!(convert(1000, "JPY", "EUR", 0.01), 1000);
        assert_eq!(convert(1000, "EUR", "JPY", 100.0), 1_000);
    }

    #[tokio::test]
    async fn translates_at_the_latest_rate_on_or_before_the_date() {
        let db = test_db("translate").await;
        assert_eq!(feed_url(&db).await.unwrap(), ECB_HIST_URL, "empty cache → full history");
        store_rates(&db, &parse_ecb_xml(FIXTURE), "ecb").await.unwrap();
        assert_eq!(feed_url(&db).await.unwrap(), ECB_90D_URL);

        // A weekend day uses the Friday before; the day itself uses its own rate.
        let r = rate_on(&db, "usd", "2026-10-29").await.unwrap();
        assert_eq!((r.rate, r.date.as_str()), (1.05, "2026-10-28"));
        assert_eq!(rate_on(&db, "USD", "2026-11-01").await.unwrap().rate, 1.1);
        assert!(rate_on(&db, "USD", "2026-10-01").await.unwrap_err().is_invalid_input(), "nothing before");
        assert_eq!(rate_on(&db, "EUR", "2000-01-01").await.unwrap().rate, 1.0);

        // 110.00 USD on 2026-10-30 = 100.00 EUR; and back.
        assert_eq!(translate(&db, 11_000, "USD", "EUR", "2026-10-30").await.unwrap().0, 10_000);
        assert_eq!(translate(&db, 10_000, "EUR", "USD", "2026-10-30").await.unwrap().0, 11_000);
        // A cross rate: 85.00 GBP = 100.00 EUR = 110.00 USD.
        let (usd, rate) = translate(&db, 8_500, "GBP", "USD", "2026-10-30").await.unwrap();
        assert_eq!(usd, 11_000);
        assert!((rate - 1.1 / 0.85).abs() < 1e-12);
        assert_eq!(translate(&db, 123, "EUR", "EUR", "2026-10-30").await.unwrap(), (123, 1.0));
    }
}
