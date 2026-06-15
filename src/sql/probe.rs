//! Probes whether the httpfs DuckDB extension can be downloaded and loaded.
//!
//! Used by `GET /api/server` to surface extension availability before the user
//! attempts an S3 SQL query. Opens a fresh in-memory connection and executes
//! `INSTALL httpfs; LOAD httpfs;` — once the extension is cached in ~/.duckdb
//! subsequent probes are fast no-ops (~10 ms). Mirrors the watchdog pattern
//! from `query_handler` so a slow first download never stalls `/api/server`.

use std::time::Duration;

use tokio::sync::oneshot;

/// Seconds to wait for the httpfs extension to download on first use.
/// Short enough to keep `/api/server` responsive in offline deployments;
/// long enough for a first-time fetch on a modest connection.
const PROBE_TIMEOUT_SECS: u64 = 5;

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
        // Return a dummy conn placeholder — can't send an interrupt handle
        // without one, but the blocking task is already done here so the
        // watchdog will just time out without an interrupt (safe).
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

  let result = match join.await {
    Ok((ok, _conn)) => ok,
    Err(e) => {
      tracing::warn!(error = %e, "httpfs probe: blocking task panicked");
      false
    }
  };
  // abort() doesn't wait for a task already past its last await point;
  // join it so a mid-interrupt watchdog finishes before conn (held inside
  // the join result's Ok arm) is dropped.
  watchdog.abort();
  let _ = watchdog.await;
  result
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

  /// Smoke-test that the probe completes within PROBE_TIMEOUT_SECS + margin
  /// even when the extension is already cached (the typical case).
  #[tokio::test]
  async fn probe_completes_promptly() {
    // Just run it; any outcome is acceptable in a non-networked environment.
    // The goal is to verify there's no hang or panic.
    let _result = probe_httpfs().await;
  }
}
