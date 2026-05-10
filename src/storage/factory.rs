use std::path::Path;

use anyhow::{Context, anyhow, bail};

use super::StorageBackend;
use super::local::LocalFsBackend;
use super::s3::S3Backend;
use crate::config::{Config, StorageType};

/// Build a storage backend from validated configuration.
/// Picks the entry with `active = true`; falls back to the first storage if none is active.
pub async fn create_backend(cfg: &Config) -> anyhow::Result<Box<dyn StorageBackend>> {
    let entry = cfg
        .active_storage()
        .ok_or_else(|| anyhow!("no storages defined in configuration"))?;

    tracing::info!(
        storage.name = entry.name.as_str(),
        storage.r#type = ?entry.r#type,
        storage.active = entry.active,
        "activating storage backend"
    );

    let backend: Box<dyn StorageBackend> = match entry.r#type {
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
            Box::new(backend)
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
            Box::new(LocalFsBackend::new(local.root_path.clone()))
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
