use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{Credentials, Region};
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::operation::get_object::GetObjectError;
use aws_sdk_s3::operation::head_object::HeadObjectError;
use aws_sdk_s3::operation::list_buckets::ListBucketsError;
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
  /// `Some(name)` pins the backend to a single bucket: every operation
  /// targets it, and `prefix`/`path` are object keys (the legacy model).
  /// `None` enables multi-bucket mode: the storage root performs
  /// `ListBuckets`, and the first path segment of every subsequent request
  /// names the bucket. See [`S3Backend::split_path`] for the routing rule.
  bucket: Option<String>,
}

impl S3Backend {
  pub async fn new(cfg: &S3Config) -> Result<Self, AppError> {
    // bucket is optional now — `S3Config::fixed_bucket()` reports `None` for
    // omit / "" / "*" / whitespace. In that case the backend enters
    // multi-bucket mode and routes via the path's first segment.
    let pinned_bucket = cfg.fixed_bucket().map(str::to_string);

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
      bucket: pinned_bucket,
    })
  }

  fn split_path<'a>(&self, path: &'a str) -> Result<(String, &'a str), AppError> {
    split_path(self.bucket.as_deref(), path)
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

  /// Map a `ListBuckets` SDK error, attaching a one-line hint when it's an
  /// auth denial — `s3:ListAllMyBuckets` is a separate IAM permission from
  /// per-bucket listing, and "set an explicit bucket in config" is the
  /// canonical workaround. Without the hint the operator only sees a raw
  /// AccessDenied and has to guess.
  fn map_list_buckets_err(err: SdkError<ListBucketsError>) -> AppError {
    let mapped = match err {
      SdkError::ServiceError(svc) => {
        let status = svc.raw().status().as_u16();
        let code = svc.err().code().unwrap_or_default();
        classify_s3_status(status, code, "list_buckets", svc.err())
      }
      e => AppError::Backend(format!("S3 list_buckets sdk error: {e}")),
    };
    if let AppError::Forbidden(msg) = mapped {
      return AppError::Forbidden(format!(
        "{msg} (multi-bucket mode requires s3:ListAllMyBuckets — set an explicit `bucket` in the storage config to skip this call)"
      ));
    }
    mapped
  }

  async fn list_v2(
    &self,
    bucket: &str,
    sub_prefix: &str,
    token: Option<String>,
    bucket_prefix: Option<&str>,
  ) -> Result<ListResult, AppError> {
    let mut req = self
      .client
      .list_objects_v2()
      .bucket(bucket)
      .delimiter("/")
      .max_keys(LIST_PAGE_SIZE);

    if !sub_prefix.is_empty() {
      req = req.prefix(sub_prefix);
    }
    if let Some(t) = token {
      req = req.continuation_token(t);
    }

    let resp = req.send().await.map_err(Self::map_list_err)?;

    let mut entries: Vec<FileEntry> = Vec::new();

    for cp in resp.common_prefixes() {
      if let Some(p) = cp.prefix() {
        entries.push(FileEntry {
          key: join_bucket_prefix(bucket_prefix, p),
          size: 0,
          last_modified: None,
          is_dir: true,
        });
      }
    }

    for obj in resp.contents() {
      let Some(key) = obj.key() else { continue };
      entries.push(FileEntry {
        key: join_bucket_prefix(bucket_prefix, key),
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
      // S3 has no cheap object-count API under a prefix; populating this
      // would require walking the full chain which is the same cost as
      // visiting the last page. Leave it for the client to discover by
      // walking when it cares.
      total_pages: None,
    })
  }

  async fn list_v1(
    &self,
    bucket: &str,
    sub_prefix: &str,
    marker: &str,
    bucket_prefix: Option<&str>,
  ) -> Result<ListResult, AppError> {
    let mut req = self
      .client
      .list_objects()
      .bucket(bucket)
      .delimiter("/")
      .max_keys(LIST_PAGE_SIZE)
      .marker(marker);

    if !sub_prefix.is_empty() {
      req = req.prefix(sub_prefix);
    }

    let resp = req.send().await.map_err(Self::map_list_v1_err)?;

    let mut entries: Vec<FileEntry> = Vec::new();

    for cp in resp.common_prefixes() {
      if let Some(p) = cp.prefix() {
        entries.push(FileEntry {
          key: join_bucket_prefix(bucket_prefix, p),
          size: 0,
          last_modified: None,
          is_dir: true,
        });
      }
    }

    for obj in resp.contents() {
      let Some(key) = obj.key() else { continue };
      entries.push(FileEntry {
        key: join_bucket_prefix(bucket_prefix, key),
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
      total_pages: None,
    })
  }

  /// Multi-bucket root listing — `ListBuckets` against the configured
  /// credentials. Returns each bucket as a top-level "directory" entry so
  /// the existing list/tree UI navigates into one with a normal prefix
  /// request. The API returns the full roster in one shot, so we don't
  /// paginate and we can report `total_pages = Some(1)`.
  async fn list_buckets(&self) -> Result<ListResult, AppError> {
    let resp = self
      .client
      .list_buckets()
      .send()
      .await
      .map_err(Self::map_list_buckets_err)?;

    let mut entries: Vec<FileEntry> = resp
      .buckets()
      .iter()
      .filter_map(|b| {
        let name = b.name()?;
        Some(FileEntry {
          key: format!("{name}/"),
          size: 0,
          last_modified: b.creation_date().map(|t| t.to_string()),
          is_dir: true,
        })
      })
      .collect();
    // Stable, predictable order across calls — S3 doesn't guarantee
    // ListBuckets order.
    entries.sort_by(|a, b| a.key.cmp(&b.key));

    Ok(ListResult {
      entries,
      next_token: None,
      walked_tokens: Vec::new(),
      total_pages: Some(1),
    })
  }
}

/// Prepend `"<bucket>/"` to an S3-returned key when the backend is in
/// multi-bucket mode. In single-bucket mode `bucket_prefix` is `None` and
/// the key passes through unchanged — same wire format as before this
/// feature landed.
fn join_bucket_prefix(bucket_prefix: Option<&str>, key: &str) -> String {
  match bucket_prefix {
    Some(p) => format!("{p}{key}"),
    None => key.to_string(),
  }
}

/// Resolve a request path into `(bucket, key)` for the S3 backend.
///
/// - Single-bucket mode (`pinned = Some(b)`): the bucket is the configured
///   one, the key is the path verbatim — the legacy behaviour.
/// - Multi-bucket mode (`pinned = None`): split on the first `/`. The bucket
///   is the leading segment; the key is everything after. The frontend
///   always emits prefixes with a trailing slash, so `"bucket/"` yields
///   `("bucket", "")` and lists that bucket's root.
///
/// Errors with `InvalidPath` when the path is empty, lacks a `/`, or starts
/// with `/` — none of those refer to a valid S3 object.
fn split_path<'a>(pinned: Option<&str>, path: &'a str) -> Result<(String, &'a str), AppError> {
  if let Some(b) = pinned {
    return Ok((b.to_string(), path));
  }
  if path.is_empty() {
    return Err(AppError::InvalidPath(
      "S3 multi-bucket storage requires <bucket>/<key>".into(),
    ));
  }
  let (bucket, rest) = match path.split_once('/') {
    Some(pair) => pair,
    // A bare segment without `/` can't address an object: the storage is
    // multi-bucket so `"foo"` could only mean "the bucket foo", which is
    // never the right answer for get / stat / nested list calls.
    None => {
      return Err(AppError::InvalidPath(format!(
        "S3 multi-bucket path '{path}' is missing the '<bucket>/<key>' separator"
      )));
    }
  };
  if bucket.is_empty() {
    return Err(AppError::InvalidPath(format!(
      "S3 multi-bucket path '{path}' has an empty bucket segment"
    )));
  }
  Ok((bucket.to_string(), rest))
}

#[async_trait]
impl StorageBackend for S3Backend {
  async fn get_file(&self, path: &str, opts: GetOptions) -> Result<StorageResponse, AppError> {
    let (bucket, key) = self.split_path(path)?;
    let mut req = self.client.get_object().bucket(&bucket).key(key);
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
    // Multi-bucket root listing routes to ListBuckets — the only call where
    // `prefix == ""` doesn't address a single bucket. Tokens never appear
    // here (ListBuckets isn't paginated in this backend), so ignore them.
    if self.bucket.is_none() && prefix.is_empty() {
      return self.list_buckets().await;
    }

    // Otherwise we need to know which bucket to list. Split the prefix on
    // its first `/`: in single-bucket mode the configured bucket is used
    // and the prefix passes through verbatim; in multi-bucket mode the
    // leading segment names the bucket and the rest is the sub-prefix.
    let (bucket, sub_prefix) = self.split_path(prefix)?;
    let bucket_prefix_owned;
    let bucket_prefix = if self.bucket.is_some() {
      None
    } else {
      bucket_prefix_owned = format!("{bucket}/");
      Some(bucket_prefix_owned.as_str())
    };

    // Tokens prefixed with "m:" mean a previous v2 page failed to issue a
    // working ContinuationToken — the rest of this listing rides on v1
    // Marker semantics, which uses a different server code path that holds
    // up on broken-v2 gateways (e.g. SenseTime ADS).
    if let Some(t) = token.as_deref()
      && let Some(marker) = t.strip_prefix(V1_MARKER_PREFIX)
    {
      return self
        .list_v1(&bucket, sub_prefix, marker, bucket_prefix)
        .await;
    }
    self.list_v2(&bucket, sub_prefix, token, bucket_prefix).await
  }

  async fn stat(&self, path: &str) -> Result<FileMeta, AppError> {
    let (bucket, key) = self.split_path(path)?;
    let resp = self
      .client
      .head_object()
      .bucket(&bucket)
      .key(key)
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

  // --- multi-bucket path routing ----------------------------------------

  #[test]
  fn split_path_single_bucket_passes_through() {
    // Pinned bucket short-circuits the split: path is treated as an opaque
    // key, no parsing — preserves the pre-feature wire format.
    assert_eq!(
      split_path(Some("b"), "foo/bar").unwrap(),
      ("b".to_string(), "foo/bar"),
    );
    assert_eq!(
      split_path(Some("b"), "").unwrap(),
      ("b".to_string(), ""),
      "empty path stays empty in single-bucket mode (root listing)",
    );
  }

  #[test]
  fn split_path_multi_bucket_splits_on_first_slash() {
    assert_eq!(
      split_path(None, "b/x/y").unwrap(),
      ("b".to_string(), "x/y"),
    );
    assert_eq!(
      split_path(None, "b/").unwrap(),
      ("b".to_string(), ""),
      "trailing-slash bucket prefix lists that bucket's root",
    );
  }

  #[test]
  fn split_path_multi_bucket_rejects_empty_and_bare_bucket() {
    assert!(matches!(
      split_path(None, ""),
      Err(AppError::InvalidPath(_))
    ));
    assert!(
      matches!(split_path(None, "b"), Err(AppError::InvalidPath(_))),
      "a bare bucket name with no '/' can't address an object",
    );
  }

  #[test]
  fn split_path_multi_bucket_rejects_leading_slash() {
    assert!(matches!(
      split_path(None, "/b/x"),
      Err(AppError::InvalidPath(_))
    ));
  }

  #[test]
  fn join_bucket_prefix_no_op_in_single_bucket() {
    assert_eq!(join_bucket_prefix(None, "foo/bar"), "foo/bar");
    assert_eq!(join_bucket_prefix(None, ""), "");
  }

  #[test]
  fn join_bucket_prefix_prepends_in_multi_bucket() {
    assert_eq!(join_bucket_prefix(Some("b/"), "foo/bar"), "b/foo/bar");
    assert_eq!(join_bucket_prefix(Some("b/"), "sub/"), "b/sub/");
  }
}
