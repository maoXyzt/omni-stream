use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{Credentials, Region};
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::operation::get_object::GetObjectError;
use aws_sdk_s3::operation::head_object::HeadObjectError;
use aws_sdk_s3::operation::list_objects::ListObjectsError;
use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Error;
use tokio_util::io::ReaderStream;

use super::{FileEntry, FileMeta, GetOptions, ListResult, StorageBackend, StorageResponse};
use crate::config::S3Config;
use crate::error::AppError;

const LIST_PAGE_SIZE: i32 = 100;
const CREDENTIAL_PROVIDER_NAME: &str = "omni-stream-config";

// Prefix marking a v1 `ListObjects` Marker cursor in `next_token`. Once the
// fallback fires (because the v2 endpoint failed to issue a working
// ContinuationToken for this gateway — observed on SenseTime ADS), the
// listing session stays on v1 for the duration; v1 is a different
// server-side code path and accepts a simple last-key marker.
const V1_MARKER_PREFIX: &str = "m:";

/// Compute `next_token` for a v2 `ListObjectsV2` response.
///
/// Honors the server-issued ContinuationToken when present. Otherwise — when
/// the response looks truncated (flag set or page is full) — emits a v1
/// Marker cursor to switch the rest of the listing onto `ListObjects` v1.
fn compute_next_token_v2(
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

  synthesize_v1_marker_from_entries(entries)
}

/// Compute `next_token` for a v1 `ListObjects` response.
///
/// Prefers the server-issued NextMarker. Falls back to the lex-greatest key
/// on the page when the server omits NextMarker but the response is
/// truncated or full.
fn compute_next_token_v1(
  server_next_marker: Option<&str>,
  is_truncated: Option<bool>,
  entries: &[FileEntry],
) -> Option<String> {
  if let Some(m) = server_next_marker {
    return Some(format!("{V1_MARKER_PREFIX}{m}"));
  }

  let truncated = is_truncated.unwrap_or(false);
  let full_page = entries.len() >= LIST_PAGE_SIZE as usize;
  if !truncated && !full_page {
    return None;
  }

  synthesize_v1_marker_from_entries(entries)
}

fn synthesize_v1_marker_from_entries(entries: &[FileEntry]) -> Option<String> {
  let last_entry = entries.iter().max_by(|a, b| a.key.cmp(&b.key))?;

  // If the boundary lands on a CommonPrefix ("dir/"), a marker of "dir/"
  // would still match keys inside it (since "dir/" < "dir/foo"), causing
  // the same directory to re-emit. Append max-codepoint to step past the
  // entire subtree.
  let cursor = if last_entry.is_dir {
    format!("{}\u{10FFFF}", last_entry.key)
  } else {
    last_entry.key.clone()
  };
  Some(format!("{V1_MARKER_PREFIX}{cursor}"))
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

  fn map_list_v1_err(err: SdkError<ListObjectsError>) -> AppError {
    match err {
      SdkError::ServiceError(svc) => {
        let status = svc.raw().status().as_u16();
        let code = svc.err().code().unwrap_or_default();
        classify_s3_status(status, code, "list", svc.err())
      }
      e => AppError::Backend(format!("S3 list sdk error: {e}")),
    }
  }

  async fn list_v2(&self, prefix: &str, token: Option<String>) -> Result<ListResult, AppError> {
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

    let next_token = compute_next_token_v2(
      resp.next_continuation_token(),
      resp.is_truncated(),
      &entries,
    );

    Ok(ListResult {
      entries,
      next_token,
      walked_tokens: Vec::new(),
    })
  }

  async fn list_v1(&self, prefix: &str, marker: &str) -> Result<ListResult, AppError> {
    let mut req = self
      .client
      .list_objects()
      .bucket(&self.bucket)
      .delimiter("/")
      .max_keys(LIST_PAGE_SIZE)
      .marker(marker);

    if !prefix.is_empty() {
      req = req.prefix(prefix);
    }

    let resp = req.send().await.map_err(Self::map_list_v1_err)?;

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

    let next_token = compute_next_token_v1(resp.next_marker(), resp.is_truncated(), &entries);

    Ok(ListResult {
      entries,
      next_token,
      walked_tokens: Vec::new(),
    })
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
    // Tokens prefixed with "m:" mean a previous v2 page failed to issue a
    // working ContinuationToken — the rest of this listing rides on v1
    // Marker semantics, which uses a different server code path that holds
    // up on broken-v2 gateways (e.g. SenseTime ADS).
    if let Some(t) = token.as_deref()
      && let Some(marker) = t.strip_prefix(V1_MARKER_PREFIX)
    {
      return self.list_v1(prefix, marker).await;
    }
    self.list_v2(prefix, token).await
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

  // --- v2 path -----------------------------------------------------------

  #[test]
  fn v2_server_token_wins_even_on_full_page() {
    let entries = n_files(LIST_PAGE_SIZE as usize);
    let got = compute_next_token_v2(Some("svr-abc"), Some(true), &entries);
    assert_eq!(got.as_deref(), Some("svr-abc"));
  }

  #[test]
  fn v2_short_page_without_truncated_returns_none() {
    let entries = n_files(30);
    assert_eq!(compute_next_token_v2(None, Some(false), &entries), None);
    assert_eq!(compute_next_token_v2(None, None, &entries), None);
  }

  #[test]
  fn v2_full_page_without_server_signal_switches_to_v1() {
    let entries = n_files(LIST_PAGE_SIZE as usize);
    let got = compute_next_token_v2(None, None, &entries).expect("expected fallback token");
    assert_eq!(got, format!("{V1_MARKER_PREFIX}k0099.bin"));
  }

  #[test]
  fn v2_truncated_flag_without_token_switches_to_v1_even_on_short_page() {
    let entries = n_files(30);
    let got = compute_next_token_v2(None, Some(true), &entries).expect("expected fallback token");
    assert_eq!(got, format!("{V1_MARKER_PREFIX}k0029.bin"));
  }

  #[test]
  fn v2_boundary_on_common_prefix_appends_sentinel() {
    let entries = vec![dir("dir1/"), dir("dir2/"), dir("dir3/")];
    let got = compute_next_token_v2(None, Some(true), &entries).expect("expected fallback token");
    assert_eq!(got, format!("{V1_MARKER_PREFIX}dir3/\u{10FFFF}"));
  }

  #[test]
  fn v2_fallback_uses_lex_greatest_entry_across_files_and_prefixes() {
    // Common prefixes are pushed before files in list_v2; the helper must
    // still pick the lex-greatest key, not the last-pushed one.
    let entries = vec![
      dir("a-dir/"),
      dir("b-dir/"),
      file("c-file.txt"),
      file("a-file.txt"),
    ];
    let got = compute_next_token_v2(None, Some(true), &entries).expect("expected fallback token");
    assert_eq!(got, format!("{V1_MARKER_PREFIX}c-file.txt"));
  }

  #[test]
  fn v2_empty_response_returns_none_even_if_truncated_flag_set() {
    assert_eq!(compute_next_token_v2(None, Some(true), &[]), None);
  }

  // --- v1 path -----------------------------------------------------------

  #[test]
  fn v1_server_next_marker_wins() {
    let entries = n_files(LIST_PAGE_SIZE as usize);
    let got = compute_next_token_v1(Some("dir/last-key"), Some(true), &entries);
    assert_eq!(got, Some(format!("{V1_MARKER_PREFIX}dir/last-key")));
  }

  #[test]
  fn v1_short_page_without_truncated_returns_none() {
    let entries = n_files(30);
    assert_eq!(compute_next_token_v1(None, Some(false), &entries), None);
    assert_eq!(compute_next_token_v1(None, None, &entries), None);
  }

  #[test]
  fn v1_full_page_without_next_marker_falls_back_to_last_key() {
    let entries = n_files(LIST_PAGE_SIZE as usize);
    let got = compute_next_token_v1(None, None, &entries).expect("expected fallback token");
    assert_eq!(got, format!("{V1_MARKER_PREFIX}k0099.bin"));
  }

  #[test]
  fn v1_boundary_on_common_prefix_appends_sentinel() {
    let entries = vec![dir("dir1/"), dir("dir2/"), dir("dir3/")];
    let got = compute_next_token_v1(None, Some(true), &entries).expect("expected fallback token");
    assert_eq!(got, format!("{V1_MARKER_PREFIX}dir3/\u{10FFFF}"));
  }
}
