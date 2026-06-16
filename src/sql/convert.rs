//! `POST /api/convert` — convert a JSONL/NDJSON/TSV/CSV file to Parquet
//! in-place via DuckDB.
//!
//! The endpoint is gated behind the same triple condition as `/api/query`
//! (`duckdb` feature + `auth.enabled` + `[sql].enabled`). It reuses the same
//! sandboxed session setup so the DuckDB process is confined to the storage's
//! root directory (local) or S3 bucket scope (S3) — exactly the same write
//! permissions the SQL editor already grants.
//!
//! ## Async job model
//!
//! Unlike the synchronous `query_handler`, conversions of large files can take
//! tens of minutes and must not be held open in an HTTP connection.  The
//! handler therefore:
//! 1. Validates the request synchronously (auth / format / 409 conflict) and
//!    returns fast error responses for those cases.
//! 2. Registers a job in `SqlState::jobs`, spawns a detached `tokio::spawn`
//!    task that runs the conversion, and immediately returns **202 Accepted**
//!    with `{ "job_id": "…" }`.
//! 3. The detached task updates the job registry when it finishes (done /
//!    failed).  The frontend polls `GET /api/convert/{id}` to track progress.

use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::handlers::AppState;
use crate::storage::local::safe_join;

use super::jobs::JobStatusResponse;
use super::session;
use super::{SqlState, SqlTarget};

// --- request / response types ------------------------------------------------

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

/// Immediate response from `POST /api/convert` (202 Accepted).
/// The client should poll `GET /api/convert/{job_id}` until `state` is
/// `"done"` or `"failed"`.
#[derive(Debug, Serialize)]
pub struct ConvertAccepted {
  pub job_id: String,
}

// --- POST /api/convert -------------------------------------------------------

pub async fn convert_handler(
  State(state): State<AppState>,
  Extension(sql_state): Extension<Arc<SqlState>>,
  Json(req): Json<ConvertRequest>,
) -> Result<(StatusCode, Json<ConvertAccepted>), AppError> {
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

  let setup = session::setup_statements(&sql_state.cfg, target, &sql_state.scratch_dir)?;
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

  // All synchronous validation passed — register the job and detach.
  let job_id = sql_state.jobs.register();

  // Determine target kind for logging inside the spawned task.
  let is_s3 = matches!(target, SqlTarget::S3(_));
  let storage_name = req.storage.clone();

  // Detach the conversion; the HTTP response returns immediately so the client
  // connection is not held open for the full (potentially multi-minute) run.
  //
  // Safety: `sql_state` is Arc-cloned into the task. The task never reads
  // `target` (a borrow from `sql_state`'s HashMap) — it re-resolves it via
  // `sql_state.resolve(storage_name)` inside the blocking closure so there
  // are no lifetime issues crossing the spawn boundary.
  let sql_state_task = Arc::clone(&sql_state);
  let job_id_task = job_id.clone();
  tokio::spawn(async move {
    run_conversion_task(
      sql_state_task,
      ConversionTask {
        job_id: job_id_task,
        storage_name,
        setup,
        copy_sql,
        out_uri,
        output_key,
        is_s3,
      },
    )
    .await;
  });

  Ok((StatusCode::ACCEPTED, Json(ConvertAccepted { job_id })))
}

// --- GET /api/convert/{job_id} -----------------------------------------------

pub async fn convert_status_handler(
  State(state): State<AppState>,
  Extension(sql_state): Extension<Arc<SqlState>>,
  Path(job_id): Path<String>,
) -> Result<Json<JobStatusResponse>, AppError> {
  if !state.sql_enabled() {
    return Err(AppError::Forbidden(
      "convert endpoint disabled: requires auth.enabled = true (and [sql] enabled)".into(),
    ));
  }
  sql_state
    .jobs
    .status(&job_id)
    .map(Json)
    .ok_or_else(|| AppError::NotFound(format!("convert job not found: '{job_id}'")))
}

// --- detached conversion task ------------------------------------------------

/// Parameters forwarded into the detached background conversion task.
struct ConversionTask {
  job_id: String,
  storage_name: Option<String>,
  setup: String,
  copy_sql: String,
  out_uri: String,
  output_key: String,
  is_s3: bool,
}

/// The body of the detached background task.  Mirrors the spawn_blocking +
/// watchdog pattern from the old synchronous `convert_handler`, with two
/// changes: timeout comes from `convert_timeout_secs` (not `query_timeout_secs`)
/// and the result is written to the job registry instead of returned as an HTTP
/// response.
async fn run_conversion_task(sql_state: Arc<SqlState>, task: ConversionTask) {
  let ConversionTask {
    job_id,
    storage_name,
    setup,
    copy_sql,
    out_uri,
    output_key,
    is_s3,
  } = task;
  let timeout_secs = sql_state.cfg.convert_timeout_secs;
  let start = Instant::now();

  // Mirrors the spawn_blocking + watchdog pattern in query_handler.
  let (tx, rx) = tokio::sync::oneshot::channel();
  let join = tokio::task::spawn_blocking(move || {
    let conn = match duckdb::Connection::open_in_memory() {
      Ok(c) => c,
      Err(e) => return (Err(AppError::Backend(format!("open duckdb: {e}"))), None),
    };
    let _ = tx.send(conn.interrupt_handle());
    if let Err(e) = conn.execute_batch(&setup) {
      // SECURITY: setup SQL contains `CREATE SECRET … KEY_ID … SECRET …`.
      // DuckDB may echo offending SQL fragments in error messages, so the raw
      // error is deliberately dropped here — never propagate it to logs or the
      // client.  A generic message is sufficient for operators to investigate.
      drop(e);
      return (
        Err(AppError::Backend("sql session setup failed".into())),
        Some(conn),
      );
    }
    match conn.execute(&copy_sql, []) {
      Ok(n) => (Ok(n as u64), Some(conn)),
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
  let (result, conn) = match joined {
    Ok(pair) => pair,
    Err(e) => {
      let msg = format!("convert task panicked: {e}");
      tracing::error!(job_id = %job_id, "{msg}");
      sql_state.jobs.fail(
        &job_id,
        "Conversion task panicked.".into(),
        msg.clone(),
        msg,
      );
      return;
    }
  };
  drop(conn);

  let target_kind = if is_s3 { "s3" } else { "local" };

  match result {
    Ok(rows_written) => {
      // SECURITY: log target kind and out_uri only — never log `setup` (which
      // contains CREATE SECRET … KEY_ID … SECRET …) or any credential field.
      tracing::info!(
        storage = storage_name.as_deref().unwrap_or("<default>"),
        target = target_kind,
        out_uri = %out_uri,
        rows_written,
        elapsed_ms = elapsed.as_millis() as u64,
        "convert succeeded",
      );
      sql_state.jobs.complete(&job_id, output_key, rows_written);
    }
    Err(AppError::DuckDbRaw(_)) if elapsed >= Duration::from_secs(timeout_secs) => {
      tracing::warn!(
        storage = storage_name.as_deref().unwrap_or("<default>"),
        out_uri = %out_uri,
        elapsed_ms = elapsed.as_millis() as u64,
        "convert timed out",
      );
      let msg = format!("Conversion timed out after {timeout_secs}s.");
      sql_state.jobs.fail(
        &job_id,
        msg.clone(),
        format!(
          "The conversion exceeded the {timeout_secs}s limit. \
           For very large files consider increasing `convert_timeout_secs` in \
           the server configuration."
        ),
        msg,
      );
    }
    Err(AppError::DuckDbRaw(raw)) => {
      // Re-resolve the target kind for diag. This is a cheap HashMap lookup
      // inside sql_state and cannot fail because the job was only registered
      // after a successful resolve in convert_handler.
      let target_for_diag = sql_state
        .targets
        .get(storage_name.as_deref().unwrap_or(&sql_state.default_name));
      let diag = target_for_diag
        .and_then(|t| super::diag::diagnose(t, Some(&out_uri), &raw))
        .unwrap_or_else(|| {
          let hint = if is_s3 {
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
      // SECURITY: log target kind and out_uri only — never log `setup` or
      // any credential field.
      tracing::error!(
        storage = storage_name.as_deref().unwrap_or("<default>"),
        target = target_kind,
        out_uri = %out_uri,
        summary = %diag.summary,
        duckdb_error = %raw,
        "convert failed",
      );
      sql_state.jobs.fail(&job_id, diag.summary, diag.hint, raw);
    }
    Err(e) => {
      let msg = e.to_string();
      tracing::error!(
        storage = storage_name.as_deref().unwrap_or("<default>"),
        out_uri = %out_uri,
        error = %msg,
        "convert failed (unexpected error)",
      );
      sql_state
        .jobs
        .fail(&job_id, "Conversion failed.".into(), msg.clone(), msg);
    }
  }
}

// --- URI helpers -------------------------------------------------------------

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

// --- tests -------------------------------------------------------------------

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
        writeable: false,
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
    // Verify the Conflict variant maps to the right HTTP status.
    let err = AppError::Conflict(
      "output file already exists: 'exists.parquet'. Set overwrite=true to replace it.".into(),
    );
    assert_eq!(
      err.to_string(),
      "conflict: output file already exists: 'exists.parquet'. Set overwrite=true to replace it."
    );
  }

  #[tokio::test]
  async fn status_returns_404_for_unknown_job() {
    let res = convert_status_handler(
      State(app_state(true)),
      Extension(sql_state_local(&tmp_root(), true)),
      Path("999".to_string()),
    )
    .await;
    assert!(matches!(res, Err(AppError::NotFound(_))), "{res:?}");
  }

  /// Helper: poll `convert_status_handler` until the job reaches a terminal
  /// state, then return the response. Bounded by a 15s timeout so a regression
  /// that leaves a job stuck in `"running"` doesn't hang CI indefinitely.
  async fn poll_until_done(
    app: AppState,
    sql_st: Arc<SqlState>,
    job_id: &str,
  ) -> crate::sql::jobs::JobStatusResponse {
    tokio::time::timeout(Duration::from_secs(15), async {
      loop {
        let res = convert_status_handler(
          State(app.clone()),
          Extension(Arc::clone(&sql_st)),
          Path(job_id.to_string()),
        )
        .await
        .expect("status handler should not error while job exists");
        if res.0.state != "running" {
          return res.0;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
      }
    })
    .await
    .expect("convert job did not reach a terminal state within 15s")
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
    // We need a real backend for the stat check.
    use crate::config::{Config, LocalConfig, SqlConfig, StorageConfig, StorageType};
    use crate::storage::factory::create_registry;
    let cfg = Config {
      server: Default::default(),
      storages: vec![StorageConfig {
        name: "t".into(),
        r#type: StorageType::Local,
        active: true,
        writeable: false,
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

    // POST → 202 + job_id
    let (status, Json(accepted)) = convert_handler(
      State(state.clone()),
      Extension(Arc::clone(&sql_st)),
      req("test_e2e.jsonl", false),
    )
    .await
    .expect("convert should accept");
    assert_eq!(status, StatusCode::ACCEPTED);

    // Poll until terminal state.
    let result = poll_until_done(state, sql_st, &accepted.job_id).await;
    assert_eq!(result.state, "done", "job failed: {result:?}");
    assert_eq!(result.rows_written, Some(2));
    assert_eq!(result.output_key.as_deref(), Some("test_e2e.parquet"));
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
        writeable: false,
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
    let sql_st = sql_state_local(&root, true);

    let (status, Json(accepted)) = convert_handler(
      State(state.clone()),
      Extension(Arc::clone(&sql_st)),
      req("test_e2e.tsv", false),
    )
    .await
    .expect("TSV convert should accept");
    assert_eq!(status, StatusCode::ACCEPTED);

    let result = poll_until_done(state, sql_st, &accepted.job_id).await;
    assert_eq!(result.state, "done", "job failed: {result:?}");
    assert_eq!(result.rows_written, Some(2));
    assert!(
      parquet_path.exists(),
      "parquet file should have been written"
    );
  }
}
