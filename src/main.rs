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

use crate::config::Config;
use crate::handlers::{
    AppState, list_handler, proxy_handler, stat_handler, static_handler,
};
use crate::storage::StorageBackend;
use crate::storage::factory::create_backend;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    // Config is immutable post-load (design §6) — wrap in Arc so future code paths
    // (e.g. handlers exposing version/health info) can share it cheaply.
    let cfg = Arc::new(Config::load().context("load configuration")?);

    let backend: Arc<dyn StorageBackend> = create_backend(&cfg).await?.into();
    let state = AppState { backend };

    let app = Router::new()
        .route("/api/list", get(list_handler))
        .route("/api/stat/{*key}", get(stat_handler))
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
