pub mod factory;
pub mod local;
pub mod s3;

use std::pin::Pin;

use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;
use serde::Serialize;

use crate::error::AppError;

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

#[derive(Debug, Clone, Default)]
pub struct GetOptions {
  pub range: Option<String>,
}

pub struct StorageResponse {
  pub body: ByteStream,
  pub content_length: Option<u64>,
  pub content_type: Option<String>,
  pub etag: Option<String>,
  pub last_modified: Option<String>,
  pub content_range: Option<String>,
  pub is_partial: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileMeta {
  pub path: String,
  pub size: u64,
  pub etag: Option<String>,
  pub content_type: Option<String>,
  pub last_modified: Option<String>,
  pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
  pub key: String,
  pub size: u64,
  pub last_modified: Option<String>,
  pub is_dir: bool,
  /// True when this entry is a filesystem symbolic link. Always `false` for
  /// non-local backends (S3, stub) that have no symlink concept. Orthogonal
  /// to `is_dir`: a symlink pointing at a directory has both set to `true`
  /// when `follow_symlinks` is enabled.
  pub is_symlink: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ListResult {
  pub entries: Vec<FileEntry>,
  pub next_token: Option<String>,
  /// Intermediate page tokens from a `list_files_walking` call —
  /// `walked_tokens[i]` is the token that fetches the (i+1)-th page from
  /// the caller's starting point. Empty for plain `list_files`; shorter
  /// than `skip_pages` when the listing ended before the target page.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub walked_tokens: Vec<String>,
  /// Total page count when the backend can compute it cheaply. Populated by
  /// backends whose `list_files` already does an O(dir) scan and just needs
  /// to count alongside (local fs); left `None` by backends where counting
  /// requires walking the full pagination chain (S3). The frontend renders
  /// `Page X / Y` when present, falls back to `Page X` when `None`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub total_pages: Option<u64>,
}

#[async_trait]
pub trait StorageBackend: Send + Sync {
  async fn get_file(&self, path: &str, opts: GetOptions) -> Result<StorageResponse, AppError>;
  async fn list_files(&self, prefix: &str, token: Option<String>) -> Result<ListResult, AppError>;
  async fn stat(&self, path: &str) -> Result<FileMeta, AppError>;

  /// Walk `skip` pages forward from `token`, returning the resulting page
  /// plus the intermediate `next_token`s in `walked_tokens`. The default
  /// implementation is a naive loop of `list_files` calls — correct for any
  /// backend, but expensive when each `list_files` itself does an O(N) scan
  /// (the local-fs case overrides this with a single scan + slice; S3 keeps
  /// the default because each list is one independent API call anyway).
  async fn list_files_walking(
    &self,
    prefix: &str,
    token: Option<String>,
    skip: u32,
  ) -> Result<ListResult, AppError> {
    let mut walked: Vec<String> = Vec::with_capacity(skip as usize);
    let mut current = token;
    for _ in 0..skip {
      let step = self.list_files(prefix, current).await?;
      match step.next_token {
        Some(t) => {
          walked.push(t.clone());
          current = Some(t);
        }
        None => {
          // EOF before target. Return whatever the last step produced so
          // the caller can snap to the actual end.
          return Ok(ListResult {
            entries: step.entries,
            next_token: None,
            walked_tokens: walked,
            total_pages: step.total_pages,
          });
        }
      }
    }
    let mut result = self.list_files(prefix, current).await?;
    result.walked_tokens = walked;
    Ok(result)
  }
}
