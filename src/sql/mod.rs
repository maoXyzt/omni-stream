//! Optional DuckDB-backed `/api/query` endpoint (cargo feature `duckdb`).
//!
//! Pipeline per request: validate the SQL is read-mostly (`validate`), build
//! a fresh in-memory connection sandboxed to the selected storage
//! (`session`), execute with a row cap and wall-clock interrupt (`exec`).
//! A fresh connection per request keeps secrets and sandbox settings from
//! leaking across storages; setup cost is milliseconds once the httpfs
//! extension is cached on disk.

pub mod exec;
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
  targets: HashMap<String, SqlTarget>,
  default_name: String,
}

impl SqlState {
  pub fn from_config(cfg: &Config) -> Self {
    let mut targets = HashMap::new();
    for s in &cfg.storages {
      let target = match (s.r#type, &s.s3, &s.local) {
        (StorageType::S3, Some(s3), _) => SqlTarget::S3(s3.clone()),
        (StorageType::Local, _, Some(local)) => SqlTarget::Local {
          root_path: local.root_path.clone(),
        },
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
      cfg: cfg.sql.clone(),
      targets,
      default_name,
    }
  }

  fn resolve(&self, name: Option<&str>) -> Result<&SqlTarget, AppError> {
    let name = name.unwrap_or(&self.default_name);
    self
      .targets
      .get(name)
      .ok_or_else(|| AppError::NotFound(format!("unknown storage: {name}")))
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
  let setup = session::setup_statements(&sql_state.cfg, target)?;

  let timeout_secs = sql_state.cfg.query_timeout_secs;
  let max_rows = sql_state.cfg.max_rows as usize;
  let user_sql = req.sql.clone();
  let start = Instant::now();

  // The blocking task sends its interrupt handle back as soon as the
  // connection exists; the watchdog fires it when the wall clock expires,
  // which makes the running query fail fast with an interrupt error.
  let (tx, rx) = tokio::sync::oneshot::channel();
  let join = tokio::task::spawn_blocking(move || {
    let conn = duckdb::Connection::open_in_memory()
      .map_err(|e| AppError::Backend(format!("open duckdb: {e}")))?;
    let _ = tx.send(conn.interrupt_handle());
    conn
      .execute_batch(&setup)
      .map_err(|e| AppError::Backend(format!("sql session setup: {e}")))?;
    exec::run_query(&conn, &user_sql, max_rows)
  });
  let watchdog = tokio::spawn(async move {
    if let Ok(handle) = rx.await {
      tokio::time::sleep(Duration::from_secs(timeout_secs)).await;
      handle.interrupt();
    }
  });
  let result = join
    .await
    .map_err(|e| AppError::Backend(format!("query task failed: {e}")))?;
  watchdog.abort();

  let elapsed = start.elapsed();
  let (columns, rows, truncated) = match result {
    Ok(ok) => ok,
    // An interrupted query surfaces as a generic engine error; when the wall
    // clock says we fired the interrupt, report it as a timeout instead.
    Err(AppError::Query(_)) if elapsed >= Duration::from_secs(timeout_secs) => {
      return Err(AppError::QueryTimeout(timeout_secs));
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
