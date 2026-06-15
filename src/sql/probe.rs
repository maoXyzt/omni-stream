//! Probes whether the httpfs DuckDB extension can be downloaded and loaded.
//!
//! Used by `GET /api/server` to surface extension availability before the user
//! attempts an S3 SQL query. Opens a fresh in-memory connection and executes
//! `INSTALL httpfs; LOAD httpfs;` — once the extension is cached in ~/.duckdb
//! subsequent probes are fast no-ops (~10 ms). Mirrors the watchdog pattern
//! from `query_handler` so a slow first download never stalls `/api/server`.
//!
//! `probe_httpfs_cached` wraps the raw probe with a 30-second in-memory TTL
//! so repeated `/api/server` requests (multi-tab, monitoring) pay only a mutex
//! lock + timestamp check on cache hits.

use std::time::{Duration, Instant};

use tokio::sync::oneshot;

/// Seconds to wait for the httpfs extension to download on first use.
const PROBE_TIMEOUT_SECS: u64 = 5;

/// Cache TTL for the probe result. httpfs availability is effectively static
/// (it doesn't change without a server restart or manual cache eviction), so
/// 30 s is conservative.
const CACHE_TTL_SECS: u64 = 30;

/// Shared cache type stored in `AppState`. Holds the last probe result and
/// the instant it was recorded; `None` means the probe has never run.
pub type ProbeCache = tokio::sync::Mutex<Option<(bool, Instant)>>;

/// Like [`probe_httpfs`], but caches the result for [`CACHE_TTL_SECS`]
/// seconds. On a cache hit only a mutex lock + timestamp check is paid; no
/// DuckDB connection is opened.
pub async fn probe_httpfs_cached(cache: &ProbeCache) -> bool {
  // Fast path: return cached result if still fresh.
  {
    let guard = cache.lock().await;
    if let Some((result, ts)) = *guard
      && ts.elapsed().as_secs() < CACHE_TTL_SECS
    {
      return result;
    }
  }
  // Cache miss or expired — run the real probe then update the cache.
  let result = probe_httpfs().await;
  *cache.lock().await = Some((result, Instant::now()));
  result
}

/// Returns `true` if the `httpfs` DuckDB extension can be installed and
/// loaded, `false` on any error or timeout.
///
/// The probe is intentionally narrow: it opens a fresh in-memory connection
/// without S3 credentials or sandbox settings (`disabled_filesystems`,
/// `lock_configuration`, etc.) — those belong to per-query sessions in
/// `session.rs`. It only validates that the extension binary is reachable.
pub async fn probe_httpfs() -> bool {
  let (tx, rx) = oneshot::channel();
  let join = tokio::task::spawn_blocking(move || {
    let conn = match duckdb::Connection::open_in_memory() {
      Ok(c) => c,
      Err(e) => {
        tracing::warn!(error = %e, "httpfs probe: failed to open in-memory connection");
        // Can't send an interrupt handle without a connection; the watchdog
        // will time out and fire into nothing (safe — rx is dropped here).
        return (false, None::<duckdb::Connection>);
      }
    };
    // Send the interrupt handle before the potentially-blocking INSTALL so
    // the watchdog can cancel a stalled download.
    let _ = tx.send(conn.interrupt_handle());
    let ok = match conn.execute_batch("INSTALL httpfs;\nLOAD httpfs;") {
      Ok(()) => {
        tracing::debug!("httpfs probe: extension available");
        true
      }
      Err(e) => {
        tracing::warn!(error = %e, "httpfs probe: extension unavailable");
        false
      }
    };
    // Return conn alongside the result so it outlives the watchdog abort —
    // same lifetime discipline as query_handler: InterruptHandle::interrupt()
    // and Connection::drop() must not race.
    (ok, Some(conn))
  });

  // Watchdog mirrors query_handler: fires an interrupt if the download
  // takes longer than PROBE_TIMEOUT_SECS.
  let watchdog = tokio::spawn(async move {
    if let Ok(handle) = rx.await {
      tokio::time::sleep(Duration::from_secs(PROBE_TIMEOUT_SECS)).await;
      handle.interrupt();
    }
  });

  // Abort and await the watchdog BEFORE destructuring `joined` so that conn
  // (returned inside the Ok arm) is dropped only after the watchdog has
  // fully exited — prevents the InterruptHandle::interrupt() / Connection::drop()
  // race described in query_handler's inline comment.
  let joined = join.await;
  watchdog.abort();
  let _ = watchdog.await;

  match joined {
    Ok((ok, _conn)) => ok,
    Err(e) => {
      tracing::warn!(error = %e, "httpfs probe: blocking task panicked");
      false
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Requires network access — the httpfs extension is fetched from
  /// extensions.duckdb.org on the first run and cached under ~/.duckdb.
  /// Marked `#[ignore]` so it is skipped in offline CI; run explicitly with
  /// `cargo test --features duckdb -- --ignored probe_httpfs_available`.
  #[ignore = "requires network access to download the httpfs extension"]
  #[tokio::test]
  async fn probe_httpfs_available() {
    assert!(
      probe_httpfs().await,
      "httpfs extension should load successfully"
    );
  }

  /// Smoke-test that the probe completes without hanging or panicking.
  /// Any outcome is acceptable in a non-networked environment.
  #[tokio::test]
  async fn probe_completes_promptly() {
    let _result = probe_httpfs().await;
  }

  /// Cache hit: second call returns the cached value without re-probing.
  #[tokio::test]
  async fn cached_probe_returns_cached_result() {
    let cache = ProbeCache::new(Some((true, Instant::now())));
    // Should return true from cache without touching DuckDB.
    assert!(probe_httpfs_cached(&cache).await);
  }

  /// Cache miss: expired entry triggers a new probe.
  #[tokio::test]
  async fn cached_probe_re_runs_when_expired() {
    // Forge an entry that is clearly past the TTL.
    let old = Instant::now() - Duration::from_secs(CACHE_TTL_SECS + 1);
    let cache = ProbeCache::new(Some((true, old)));
    // The re-probe may succeed or fail depending on environment; just verify
    // it returns without hanging.
    let _result = probe_httpfs_cached(&cache).await;
  }
}
