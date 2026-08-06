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

  /// The storage accepted directory listing but denied reading an object's
  /// metadata or bytes. Kept distinct from generic `Forbidden` so clients can
  /// show an actionable read-permission hint without parsing backend text.
  #[error("object read forbidden: {0}")]
  ObjectReadForbidden(String),

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

  /// A write target already exists and overwrite wasn't requested. 409 so the
  /// SPA can offer to overwrite. Used by the file write API (`PUT /api/files`,
  /// `POST /api/move`) and the JSONL→Parquet `/api/convert` endpoint. Not
  /// duckdb-gated: the file write routes exist in every build.
  #[error("conflict: {0}")]
  Conflict(String),

  /// DuckDB-side failure (parser / binder / runtime). The engine message is
  /// passed through verbatim so the SQL editor shows actionable diagnostics.
  #[cfg(feature = "duckdb")]
  #[error("query error: {0}")]
  Query(String),

  /// SQL rejected by the read-only validator before reaching DuckDB.
  #[cfg(feature = "duckdb")]
  #[error("query rejected: {0}")]
  QueryRejected(String),

  #[cfg(feature = "duckdb")]
  #[error("query timed out after {0}s")]
  QueryTimeout(u64),

  /// Internal sentinel: raw DuckDB error from a sandboxed blocking task,
  /// before classification.  Never reaches the client directly — handlers
  /// convert it into `ConvertFailed` or `QueryDiagnosed`.
  #[cfg(feature = "duckdb")]
  #[error("duckdb: {0}")]
  DuckDbRaw(String),

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
      AppError::Forbidden(_) | AppError::ObjectReadForbidden(_) => StatusCode::FORBIDDEN,
      AppError::InvalidRange(_) => StatusCode::RANGE_NOT_SATISFIABLE,
      AppError::InvalidPath(_) | AppError::Unsupported(_) => StatusCode::BAD_REQUEST,
      AppError::Io(e) if e.kind() == io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
      AppError::StorageInvalid(_) => StatusCode::SERVICE_UNAVAILABLE,
      AppError::Io(_) | AppError::Backend(_) => StatusCode::INTERNAL_SERVER_ERROR,
      AppError::Conflict(_) => StatusCode::CONFLICT,
      #[cfg(feature = "duckdb")]
      AppError::Query(_) | AppError::QueryRejected(_) => StatusCode::BAD_REQUEST,
      #[cfg(feature = "duckdb")]
      AppError::QueryTimeout(_) => StatusCode::REQUEST_TIMEOUT,
      #[cfg(feature = "duckdb")]
      AppError::DuckDbRaw(_) => StatusCode::INTERNAL_SERVER_ERROR,
      #[cfg(feature = "duckdb")]
      AppError::QueryDiagnosed { .. } => StatusCode::BAD_REQUEST,
    }
  }
}

impl IntoResponse for AppError {
  fn into_response(self) -> Response {
    let status = self.status();

    if let AppError::ObjectReadForbidden(ref message) = self {
      let body = Json(json!({
          "error":   status.canonical_reason().unwrap_or("error"),
          "code":    "OBJECT_READ_FORBIDDEN",
          "message": message,
          "hint":    "Check s3:GetObject for the object (and kms:Decrypt for SSE-KMS); s3:ListBucket only permits listing object names.",
      }));
      return (status, body).into_response();
    }

    // Structured variants: emit extra fields so the SPA can render a rich
    // error dialog.  All other errors keep the plain {error, message} shape
    // so existing consumers are unaffected.
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

#[cfg(test)]
mod tests {
  use axum::body::to_bytes;

  use super::*;

  #[tokio::test]
  async fn object_read_forbidden_has_stable_code_and_hint() {
    let response = AppError::ObjectReadForbidden("S3 head denied".into()).into_response();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let body = to_bytes(response.into_body(), usize::MAX)
      .await
      .expect("read error response body");
    let body: serde_json::Value = serde_json::from_slice(&body).expect("parse error response body");
    assert_eq!(body["code"], "OBJECT_READ_FORBIDDEN");
    assert_eq!(body["message"], "S3 head denied");
    assert!(
      body["hint"]
        .as_str()
        .is_some_and(|hint| { hint.contains("s3:GetObject") && hint.contains("s3:ListBucket") })
    );
  }
}
