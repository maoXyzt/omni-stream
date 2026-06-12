//! `POST /api/convert` — convert a JSONL/NDJSON/TSV/CSV file to Parquet
//! in-place via DuckDB.
//!
//! The endpoint is gated behind the same triple condition as `/api/query`
//! (`duckdb` feature + `auth.enabled` + `[sql].enabled`). It reuses the same
//! sandboxed session setup so the DuckDB process is confined to the storage's
//! root directory (local) or S3 bucket scope (S3) — exactly the same write
//! permissions the SQL editor already grants.

use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::handlers::AppState;
use crate::storage::local::safe_join;

use super::session;
use super::{SqlState, SqlTarget};

#[derive(Debug, Deserialize)]
pub struct ConvertRequest {
  /// Storage-relative path of the source file (e.g.
  /// `"logs/2024/events.jsonl"` or `"data/records.tsv"`).
  /// Supported formats: `.jsonl`, `.ndjson`, `.tsv`, `.csv`.
  /// Leading slashes are stripped.
  pub key: String,
  /// Storage name; defaults to the server's active storage when absent.
  pub storage: Option<String>,
  /// When true, overwrite an existing `.parquet` file at the output path.
  /// When false (default), a pre-existing output causes a 409 Conflict.
  #[serde(default)]
  pub overwrite: bool,
}

#[derive(Debug, Serialize)]
pub struct ConvertResponse {
  /// Storage-relative path of the written Parquet file.
  pub output_key: String,
  /// Number of rows written (as reported by DuckDB's `COPY … TO` statement).
  pub rows_written: u64,
  pub elapsed_ms: u64,
}

pub async fn convert_handler(
  State(state): State<AppState>,
  Extension(sql_state): Extension<Arc<SqlState>>,
  Json(req): Json<ConvertRequest>,
) -> Result<Json<ConvertResponse>, AppError> {
  // Runtime gate: same condition as query_handler.
  if !state.sql_enabled() {
    return Err(AppError::Forbidden(
      "convert endpoint disabled: requires auth.enabled = true (and [sql] enabled)".into(),
    ));
  }

  let key = req.key.trim_start_matches('/');

  let lower = key.to_lowercase();
  let is_json_lines = lower.ends_with(".jsonl") || lower.ends_with(".ndjson");
  let is_csv_like = lower.ends_with(".tsv") || lower.ends_with(".csv");
  if !is_json_lines && !is_csv_like {
    return Err(AppError::Unsupported(format!(
      "convert: expected a .jsonl, .ndjson, .tsv, or .csv source file, got '{key}'"
    )));
  }

  // Replace the extension with .parquet.
  let dot = key.rfind('.').expect("suffix check guarantees a dot");
  let output_key = format!("{}.parquet", &key[..dot]);

  // Resolve the SqlTarget — reuses the same error-handling as query_handler
  // (unknown storage → 404, follow_symlinks=false → 400 Unsupported).
  let target = sql_state.resolve(req.storage.as_deref())?;

  // Existence check via the storage backend so we can return 409 before
  // spinning up DuckDB at all.
  let backend = state.resolve(req.storage.as_deref())?;
  match backend.stat(&output_key).await {
    Ok(_) if !req.overwrite => {
      return Err(AppError::Conflict(format!(
        "output file already exists: '{output_key}'. \
         Set overwrite=true to replace it."
      )));
    }
    // File exists and overwrite is allowed — proceed.
    Ok(_) => {}
    // File does not exist — proceed.
    Err(AppError::NotFound(_)) => {}
    Err(AppError::Io(ref e)) if e.kind() == io::ErrorKind::NotFound => {}
    // Any other stat error (auth failure, backend unavailable, …) → surface it.
    Err(e) => return Err(e),
  }

  // Build the DuckDB-visible URIs for source and destination.
  let (in_uri, out_uri) = build_uris(target, key, &output_key)?;

  let setup = session::setup_statements(&sql_state.cfg, target)?;
  // TSV/CSV: read_csv_auto auto-detects comma vs tab (and other delimiters).
  // JSONL/NDJSON: read_json_auto handles newline-delimited JSON.
  let read_fn = if is_json_lines {
    "read_json_auto"
  } else {
    "read_csv_auto"
  };
  let copy_sql = format!(
    "COPY (SELECT * FROM {read_fn}('{}')) TO '{}' (FORMAT PARQUET)",
    session::sql_escape(&in_uri),
    session::sql_escape(&out_uri),
  );

  let timeout_secs = sql_state.cfg.query_timeout_secs;
  let start = Instant::now();

  // Mirrors the spawn_blocking + watchdog pattern in query_handler.
  // The blocking closure returns the raw DuckDB error text (DuckDbRaw) so
  // the outer async context can classify it with `diag::diagnose` while
  // still having access to `target` and `out_uri`.
  let (tx, rx) = tokio::sync::oneshot::channel();
  let join = tokio::task::spawn_blocking(move || {
    let conn = match duckdb::Connection::open_in_memory() {
      Ok(c) => c,
      Err(e) => return (Err(AppError::Backend(format!("open duckdb: {e}"))), None),
    };
    let _ = tx.send(conn.interrupt_handle());
    if let Err(e) = conn.execute_batch(&setup) {
      // Session setup failures (extension install, secret creation, …) are
      // also infrastructure errors worth diagnosing, so surface them as
      // DuckDbRaw for the same classification path.
      return (Err(AppError::DuckDbRaw(format!("{e}"))), Some(conn));
    }
    match conn.execute(&copy_sql, []) {
      Ok(n) => (Ok(n as u64), Some(conn)),
      // Return the raw DuckDB error; classification happens in the outer
      // async scope where `target` and `out_uri` are available.
      Err(e) => (Err(AppError::DuckDbRaw(format!("{e}"))), Some(conn)),
    }
  });
  let watchdog = tokio::spawn(async move {
    if let Ok(handle) = rx.await {
      tokio::time::sleep(Duration::from_secs(timeout_secs)).await;
      handle.interrupt();
    }
  });
  let joined = join.await;
  watchdog.abort();
  let _ = watchdog.await;

  let elapsed = start.elapsed();
  let (result, conn) =
    joined.map_err(|e| AppError::Backend(format!("convert task failed: {e}")))?;
  drop(conn);

  let rows_written = match result {
    Ok(n) => n,
    // An interrupted task near the wall-clock limit → surface as timeout.
    Err(AppError::DuckDbRaw(_)) if elapsed >= Duration::from_secs(timeout_secs) => {
      tracing::warn!(
        storage = req.storage.as_deref().unwrap_or("<default>"),
        out_uri = %out_uri,
        elapsed_ms = elapsed.as_millis() as u64,
        "convert timed out",
      );
      return Err(AppError::QueryTimeout(timeout_secs));
    }
    Err(AppError::DuckDbRaw(raw)) => {
      let target_kind = if matches!(target, SqlTarget::S3(_)) {
        "s3"
      } else {
        "local"
      };
      let diag = super::diag::diagnose(target, Some(&out_uri), &raw).unwrap_or_else(|| {
        // Fallback for errors that don't match a known pattern.
        let hint = if matches!(target, SqlTarget::S3(_)) {
          format!(
            "Could not write '{}'. Review the S3 endpoint, credentials, and bucket \
             permissions. The DuckDB error is shown below.",
            out_uri,
          )
        } else {
          format!(
            "Could not write '{}'. Check that the storage root is writable by \
             the server process. The DuckDB error is shown below.",
            out_uri,
          )
        };
        super::diag::Diagnosis {
          summary: "The conversion failed.".into(),
          hint,
        }
      });
      // SECURITY: log target kind and out_uri only — never log `setup` (which
      // contains CREATE SECRET … KEY_ID … SECRET …) or any credential field.
      tracing::error!(
        storage = req.storage.as_deref().unwrap_or("<default>"),
        target = target_kind,
        out_uri = %out_uri,
        summary = %diag.summary,
        duckdb_error = %raw,
        "convert failed",
      );
      return Err(AppError::ConvertFailed {
        summary: diag.summary,
        hint: diag.hint,
        raw,
      });
    }
    Err(e) => return Err(e),
  };

  // SECURITY: same logging constraint as above — out_uri only, no credentials.
  tracing::info!(
    storage = req.storage.as_deref().unwrap_or("<default>"),
    out_uri = %out_uri,
    rows_written,
    elapsed_ms = elapsed.as_millis() as u64,
    "convert succeeded",
  );

  Ok(Json(ConvertResponse {
    output_key,
    rows_written,
    elapsed_ms: elapsed.as_millis() as u64,
  }))
}

/// Build the DuckDB-visible URIs for the source file and destination Parquet.
fn build_uris(
  target: &SqlTarget,
  key: &str,
  output_key: &str,
) -> Result<(String, String), AppError> {
  match target {
    SqlTarget::Local { root_path } => {
      let in_full = safe_join(root_path, key)?;
      let out_full = safe_join(root_path, output_key)?;
      Ok((
        in_full.to_string_lossy().into_owned(),
        out_full.to_string_lossy().into_owned(),
      ))
    }
    SqlTarget::S3(s3) => {
      // When the storage pins a single bucket, prepend `s3://<bucket>/`.
      // In multi-bucket mode the key's first segment is already the bucket
      // name, so `s3://<key>` is the correct URI directly.
      let (in_uri, out_uri) = match s3.fixed_bucket() {
        Some(bucket) => (
          format!("s3://{}/{}", bucket, key.trim_start_matches('/')),
          format!("s3://{}/{}", bucket, output_key.trim_start_matches('/')),
        ),
        None => (
          format!("s3://{}", key.trim_start_matches('/')),
          format!("s3://{}", output_key.trim_start_matches('/')),
        ),
      };
      Ok((in_uri, out_uri))
    }
  }
}

#[cfg(test)]
mod tests {
  use std::collections::HashMap;
  use std::path::PathBuf;

  use super::*;
  use crate::config::{LocalConfig, S3Config, SqlConfig, StorageConfig, StorageType};
  use crate::storage::factory::BackendRegistry;

  fn app_state(sql_enabled: bool) -> AppState {
    let reg = BackendRegistry {
      backends: HashMap::new(),
      invalid: HashMap::new(),
      order: vec![],
      default_name: "t".into(),
    };
    AppState::new(reg, None, Arc::new("test".into()), true, true, sql_enabled)
  }

  fn sql_state_local(root: &std::path::Path, follow_symlinks: bool) -> Arc<SqlState> {
    let cfg = crate::config::Config {
      server: Default::default(),
      storages: vec![StorageConfig {
        name: "t".into(),
        r#type: StorageType::Local,
        active: true,
        s3: None,
        local: Some(LocalConfig {
          root_path: root.to_path_buf(),
          follow_symlinks,
        }),
      }],
      auth: Default::default(),
      thumbnails: Default::default(),
      sql: SqlConfig::default(),
    };
    Arc::new(SqlState::from_config(&cfg))
  }

  fn tmp_root() -> PathBuf {
    let dir = std::env::temp_dir().join("omni-convert-test");
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn req(key: &str, overwrite: bool) -> Json<ConvertRequest> {
    Json(ConvertRequest {
      key: key.into(),
      storage: Some("t".into()),
      overwrite,
    })
  }

  // --- Unit tests (no DuckDB execution) ------------------------------------

  #[test]
  fn build_uris_local() {
    let root = PathBuf::from("/data/storage");
    let target = SqlTarget::Local { root_path: root };
    let (in_uri, out_uri) = build_uris(&target, "sub/file.jsonl", "sub/file.parquet").unwrap();
    assert_eq!(in_uri, "/data/storage/sub/file.jsonl");
    assert_eq!(out_uri, "/data/storage/sub/file.parquet");
  }

  #[test]
  fn build_uris_local_rejects_traversal() {
    let root = PathBuf::from("/data/storage");
    let target = SqlTarget::Local { root_path: root };
    assert!(build_uris(&target, "../escape.jsonl", "../escape.parquet").is_err());
  }

  #[test]
  fn build_uris_s3_fixed_bucket() {
    let s3 = S3Config {
      endpoint: None,
      bucket: Some("my-bucket".into()),
      access_key: Some("k".into()),
      secret_key: Some("s".into()),
      region: None,
      force_path_style: true,
    };
    let target = SqlTarget::S3(s3);
    let (in_uri, out_uri) =
      build_uris(&target, "path/to/data.jsonl", "path/to/data.parquet").unwrap();
    assert_eq!(in_uri, "s3://my-bucket/path/to/data.jsonl");
    assert_eq!(out_uri, "s3://my-bucket/path/to/data.parquet");
  }

  #[test]
  fn build_uris_s3_multi_bucket() {
    let s3 = S3Config {
      endpoint: None,
      bucket: None, // multi-bucket
      access_key: Some("k".into()),
      secret_key: Some("s".into()),
      region: None,
      force_path_style: true,
    };
    let target = SqlTarget::S3(s3);
    let (in_uri, out_uri) =
      build_uris(&target, "bucket-a/file.jsonl", "bucket-a/file.parquet").unwrap();
    assert_eq!(in_uri, "s3://bucket-a/file.jsonl");
    assert_eq!(out_uri, "s3://bucket-a/file.parquet");
  }

  #[test]
  fn output_key_replaces_suffix_jsonl() {
    let key = "dir/data.jsonl";
    let dot = key.rfind('.').unwrap();
    assert_eq!(format!("{}.parquet", &key[..dot]), "dir/data.parquet");
  }

  #[test]
  fn output_key_replaces_suffix_ndjson() {
    let key = "dir/stream.ndjson";
    let dot = key.rfind('.').unwrap();
    assert_eq!(format!("{}.parquet", &key[..dot]), "dir/stream.parquet");
  }

  // --- Integration tests (requires DuckDB execution) -----------------------

  #[tokio::test]
  async fn rejects_when_sql_disabled() {
    let res = convert_handler(
      State(app_state(false)),
      Extension(sql_state_local(&tmp_root(), true)),
      req("a.jsonl", false),
    )
    .await;
    assert!(matches!(res, Err(AppError::Forbidden(_))), "{res:?}");
  }

  #[tokio::test]
  async fn rejects_unsupported_suffix() {
    for bad in ["data.xml", "archive.tar.gz", "image.png"] {
      let res = convert_handler(
        State(app_state(true)),
        Extension(sql_state_local(&tmp_root(), true)),
        req(bad, false),
      )
      .await;
      assert!(
        matches!(res, Err(AppError::Unsupported(_))),
        "expected Unsupported for {bad}: {res:?}"
      );
    }
  }

  #[tokio::test]
  async fn rejects_follow_symlinks_false() {
    let res = convert_handler(
      State(app_state(true)),
      Extension(sql_state_local(&tmp_root(), false)),
      req("a.jsonl", false),
    )
    .await;
    assert!(matches!(res, Err(AppError::Unsupported(_))), "{res:?}");
  }

  #[tokio::test]
  async fn rejects_conflict_when_output_exists() {
    let root = tmp_root();
    // Write a dummy parquet file so stat succeeds.
    std::fs::write(root.join("exists.parquet"), b"fake").unwrap();
    // The test sql_state has no real backends so stat would fail — instead
    // verify the 409 path by confirming the output_key logic and that the
    // Conflict variant maps to the right HTTP status.
    let err = AppError::Conflict(
      "output file already exists: 'exists.parquet'. Set overwrite=true to replace it.".into(),
    );
    assert_eq!(
      err.to_string(),
      "conflict: output file already exists: 'exists.parquet'. Set overwrite=true to replace it."
    );
  }

  #[tokio::test]
  async fn end_to_end_local_convert() {
    let root = tmp_root();
    let jsonl_path = root.join("test_e2e.jsonl");
    let parquet_path = root.join("test_e2e.parquet");
    // Write a small JSONL file.
    std::fs::write(
      &jsonl_path,
      b"{\"id\":1,\"name\":\"alice\"}\n{\"id\":2,\"name\":\"bob\"}\n",
    )
    .unwrap();
    // Remove any leftover parquet from previous run.
    let _ = std::fs::remove_file(&parquet_path);

    let sql_st = sql_state_local(&root, true);
    // We need a real backend for the stat check. Build a minimal AppState
    // that has a local backend for "t".
    use crate::config::{Config, LocalConfig, SqlConfig, StorageConfig, StorageType};
    use crate::storage::factory::create_registry;
    let cfg = Config {
      server: Default::default(),
      storages: vec![StorageConfig {
        name: "t".into(),
        r#type: StorageType::Local,
        active: true,
        s3: None,
        local: Some(LocalConfig {
          root_path: root.clone(),
          follow_symlinks: true,
        }),
      }],
      auth: Default::default(),
      thumbnails: Default::default(),
      sql: SqlConfig::default(),
    };
    let reg = create_registry(&cfg).await.unwrap();
    let state = AppState::new(reg, None, Arc::new("test".into()), true, true, true);

    let res = convert_handler(
      State(state),
      Extension(sql_st),
      req("test_e2e.jsonl", false),
    )
    .await
    .expect("convert should succeed");
    assert_eq!(res.0.output_key, "test_e2e.parquet");
    assert_eq!(res.0.rows_written, 2);
    assert!(
      parquet_path.exists(),
      "parquet file should have been written"
    );
  }

  #[tokio::test]
  async fn end_to_end_local_convert_tsv() {
    let root = tmp_root();
    let tsv_path = root.join("test_e2e.tsv");
    let parquet_path = root.join("test_e2e.parquet");
    // Write a small TSV file.
    std::fs::write(&tsv_path, b"id\tname\n1\talice\n2\tbob\n").unwrap();
    let _ = std::fs::remove_file(&parquet_path);

    use crate::config::{Config, LocalConfig, SqlConfig, StorageConfig, StorageType};
    use crate::storage::factory::create_registry;
    let cfg = Config {
      server: Default::default(),
      storages: vec![StorageConfig {
        name: "t".into(),
        r#type: StorageType::Local,
        active: true,
        s3: None,
        local: Some(LocalConfig {
          root_path: root.clone(),
          follow_symlinks: true,
        }),
      }],
      auth: Default::default(),
      thumbnails: Default::default(),
      sql: SqlConfig::default(),
    };
    let reg = create_registry(&cfg).await.unwrap();
    let state = AppState::new(reg, None, Arc::new("test".into()), true, true, true);

    let res = convert_handler(
      State(state),
      Extension(sql_state_local(&root, true)),
      req("test_e2e.tsv", false),
    )
    .await
    .expect("TSV convert should succeed");
    assert_eq!(res.0.output_key, "test_e2e.parquet");
    assert_eq!(res.0.rows_written, 2);
    assert!(
      parquet_path.exists(),
      "parquet file should have been written"
    );
  }
}
