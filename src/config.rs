use std::env;
use std::fmt;
use std::path::PathBuf;

use anyhow::{Context, anyhow, bail};
use config::{Config as ConfigBuilder, Environment, File, FileFormat};
use directories::ProjectDirs;
use serde::{Deserialize, Deserializer};

const APP_QUALIFIER: &str = "";
const APP_ORG: &str = "";
const APP_NAME: &str = "omni-stream";
const CONFIG_FILE: &str = "config.toml";
const ENV_PREFIX: &str = "OMNI";

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
  8080
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
  pub bucket: String,
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

impl Default for S3Config {
  fn default() -> Self {
    Self {
      endpoint: None,
      bucket: String::new(),
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
      .field("bucket", &self.bucket)
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
  if let Some(rest) = s.strip_prefix('~') {
    if rest.is_empty() || rest.starts_with('/') {
      if let Some(home) = env::var_os("HOME") {
        let mut p = PathBuf::from(home);
        let trimmed = rest.strip_prefix('/').unwrap_or(rest);
        if !trimmed.is_empty() {
          p.push(trimmed);
        }
        return p;
      }
    }
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
    let path = config_file_path();
    tracing::debug!(path = %path.display(), "loading omni-stream config");

    let path_str = path.to_string_lossy().into_owned();
    let exists = path.is_file();

    let raw = ConfigBuilder::builder()
      .add_source(
        File::with_name(&path_str)
          .format(FileFormat::Toml)
          .required(exists),
      )
      .add_source(
        Environment::with_prefix(ENV_PREFIX)
          .separator("_")
          .try_parsing(true),
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
          if s3.bucket.trim().is_empty() {
            bail!("storage '{}': s3.bucket is required", s.name);
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

fn config_file_path() -> PathBuf {
  if let Ok(p) = env::var("OMNI_CONFIG") {
    return PathBuf::from(p);
  }
  if let Ok(xdg) = env::var("XDG_CONFIG_HOME") {
    return PathBuf::from(xdg).join(APP_NAME).join(CONFIG_FILE);
  }
  if let Some(dirs) = ProjectDirs::from(APP_QUALIFIER, APP_ORG, APP_NAME) {
    return dirs.config_dir().join(CONFIG_FILE);
  }
  PathBuf::from(CONFIG_FILE)
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
    assert_eq!(cfg.server.port, 8080);
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
      bucket: "b".into(),
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
}
