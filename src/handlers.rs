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
use crate::storage::factory::{BackendRegistry, NamedBackend};
use crate::storage::{FileMeta, GetOptions, ListResult, StorageBackend};

#[derive(Clone)]
pub struct AppState {
    backends: Arc<HashMap<String, NamedBackend>>,
    order: Arc<Vec<String>>,
    default_name: Arc<String>,
}

impl AppState {
    pub fn from_registry(reg: BackendRegistry) -> Self {
        Self {
            backends: Arc::new(reg.backends),
            order: Arc::new(reg.order),
            default_name: Arc::new(reg.default_name),
        }
    }

    fn resolve(&self, name: Option<&str>) -> Result<Arc<dyn StorageBackend>, AppError> {
        let key = name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.default_name.as_str());
        self.backends
            .get(key)
            .map(|nb| nb.backend.clone())
            .ok_or_else(|| AppError::NotFound(format!("storage '{key}'")))
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
}

#[derive(Debug, Serialize)]
pub struct StoragesResponse {
    pub storages: Vec<StorageDescriptor>,
    pub default: String,
}

pub async fn list_storages_handler(State(state): State<AppState>) -> Json<StoragesResponse> {
    let storages = state
        .order
        .iter()
        .filter_map(|name| state.backends.get(name))
        .map(|nb| StorageDescriptor {
            name: nb.name.clone(),
            r#type: match nb.r#type {
                crate::config::StorageType::S3 => "s3",
                crate::config::StorageType::Local => "local",
            },
        })
        .collect();
    Json(StoragesResponse {
        storages,
        default: state.default_name.as_str().to_string(),
    })
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
