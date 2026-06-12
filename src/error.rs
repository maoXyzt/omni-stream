use std::io;

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
  #[error("not found: {0}")]
  NotFound(String),

  #[error("forbidden: {0}")]
  Forbidden(String),

  #[error("invalid range: {0}")]
  InvalidRange(String),

  #[error("invalid path: {0}")]
  InvalidPath(String),

  #[error(transparent)]
  Io(#[from] io::Error),

  #[error("storage backend error: {0}")]
  Backend(String),

  /// Returned when a request targets a storage that exists in config but
  /// failed to initialize at startup. Distinct from `Backend` because it's
  /// a deterministic config-time failure (retrying won't help) rather than
  /// a transient backend error; 503 + a clear message lets the UI mark the
  /// storage as invalid and the operator know to fix the config.
  #[error("storage unavailable: {0}")]
  StorageInvalid(String),

  #[error("unsupported operation: {0}")]
  Unsupported(String),

  /// DuckDB-side failure (parser / binder / runtime). The engine message is
  /// passed through verbatim so the SQL editor shows actionable diagnostics.
  #[cfg(feature = "duckdb")]
  #[error("query error: {0}")]
  Query(String),

  /// SQL rejected by the read-only validator before reaching DuckDB.
  #[cfg(feature = "duckdb")]
  #[error("query rejected: {0}")]
  QueryRejected(String),

  /// Convert target already exists and overwrite wasn't requested (the
  /// JSONL→Parquet `/api/convert` endpoint). 409 so the SPA can offer to
  /// overwrite. duckdb-gated like the other SQL-path variants.
  #[cfg(feature = "duckdb")]
  #[error("conflict: {0}")]
  Conflict(String),

  #[cfg(feature = "duckdb")]
  #[error("query timed out after {0}s")]
  QueryTimeout(u64),

  /// Internal sentinel: raw DuckDB error from a sandboxed blocking task,
  /// before classification.  Never reaches the client directly — handlers
  /// convert it into `ConvertFailed` or `QueryDiagnosed`.
  #[cfg(feature = "duckdb")]
  #[error("duckdb: {0}")]
  DuckDbRaw(String),

  /// JSONL/CSV→Parquet conversion failed with a classified diagnosis.
  /// `summary` replaces the old misleading "read-only" prefix; `hint`
  /// gives actionable troubleshooting guidance; `raw` preserves the
  /// verbatim DuckDB error for power users / support.  HTTP 500.
  #[cfg(feature = "duckdb")]
  #[error("{summary}")]
  ConvertFailed {
    summary: String,
    hint: String,
    raw: String,
  },

  /// SQL query hit a recognisable infrastructure problem (S3 fallback,
  /// permission, extension load, …).  `message` is the verbatim DuckDB
  /// text (still useful for SQL errors); `hint` gives a troubleshooting
  /// pointer.  HTTP 400, same as `Query`.
  #[cfg(feature = "duckdb")]
  #[error("{message}")]
  QueryDiagnosed { message: String, hint: String },
}

impl AppError {
  fn status(&self) -> StatusCode {
    match self {
      AppError::NotFound(_) => StatusCode::NOT_FOUND,
      AppError::Forbidden(_) => StatusCode::FORBIDDEN,
      AppError::InvalidRange(_) => StatusCode::RANGE_NOT_SATISFIABLE,
      AppError::InvalidPath(_) | AppError::Unsupported(_) => StatusCode::BAD_REQUEST,
      AppError::Io(e) if e.kind() == io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
      AppError::StorageInvalid(_) => StatusCode::SERVICE_UNAVAILABLE,
      AppError::Io(_) | AppError::Backend(_) => StatusCode::INTERNAL_SERVER_ERROR,
      #[cfg(feature = "duckdb")]
      AppError::Query(_) | AppError::QueryRejected(_) => StatusCode::BAD_REQUEST,
      #[cfg(feature = "duckdb")]
      AppError::Conflict(_) => StatusCode::CONFLICT,
      #[cfg(feature = "duckdb")]
      AppError::QueryTimeout(_) => StatusCode::REQUEST_TIMEOUT,
      #[cfg(feature = "duckdb")]
      AppError::DuckDbRaw(_) => StatusCode::INTERNAL_SERVER_ERROR,
      #[cfg(feature = "duckdb")]
      AppError::ConvertFailed { .. } => StatusCode::INTERNAL_SERVER_ERROR,
      #[cfg(feature = "duckdb")]
      AppError::QueryDiagnosed { .. } => StatusCode::BAD_REQUEST,
    }
  }
}

impl IntoResponse for AppError {
  fn into_response(self) -> Response {
    let status = self.status();

    // Structured variants: emit extra fields so the SPA can render a rich
    // error dialog.  All other errors keep the plain {error, message} shape
    // so existing consumers are unaffected.
    #[cfg(feature = "duckdb")]
    if let AppError::ConvertFailed {
      ref summary,
      ref hint,
      ref raw,
    } = self
    {
      let body = Json(json!({
          "error":   status.canonical_reason().unwrap_or("error"),
          "message": summary,
          "hint":    hint,
          "raw":     raw,
      }));
      return (status, body).into_response();
    }

    #[cfg(feature = "duckdb")]
    if let AppError::QueryDiagnosed {
      ref message,
      ref hint,
    } = self
    {
      let body = Json(json!({
          "error":   status.canonical_reason().unwrap_or("error"),
          "message": message,
          "hint":    hint,
      }));
      return (status, body).into_response();
    }

    let body = Json(json!({
        "error":   status.canonical_reason().unwrap_or("error"),
        "message": self.to_string(),
    }));
    (status, body).into_response()
  }
}
