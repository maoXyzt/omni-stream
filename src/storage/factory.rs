use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, anyhow, bail};

use super::StorageBackend;
use super::local::LocalFsBackend;
use super::s3::S3Backend;
use crate::config::{Config, StorageConfig, StorageType};

/// A storage backend together with its declared name and type — used by handlers
/// to expose `/api/storages` without holding on to the full `Config`.
#[derive(Clone)]
pub struct NamedBackend {
    pub name: String,
    pub r#type: StorageType,
    pub backend: Arc<dyn StorageBackend>,
}

/// Container of all configured backends with a designated default.
pub struct BackendRegistry {
    pub backends: HashMap<String, NamedBackend>,
    pub order: Vec<String>,
    pub default_name: String,
}

/// Build all backends declared in configuration. The default is the entry with
/// `active = true`; if none is active, it falls back to the first defined storage.
pub async fn create_registry(cfg: &Config) -> anyhow::Result<BackendRegistry> {
    if cfg.storages.is_empty() {
        bail!("no storages defined in configuration");
    }

    let default = cfg
        .active_storage()
        .ok_or_else(|| anyhow!("no storages defined in configuration"))?;
    let default_name = default.name.clone();

    let mut backends: HashMap<String, NamedBackend> = HashMap::new();
    let mut order: Vec<String> = Vec::with_capacity(cfg.storages.len());
    for entry in &cfg.storages {
        if backends.contains_key(&entry.name) {
            bail!("duplicate storage name: '{}'", entry.name);
        }

        tracing::info!(
            storage.name = entry.name.as_str(),
            storage.r#type = ?entry.r#type,
            storage.default = entry.name == default_name,
            "registering storage backend"
        );

        let backend = build_one(entry).await?;
        backends.insert(
            entry.name.clone(),
            NamedBackend {
                name: entry.name.clone(),
                r#type: entry.r#type,
                backend,
            },
        );
        order.push(entry.name.clone());
    }

    Ok(BackendRegistry {
        backends,
        order,
        default_name,
    })
}

async fn build_one(entry: &StorageConfig) -> anyhow::Result<Arc<dyn StorageBackend>> {
    let backend: Arc<dyn StorageBackend> = match entry.r#type {
        StorageType::S3 => {
            let s3 = entry.s3.as_ref().ok_or_else(|| {
                anyhow!(
                    "storage '{}': type=s3 but [storages.s3] sub-table is missing",
                    entry.name
                )
            })?;
            let backend = S3Backend::new(s3)
                .await
                .with_context(|| format!("init S3 backend '{}'", entry.name))?;
            Arc::new(backend)
        }
        StorageType::Local => {
            let local = entry.local.as_ref().ok_or_else(|| {
                anyhow!(
                    "storage '{}': type=local but [storages.local] sub-table is missing",
                    entry.name
                )
            })?;
            validate_local_root(&local.root_path).with_context(|| {
                format!("invalid root_path for storage '{}'", entry.name)
            })?;
            Arc::new(LocalFsBackend::new(
                local.root_path.clone(),
                local.follow_symlinks,
            ))
        }
    };
    Ok(backend)
}

/// Verify that `root_path` exists, is a directory, and is read+write accessible by
/// the current process. Required by design §6: "must validate root_path".
fn validate_local_root(path: &Path) -> anyhow::Result<()> {
    let metadata = std::fs::metadata(path).with_context(|| {
        format!(
            "root_path does not exist or is unreadable: {}",
            path.display()
        )
    })?;
    if !metadata.is_dir() {
        bail!("root_path is not a directory: {}", path.display());
    }

    // POSIX permission bits aren't a reliable signal of effective access for the
    // current user (group/other perms, ACLs, immutable attrs, read-only mounts),
    // so probe with an actual create+delete in the directory.
    let probe = path.join(".omni-stream-write-probe");
    std::fs::write(&probe, b"")
        .with_context(|| format!("root_path is not writable: {}", path.display()))?;
    let _ = std::fs::remove_file(&probe);

    Ok(())
}
