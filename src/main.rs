mod auth;
mod cli_style;
mod config;
mod error;
mod handlers;
#[cfg(feature = "duckdb")]
mod sql;
mod storage;
mod thumbs;

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::Context;
use axum::Router;
use axum::http::StatusCode;
use axum::middleware;
use axum::routing::get;
use tokio::time::MissedTickBehavior;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::auth::{AuthState, auth_middleware};
use crate::config::Config;
use crate::handlers::{
  AppState, list_handler, list_storages_handler, proxy_handler, server_info_handler, stat_handler,
  static_handler, thumb_handler,
};
use crate::storage::factory::create_registry;
use crate::thumbs::ThumbState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  init_tracing();

  // CLI subcommands short-circuit the server. Dispatch happens BEFORE
  // `Config::load()` so `config init` / `config list` / `config check
  // <path>` work on a fresh host where no config file exists yet.
  //
  // Hand-rolled parser, not clap: the surface is six positional subcommands
  // with no flags, and a derive-clap setup would add ~100 KB plus several
  // seconds of compile time for no UX win. Revisit when we grow real flags
  // (e.g. `--format json`, `--color={auto,always,never}`).
  let mut argv = std::env::args().skip(1);
  if let Some(sub) = argv.next() {
    match sub.as_str() {
      "config" => return run_config_admin(argv.collect::<Vec<_>>()),
      "cache" => {
        let cfg = Config::load().context("load configuration")?;
        return run_cache_admin(argv.collect::<Vec<_>>(), &cfg);
      }
      "-h" | "--help" | "help" => {
        print_top_help();
        return Ok(());
      }
      other => {
        eprintln!(
          "{} {} {}",
          cli_style::icon_fail(),
          cli_style::red("unknown subcommand:"),
          cli_style::cyan(other),
        );
        print_top_help();
        std::process::exit(2);
      }
    }
  }

  // Config is immutable post-load (design §6) — wrap in Arc so future code paths
  // (e.g. handlers exposing version/health info) can share it cheaply.
  let cfg = Arc::new(Config::load().context("load configuration")?);

  let registry = create_registry(&cfg).await?;
  let thumb = ThumbState::build(&cfg.thumbnails).context("init thumbnail cache")?;
  if let Some(t) = thumb.as_ref() {
    spawn_thumb_sweep(t.clone());
  }
  // gethostname() syscall once at startup; the value is immutable for the
  // process lifetime so it's safe to share via Arc.
  let hostname = Arc::new(
    hostname::get()
      .ok()
      .and_then(|s| s.into_string().ok())
      .unwrap_or_else(|| "unknown".into()),
  );
  let auth_state = AuthState::from_config(&cfg.auth).context("init auth gate")?;
  if auth_state.enabled {
    tracing::info!("auth gate enabled: /api/* requires Bearer token");
  } else {
    tracing::info!("auth gate disabled (open API)");
  }
  // The SQL endpoint executes user-supplied SQL, so it never runs on an open
  // API: compile-time feature AND auth AND the [sql] kill-switch must all be
  // on. The flag also reaches the SPA via /api/server to gate the editor UI.
  let sql_enabled = cfg!(feature = "duckdb") && auth_state.enabled && cfg.sql.enabled;
  #[cfg(feature = "duckdb")]
  if sql_enabled {
    tracing::info!(
      timeout_secs = cfg.sql.query_timeout_secs,
      max_rows = cfg.sql.max_rows,
      "SQL query endpoint enabled (POST /api/query)",
    );
  } else {
    tracing::warn!("SQL query endpoint disabled: requires auth.enabled = true and [sql] enabled");
  }
  let state = AppState::new(registry, thumb, hostname, auth_state.enabled, sql_enabled);

  // Bounded per-route timeout for the catalog endpoints. Catalogs touch
  // every entry under a prefix (especially `list` walking many pages), and
  // an unbounded backend hang would leave the SPA stuck on a spinner. 25 s
  // is generous enough that the single-scan local-fs path completes on any
  // realistic directory but short enough that a stuck request fails fast
  // and surfaces a 408 the frontend can react to.
  //
  // `proxy` is deliberately excluded — file streams can legitimately run
  // for minutes on large downloads.
  let catalog_timeout =
    TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(25));

  let app = Router::new()
    .route("/api/server", get(server_info_handler))
    .route("/api/storages", get(list_storages_handler))
    .route("/api/list", get(list_handler).layer(catalog_timeout))
    .route("/api/stat/{*key}", get(stat_handler).layer(catalog_timeout))
    .route("/api/proxy/{*key}", get(proxy_handler))
    .route(
      "/api/thumb/{*key}",
      get(thumb_handler).layer(catalog_timeout),
    );
  // Registered before the auth route_layer below so the query endpoint is
  // bearer-token protected like every other /api route. The handler holds
  // its own per-query interrupt timeout; this outer layer is a belt-and-
  // braces bound in case the blocking task wedges before the watchdog arms.
  #[cfg(feature = "duckdb")]
  let app = {
    let sql_state = std::sync::Arc::new(sql::SqlState::from_config(&cfg));
    let query_timeout = TimeoutLayer::with_status_code(
      StatusCode::REQUEST_TIMEOUT,
      Duration::from_secs(cfg.sql.query_timeout_secs + 5),
    );
    app
      .route(
        "/api/query",
        axum::routing::post(sql::query_handler).layer(query_timeout),
      )
      // Router-level so the MethodRouter keeps a single layer (two chained
      // `.layer` calls defeat axum's error-type inference). Other routes
      // simply ignore the extension.
      .layer(axum::Extension(sql_state))
  };
  let app = app
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
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
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
  println!("{}", cli_style::bold("Usage:"));
  println!(
    "  {}                 Start the HTTP server",
    cli_style::cyan("omni-stream"),
  );
  println!(
    "  {} {}     Inspect / manage the config file {}",
    cli_style::cyan("omni-stream config"),
    cli_style::cyan("<op>"),
    cli_style::dim("(see `config --help`)"),
  );
  println!(
    "  {} {}      Manage the thumbnail cache {}",
    cli_style::cyan("omni-stream cache"),
    cli_style::cyan("<op>"),
    cli_style::dim("(see `cache --help`)"),
  );
}

fn print_config_help() {
  println!(
    "{} {}",
    cli_style::bold("Usage: omni-stream config"),
    cli_style::cyan("<list|init|check>"),
  );
  println!();
  println!(
    "  {}             List config-file candidates in priority order",
    cli_style::cyan("list"),
  );
  println!("                   and mark which one the loader will use.");
  println!(
    "  {}             Create a config file at one of the candidate",
    cli_style::cyan("init"),
  );
  println!("                   locations (interactive).");
  println!(
    "  {} {}     Parse + validate the active config, or PATH",
    cli_style::cyan("check"),
    cli_style::dim("[PATH]"),
  );
  println!("                   if given. Exits non-zero on any error.");
}

fn print_cache_help() {
  println!(
    "{} {}",
    cli_style::bold("Usage: omni-stream cache"),
    cli_style::cyan("<info|prune|clear>"),
  );
  println!();
  println!(
    "  {}     Print cache location, file count, total size, age range",
    cli_style::cyan("info"),
  );
  println!(
    "  {}    Run one sweep with the configured limits",
    cli_style::cyan("prune"),
  );
  println!(
    "           {}",
    cli_style::dim("(max_cache_bytes, max_age_days)"),
  );
  println!(
    "  {}    Remove the entire cache directory",
    cli_style::cyan("clear"),
  );
}

fn run_config_admin(args: Vec<String>) -> anyhow::Result<()> {
  let mut it = args.into_iter();
  let op = it.next().unwrap_or_default();
  match op.as_str() {
    "list" => cmd_config_list(),
    "init" => cmd_config_init(),
    "check" => cmd_config_check(it.next().map(PathBuf::from).as_deref()),
    "-h" | "--help" | "help" | "" => {
      print_config_help();
      Ok(())
    }
    other => {
      print_config_help();
      anyhow::bail!("unknown config subcommand: {other}");
    }
  }
}

fn cmd_config_list() -> anyhow::Result<()> {
  let candidates = Config::candidates();
  let active = Config::active_path();
  println!(
    "{}{}",
    cli_style::icon_check(),
    cli_style::bold("Config file lookup (in priority order):"),
  );
  println!();
  for (i, c) in candidates.iter().enumerate() {
    let exists = c.path.is_file();
    let is_active = active.as_ref() == Some(&c.path);
    let (icon, tag_text) = match (is_active, exists) {
      (true, true) => (cli_style::icon_active(), cli_style::green("[active]")),
      // Only reachable when OMNI_CONFIG explicitly points at a missing file;
      // we honour the env var verbatim so the user sees their typo.
      (true, false) => (
        cli_style::icon_warn(),
        cli_style::yellow("[active, missing]"),
      ),
      (false, true) => (cli_style::icon_ok(), cli_style::dim("[exists]")),
      (false, false) => ("  ", cli_style::dim("[missing]")),
    };
    println!(
      "  {} {} {} {}",
      cli_style::bold(&format!("{}.", i + 1)),
      icon,
      c.label,
      tag_text,
    );
    println!(
      "     {}{}",
      cli_style::icon_folder(),
      cli_style::cyan(&c.path.display().to_string()),
    );
  }
  println!();
  match active {
    Some(path) => {
      println!(
        "{} {}",
        cli_style::bold("Active path:"),
        cli_style::cyan(&path.display().to_string()),
      );
      if !path.is_file() {
        println!(
          "  {} {}",
          cli_style::icon_warn(),
          cli_style::yellow(
            "(OMNI_CONFIG points at a missing file — fix the path or unset the env var)"
          ),
        );
      }
    }
    None => {
      println!(
        "{} {}",
        cli_style::bold("Active path:"),
        cli_style::yellow("(none — no candidate exists on disk)"),
      );
      println!(
        "  {} {}",
        cli_style::icon_warn(),
        cli_style::dim(
          "server would start with defaults + env vars only; run `omni-stream config init` to create one"
        ),
      );
    }
  }
  Ok(())
}

fn cmd_config_init() -> anyhow::Result<()> {
  let candidates = Config::candidates();
  println!(
    "{}{}",
    cli_style::icon_init(),
    cli_style::bold("Choose where to create the config file:"),
  );
  println!();
  for (i, c) in candidates.iter().enumerate() {
    println!(
      "  {} {}{}",
      cli_style::bold(&format!("{}.", i + 1)),
      cli_style::icon_folder(),
      cli_style::cyan(&c.path.display().to_string()),
    );
    println!("     {}", cli_style::dim(&format!("({})", c.label)));
  }
  let custom_idx = candidates.len() + 1;
  println!(
    "  {} {}",
    cli_style::bold(&format!("{custom_idx}.")),
    cli_style::bold("custom path…"),
  );
  println!();
  print!(
    "{} {}",
    cli_style::bold("Selection"),
    cli_style::dim("[1]:"),
  );
  print!(" ");
  io::stdout().flush().context("flush stdout")?;

  let mut input = String::new();
  io::stdin()
    .lock()
    .read_line(&mut input)
    .context("read selection")?;
  let trimmed = input.trim();
  let idx: usize = if trimmed.is_empty() {
    1
  } else {
    trimmed
      .parse()
      .with_context(|| format!("invalid selection: {trimmed:?}"))?
  };
  if idx == 0 || idx > custom_idx {
    anyhow::bail!("selection out of range: {idx}");
  }

  let target = if idx == custom_idx {
    print!("{} ", cli_style::bold("Enter target path:"));
    io::stdout().flush().context("flush stdout")?;
    let mut p = String::new();
    io::stdin()
      .lock()
      .read_line(&mut p)
      .context("read custom path")?;
    let p = p.trim();
    if p.is_empty() {
      anyhow::bail!("empty path");
    }
    PathBuf::from(p)
  } else {
    candidates[idx - 1].path.clone()
  };

  if target.exists() {
    print!(
      "{} {} {} {} ",
      cli_style::icon_warn(),
      cli_style::yellow("File exists at"),
      cli_style::cyan(&target.display().to_string()),
      cli_style::yellow("— overwrite? [y/N]:"),
    );
    io::stdout().flush().context("flush stdout")?;
    let mut ans = String::new();
    io::stdin()
      .lock()
      .read_line(&mut ans)
      .context("read overwrite confirmation")?;
    let ans = ans.trim().to_ascii_lowercase();
    if ans != "y" && ans != "yes" {
      println!("{}", cli_style::dim("aborted (file unchanged)"));
      return Ok(());
    }
  }

  if let Some(parent) = target.parent()
    && !parent.as_os_str().is_empty()
  {
    std::fs::create_dir_all(parent)
      .with_context(|| format!("create parent directory {}", parent.display()))?;
  }
  let template = Config::example_template();
  std::fs::write(&target, template).with_context(|| format!("write {}", target.display()))?;
  println!(
    "{} {} {} {} {}",
    cli_style::icon_ok(),
    cli_style::green("Wrote"),
    cli_style::cyan(&template.len().to_string()),
    cli_style::green("bytes to"),
    cli_style::cyan(&target.display().to_string()),
  );
  println!(
    "{}",
    cli_style::dim(
      "Edit the file before starting omni-stream — at minimum configure a [[storages]] entry."
    ),
  );
  Ok(())
}

fn cmd_config_check(path: Option<&Path>) -> anyhow::Result<()> {
  let target = match path {
    Some(p) => p.to_path_buf(),
    None => match Config::active_path() {
      Some(p) => p,
      None => {
        eprintln!(
          "{} {}",
          cli_style::icon_fail(),
          cli_style::red("no config file found in any candidate location"),
        );
        eprintln!(
          "  {}",
          cli_style::dim_stderr("(run `omni-stream config list` to see candidates)"),
        );
        std::process::exit(1);
      }
    },
  };
  match Config::check(&target) {
    Ok(cfg) => {
      println!(
        "{} {} {} {}",
        cli_style::icon_ok(),
        cli_style::green("OK:"),
        cli_style::cyan(&target.display().to_string()),
        cli_style::dim("parses and validates."),
      );
      println!(
        "  {} {}",
        cli_style::dim("storages:"),
        cli_style::cyan(&cfg.storages.len().to_string()),
      );
      if let Some(active) = cfg.active_storage() {
        println!(
          "  {} {} {}",
          cli_style::dim("active storage:"),
          cli_style::cyan(&active.name),
          cli_style::dim(&format!("(type={:?})", active.r#type)),
        );
      }
      Ok(())
    }
    Err(e) => {
      eprintln!(
        "{} {} {}",
        cli_style::icon_fail(),
        cli_style::red("FAIL:"),
        cli_style::cyan_stderr(&target.display().to_string()),
      );
      for (i, cause) in e.chain().enumerate() {
        eprintln!(
          "  {} {}",
          cli_style::dim_stderr(&format!("{i}:")),
          cli_style::red(&cause.to_string()),
        );
      }
      std::process::exit(1);
    }
  }
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
  println!(
    "{}{}",
    cli_style::icon_info(),
    cli_style::bold("cache info"),
  );
  println!(
    "  {} {}",
    cli_style::dim("cache root:"),
    cli_style::cyan(&root.display().to_string()),
  );
  println!(
    "  {} {}",
    cli_style::dim("files:     "),
    cli_style::cyan(&inv.files.to_string()),
  );
  println!(
    "  {} {} {} {}",
    cli_style::dim("total:     "),
    cli_style::cyan(&human_bytes(inv.bytes)),
    cli_style::dim("/"),
    cli_style::dim(&format!(
      "{} cap",
      human_bytes(cfg.thumbnails.max_cache_bytes)
    )),
  );
  println!(
    "  {} {} {}",
    cli_style::dim("age cap:   "),
    cli_style::cyan(&format!("{} days", cfg.thumbnails.max_age_days)),
    if cfg.thumbnails.max_age_days == 0 {
      cli_style::dim("(disabled)")
    } else {
      String::new()
    },
  );
  println!(
    "  {} {}",
    cli_style::dim("oldest:    "),
    cli_style::cyan(&fmt_age(inv.oldest)),
  );
  println!(
    "  {} {}",
    cli_style::dim("newest:    "),
    cli_style::cyan(&fmt_age(inv.newest)),
  );
  Ok(())
}

fn cmd_cache_prune(cfg: &Config) -> anyhow::Result<()> {
  let root = crate::thumbs::resolve_cache_root_for(cfg.thumbnails.cache_path.as_deref())?;
  let max_age = Duration::from_secs(u64::from(cfg.thumbnails.max_age_days) * 86_400);
  let stats = crate::thumbs::sweep_cache(&root, cfg.thumbnails.max_cache_bytes, max_age)?;
  println!(
    "{}{}",
    cli_style::icon_prune(),
    cli_style::bold("cache prune"),
  );
  println!(
    "  {} {}",
    cli_style::dim("cache root:"),
    cli_style::cyan(&root.display().to_string()),
  );
  let deleted_color = if stats.files_deleted > 0 {
    cli_style::yellow as fn(&str) -> String
  } else {
    cli_style::dim as fn(&str) -> String
  };
  println!(
    "  {} {} {} {} {}",
    cli_style::dim("deleted:   "),
    deleted_color(&stats.files_deleted.to_string()),
    cli_style::dim("files,"),
    deleted_color(&human_bytes(stats.bytes_freed)),
    cli_style::dim("freed"),
  );
  println!(
    "  {} {} {} {}",
    cli_style::dim("remaining: "),
    cli_style::cyan(&stats.files_remaining.to_string()),
    cli_style::dim("files,"),
    cli_style::cyan(&human_bytes(stats.bytes_remaining)),
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
  println!(
    "{}{}",
    cli_style::icon_clear(),
    cli_style::bold("cache clear"),
  );
  if !root.exists() {
    println!(
      "  {} {}",
      cli_style::dim("cache root does not exist:"),
      cli_style::cyan(&root.display().to_string()),
    );
    return Ok(());
  }
  std::fs::remove_dir_all(&root).with_context(|| format!("remove {}", root.display()))?;
  println!(
    "{} {} {}",
    cli_style::icon_ok(),
    cli_style::green("removed:"),
    cli_style::cyan(&root.display().to_string()),
  );
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
