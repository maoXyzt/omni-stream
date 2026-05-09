use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow};
use directories::ProjectDirs;
use serde::Deserialize;

use crate::storage::s3::S3Config;

const APP_QUALIFIER: &str = "";
const APP_ORG: &str = "";
const APP_NAME: &str = "omni-stream";
const CONFIG_FILE: &str = "config.toml";

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

#[derive(Debug, Clone, Deserialize)]
pub struct LocalFsStorageConfig {
    pub root: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StorageConfig {
    S3(S3Config),
    LocalFs(LocalFsStorageConfig),
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
    pub storage: StorageConfig,
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let path = locate_config_file()
            .ok_or_else(|| anyhow!("no config file found; set OMNI_CONFIG or place config at $XDG_CONFIG_HOME/omni-stream/config.toml"))?;
        Self::load_from(&path)
    }

    pub fn load_from(path: &Path) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("read config: {}", path.display()))?;
        let mut cfg: Config = toml::from_str(&raw)
            .with_context(|| format!("parse config: {}", path.display()))?;
        cfg.apply_env_overrides();
        Ok(cfg)
    }

    fn apply_env_overrides(&mut self) {
        if let Ok(v) = env::var("OMNI_HOST") {
            self.server.host = v;
        }
        if let Ok(v) = env::var("OMNI_PORT")
            && let Ok(p) = v.parse::<u16>()
        {
            self.server.port = p;
        }

        match &mut self.storage {
            StorageConfig::S3(s3) => {
                if let Ok(v) = env::var("OMNI_S3_BUCKET") {
                    s3.bucket = v;
                }
                if let Ok(v) = env::var("OMNI_S3_REGION") {
                    s3.region = Some(v);
                }
                if let Ok(v) = env::var("OMNI_S3_ENDPOINT") {
                    s3.endpoint = Some(v);
                }
                if let Ok(v) = env::var("OMNI_S3_ACCESS_KEY_ID") {
                    s3.access_key_id = Some(v);
                }
                if let Ok(v) = env::var("OMNI_S3_SECRET_ACCESS_KEY") {
                    s3.secret_access_key = Some(v);
                }
                if let Ok(v) = env::var("OMNI_S3_SESSION_TOKEN") {
                    s3.session_token = Some(v);
                }
                if let Ok(v) = env::var("OMNI_S3_FORCE_PATH_STYLE") {
                    s3.force_path_style = parse_bool(&v);
                }
            }
            StorageConfig::LocalFs(local) => {
                if let Ok(v) = env::var("OMNI_LOCAL_ROOT") {
                    local.root = PathBuf::from(v);
                }
            }
        }
    }
}

fn parse_bool(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_s3_example() {
        let raw = std::fs::read_to_string("config.example.toml").unwrap();
        let cfg: Config = toml::from_str(&raw).expect("parse example.toml");
        assert_eq!(cfg.server.port, 8080);
        match cfg.storage {
            StorageConfig::S3(s3) => {
                assert_eq!(s3.bucket, "my-bucket");
                assert_eq!(s3.endpoint.as_deref(), Some("http://localhost:9000"));
                assert!(s3.force_path_style);
            }
            _ => panic!("expected S3 storage"),
        }
    }

    #[test]
    fn parses_local_fs_variant() {
        let raw = r#"
[server]
host = "0.0.0.0"
port = 9000

[storage]
type = "local_fs"
root = "/var/lib/omni-stream"
"#;
        let cfg: Config = toml::from_str(raw).expect("parse local_fs");
        match cfg.storage {
            StorageConfig::LocalFs(l) => {
                assert_eq!(l.root, PathBuf::from("/var/lib/omni-stream"));
            }
            _ => panic!("expected local_fs storage"),
        }
    }

    #[test]
    fn server_defaults_when_omitted() {
        let raw = r#"
[storage]
type = "local_fs"
root = "/tmp"
"#;
        let cfg: Config = toml::from_str(raw).expect("parse minimal");
        assert_eq!(cfg.server.host, "127.0.0.1");
        assert_eq!(cfg.server.port, 8080);
    }
}

/// XDG_CONFIG_HOME first, then platform default via `directories`, then ./config.toml.
fn locate_config_file() -> Option<PathBuf> {
    if let Ok(p) = env::var("OMNI_CONFIG") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }

    if let Ok(xdg) = env::var("XDG_CONFIG_HOME") {
        let p = PathBuf::from(xdg).join(APP_NAME).join(CONFIG_FILE);
        if p.is_file() {
            return Some(p);
        }
    }

    if let Some(dirs) = ProjectDirs::from(APP_QUALIFIER, APP_ORG, APP_NAME) {
        let p = dirs.config_dir().join(CONFIG_FILE);
        if p.is_file() {
            return Some(p);
        }
    }

    let cwd = PathBuf::from(CONFIG_FILE);
    if cwd.is_file() {
        return Some(cwd);
    }

    None
}
