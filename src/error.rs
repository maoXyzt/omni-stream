use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid range: {0}")]
    InvalidRange(String),

    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error(transparent)]
    Io(#[from] io::Error),

    #[error("storage backend error: {0}")]
    Backend(String),

    #[error("unsupported operation: {0}")]
    Unsupported(String),
}
