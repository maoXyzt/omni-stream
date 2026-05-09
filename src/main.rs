mod config;
mod error;
mod handlers;
mod storage;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use axum::routing::get;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::config::{Config, StorageConfig};
use crate::handlers::{AppState, list_handler, proxy_handler, static_handler};
use crate::storage::StorageBackend;
use crate::storage::local::LocalFsBackend;
use crate::storage::s3::S3Backend;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let cfg = Config::load()?;
    let backend = build_backend(&cfg).await?;
    let state = AppState { backend };

    let app = Router::new()
        .route("/api/list", get(list_handler))
        .route("/api/proxy/{*key}", get(proxy_handler))
        .fallback(static_handler)
        .with_state(state)
        .layer(TraceLayer::new_for_http());

    let addr = format!("{}:{}", cfg.server.host, cfg.server.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    tracing::info!("OmniStream listening on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();
}

async fn build_backend(cfg: &Config) -> anyhow::Result<Arc<dyn StorageBackend>> {
    let backend: Arc<dyn StorageBackend> = match &cfg.storage {
        StorageConfig::S3(s3) => Arc::new(
            S3Backend::new(s3.clone())
                .await
                .context("init S3 backend")?,
        ),
        StorageConfig::LocalFs(local) => Arc::new(LocalFsBackend::new(local.root.clone())),
    };
    Ok(backend)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install ctrl-c handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
