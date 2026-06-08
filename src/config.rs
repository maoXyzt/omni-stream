use std::env;
use std::fmt;
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow, bail};
use config::{Config as ConfigBuilder, Environment, File, FileFormat};
use directories::ProjectDirs;
use serde::{Deserialize, Deserializer};

const APP_QUALIFIER: &str = "";
const APP_ORG: &str = "";
const APP_NAME: &str = "omni-stream";
const CONFIG_FILE: &str = "config.toml";
const ENV_PREFIX: &str = "OMNI";

// Embedded at compile time so `omni-stream config init` works on a host where
// the binary is the only artifact present. The file is also listed in
// `[package.include]` so the path resolves both in-tree and from a published
// crates.io tarball.
const EXAMPLE_CONFIG: &str = include_str!("../config.example.toml");

/// One entry in the config-file lookup order. Listing these (via
/// [`Config::candidates`]) lets the CLI report where the loader looks and
/// which one actually wins.
#[derive(Debug, Clone)]
pub struct ConfigCandidate {
  /// Human-readable origin (env var name or platform default).
  pub label: &'static str,
  /// Fully resolved on-disk path.
  pub path: PathBuf,
}

/// Read an env var, returning `None` when unset *or* set to the empty string.
/// Empty values usually come from shells (`VAR=` on the command line), and
/// every consumer here would treat an empty path as garbage — better to
/// collapse the two cases at the boundary.
fn env_nonempty(key: &str) -> Option<String> {
  env::var(key).ok().filter(|s| !s.is_empty())
}

/// Pure resolver behind [`Config::active_path`] — extracted so unit tests can
/// exercise the precedence rules without touching process env / filesystem.
///
/// `omni_config_set` mirrors `OMNI_CONFIG` being present in the process env.
/// `exists` is the existence check (real impl uses `Path::is_file`).
fn pick_active(
  candidates: &[ConfigCandidate],
  omni_config_set: bool,
  exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
  if omni_config_set {
    // OMNI_CONFIG is by construction the first candidate when present. Return
    // it as-is, even if the file is missing — see Config::active_path docs.
    return candidates.first().map(|c| c.path.clone());
  }
  candidates
    .iter()
    .find(|c| exists(&c.path))
    .map(|c| c.path.clone())
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
  #[serde(default)]
  pub server: ServerConfig,
  #[serde(default)]
  pub storages: Vec<StorageConfig>,
  #[serde(default)]
  pub auth: AuthConfig,
  #[serde(default)]
  pub thumbnails: ThumbConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
  #[serde(default = "default_host")]
  pub host: String,
  #[serde(default = "default_port")]
  pub port: u16,
}

impl Default for ServerConfig {
  fn default() -> Self {
    Self {
      host: default_host(),
      port: default_port(),
    }
  }
}

fn default_host() -> String {
  "127.0.0.1".to_string()
}

fn default_port() -> u16 {
  28080
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StorageType {
  S3,
  Local,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StorageConfig {
  pub name: String,
  pub r#type: StorageType,
  #[serde(default)]
  pub active: bool,
  #[serde(default)]
  pub s3: Option<S3Config>,
  #[serde(default)]
  pub local: Option<LocalConfig>,
}

#[derive(Clone, Deserialize)]
pub struct S3Config {
  #[serde(default)]
  pub endpoint: Option<String>,
  /// Optional bucket pin. When set, the storage operates against this single
  /// bucket exactly as before. When omitted (or set to the `"*"` sentinel),
  /// the storage enters multi-bucket mode: the root listing performs
  /// `ListBuckets` and each bucket appears as a top-level directory. See
  /// [`S3Config::fixed_bucket`] for the canonical "is this multi-bucket?"
  /// check.
  #[serde(default)]
  pub bucket: Option<String>,
  #[serde(default)]
  pub access_key: Option<String>,
  #[serde(default)]
  pub secret_key: Option<String>,
  #[serde(default)]
  pub region: Option<String>,
  // Path-style addressing (`https://endpoint/bucket/key`). Disable for
  // gateways that require virtual-host style (`https://bucket.endpoint/key`),
  // e.g. some AOSS / OSS internal endpoints.
  #[serde(default = "default_force_path_style")]
  pub force_path_style: bool,
}

fn default_force_path_style() -> bool {
  true
}

impl S3Config {
  /// Returns the configured bucket name when this storage pins to a single
  /// bucket, or `None` when it should operate in multi-bucket mode.
  ///
  /// Multi-bucket triggers when the field is absent, empty / whitespace, or
  /// equal to the `"*"` sentinel. Callers use this both to decide which API
  /// to call (ListBuckets vs. ListObjects) and to drive UI hints — the
  /// storage card renders "(all buckets)" when this returns `None`.
  pub fn fixed_bucket(&self) -> Option<&str> {
    let raw = self.bucket.as_deref()?.trim();
    if raw.is_empty() || raw == "*" {
      None
    } else {
      Some(raw)
    }
  }
}

impl Default for S3Config {
  fn default() -> Self {
    Self {
      endpoint: None,
      bucket: None,
      access_key: None,
      secret_key: None,
      region: None,
      force_path_style: default_force_path_style(),
    }
  }
}

// Manual Debug implementation: never leak access_key / secret_key into logs.
impl fmt::Debug for S3Config {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("S3Config")
      .field("endpoint", &self.endpoint)
      .field(
        "bucket",
        &self.bucket.as_deref().unwrap_or("<multi-bucket>"),
      )
      .field("access_key", &mask_secret(self.access_key.as_deref()))
      .field("secret_key", &mask_secret(self.secret_key.as_deref()))
      .field("region", &self.region)
      .field("force_path_style", &self.force_path_style)
      .finish()
  }
}

fn mask_secret(s: Option<&str>) -> &'static str {
  match s {
    Some(_) => "***REDACTED***",
    None => "<unset>",
  }
}

#[derive(Debug, Clone, Deserialize)]
pub struct LocalConfig {
  #[serde(deserialize_with = "deser_path_expand_tilde")]
  pub root_path: PathBuf,
  // Follow symlinks when serving / listing under `root_path`. When false,
  // symlinks are surfaced as their own entries (size = link length, no
  // traversal) and reading them returns Forbidden.
  #[serde(default = "default_follow_symlinks")]
  pub follow_symlinks: bool,
}

fn default_follow_symlinks() -> bool {
  true
}

fn expand_tilde(s: &str) -> PathBuf {
  if let Some(rest) = s.strip_prefix('~')
    && (rest.is_empty() || rest.starts_with('/'))
    && let Some(home) = env::var_os("HOME")
  {
    let mut p = PathBuf::from(home);
    let trimmed = rest.strip_prefix('/').unwrap_or(rest);
    if !trimmed.is_empty() {
      p.push(trimmed);
    }
    return p;
  }
  PathBuf::from(s)
}

fn deser_path_expand_tilde<'de, D: Deserializer<'de>>(d: D) -> Result<PathBuf, D::Error> {
  let s = String::deserialize(d)?;
  Ok(expand_tilde(&s))
}

/// On-demand JPEG thumbnail cache. Disabled by default — when off, the grid
/// view falls back to `/api/proxy` (full-resolution originals).
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ThumbConfig {
  pub enabled: bool,
  /// Cache root; tilde expanded. Default: `~/.cache/omni-stream/thumbs`.
  /// Absent when None and resolved at startup against `$XDG_CACHE_HOME` /
  /// `directories::ProjectDirs`, so a single path string in TOML is enough.
  pub cache_path: Option<String>,
  /// JPEG quality 1-100. Copyparty uses Q=40-60 for max compression; Q=70 is
  /// a safer default that keeps photo thumbnails artifact-free at ~15 KB.
  pub quality: u8,
  pub max_source_bytes: u64,
  /// Allowed thumbnail widths in pixels. Requests outside this set snap to
  /// the nearest larger value (clamped to the max). Bounding the set keeps
  /// the cache enumerable and prevents attackers triggering arbitrary widths.
  pub sizes: Vec<u32>,
  pub default_size: u32,

  /// Soft cap on total cache size. Background sweep deletes oldest entries
  /// (by mtime, refreshed on cache hit) until the total drops below this.
  pub max_cache_bytes: u64,
  /// Hard age cap: entries older than this are deleted regardless of cap.
  /// Zero disables the age check.
  pub max_age_days: u32,
  /// How often the background sweep runs. Floored to 60s at runtime.
  pub sweep_interval_secs: u64,
}

impl Default for ThumbConfig {
  fn default() -> Self {
    Self {
      enabled: false,
      cache_path: None,
      quality: 70,
      max_source_bytes: 50 * 1024 * 1024,
      sizes: vec![160, 320, 640],
      default_size: 320,
      max_cache_bytes: 1024 * 1024 * 1024, // 1 GiB
      max_age_days: 90,
      sweep_interval_secs: 3600,
    }
  }
}

/// Optional bearer-token gate on `/api/*`. When `enabled = false` (default),
/// the API is open to anyone who can reach the listening port.
#[derive(Clone, Default, Deserialize)]
pub struct AuthConfig {
  #[serde(default)]
  pub enabled: bool,
  #[serde(default)]
  pub token: Option<String>,
}

// Manual Debug: token is a secret; never let it surface via tracing or panic dumps.
impl fmt::Debug for AuthConfig {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("AuthConfig")
      .field("enabled", &self.enabled)
      .field("token", &mask_secret(self.token.as_deref()))
      .finish()
  }
}

impl Config {
  pub fn load() -> anyhow::Result<Self> {
    let path_opt = Self::active_path();
    let shown = path_opt
      .as_ref()
      .map(|p| p.display().to_string())
      .unwrap_or_else(|| "<none>".to_string());

    let mut builder = ConfigBuilder::builder();
    if let Some(path) = path_opt.as_ref() {
      // When `active_path()` returns Some it's already either a verified-
      // existing file (the common case) or an explicit `OMNI_CONFIG` value
      // we promised to honour as-given. Mark it required iff it exists, so
      // an OMNI_CONFIG typo surfaces at validate() time as "no storages"
      // rather than a crash deep in the loader.
      let path_str = path.to_string_lossy().into_owned();
      let exists = path.is_file();
      builder = builder.add_source(
        File::with_name(&path_str)
          .format(FileFormat::Toml)
          .required(exists),
      );
    }

    let raw = builder
      .add_source(
        Environment::with_prefix(ENV_PREFIX)
          .separator("_")
          .try_parsing(true),
      )
      .build()
      .with_context(|| format!("load config (file={shown})"))?;

    let cfg: Config = raw
      .try_deserialize()
      .with_context(|| format!("deserialize config: {shown}"))?;

    cfg
      .validate()
      .with_context(|| format!("validate config: {shown}"))?;

    // Logged at info post-validate (not pre-build) so a successful line means
    // "this is the file actually serving traffic" — load failures surface via
    // the anyhow error chain, which already names the path.
    match path_opt.as_ref() {
      Some(p) => tracing::info!(path = %p.display(), "loaded omni-stream config"),
      // Unreachable in practice — validate() bails on "no storages configured"
      // before we get here — but kept defensive in case a future env-only
      // config (e.g. via OMNI_STORAGES_*) becomes viable.
      None => {
        tracing::warn!("started without a config file — running on env vars + defaults only",)
      }
    }
    Ok(cfg)
  }

  /// The path the loader will actually read at startup, or `None` if no
  /// config file is reachable.
  ///
  /// Resolution rules:
  /// - If `OMNI_CONFIG` is set, that path wins **regardless of whether the
  ///   file exists**. The env var is an explicit user instruction; falling
  ///   through silently would mask a typo (e.g. `OMNI_CONFIG=/etc/oms.tml`
  ///   accidentally loading a different file).
  /// - Otherwise, walk the conventional candidate chain (XDG, ProjectDirs,
  ///   cwd) and return the first path that exists on disk. Skipping missing
  ///   intermediate candidates is what users expect — a missing
  ///   `~/.config/omni-stream/config.toml` should not prevent `./config.toml`
  ///   from being picked up.
  /// - If nothing exists and no env override is set, returns `None`. The
  ///   loader then falls back to env-vars + defaults only (which usually
  ///   fails `validate()` on "no storages configured").
  pub fn active_path() -> Option<PathBuf> {
    pick_active(
      &Self::candidates(),
      env_nonempty("OMNI_CONFIG").is_some(),
      |p| p.is_file(),
    )
  }

  /// All paths the CLI considers, in priority order. Deduplicated by resolved
  /// path so platforms where the XDG default coincides with ProjectDirs don't
  /// list the same location twice.
  pub fn candidates() -> Vec<ConfigCandidate> {
    let mut out: Vec<ConfigCandidate> = Vec::new();
    fn push(out: &mut Vec<ConfigCandidate>, label: &'static str, path: PathBuf) {
      if !out.iter().any(|c| c.path == path) {
        out.push(ConfigCandidate { label, path });
      }
    }

    if let Some(p) = env_nonempty("OMNI_CONFIG") {
      push(&mut out, "$OMNI_CONFIG", PathBuf::from(p));
    }
    match env_nonempty("XDG_CONFIG_HOME") {
      Some(xdg) => push(
        &mut out,
        "$XDG_CONFIG_HOME/omni-stream/config.toml",
        PathBuf::from(xdg).join(APP_NAME).join(CONFIG_FILE),
      ),
      None => {
        if let Some(home) = env_nonempty("HOME") {
          push(
            &mut out,
            "~/.config/omni-stream/config.toml",
            PathBuf::from(home)
              .join(".config")
              .join(APP_NAME)
              .join(CONFIG_FILE),
          );
        }
      }
    }
    if let Some(dirs) = ProjectDirs::from(APP_QUALIFIER, APP_ORG, APP_NAME) {
      push(
        &mut out,
        "ProjectDirs (platform default)",
        dirs.config_dir().join(CONFIG_FILE),
      );
    }
    push(&mut out, "./config.toml", PathBuf::from(CONFIG_FILE));

    out
  }

  /// Parse + validate a specific config file. Skips env-var layering on
  /// purpose: `config check` is "does this file alone make sense", not "would
  /// the running server start". Bails when the path doesn't exist so the user
  /// gets a clear error instead of a silently-applied empty config.
  pub fn check(path: &Path) -> anyhow::Result<Self> {
    if !path.is_file() {
      bail!("config file not found: {}", path.display());
    }
    let path_str = path.to_string_lossy().into_owned();
    let raw = ConfigBuilder::builder()
      .add_source(
        File::with_name(&path_str)
          .format(FileFormat::Toml)
          .required(true),
      )
      .build()
      .with_context(|| format!("load config (file={})", path.display()))?;
    let cfg: Config = raw
      .try_deserialize()
      .with_context(|| format!("deserialize config: {}", path.display()))?;
    cfg
      .validate()
      .with_context(|| format!("validate config: {}", path.display()))?;
    Ok(cfg)
  }

  /// The starter template `config init` writes. Compile-time embedded.
  pub fn example_template() -> &'static str {
    EXAMPLE_CONFIG
  }

  fn validate(&self) -> anyhow::Result<()> {
    if self.storages.is_empty() {
      bail!("no storages configured; define at least one [[storages]] entry");
    }
    for s in &self.storages {
      match s.r#type {
        StorageType::S3 => {
          let s3 = s.s3.as_ref().ok_or_else(|| {
            anyhow!(
              "storage '{}' has type=s3 but is missing the s3 sub-table",
              s.name
            )
          })?;
          // bucket is now optional: omitted / "" / "*" all mean "multi-bucket
          // mode" (root listing performs ListBuckets). When a literal name is
          // supplied it must be a single S3 bucket — reject anything that
          // looks like a bucket/prefix path so the operator gets a clear
          // error instead of silently failing on every list.
          if let Some(raw) = s3.bucket.as_deref()
            && raw.contains('/')
          {
            bail!(
              "storage '{}': s3.bucket must be a bare bucket name (no '/'); got '{}'",
              s.name,
              raw,
            );
          }
        }
        StorageType::Local => {
          let local = s.local.as_ref().ok_or_else(|| {
            anyhow!(
              "storage '{}' has type=local but is missing the local sub-table",
              s.name
            )
          })?;
          if local.root_path.as_os_str().is_empty() {
            bail!("storage '{}': local.root_path is required", s.name);
          }
        }
      }
    }
    if self.auth.enabled {
      let token_empty = self
        .auth
        .token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_none();
      if token_empty {
        bail!("auth.enabled = true but auth.token is missing or empty");
      }
    }
    Ok(())
  }

  /// Return the entry with `active = true`, falling back to the first defined storage.
  /// `validate()` guarantees at least one storage exists, but we still return Option
  /// so callers handle the empty case explicitly without unwrap.
  pub fn active_storage(&self) -> Option<&StorageConfig> {
    self
      .storages
      .iter()
      .find(|s| s.active)
      .or_else(|| self.storages.first())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn parse(raw: &str) -> Config {
    let cfg: Config = toml::from_str(raw).expect("parse toml");
    cfg.validate().expect("validate");
    cfg
  }

  #[test]
  fn parses_example_file() {
    let raw = std::fs::read_to_string("config.example.toml").expect("read example");
    let cfg = parse(&raw);
    // port is commented out in the template → falls back to the code default
    assert_eq!(cfg.server.port, 28080);
    assert!(!cfg.storages.is_empty());
    let active = cfg.active_storage().expect("active");
    assert_eq!(active.r#type, StorageType::S3);
  }

  #[test]
  fn picks_active_when_present() {
    let raw = r#"
[[storages]]
name = "first"
type = "local"
active = false
local = { root_path = "/tmp" }

[[storages]]
name = "second"
type = "local"
active = true
local = { root_path = "/var" }
"#;
    let cfg = parse(raw);
    assert_eq!(cfg.active_storage().unwrap().name, "second");
  }

  #[test]
  fn falls_back_to_first_when_no_active() {
    let raw = r#"
[[storages]]
name = "first"
type = "local"
local = { root_path = "/tmp" }

[[storages]]
name = "second"
type = "local"
local = { root_path = "/var" }
"#;
    let cfg = parse(raw);
    assert_eq!(cfg.active_storage().unwrap().name, "first");
  }

  #[test]
  fn server_defaults_when_omitted() {
    let raw = r#"
[[storages]]
name = "x"
type = "local"
active = true
local = { root_path = "/tmp" }
"#;
    let cfg = parse(raw);
    assert_eq!(cfg.server.host, "127.0.0.1");
    assert_eq!(cfg.server.port, 28080);
  }

  #[test]
  fn rejects_s3_without_subtable() {
    let raw = r#"
[[storages]]
name = "broken"
type = "s3"
active = true
"#;
    let cfg: Config = toml::from_str(raw).expect("syntactic parse");
    assert!(cfg.validate().is_err());
  }

  #[test]
  fn rejects_empty_storages() {
    let raw = r#"
[server]
port = 9000
"#;
    let cfg: Config = toml::from_str(raw).expect("syntactic parse");
    assert!(cfg.validate().is_err());
  }

  #[test]
  fn auth_disabled_by_default() {
    let raw = r#"
[[storages]]
name = "x"
type = "local"
active = true
local = { root_path = "/tmp" }
"#;
    let cfg = parse(raw);
    assert!(!cfg.auth.enabled);
    assert!(cfg.auth.token.is_none());
  }

  #[test]
  fn auth_enabled_requires_non_empty_token() {
    let cases = [
      r#"
[auth]
enabled = true

[[storages]]
name = "x"
type = "local"
active = true
local = { root_path = "/tmp" }
"#,
      r#"
[auth]
enabled = true
token = "   "

[[storages]]
name = "x"
type = "local"
active = true
local = { root_path = "/tmp" }
"#,
    ];
    for raw in cases {
      let cfg: Config = toml::from_str(raw).expect("syntactic");
      assert!(cfg.validate().is_err(), "should reject: {raw}");
    }
  }

  #[test]
  fn auth_enabled_with_token_validates() {
    let raw = r#"
[auth]
enabled = true
token = "secret-token"

[[storages]]
name = "x"
type = "local"
active = true
local = { root_path = "/tmp" }
"#;
    let cfg = parse(raw);
    assert!(cfg.auth.enabled);
    assert_eq!(cfg.auth.token.as_deref(), Some("secret-token"));
  }

  #[test]
  fn debug_masks_auth_token() {
    let auth = AuthConfig {
      enabled: true,
      token: Some("very-secret-bearer-value".into()),
    };
    let dbg = format!("{auth:?}");
    assert!(!dbg.contains("very-secret-bearer-value"), "leaked: {dbg}");
    assert!(dbg.contains("REDACTED"));
  }

  #[test]
  fn debug_masks_s3_secrets() {
    let s3 = S3Config {
      endpoint: Some("https://example.com".into()),
      bucket: Some("b".into()),
      access_key: Some("AKIDsecret".into()),
      secret_key: Some("supersecret".into()),
      region: Some("us-east-1".into()),
      force_path_style: true,
    };
    let dbg = format!("{s3:?}");
    assert!(!dbg.contains("AKIDsecret"), "access_key leaked: {dbg}");
    assert!(!dbg.contains("supersecret"), "secret_key leaked: {dbg}");
    assert!(dbg.contains("REDACTED"));
    assert!(dbg.contains("https://example.com"));
    assert!(dbg.contains("us-east-1"));
  }

  #[test]
  fn local_root_path_expands_tilde() {
    // SAFETY: tests run single-threaded enough for HOME mutation; if this
    // becomes flaky we can switch to a serial_test guard.
    unsafe {
      env::set_var("HOME", "/home/tester");
    }
    let raw = r#"
[[storages]]
name = "x"
type = "local"
active = true
local = { root_path = "~/data/foo" }
"#;
    let cfg: Config = toml::from_str(raw).expect("parse");
    let local = cfg.storages[0].local.as_ref().expect("local");
    assert_eq!(local.root_path, PathBuf::from("/home/tester/data/foo"));
  }

  #[test]
  fn local_root_path_bare_tilde_is_home() {
    unsafe {
      env::set_var("HOME", "/home/tester");
    }
    assert_eq!(expand_tilde("~"), PathBuf::from("/home/tester"));
  }

  #[test]
  fn local_root_path_no_tilde_passthrough() {
    assert_eq!(expand_tilde("/var/data"), PathBuf::from("/var/data"));
    // Leading "~user" is not expanded (we don't resolve other users).
    assert_eq!(expand_tilde("~other/data"), PathBuf::from("~other/data"));
  }

  #[test]
  fn check_validates_example_file() {
    let cfg = Config::check(Path::new("config.example.toml")).expect("check example");
    assert!(!cfg.storages.is_empty());
  }

  #[test]
  fn check_reports_missing_file() {
    let err =
      Config::check(Path::new("/nonexistent/omni-stream/config.toml")).expect_err("should fail");
    assert!(err.to_string().contains("config file not found"), "{err}");
  }

  #[test]
  fn embedded_example_matches_on_disk() {
    let on_disk = std::fs::read_to_string("config.example.toml").expect("read example");
    assert_eq!(Config::example_template(), on_disk);
  }

  #[test]
  fn pick_active_skips_missing_candidates_when_no_env_override() {
    let cands = vec![
      ConfigCandidate {
        label: "first",
        path: PathBuf::from("/missing/a"),
      },
      ConfigCandidate {
        label: "second",
        path: PathBuf::from("/exists/b"),
      },
      ConfigCandidate {
        label: "third",
        path: PathBuf::from("/exists/c"),
      },
    ];
    let exists = |p: &Path| p.starts_with("/exists");
    assert_eq!(
      pick_active(&cands, false, exists),
      Some(PathBuf::from("/exists/b")),
      "first existing candidate wins",
    );
  }

  #[test]
  fn pick_active_returns_none_when_nothing_exists() {
    let cands = vec![ConfigCandidate {
      label: "only",
      path: PathBuf::from("/m/a"),
    }];
    assert_eq!(pick_active(&cands, false, |_| false), None);
  }

  #[test]
  fn pick_active_honors_omni_config_even_when_missing() {
    let cands = vec![
      ConfigCandidate {
        label: "$OMNI_CONFIG",
        path: PathBuf::from("/missing-but-explicit"),
      },
      ConfigCandidate {
        label: "fallback",
        path: PathBuf::from("/exists/fallback"),
      },
    ];
    let exists = |p: &Path| p == Path::new("/exists/fallback");
    assert_eq!(
      pick_active(&cands, true, exists),
      Some(PathBuf::from("/missing-but-explicit")),
      "OMNI_CONFIG must not silently fall through — typos surface clearly",
    );
  }

  #[test]
  fn pick_active_empty_candidates_returns_none() {
    assert_eq!(pick_active(&[], false, |_| true), None);
    assert_eq!(pick_active(&[], true, |_| true), None);
  }

  #[test]
  fn candidates_always_include_cwd_fallback() {
    let cands = Config::candidates();
    assert!(!cands.is_empty(), "candidates must never be empty");
    assert!(
      cands.iter().any(|c| c.path == Path::new("config.toml")),
      "cwd fallback ./config.toml must be present: {cands:?}",
    );
  }

  #[test]
  fn storage_type_serializes_as_lowercase() {
    let raw = r#"
[[storages]]
name = "x"
type = "s3"
active = true
s3 = { bucket = "b" }
"#;
    let cfg: Config = toml::from_str(raw).expect("parse");
    assert_eq!(cfg.storages[0].r#type, StorageType::S3);
  }

  #[test]
  fn s3_fixed_bucket_treats_star_and_empty_as_none() {
    // None, "", whitespace-only, and the "*" sentinel all collapse to
    // multi-bucket mode. Trim first so " * " also counts as the sentinel —
    // copy-paste from docs shouldn't accidentally pin to a literal " * ".
    for raw in [None, Some(""), Some("   "), Some("*"), Some(" * ")] {
      let cfg = S3Config {
        bucket: raw.map(str::to_string),
        ..S3Config::default()
      };
      assert_eq!(
        cfg.fixed_bucket(),
        None,
        "expected multi-bucket for bucket={raw:?}"
      );
    }
  }

  #[test]
  fn s3_fixed_bucket_returns_value_when_set() {
    let cfg = S3Config {
      bucket: Some("my-bucket".into()),
      ..S3Config::default()
    };
    assert_eq!(cfg.fixed_bucket(), Some("my-bucket"));
    // Trim surrounding whitespace so a stray newline doesn't silently change
    // the bucket name the AWS SDK sees.
    let cfg = S3Config {
      bucket: Some("  my-bucket  ".into()),
      ..S3Config::default()
    };
    assert_eq!(cfg.fixed_bucket(), Some("my-bucket"));
  }

  #[test]
  fn validate_accepts_s3_without_bucket() {
    let raw = r#"
[[storages]]
name = "all"
type = "s3"
active = true
s3 = { endpoint = "http://localhost:9000" }
"#;
    let cfg = parse(raw);
    let s3 = cfg.storages[0].s3.as_ref().expect("s3");
    assert_eq!(s3.fixed_bucket(), None);
  }

  #[test]
  fn validate_accepts_s3_with_star_bucket() {
    let raw = r#"
[[storages]]
name = "all"
type = "s3"
active = true
s3 = { bucket = "*", endpoint = "http://localhost:9000" }
"#;
    let cfg = parse(raw);
    let s3 = cfg.storages[0].s3.as_ref().expect("s3");
    assert_eq!(s3.fixed_bucket(), None);
  }

  #[test]
  fn validate_rejects_bucket_with_slash() {
    // A '/' in the bucket name almost certainly means the operator pasted a
    // bucket/prefix path. Surface that as a config error rather than letting
    // every S3 call return a 400 from the gateway.
    let raw = r#"
[[storages]]
name = "broken"
type = "s3"
active = true
s3 = { bucket = "my-bucket/prefix" }
"#;
    let cfg: Config = toml::from_str(raw).expect("syntactic parse");
    assert!(cfg.validate().is_err());
  }
}
