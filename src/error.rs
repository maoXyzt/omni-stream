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
    }
  }
}

impl IntoResponse for AppError {
  fn into_response(self) -> Response {
    let status = self.status();
    let body = Json(json!({
        "error": status.canonical_reason().unwrap_or("error"),
        "message": self.to_string(),
    }));
    (status, body).into_response()
  }
}
