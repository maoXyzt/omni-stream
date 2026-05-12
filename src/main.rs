mod auth;
mod config;
mod error;
mod handlers;
mod storage;
mod thumbs;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::Context;
use axum::Router;
use axum::middleware;
use axum::routing::get;
use tokio::time::MissedTickBehavior;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::auth::{AuthState, auth_middleware};
use crate::config::Config;
use crate::handlers::{
    AppState, list_handler, list_storages_handler, proxy_handler, stat_handler, static_handler,
    thumb_handler,
};
use crate::storage::factory::create_registry;
use crate::thumbs::ThumbState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    // Config is immutable post-load (design §6) — wrap in Arc so future code paths
    // (e.g. handlers exposing version/health info) can share it cheaply.
    let cfg = Arc::new(Config::load().context("load configuration")?);

    // CLI subcommands short-circuit the server. Use the first positional arg
    // to dispatch; the binary still runs as a server when invoked with no
    // args (preserving existing `./omni-stream` behavior).
    let mut argv = std::env::args().skip(1);
    if let Some(sub) = argv.next() {
        match sub.as_str() {
            "cache" => return run_cache_admin(argv.collect::<Vec<_>>(), &cfg),
            "-h" | "--help" | "help" => {
                print_top_help();
                return Ok(());
            }
            other => {
                eprintln!("unknown subcommand: {other}");
                print_top_help();
                std::process::exit(2);
            }
        }
    }

    let registry = create_registry(&cfg).await?;
    let thumb = ThumbState::build(&cfg.thumbnails).context("init thumbnail cache")?;
    if let Some(t) = thumb.as_ref() {
        spawn_thumb_sweep(t.clone());
    }
    let state = AppState::new(registry, thumb);
    let auth_state = AuthState::from_config(&cfg.auth).context("init auth gate")?;
    if auth_state.enabled {
        tracing::info!("auth gate enabled: /api/* requires Bearer token");
    } else {
        tracing::info!("auth gate disabled (open API)");
    }

    let app = Router::new()
        .route("/api/storages", get(list_storages_handler))
        .route("/api/list", get(list_handler))
        .route("/api/stat/{*key}", get(stat_handler))
        .route("/api/proxy/{*key}", get(proxy_handler))
        .route("/api/thumb/{*key}", get(thumb_handler))
        // route_layer applies only to routes registered above; fallback (SPA HTML/
        // JS/CSS) stays open so the browser can load the login UI.
        .route_layer(middleware::from_fn_with_state(auth_state, auth_middleware))
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

fn spawn_thumb_sweep(state: Arc<ThumbState>) {
    let interval = state.sweep_interval();
    tokio::spawn(async move {
        // First sweep deferred by the interval rather than running at boot —
        // a freshly-restarted server probably hasn't drifted over the cap
        // yet, and deferring keeps startup logs uncluttered.
        let mut ticker = tokio::time::interval_at(
            tokio::time::Instant::now() + interval,
            interval,
        );
        // Don't try to "catch up" if a sweep ran long; just resume cadence.
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let s = state.clone();
            let res = tokio::task::spawn_blocking(move || s.sweep_once()).await;
            match res {
                Ok(Ok(stats)) if stats.files_deleted > 0 => tracing::info!(
                    deleted = stats.files_deleted,
                    freed = stats.bytes_freed,
                    remaining_files = stats.files_remaining,
                    remaining_bytes = stats.bytes_remaining,
                    "thumb cache sweep",
                ),
                Ok(Ok(_)) => tracing::debug!("thumb cache sweep: nothing to do"),
                Ok(Err(e)) => tracing::warn!(error = %e, "thumb cache sweep failed"),
                Err(e) => tracing::warn!(error = %e, "thumb cache sweep panicked"),
            }
        }
    });
}

fn print_top_help() {
    println!("Usage:");
    println!("  omni-stream                Start the HTTP server");
    println!("  omni-stream cache <op>     Manage the thumbnail cache (see `cache --help`)");
}

fn print_cache_help() {
    println!("Usage: omni-stream cache <info|prune|clear>");
    println!();
    println!("  info     Print cache location, file count, total size, age range");
    println!("  prune    Run one sweep with the configured limits");
    println!("           (max_cache_bytes, max_age_days)");
    println!("  clear    Remove the entire cache directory");
}

fn run_cache_admin(args: Vec<String>, cfg: &Config) -> anyhow::Result<()> {
    let op = args.first().map(String::as_str).unwrap_or("");
    match op {
        "info" => cmd_cache_info(cfg),
        "prune" => cmd_cache_prune(cfg),
        "clear" => cmd_cache_clear(cfg),
        "-h" | "--help" | "help" | "" => {
            print_cache_help();
            Ok(())
        }
        other => {
            print_cache_help();
            anyhow::bail!("unknown cache subcommand: {other}");
        }
    }
}

fn cmd_cache_info(cfg: &Config) -> anyhow::Result<()> {
    let root = crate::thumbs::resolve_cache_root_for(cfg.thumbnails.cache_path.as_deref())?;
    let inv = crate::thumbs::inventory_cache(&root)?;
    println!("cache root: {}", root.display());
    println!("files:      {}", inv.files);
    println!(
        "total:      {} / {} cap",
        human_bytes(inv.bytes),
        human_bytes(cfg.thumbnails.max_cache_bytes),
    );
    println!(
        "age cap:    {} days{}",
        cfg.thumbnails.max_age_days,
        if cfg.thumbnails.max_age_days == 0 { " (disabled)" } else { "" },
    );
    println!("oldest:     {}", fmt_age(inv.oldest));
    println!("newest:     {}", fmt_age(inv.newest));
    Ok(())
}

fn cmd_cache_prune(cfg: &Config) -> anyhow::Result<()> {
    let root = crate::thumbs::resolve_cache_root_for(cfg.thumbnails.cache_path.as_deref())?;
    let max_age = Duration::from_secs(u64::from(cfg.thumbnails.max_age_days) * 86_400);
    let stats = crate::thumbs::sweep_cache(&root, cfg.thumbnails.max_cache_bytes, max_age)?;
    println!("cache root:    {}", root.display());
    println!(
        "deleted:       {} files, {} freed",
        stats.files_deleted,
        human_bytes(stats.bytes_freed),
    );
    println!(
        "remaining:     {} files, {}",
        stats.files_remaining,
        human_bytes(stats.bytes_remaining),
    );
    Ok(())
}

fn cmd_cache_clear(cfg: &Config) -> anyhow::Result<()> {
    let root = crate::thumbs::resolve_cache_root_for(cfg.thumbnails.cache_path.as_deref())?;
    // Belt-and-braces guard against a config typo nuking $HOME or `/`.
    if !is_safe_to_remove(&root) {
        anyhow::bail!(
            "refusing to clear cache root that resolves to {} — set thumbnails.cache_path explicitly",
            root.display(),
        );
    }
    if !root.exists() {
        println!("cache root does not exist: {}", root.display());
        return Ok(());
    }
    std::fs::remove_dir_all(&root)
        .with_context(|| format!("remove {}", root.display()))?;
    println!("removed: {}", root.display());
    Ok(())
}

fn is_safe_to_remove(p: &Path) -> bool {
    // Reject root (`/`), empty paths, and `$HOME` / `$HOME/`. Anything else
    // is the operator's responsibility.
    if p.as_os_str().is_empty() {
        return false;
    }
    if p == Path::new("/") {
        return false;
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = Path::new(&home);
        if p == home {
            return false;
        }
    }
    true
}

fn human_bytes(b: u64) -> String {
    const UNITS: &[&str] = &["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{b} {}", UNITS[0])
    } else if v >= 100.0 {
        format!("{v:.0} {}", UNITS[i])
    } else if v >= 10.0 {
        format!("{v:.1} {}", UNITS[i])
    } else {
        format!("{v:.2} {}", UNITS[i])
    }
}

fn fmt_age(mtime: Option<SystemTime>) -> String {
    let Some(m) = mtime else { return "—".into() };
    match SystemTime::now().duration_since(m) {
        Ok(d) => {
            let secs = d.as_secs();
            let days = secs / 86_400;
            let hours = (secs % 86_400) / 3_600;
            let mins = (secs % 3_600) / 60;
            if days > 0 {
                format!("{days}d {hours}h ago")
            } else if hours > 0 {
                format!("{hours}h {mins}m ago")
            } else {
                format!("{mins}m ago")
            }
        }
        Err(_) => "in the future".into(),
    }
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
