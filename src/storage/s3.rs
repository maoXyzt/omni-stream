use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{Credentials, Region};
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::operation::get_object::GetObjectError;
use aws_sdk_s3::operation::head_object::HeadObjectError;
use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Error;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use tokio_util::io::ReaderStream;

use super::{FileEntry, FileMeta, GetOptions, ListResult, StorageBackend, StorageResponse};
use crate::config::S3Config;
use crate::error::AppError;

const LIST_PAGE_SIZE: i32 = 100;
const CREDENTIAL_PROVIDER_NAME: &str = "omni-stream-config";

/// Decide the `next_token` for a list response.
///
/// Honors the server-issued continuation token when present. Otherwise, when
/// the response looks truncated (flag set or page is full), synthesizes a
/// continuation token by base64-encoding the last key — this matches the
/// scheme used by common S3-compatible services that derive the next token
/// as `base64(last_returned_key)`. The synthesized token is sent back as a
/// regular `continuation_token` (not `start_after`), since some homemade
/// gateways only implement the continuation-token path.
fn compute_next_token(
  server_token: Option<&str>,
  is_truncated: Option<bool>,
  entries: &[FileEntry],
) -> Option<String> {
  if let Some(t) = server_token {
    return Some(t.to_string());
  }

  let truncated = is_truncated.unwrap_or(false);
  let full_page = entries.len() >= LIST_PAGE_SIZE as usize;
  if !truncated && !full_page {
    return None;
  }

  let last_entry = entries.iter().max_by(|a, b| a.key.cmp(&b.key))?;

  // If the boundary lands on a CommonPrefix ("dir/"), a cursor of "dir/"
  // would still match keys inside it (since "dir/" < "dir/foo"), causing
  // the same directory to re-emit. Append max-codepoint to step past the
  // entire subtree.
  let cursor = if last_entry.is_dir {
    format!("{}\u{10FFFF}", last_entry.key)
  } else {
    last_entry.key.clone()
  };
  Some(BASE64_STANDARD.encode(cursor.as_bytes()))
}

/// Map raw S3 HTTP status / error-code combos to AppError variants.
/// `op` ("get" | "head" | "list") is purely for the diagnostic message.
fn classify_s3_status(status: u16, code: &str, op: &str, raw: impl std::fmt::Display) -> AppError {
  match (status, code) {
    (404, _) | (_, "NoSuchKey") => AppError::NotFound("S3 key not found".into()),
    (403, _) | (_, "AccessDenied") | (_, "Forbidden") => {
      AppError::Forbidden(format!("S3 {op} denied: {raw}"))
    }
    (416, _) | (_, "InvalidRange") => {
      AppError::InvalidRange(format!("S3 {op} range invalid: {raw}"))
    }
    _ => AppError::Backend(format!("S3 {op} error: {raw}")),
  }
}

pub struct S3Backend {
  client: Client,
  bucket: String,
}

impl S3Backend {
  pub async fn new(cfg: &S3Config) -> Result<Self, AppError> {
    if cfg.bucket.trim().is_empty() {
      return Err(AppError::Backend("S3 bucket is required".into()));
    }

    let mut loader = aws_config::defaults(BehaviorVersion::latest());

    // SigV4 requires a region even against MinIO / LocalStack where the
    // server itself doesn't validate it. Fall back to "us-east-1" so users
    // don't have to set AWS_REGION just to talk to a local S3-compatible
    // endpoint.
    let region = cfg
      .region
      .clone()
      .unwrap_or_else(|| "us-east-1".to_string());
    loader = loader.region(Region::new(region));
    let custom_endpoint = cfg.endpoint.is_some();
    if let Some(endpoint) = cfg.endpoint.clone() {
      loader = loader.endpoint_url(endpoint);
    }
    if let (Some(akid), Some(sak)) = (cfg.access_key.clone(), cfg.secret_key.clone()) {
      let creds = Credentials::new(akid, sak, None, None, CREDENTIAL_PROVIDER_NAME);
      loader = loader.credentials_provider(creds);
    }

    let shared = loader.load().await;
    // Default to path-style with custom endpoints (MinIO / LocalStack / Ceph
    // need it), and to virtual-host style on AWS itself. `force_path_style`
    // in config overrides this — set false for gateways like AOSS-internal
    // that only accept `bucket.endpoint` addressing.
    let path_style = cfg.force_path_style && custom_endpoint;
    let s3_cfg = aws_sdk_s3::config::Builder::from(&shared)
      .force_path_style(path_style)
      .build();
    let client = Client::from_conf(s3_cfg);

    Ok(Self {
      client,
      bucket: cfg.bucket.clone(),
    })
  }

  fn map_get_err(err: SdkError<GetObjectError>) -> AppError {
    match err {
      SdkError::ServiceError(svc) => {
        if matches!(svc.err(), GetObjectError::NoSuchKey(_)) {
          return AppError::NotFound("S3 key not found".into());
        }
        let status = svc.raw().status().as_u16();
        let code = svc.err().code().unwrap_or_default();
        classify_s3_status(status, code, "get", svc.err())
      }
      e => AppError::Backend(format!("S3 get sdk error: {e}")),
    }
  }

  fn map_head_err(err: SdkError<HeadObjectError>) -> AppError {
    match err {
      SdkError::ServiceError(svc) => {
        if matches!(svc.err(), HeadObjectError::NotFound(_)) {
          return AppError::NotFound("S3 key not found".into());
        }
        let status = svc.raw().status().as_u16();
        let code = svc.err().code().unwrap_or_default();
        classify_s3_status(status, code, "head", svc.err())
      }
      e => AppError::Backend(format!("S3 head sdk error: {e}")),
    }
  }

  fn map_list_err(err: SdkError<ListObjectsV2Error>) -> AppError {
    match err {
      SdkError::ServiceError(svc) => {
        let status = svc.raw().status().as_u16();
        let code = svc.err().code().unwrap_or_default();
        classify_s3_status(status, code, "list", svc.err())
      }
      e => AppError::Backend(format!("S3 list sdk error: {e}")),
    }
  }
}

#[async_trait]
impl StorageBackend for S3Backend {
  async fn get_file(&self, path: &str, opts: GetOptions) -> Result<StorageResponse, AppError> {
    let mut req = self.client.get_object().bucket(&self.bucket).key(path);
    if let Some(range) = opts.range {
      req = req.range(range);
    }
    let resp = req.send().await.map_err(Self::map_get_err)?;

    let content_length = resp.content_length().map(|v| v.max(0) as u64);
    let content_type = resp.content_type().map(str::to_string);
    let etag = resp.e_tag().map(str::to_string);
    let last_modified = resp.last_modified().map(|t| t.to_string());
    let content_range = resp.content_range().map(str::to_string);
    let is_partial = content_range.is_some();

    let reader = resp.body.into_async_read();
    let stream = ReaderStream::new(reader);

    Ok(StorageResponse {
      body: Box::pin(stream),
      content_length,
      content_type,
      etag,
      last_modified,
      content_range,
      is_partial,
    })
  }

  async fn list_files(&self, prefix: &str, token: Option<String>) -> Result<ListResult, AppError> {
    let mut req = self
      .client
      .list_objects_v2()
      .bucket(&self.bucket)
      .delimiter("/")
      .max_keys(LIST_PAGE_SIZE);

    if !prefix.is_empty() {
      req = req.prefix(prefix);
    }
    if let Some(t) = token {
      req = req.continuation_token(t);
    }

    let resp = req.send().await.map_err(Self::map_list_err)?;

    let mut entries: Vec<FileEntry> = Vec::new();

    for cp in resp.common_prefixes() {
      if let Some(p) = cp.prefix() {
        entries.push(FileEntry {
          key: p.to_string(),
          size: 0,
          last_modified: None,
          is_dir: true,
        });
      }
    }

    for obj in resp.contents() {
      let Some(key) = obj.key() else { continue };
      entries.push(FileEntry {
        key: key.to_string(),
        size: obj.size().unwrap_or(0).max(0) as u64,
        last_modified: obj.last_modified().map(|t| t.to_string()),
        is_dir: false,
      });
    }

    let next_token = compute_next_token(
      resp.next_continuation_token(),
      resp.is_truncated(),
      &entries,
    );

    Ok(ListResult {
      entries,
      next_token,
    })
  }

  async fn stat(&self, path: &str) -> Result<FileMeta, AppError> {
    let resp = self
      .client
      .head_object()
      .bucket(&self.bucket)
      .key(path)
      .send()
      .await
      .map_err(Self::map_head_err)?;

    Ok(FileMeta {
      path: path.to_string(),
      size: resp.content_length().unwrap_or(0).max(0) as u64,
      etag: resp.e_tag().map(str::to_string),
      content_type: resp.content_type().map(str::to_string),
      last_modified: resp.last_modified().map(|t| t.to_string()),
      is_dir: false,
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn file(key: &str) -> FileEntry {
    FileEntry {
      key: key.to_string(),
      size: 0,
      last_modified: None,
      is_dir: false,
    }
  }

  fn dir(key: &str) -> FileEntry {
    FileEntry {
      key: key.to_string(),
      size: 0,
      last_modified: None,
      is_dir: true,
    }
  }

  fn n_files(n: usize) -> Vec<FileEntry> {
    (0..n).map(|i| file(&format!("k{i:04}.bin"))).collect()
  }

  fn decode(token: &str) -> String {
    String::from_utf8(BASE64_STANDARD.decode(token).expect("valid base64")).expect("utf8")
  }

  #[test]
  fn server_token_wins_even_on_full_page() {
    let entries = n_files(LIST_PAGE_SIZE as usize);
    let got = compute_next_token(Some("svr-abc"), Some(true), &entries);
    assert_eq!(got.as_deref(), Some("svr-abc"));
  }

  #[test]
  fn short_page_without_truncated_returns_none() {
    let entries = n_files(30);
    assert_eq!(compute_next_token(None, Some(false), &entries), None);
    assert_eq!(compute_next_token(None, None, &entries), None);
  }

  #[test]
  fn full_page_without_server_signal_falls_back() {
    let entries = n_files(LIST_PAGE_SIZE as usize);
    let got = compute_next_token(None, None, &entries).expect("expected fallback token");
    assert_eq!(decode(&got), "k0099.bin");
  }

  #[test]
  fn truncated_flag_without_token_falls_back_even_on_short_page() {
    let entries = n_files(30);
    let got = compute_next_token(None, Some(true), &entries).expect("expected fallback token");
    assert_eq!(decode(&got), "k0029.bin");
  }

  #[test]
  fn boundary_on_common_prefix_appends_sentinel() {
    let entries = vec![dir("dir1/"), dir("dir2/"), dir("dir3/")];
    let got = compute_next_token(None, Some(true), &entries).expect("expected fallback token");
    assert_eq!(decode(&got), "dir3/\u{10FFFF}");
  }

  #[test]
  fn fallback_uses_lex_greatest_entry_across_files_and_prefixes() {
    // Common prefixes are pushed before files in list_files; the helper must
    // still pick the lex-greatest key, not the last-pushed one.
    let entries = vec![
      dir("a-dir/"),
      dir("b-dir/"),
      file("c-file.txt"),
      file("a-file.txt"),
    ];
    let got = compute_next_token(None, Some(true), &entries).expect("expected fallback token");
    assert_eq!(decode(&got), "c-file.txt");
  }

  #[test]
  fn fallback_matches_observed_server_format() {
    // Real-world server emits next_continuation_token = base64(last_key).
    // Our synthesized fallback must use the same encoding so the server
    // can decode it transparently on the next request.
    let entries = vec![file("vigeneval/data/foo.jpg")];
    let got = compute_next_token(None, Some(true), &entries).expect("expected fallback token");
    assert_eq!(got, BASE64_STANDARD.encode(b"vigeneval/data/foo.jpg"));
  }

  #[test]
  fn empty_response_returns_none_even_if_truncated_flag_set() {
    assert_eq!(compute_next_token(None, Some(true), &[]), None);
  }
}
