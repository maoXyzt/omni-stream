use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;
use serde::Deserialize;

use crate::error::AppError;
use crate::storage::{FileMeta, GetOptions, ListResult, StorageBackend};

#[derive(Clone)]
pub struct AppState {
    pub backend: Arc<dyn StorageBackend>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub prefix: String,
    pub page_token: Option<String>,
}

pub async fn stat_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<FileMeta>, AppError> {
    let meta = state.backend.stat(&key).await?;
    Ok(Json(meta))
}

pub async fn list_handler(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<ListResult>, AppError> {
    let result = state.backend.list_files(&q.prefix, q.page_token).await?;
    Ok(Json(result))
}

pub async fn proxy_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let opts = GetOptions { range };
    let resp = state.backend.get_file(&key, opts).await?;

    let status = if resp.is_partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };

    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes");

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
