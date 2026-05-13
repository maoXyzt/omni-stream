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
}

impl AppState {
  pub fn new(reg: BackendRegistry, thumb: Option<Arc<ThumbState>>, hostname: Arc<String>) -> Self {
    Self {
      backends: Arc::new(reg.backends),
      invalid: Arc::new(reg.invalid),
      order: Arc::new(reg.order),
      default_name: Arc::new(reg.default_name),
      thumb,
      hostname,
    }
  }

  fn resolve(&self, name: Option<&str>) -> Result<Arc<dyn StorageBackend>, AppError> {
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
}

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
  pub bucket: String,
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
}

pub async fn server_info_handler(State(state): State<AppState>) -> Json<ServerInfo> {
  Json(ServerInfo {
    hostname: state.hostname.as_str().to_string(),
    version: env!("CARGO_PKG_VERSION"),
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
  let result = backend.list_files(&q.prefix, q.page_token).await?;
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
