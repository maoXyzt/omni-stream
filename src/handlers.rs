use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::storage::factory::{BackendRegistry, InvalidStorageEntry, NamedBackend, StorageDetails};
use crate::storage::{FileMeta, GetOptions, ListResult, StorageBackend};
use crate::thumbs::ThumbState;

#[derive(Clone)]
pub struct AppState {
  backends: Arc<HashMap<String, NamedBackend>>,
  /// Storages that exist in the config but failed to initialize at startup.
  /// Looked up after `backends` misses so requests targeting them return
  /// 503 (`StorageInvalid`) rather than 404 (which would imply "no such
  /// storage was ever configured").
  invalid: Arc<HashMap<String, InvalidStorageEntry>>,
  order: Arc<Vec<String>>,
  default_name: Arc<String>,
  thumb: Option<Arc<ThumbState>>,
  hostname: Arc<String>,
  /// Mirrors `auth.enabled` so `/api/server` can tell the SPA whether the
  /// bearer-token gate is active at all.
  auth_enabled: bool,
  /// Mirrors `auth.public_read`. With the gate on, `true` means reads are
  /// public and only writes need the token; `false` means everything does.
  /// The SPA uses (auth_enabled, public_read) to decide when to prompt for a
  /// token: never under `public_read` for browsing, only when a write 401s.
  public_read: bool,
  /// True only when all three hold: built with `--features duckdb`,
  /// `[sql].enabled`, and `auth.enabled`. Always false in non-duckdb builds.
  sql_enabled: bool,
}

impl AppState {
  pub fn new(
    reg: BackendRegistry,
    thumb: Option<Arc<ThumbState>>,
    hostname: Arc<String>,
    auth_enabled: bool,
    public_read: bool,
    sql_enabled: bool,
  ) -> Self {
    Self {
      backends: Arc::new(reg.backends),
      invalid: Arc::new(reg.invalid),
      order: Arc::new(reg.order),
      default_name: Arc::new(reg.default_name),
      thumb,
      hostname,
      auth_enabled,
      public_read,
      sql_enabled,
    }
  }

  #[cfg(feature = "duckdb")]
  pub fn sql_enabled(&self) -> bool {
    self.sql_enabled
  }

  pub(crate) fn resolve(&self, name: Option<&str>) -> Result<Arc<dyn StorageBackend>, AppError> {
    let key = name
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .unwrap_or_else(|| self.default_name.as_str());
    if let Some(nb) = self.backends.get(key) {
      return Ok(nb.backend.clone());
    }
    // Invalid (configured but failed to init) — distinct from "never
    // configured", so callers get a 503 with the init failure reason
    // rather than a 404 they'd interpret as a typo.
    if let Some(inv) = self.invalid.get(key) {
      return Err(AppError::StorageInvalid(format!(
        "storage '{key}' is invalid: {}",
        inv.reason
      )));
    }
    Err(AppError::NotFound(format!("storage '{key}'")))
  }
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
  #[serde(default)]
  pub prefix: String,
  pub page_token: Option<String>,
  pub storage: Option<String>,
  /// 0 / absent → behaves like before: one `list_files` call from
  /// `page_token`. N > 0 → handler walks N more steps server-side and
  /// returns the resulting page; the intermediate tokens come back in
  /// `walked_tokens` so the client can fill its page→token cache atomically.
  /// Clamped to `MAX_SKIP_PAGES` to bound worst-case server cost.
  pub skip_pages: Option<u32>,
}

/// Upper bound on `skip_pages` per request. With 1000-key pages this lets
/// one request advance ~100k entries; large enough for any realistic jump,
/// small enough that a misuse can't run away with the server.
const MAX_SKIP_PAGES: u32 = 100;

/// Used by `stat` and `proxy` — both take the key in the path and only need
/// to pick which backend to talk to.
#[derive(Debug, Deserialize)]
pub struct StorageSelector {
  pub storage: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StorageDescriptor {
  pub name: String,
  pub r#type: &'static str,
  /// `false` for storages that exist in the config but failed to initialize
  /// at startup. The UI uses this to render an "[invalid]" tag and disable
  /// selection; requests targeting an invalid storage return 503.
  pub valid: bool,
  /// Human-readable init-failure reason when `valid == false`. Useful as a
  /// tooltip in the switcher so the operator sees what to fix without
  /// digging through server logs.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  /// Type-specific identifying details for the storage-selection dialog.
  /// Exactly one of `s3` / `local` is populated based on `type`. Secrets
  /// (`access_key`, `secret_key`) are never serialized here.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub s3: Option<S3Descriptor>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub local: Option<LocalDescriptor>,
}

#[derive(Debug, Serialize)]
pub struct S3Descriptor {
  /// `Some(name)` when the storage pins to a single bucket. Serialised as
  /// JSON `null` (intentionally NOT skipped) when the storage is in
  /// multi-bucket mode — the frontend uses the explicit null to render
  /// "(all buckets)" instead of guessing from an empty string.
  pub bucket: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub endpoint: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub region: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LocalDescriptor {
  pub root_path: String,
}

#[derive(Debug, Serialize)]
pub struct StoragesResponse {
  pub storages: Vec<StorageDescriptor>,
  pub default: String,
}

#[derive(Debug, Serialize)]
pub struct ServerInfo {
  pub hostname: String,
  /// Backend semver from `Cargo.toml`, baked in at compile time. Returning
  /// it on the same endpoint the frontend already polls keeps this a
  /// zero-extra-request feature; the SPA renders it as a footer chip.
  pub version: &'static str,
  /// Whether the bearer-token gate is on at all. Under a full lockdown this
  /// endpoint sits behind the gate, so reading it implies the token works;
  /// when `public_read` is on, it's readable without a token and reports the
  /// gate state so the SPA knows writes need one.
  pub auth_enabled: bool,
  /// Whether reads are public while only writes require the token. Only
  /// meaningful when `auth_enabled`. The SPA prompts for a token lazily (on a
  /// write 401) when this is true, and up-front when it's false.
  pub public_read: bool,
  /// Whether `POST /api/query` is live (duckdb build + [sql] enabled +
  /// auth on). The SPA hides the SQL editor entry point when false.
  pub sql_enabled: bool,
}

pub async fn server_info_handler(State(state): State<AppState>) -> Json<ServerInfo> {
  Json(ServerInfo {
    hostname: state.hostname.as_str().to_string(),
    version: env!("CARGO_PKG_VERSION"),
    auth_enabled: state.auth_enabled,
    public_read: state.public_read,
    sql_enabled: state.sql_enabled,
  })
}

pub async fn list_storages_handler(State(state): State<AppState>) -> Json<StoragesResponse> {
  let storages = state
    .order
    .iter()
    .filter_map(|name| {
      // Each name in `order` belongs to exactly one of {backends, invalid}.
      // Look in backends first (the hot path) so valid entries pay just one
      // hash lookup; invalid is the slower fall-through.
      if let Some(nb) = state.backends.get(name) {
        let (s3, local) = split_details(&nb.details);
        Some(StorageDescriptor {
          name: nb.name.clone(),
          r#type: type_label(nb.r#type),
          valid: true,
          error: None,
          s3,
          local,
        })
      } else {
        // Falls through to `invalid` on miss; if it's in neither map the
        // name is an internal-invariant violation (every entry in `order`
        // is placed in exactly one map by factory.rs) — drop silently
        // rather than crash a request path.
        state.invalid.get(name).map(|inv| {
          let (s3, local) = split_details(&inv.details);
          StorageDescriptor {
            name: inv.name.clone(),
            r#type: type_label(inv.r#type),
            valid: false,
            error: Some(inv.reason.clone()),
            s3,
            local,
          }
        })
      }
    })
    .collect();
  Json(StoragesResponse {
    storages,
    default: state.default_name.as_str().to_string(),
  })
}

fn type_label(t: crate::config::StorageType) -> &'static str {
  match t {
    crate::config::StorageType::S3 => "s3",
    crate::config::StorageType::Local => "local",
  }
}

/// Unpack a `StorageDetails` enum into the two flat `Option` fields the JSON
/// response uses. Returning a tuple keeps the call site simple — exactly one
/// of the two is `Some` by construction.
fn split_details(d: &StorageDetails) -> (Option<S3Descriptor>, Option<LocalDescriptor>) {
  match d {
    StorageDetails::S3 {
      bucket,
      endpoint,
      region,
    } => (
      Some(S3Descriptor {
        bucket: bucket.clone(),
        endpoint: endpoint.clone(),
        region: region.clone(),
      }),
      None,
    ),
    StorageDetails::Local { root_path } => (
      None,
      Some(LocalDescriptor {
        root_path: root_path.clone(),
      }),
    ),
  }
}

pub async fn stat_handler(
  State(state): State<AppState>,
  Query(q): Query<StorageSelector>,
  Path(key): Path<String>,
) -> Result<Json<FileMeta>, AppError> {
  let backend = state.resolve(q.storage.as_deref())?;
  let meta = backend.stat(&key).await?;
  Ok(Json(meta))
}

pub async fn list_handler(
  State(state): State<AppState>,
  Query(q): Query<ListQuery>,
) -> Result<Json<ListResult>, AppError> {
  let backend = state.resolve(q.storage.as_deref())?;
  let skip = q.skip_pages.unwrap_or(0).min(MAX_SKIP_PAGES);
  // `list_files_walking` has a sane default impl in the trait (naive
  // sequential `list_files` calls) and a hot override on backends that can
  // amortize — local fs reads all the walked pages in a single dir scan
  // instead of repeating the same scan once per page.
  let result = backend
    .list_files_walking(&q.prefix, q.page_token, skip)
    .await?;
  Ok(Json(result))
}

pub async fn proxy_handler(
  State(state): State<AppState>,
  Query(q): Query<StorageSelector>,
  Path(key): Path<String>,
  headers: HeaderMap,
) -> Result<Response, AppError> {
  let backend = state.resolve(q.storage.as_deref())?;

  let range = headers
    .get(header::RANGE)
    .and_then(|v| v.to_str().ok())
    .map(str::to_string);

  let opts = GetOptions { range };
  let resp = backend.get_file(&key, opts).await?;

  let status = if resp.is_partial {
    StatusCode::PARTIAL_CONTENT
  } else {
    StatusCode::OK
  };

  let mut builder = Response::builder()
    .status(status)
    .header(header::ACCEPT_RANGES, "bytes")
    .header(header::CACHE_CONTROL, "public, max-age=3600");

  if let Some(ct) = resp.content_type.as_deref() {
    builder = builder.header(header::CONTENT_TYPE, ct);
  }
  if let Some(cl) = resp.content_length {
    builder = builder.header(header::CONTENT_LENGTH, cl);
  }
  if let Some(etag) = resp.etag.as_deref() {
    builder = builder.header(header::ETAG, etag);
  }
  if let Some(lm) = resp.last_modified.as_deref() {
    builder = builder.header(header::LAST_MODIFIED, lm);
  }
  if let Some(cr) = resp.content_range.as_deref() {
    builder = builder.header(header::CONTENT_RANGE, cr);
  }

  let body = Body::from_stream(resp.body);
  builder
    .body(body)
    .map_err(|e| AppError::Backend(format!("response build: {e}")))
}

/// Query params for the `/raw` mount. `ls` (presence, any value) flips a
/// request into directory-listing mode; `page_token` / `skip_pages` mirror
/// `/api/list` so a served page can paginate a large directory.
#[derive(Debug, Deserialize)]
pub struct RawQuery {
  pub ls: Option<String>,
  pub page_token: Option<String>,
  pub skip_pages: Option<u32>,
}

/// One entry in a `/raw …?ls` directory listing. `name` is the basename (not
/// the full storage key) so a served HTML page can fetch it with a plain
/// relative URL.
#[derive(Debug, Serialize)]
pub struct RawDirEntry {
  pub name: String,
  pub is_dir: bool,
  pub size: u64,
  pub last_modified: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RawListing {
  pub path: String,
  pub entries: Vec<RawDirEntry>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub next_token: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub total_pages: Option<u64>,
}

/// Last path segment of a (possibly trailing-slashed) storage key.
/// `"a/b/c.txt"` → `"c.txt"`, `"a/b/"` → `"b"`, `""` → `""`.
fn basename_of(key: &str) -> String {
  key
    .trim_end_matches('/')
    .rsplit('/')
    .next()
    .unwrap_or("")
    .to_string()
}

/// Root of the `/raw` mount (`/raw/{storage}`) — lists the storage root.
pub async fn raw_root_handler(
  State(state): State<AppState>,
  Path(storage): Path<String>,
  Query(q): Query<RawQuery>,
  headers: HeaderMap,
) -> Result<Response, AppError> {
  raw_serve(state, storage, String::new(), q, headers).await
}

/// `/raw/{storage}/{*path}` — a copyparty-style navigable file mount.
///
/// Storage lives in the PATH (not a query param) so that relative
/// sub-resource fetches from a served HTML page keep the storage context.
/// A request whose path resolves to a file streams raw bytes (same
/// Content-Type / Range behavior as `proxy_handler`, no `Content-Disposition`
/// so HTML renders inline); a request carrying `?ls`, a trailing slash, or an
/// empty path returns a JSON directory listing. Self-contained dashboards can
/// thus both load their data files relatively and discover directories via
/// `fetch("subdir/?ls")` without hard-coding paths or the storage name.
pub async fn raw_handler(
  State(state): State<AppState>,
  Path((storage, path)): Path<(String, String)>,
  Query(q): Query<RawQuery>,
  headers: HeaderMap,
) -> Result<Response, AppError> {
  raw_serve(state, storage, path, q, headers).await
}

async fn raw_serve(
  state: AppState,
  storage: String,
  path: String,
  q: RawQuery,
  headers: HeaderMap,
) -> Result<Response, AppError> {
  let backend = state.resolve(Some(&storage))?;

  // Directory intent: explicit `?ls`, a trailing slash, or the storage root.
  // We deliberately do NOT stat to detect directories — S3 has no real dir
  // objects, so the convention has to be request-shape driven to work on both
  // backends.
  let wants_listing = q.ls.is_some() || path.is_empty() || path.ends_with('/');

  if wants_listing {
    // Build the prefix for list_files_walking. On S3, the prefix is a string
    // filter: "foo" matches "foo.txt" and "foo_bar/" as well as "foo/…", while
    // "foo/" is scoped to the directory. Always use an empty string for the
    // root and a trailing-slash form for any non-root directory so S3 listings
    // return only the intended directory's contents.
    let prefix = if path.is_empty() {
      String::new()
    } else if path.ends_with('/') {
      path.clone()
    } else {
      format!("{path}/")
    };
    let skip = q.skip_pages.unwrap_or(0).min(MAX_SKIP_PAGES);
    let result = backend
      .list_files_walking(&prefix, q.page_token, skip)
      .await?;
    let entries = result
      .entries
      .into_iter()
      .map(|e| RawDirEntry {
        name: basename_of(&e.key),
        is_dir: e.is_dir,
        size: e.size,
        last_modified: e.last_modified,
      })
      .collect();
    let listing = RawListing {
      path: prefix.trim_end_matches('/').to_string(),
      entries,
      next_token: result.next_token,
      total_pages: result.total_pages,
    };
    return Ok(Json(listing).into_response());
  }

  // File branch — mirrors proxy_handler's streaming/Range/header logic, with
  // two deliberate differences: no Content-Disposition (so .html renders
  // inline instead of downloading) and `no-cache` instead of a 1h max-age,
  // since these mounts back live dashboards that re-poll their data files.
  let range = headers
    .get(header::RANGE)
    .and_then(|v| v.to_str().ok())
    .map(str::to_string);

  let resp = backend.get_file(&path, GetOptions { range }).await?;

  let status = if resp.is_partial {
    StatusCode::PARTIAL_CONTENT
  } else {
    StatusCode::OK
  };

  let mut builder = Response::builder()
    .status(status)
    .header(header::ACCEPT_RANGES, "bytes")
    .header(header::CACHE_CONTROL, "no-cache");

  if let Some(ct) = resp.content_type.as_deref() {
    builder = builder.header(header::CONTENT_TYPE, ct);
  }
  if let Some(cl) = resp.content_length {
    builder = builder.header(header::CONTENT_LENGTH, cl);
  }
  if let Some(etag) = resp.etag.as_deref() {
    builder = builder.header(header::ETAG, etag);
  }
  if let Some(lm) = resp.last_modified.as_deref() {
    builder = builder.header(header::LAST_MODIFIED, lm);
  }
  if let Some(cr) = resp.content_range.as_deref() {
    builder = builder.header(header::CONTENT_RANGE, cr);
  }

  let body = Body::from_stream(resp.body);
  builder
    .body(body)
    .map_err(|e| AppError::Backend(format!("response build: {e}")))
}

#[derive(Debug, Deserialize)]
pub struct ThumbQuery {
  pub storage: Option<String>,
  pub w: Option<u32>,
  /// Source version token (typically `last_modified` from the list response).
  /// When provided, response gets `immutable` caching since the URL itself
  /// rotates whenever the source changes.
  pub v: Option<String>,
}

pub async fn thumb_handler(
  State(state): State<AppState>,
  Query(q): Query<ThumbQuery>,
  Path(key): Path<String>,
) -> Result<Response, AppError> {
  let thumb = state
    .thumb
    .as_ref()
    .ok_or_else(|| AppError::NotFound("thumbnails disabled".into()))?;
  let backend = state.resolve(q.storage.as_deref())?;
  let width = thumb.resolve_width(q.w);

  let storage_label = q
    .storage
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| state.default_name.as_str());

  let cache_path = thumb
    .ensure_thumb(&backend, storage_label, &key, width)
    .await?;

  let file = tokio::fs::File::open(&cache_path)
    .await
    .map_err(AppError::Io)?;
  let meta = file.metadata().await.map_err(AppError::Io)?;
  let stream = tokio_util::io::ReaderStream::new(file);

  // URL is content-addressed when `v` is supplied → safe to mark immutable.
  // Without `v` we fall back to a short max-age + revalidation.
  let cache_ctl = if q.v.is_some() {
    "public, max-age=31536000, immutable"
  } else {
    "public, max-age=3600"
  };

  Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, "image/webp")
    .header(header::CONTENT_LENGTH, meta.len())
    .header(header::CACHE_CONTROL, cache_ctl)
    .body(Body::from_stream(stream))
    .map_err(|e| AppError::Backend(format!("response build: {e}")))
}

#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
struct Asset;

pub async fn static_handler(uri: Uri) -> Response {
  let raw = uri.path().trim_start_matches('/');
  let path = if raw.is_empty() { "index.html" } else { raw };

  if let Some(content) = Asset::get(path) {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    return (
      [(header::CONTENT_TYPE, mime.as_ref())],
      content.data.into_owned(),
    )
      .into_response();
  }

  // SPA fallback: any unknown non-API path serves index.html so client routing works.
  if let Some(content) = Asset::get("index.html") {
    return (
      [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
      content.data.into_owned(),
    )
      .into_response();
  }

  (StatusCode::NOT_FOUND, "not found").into_response()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::storage::{ByteStream, FileEntry, FileMeta, GetOptions, StorageResponse};
  use async_trait::async_trait;
  use std::sync::Mutex;

  /// Stub backend that paginates a fixed key list in `page_size` chunks.
  /// Tokens are stringified end-offsets — `Some("3")` means "resume from
  /// the 4th key". `prefix` is ignored. Records every `list_files` call so
  /// tests can assert the walk advanced.
  struct StubBackend {
    keys: Vec<String>,
    page_size: usize,
    calls: Mutex<Vec<Option<String>>>,
  }

  impl StubBackend {
    fn new(n: usize, page_size: usize) -> Self {
      Self {
        keys: (0..n).map(|i| format!("k{i:04}")).collect(),
        page_size,
        calls: Mutex::new(Vec::new()),
      }
    }

    fn call_count(&self) -> usize {
      self.calls.lock().unwrap().len()
    }
  }

  #[async_trait]
  impl StorageBackend for StubBackend {
    async fn list_files(
      &self,
      _prefix: &str,
      token: Option<String>,
    ) -> Result<ListResult, AppError> {
      self.calls.lock().unwrap().push(token.clone());
      let start: usize = token
        .as_deref()
        .map(|s| s.parse().unwrap_or(0))
        .unwrap_or(0);
      let end = (start + self.page_size).min(self.keys.len());
      let entries: Vec<FileEntry> = self.keys[start..end]
        .iter()
        .map(|k| FileEntry {
          key: k.clone(),
          size: 0,
          last_modified: None,
          is_dir: false,
          is_symlink: false,
        })
        .collect();
      let next_token = if end < self.keys.len() {
        Some(end.to_string())
      } else {
        None
      };
      Ok(ListResult {
        entries,
        next_token,
        walked_tokens: Vec::new(),
        // Stub mirrors the local-fs convention: every page knows the total.
        total_pages: Some((self.keys.len() as u64).div_ceil(self.page_size as u64)),
      })
    }

    async fn get_file(&self, _: &str, _: GetOptions) -> Result<StorageResponse, AppError> {
      unimplemented!("not exercised by walk tests")
    }

    async fn stat(&self, _: &str) -> Result<FileMeta, AppError> {
      unimplemented!("not exercised by walk tests")
    }
  }

  // Mute the unused-import warning for `ByteStream` — pulled in only to
  // satisfy associated-type bounds when the unimplemented! arms are
  // type-checked. (Keeping the explicit import documents the dependency.)
  #[allow(dead_code)]
  fn _ensure_bytestream_in_scope(_s: ByteStream) {}

  #[tokio::test]
  async fn walk_skip_zero_is_a_single_list_call() {
    let backend = StubBackend::new(10, 3);
    let res = backend.list_files_walking("", None, 0).await.unwrap();
    assert_eq!(
      res
        .entries
        .iter()
        .map(|e| e.key.as_str())
        .collect::<Vec<_>>(),
      vec!["k0000", "k0001", "k0002"],
    );
    assert_eq!(res.next_token.as_deref(), Some("3"));
    assert!(res.walked_tokens.is_empty());
    assert_eq!(backend.call_count(), 1);
  }

  #[tokio::test]
  async fn walk_skip_n_returns_target_page_with_intermediate_tokens() {
    // 10 keys / 3 per page → pages of [k0..k2] [k3..k5] [k6..k8] [k9].
    // skip=2 from start → land on page 3 (k6..k8), walked tokens point at
    // pages 2 and 3.
    let backend = StubBackend::new(10, 3);
    let res = backend.list_files_walking("", None, 2).await.unwrap();
    assert_eq!(
      res
        .entries
        .iter()
        .map(|e| e.key.as_str())
        .collect::<Vec<_>>(),
      vec!["k0006", "k0007", "k0008"],
    );
    assert_eq!(res.next_token.as_deref(), Some("9"));
    assert_eq!(res.walked_tokens, vec!["3", "6"]);
    // skip + 1 internal calls.
    assert_eq!(backend.call_count(), 3);
    // 10 keys / 3 per page → 4 pages. The handler propagates whatever the
    // final list_files step reported.
    assert_eq!(res.total_pages, Some(4));
  }

  #[tokio::test]
  async fn walk_preserves_total_pages_on_eof_branch() {
    // skip past the actual end → the EOF-early branch returns the last
    // page. Its `total_pages` should still flow through unchanged.
    let backend = StubBackend::new(10, 3);
    let res = backend.list_files_walking("", None, 10).await.unwrap();
    assert_eq!(res.total_pages, Some(4));
  }

  #[tokio::test]
  async fn walk_with_start_token_advances_from_that_position() {
    // Same fixture, but start from "3" (page 2). skip=1 → land on page 3.
    let backend = StubBackend::new(10, 3);
    let res = backend
      .list_files_walking("", Some("3".into()), 1)
      .await
      .unwrap();
    assert_eq!(
      res
        .entries
        .iter()
        .map(|e| e.key.as_str())
        .collect::<Vec<_>>(),
      vec!["k0006", "k0007", "k0008"],
    );
    assert_eq!(res.walked_tokens, vec!["6"]);
  }

  #[tokio::test]
  async fn walk_truncates_when_listing_ends_early() {
    // 10 keys / 3 per page → 4 real pages. skip=10 → walk until EOF, return
    // the entries of whatever page hit `next_token = None`.
    let backend = StubBackend::new(10, 3);
    let res = backend.list_files_walking("", None, 10).await.unwrap();
    assert_eq!(
      res
        .entries
        .iter()
        .map(|e| e.key.as_str())
        .collect::<Vec<_>>(),
      vec!["k0009"],
    );
    assert!(res.next_token.is_none());
    // We discovered tokens for pages 2/3/4 before hitting EOF at page 4.
    assert_eq!(res.walked_tokens, vec!["3", "6", "9"]);
    // Stops the moment we see `None`, so 4 calls total (page1→2→3→4).
    assert_eq!(backend.call_count(), 4);
  }

  #[tokio::test]
  async fn walk_skip_zero_on_empty_listing_works() {
    let backend = StubBackend::new(0, 3);
    let res = backend.list_files_walking("", None, 0).await.unwrap();
    assert!(res.entries.is_empty());
    assert!(res.next_token.is_none());
    assert!(res.walked_tokens.is_empty());
  }

  #[test]
  fn max_skip_pages_is_within_a_reasonable_bound() {
    // Pin the constant so an accidental bump (e.g. 100 → 100_000) shows up
    // in review. The handler clamps `skip_pages` to this value.
    assert_eq!(MAX_SKIP_PAGES, 100);
  }

  #[test]
  fn basename_of_common_cases() {
    assert_eq!(basename_of("a/b/c.txt"), "c.txt");
    assert_eq!(basename_of("data.json"), "data.json");
    // Directory key from list_files: trailing slash stripped, last segment returned.
    assert_eq!(basename_of("a/subdir/"), "subdir");
    assert_eq!(basename_of("subdir/"), "subdir");
    // Storage root / empty prefix — listing the root itself.
    assert_eq!(basename_of(""), "");
    // Single-segment file (no directory component).
    assert_eq!(basename_of("file.txt"), "file.txt");
    // Nested path, no trailing slash (file deep in the tree).
    assert_eq!(basename_of("a/b/c/d.parquet"), "d.parquet");
  }
}
