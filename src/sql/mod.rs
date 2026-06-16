//! Optional DuckDB-backed `/api/query` endpoint (cargo feature `duckdb`).
//!
//! Pipeline per request: validate the SQL is read-mostly (`validate`), build
//! a fresh in-memory connection sandboxed to the selected storage
//! (`session`), execute with a row cap and wall-clock interrupt (`exec`).
//! A fresh connection per request keeps secrets and sandbox settings from
//! leaking across storages; setup cost is milliseconds once the httpfs
//! extension is cached on disk.

pub mod convert;
pub mod diag;
pub mod exec;
pub mod jobs;
pub mod probe;
pub mod session;
pub mod validate;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::config::{Config, S3Config, StorageType};
use crate::error::AppError;
use crate::handlers::AppState;

/// What a query connection is allowed to touch, derived from the storage's
/// config entry. Carries S3 credentials (unlike the public descriptors in
/// `handlers`), so this never gets serialized.
pub enum SqlTarget {
  S3(S3Config),
  Local { root_path: PathBuf },
}

pub struct SqlState {
  pub cfg: crate::config::SqlConfig,
  /// Host-local directory DuckDB may use for spill-to-disk. Created at
  /// server startup (best-effort). Passed to every connection's session
  /// setup so DuckDB can write intermediate data when it exceeds
  /// `memory_limit` — without this, large S3 conversions fail with
  /// "LocalFileSystem has been disabled".
  pub scratch_dir: PathBuf,
  /// In-memory registry of background conversion jobs. `POST /api/convert`
  /// registers a job and returns its id; the detached task updates this when
  /// the conversion finishes. `GET /api/convert/{id}` queries it.
  pub jobs: jobs::JobRegistry,
  targets: HashMap<String, SqlTarget>,
  /// Storages that exist but refuse SQL, with the reason (currently: local
  /// storages with `follow_symlinks = false` — DuckDB's
  /// `allowed_directories` sandbox follows symlinks, so it cannot honour
  /// that storage's "don't traverse links" contract).
  disabled: HashMap<String, String>,
  default_name: String,
}

impl SqlState {
  pub fn from_config(cfg: &Config) -> Self {
    let mut targets = HashMap::new();
    let mut disabled = HashMap::new();
    for s in &cfg.storages {
      let target = match (s.r#type, &s.s3, &s.local) {
        (StorageType::S3, Some(s3), _) => SqlTarget::S3(s3.clone()),
        (StorageType::Local, _, Some(local)) => {
          if !local.follow_symlinks {
            disabled.insert(
              s.name.clone(),
              "storage has follow_symlinks = false, which the SQL sandbox \
               cannot enforce (DuckDB follows symlinks inside the root)"
                .into(),
            );
            continue;
          }
          SqlTarget::Local {
            root_path: local.root_path.clone(),
          }
        }
        // Config validation already rejects a missing sub-table; skip
        // defensively rather than panic.
        _ => continue,
      };
      targets.insert(s.name.clone(), target);
    }
    let default_name = cfg
      .active_storage()
      .map(|s| s.name.clone())
      .unwrap_or_default();
    Self {
      scratch_dir: session::resolve_scratch_dir(cfg.sql.temp_directory.as_deref()),
      cfg: cfg.sql.clone(),
      jobs: jobs::JobRegistry::new(),
      targets,
      disabled,
      default_name,
    }
  }

  fn resolve(&self, name: Option<&str>) -> Result<&SqlTarget, AppError> {
    let name = name.unwrap_or(&self.default_name);
    if let Some(t) = self.targets.get(name) {
      return Ok(t);
    }
    if let Some(reason) = self.disabled.get(name) {
      return Err(AppError::Unsupported(format!(
        "SQL is not available on storage '{name}': {reason}"
      )));
    }
    Err(AppError::NotFound(format!("unknown storage: {name}")))
  }
}

#[derive(Debug, Deserialize)]
pub struct QueryRequest {
  pub sql: String,
  #[serde(default)]
  pub storage: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ColumnInfo {
  pub name: String,
  pub r#type: String,
}

#[derive(Debug, Serialize)]
pub struct QueryResponse {
  pub columns: Vec<ColumnInfo>,
  pub rows: Vec<Vec<serde_json::Value>>,
  pub row_count: usize,
  pub truncated: bool,
  pub elapsed_ms: u64,
}

pub async fn query_handler(
  State(state): State<AppState>,
  Extension(sql_state): Extension<Arc<SqlState>>,
  Json(req): Json<QueryRequest>,
) -> Result<Json<QueryResponse>, AppError> {
  // Runtime gate on top of the compile-time feature: the endpoint only
  // serves when auth is enabled (and [sql].enabled isn't switched off).
  if !state.sql_enabled() {
    return Err(AppError::Forbidden(
      "SQL endpoint disabled: requires auth.enabled = true (and [sql] enabled)".into(),
    ));
  }

  let target = sql_state.resolve(req.storage.as_deref())?;
  validate::validate_readonly(&req.sql)?;
  let setup = session::setup_statements(&sql_state.cfg, target, &sql_state.scratch_dir)?;

  let timeout_secs = sql_state.cfg.query_timeout_secs;
  let max_rows = sql_state.cfg.max_rows as usize;
  let user_sql = req.sql.clone();
  let start = Instant::now();

  // The blocking task sends its interrupt handle back as soon as the
  // connection exists; the watchdog fires it when the wall clock expires,
  // which makes the running query fail fast with an interrupt error.
  //
  // Lifetime discipline: the connection is returned alongside the result —
  // on every path that handed out an interrupt handle — so it outlives the
  // watchdog. duckdb-rs's InterruptHandle nulls itself when the connection
  // closes, but disconnect and that clear() aren't atomic; a watchdog that
  // has already woken could race the drop and interrupt a freed connection.
  // Holding conn here and awaiting the aborted watchdog closes that window.
  let (tx, rx) = tokio::sync::oneshot::channel();
  let join = tokio::task::spawn_blocking(move || {
    let conn = match duckdb::Connection::open_in_memory() {
      Ok(c) => c,
      Err(e) => return (Err(AppError::Backend(format!("open duckdb: {e}"))), None),
    };
    let _ = tx.send(conn.interrupt_handle());
    if let Err(e) = conn.execute_batch(&setup) {
      return (
        Err(AppError::Backend(format!("sql session setup: {e}"))),
        Some(conn),
      );
    }
    (exec::run_query(&conn, &user_sql, max_rows), Some(conn))
  });
  let watchdog = tokio::spawn(async move {
    if let Ok(handle) = rx.await {
      tokio::time::sleep(Duration::from_secs(timeout_secs)).await;
      handle.interrupt();
    }
  });
  let joined = join.await;
  watchdog.abort();
  // abort() doesn't wait for a task already past its last await point;
  // join it so a mid-interrupt watchdog finishes before conn drops.
  let _ = watchdog.await;
  let (result, conn) = joined.map_err(|e| AppError::Backend(format!("query task failed: {e}")))?;
  drop(conn);

  let elapsed = start.elapsed();
  let (columns, rows, truncated) = match result {
    Ok(ok) => ok,
    // An interrupted query surfaces as a generic engine error; when the wall
    // clock says we fired the interrupt, report it as a timeout instead.
    Err(AppError::Query(_)) if elapsed >= Duration::from_secs(timeout_secs) => {
      return Err(AppError::QueryTimeout(timeout_secs));
    }
    Err(AppError::Query(raw)) => {
      // Try to classify the error as a recognisable infrastructure problem
      // (S3 fallback, permission, extension load, …).  For pure SQL syntax /
      // binder errors `diagnose` returns None and we surface the verbatim
      // DuckDB message unchanged — it's actionable on its own.
      if let Some(diag) = diag::diagnose(target, None, &raw) {
        let target_kind = if matches!(target, SqlTarget::S3(_)) {
          "s3"
        } else {
          "local"
        };
        // Truncate SQL in the log to avoid dumping large user queries.
        let sql_preview: String = req.sql.chars().take(200).collect();
        // SECURITY: log target kind and sql preview only — never log `setup`
        // (contains CREATE SECRET … KEY_ID … SECRET …) or any credential.
        tracing::warn!(
          storage = req.storage.as_deref().unwrap_or("<default>"),
          target = target_kind,
          sql = %sql_preview,
          duckdb_error = %raw,
          "query failed (infrastructure error)",
        );
        return Err(AppError::QueryDiagnosed {
          message: raw,
          hint: diag.hint,
        });
      }
      // Not an infrastructure error — return verbatim for the SQL editor.
      return Err(AppError::Query(raw));
    }
    Err(e) => return Err(e),
  };

  Ok(Json(QueryResponse {
    row_count: rows.len(),
    columns,
    rows,
    truncated,
    elapsed_ms: elapsed.as_millis() as u64,
  }))
}

#[cfg(test)]
mod tests {
  use std::collections::HashMap;

  use super::*;
  use crate::config::{LocalConfig, SqlConfig, StorageConfig};
  use crate::storage::factory::BackendRegistry;

  /// AppState with no real backends — query_handler only consults
  /// `sql_enabled()`, never the registry.
  fn app_state(sql_enabled: bool) -> AppState {
    let reg = BackendRegistry {
      backends: HashMap::new(),
      invalid: HashMap::new(),
      order: vec![],
      default_name: "t".into(),
    };
    AppState::new(
      reg,
      None,
      std::sync::Arc::new("test".into()),
      true,
      true,
      sql_enabled,
    )
  }

  fn sql_state(root: &std::path::Path, follow_symlinks: bool) -> Arc<SqlState> {
    let cfg = Config {
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

  fn req(sql: &str) -> Json<QueryRequest> {
    Json(QueryRequest {
      sql: sql.into(),
      storage: Some("t".into()),
    })
  }

  fn tmp_root() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("omni-sql-handler-test");
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[tokio::test]
  async fn rejects_when_sql_disabled() {
    let res = query_handler(
      State(app_state(false)),
      Extension(sql_state(&tmp_root(), true)),
      req("SELECT 1"),
    )
    .await;
    assert!(matches!(res, Err(AppError::Forbidden(_))), "{res:?}");
  }

  #[tokio::test]
  async fn rejects_invalid_sql_before_execution() {
    let res = query_handler(
      State(app_state(true)),
      Extension(sql_state(&tmp_root(), true)),
      req("DROP TABLE t"),
    )
    .await;
    assert!(matches!(res, Err(AppError::QueryRejected(_))), "{res:?}");
  }

  #[tokio::test]
  async fn rejects_copy_statement() {
    // COPY is now explicitly forbidden — validate_readonly rejects it before
    // DuckDB execution.
    let res = query_handler(
      State(app_state(true)),
      Extension(sql_state(&tmp_root(), true)),
      req("COPY (SELECT 1) TO 'out.parquet' (FORMAT PARQUET)"),
    )
    .await;
    assert!(matches!(res, Err(AppError::QueryRejected(_))), "{res:?}");
  }

  #[tokio::test]
  async fn rejects_unknown_storage() {
    let res = query_handler(
      State(app_state(true)),
      Extension(sql_state(&tmp_root(), true)),
      Json(QueryRequest {
        sql: "SELECT 1".into(),
        storage: Some("nope".into()),
      }),
    )
    .await;
    assert!(matches!(res, Err(AppError::NotFound(_))), "{res:?}");
  }

  #[tokio::test]
  async fn rejects_no_follow_symlinks_storage_with_reason() {
    let res = query_handler(
      State(app_state(true)),
      Extension(sql_state(&tmp_root(), false)),
      req("SELECT 1"),
    )
    .await;
    match res {
      Err(AppError::Unsupported(msg)) => {
        assert!(msg.contains("follow_symlinks"), "{msg}");
      }
      other => panic!("expected Unsupported, got {other:?}"),
    }
  }

  #[tokio::test]
  async fn executes_select_end_to_end() {
    let res = query_handler(
      State(app_state(true)),
      Extension(sql_state(&tmp_root(), true)),
      req("SELECT 1 AS a, 'x' AS b"),
    )
    .await
    .expect("query should succeed");
    let body = res.0;
    assert_eq!(body.row_count, 1);
    assert_eq!(body.columns.len(), 2);
    assert_eq!(body.columns[0].name, "a");
    assert!(!body.truncated);
    assert_eq!(body.rows[0][0], serde_json::json!(1));
    assert_eq!(body.rows[0][1], serde_json::json!("x"));
  }

  #[tokio::test]
  async fn select_query_runs_without_auth_token() {
    // Read-only queries require only read permission (the route middleware
    // handles that); no bearer token is needed for SELECT.
    let res = query_handler(
      State(app_state(true)),
      Extension(sql_state(&tmp_root(), true)),
      req("SELECT 1 AS a"),
    )
    .await
    .expect("read-only query should succeed");
    assert_eq!(res.0.row_count, 1);
  }
}
