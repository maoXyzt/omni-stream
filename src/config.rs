use std::env;
use std::fmt;
use std::path::PathBuf;

use anyhow::{Context, anyhow, bail};
use config::{Config as ConfigBuilder, Environment, File, FileFormat};
use directories::ProjectDirs;
use serde::Deserialize;

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

#[derive(Clone, Default, Deserialize)]
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
    pub root_path: PathBuf,
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

        cfg.validate()
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
                        anyhow!("storage '{}' has type=s3 but is missing the s3 sub-table", s.name)
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
        Ok(())
    }

    /// Return the entry with `active = true`, falling back to the first defined storage.
    /// `validate()` guarantees at least one storage exists, but we still return Option
    /// so callers handle the empty case explicitly without unwrap.
    pub fn active_storage(&self) -> Option<&StorageConfig> {
        self.storages
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
        assert_eq!(cfg.server.port, 8080);
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
    fn debug_masks_s3_secrets() {
        let s3 = S3Config {
            endpoint: Some("https://example.com".into()),
            bucket: "b".into(),
            access_key: Some("AKIDsecret".into()),
            secret_key: Some("supersecret".into()),
            region: Some("us-east-1".into()),
        };
        let dbg = format!("{s3:?}");
        assert!(!dbg.contains("AKIDsecret"), "access_key leaked: {dbg}");
        assert!(!dbg.contains("supersecret"), "secret_key leaked: {dbg}");
        assert!(dbg.contains("REDACTED"));
        assert!(dbg.contains("https://example.com"));
        assert!(dbg.contains("us-east-1"));
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
