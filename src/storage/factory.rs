use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, anyhow, bail};

use super::StorageBackend;
use super::local::LocalFsBackend;
use super::s3::S3Backend;
use crate::config::{Config, StorageConfig, StorageType};

/// Identifying details we expose to the SPA for the storage-selection dialog.
/// Excludes credentials and other secrets — only the fields a human would use
/// to disambiguate one configured storage from another. Stored on both
/// successful and invalid entries so the dialog can still render context for
/// a storage whose backend init failed (e.g. show the bad `root_path` so the
/// operator can spot the typo).
#[derive(Clone, Debug)]
pub enum StorageDetails {
  S3 {
    /// `Some(name)` when the storage pins to a single bucket; `None` when
    /// it's a multi-bucket storage (root listing performs `ListBuckets`).
    /// Surfaced as JSON `null` to the SPA so it can render "(all buckets)"
    /// for that case.
    bucket: Option<String>,
    endpoint: Option<String>,
    region: Option<String>,
  },
  Local {
    root_path: String,
  },
}

/// A storage backend together with its declared name and type — used by handlers
/// to expose `/api/storages` without holding on to the full `Config`.
#[derive(Clone)]
pub struct NamedBackend {
  pub name: String,
  pub r#type: StorageType,
  pub backend: Arc<dyn StorageBackend>,
  pub details: StorageDetails,
}

/// A configured storage entry whose backend failed to initialize. We keep
/// these in the registry (rather than dropping silently) so the API can
/// surface them to the UI as "invalid" and the handler layer can return a
/// clear error when traffic targets one — instead of pretending the storage
/// was never configured.
#[derive(Clone)]
pub struct InvalidStorageEntry {
  pub name: String,
  pub r#type: StorageType,
  pub reason: String,
  pub details: StorageDetails,
}

/// Pluck identifying details out of the parsed config. Missing sub-tables
/// (e.g. `type=s3` with no `[storage.s3]`) yield empty placeholders — the
/// init step below will still bail with a clear error, and the dialog renders
/// "—" for any field we couldn't pull.
fn extract_details(entry: &StorageConfig) -> StorageDetails {
  match entry.r#type {
    StorageType::S3 => entry
      .s3
      .as_ref()
      .map(|s3| StorageDetails::S3 {
        // Multi-bucket sentinels ("", "*", whitespace) collapse to `None`
        // so the UI renders "(all buckets)" instead of leaking the literal
        // config value.
        bucket: s3.fixed_bucket().map(str::to_string),
        endpoint: s3.endpoint.clone(),
        region: s3.region.clone(),
      })
      .unwrap_or(StorageDetails::S3 {
        bucket: None,
        endpoint: None,
        region: None,
      }),
    StorageType::Local => entry
      .local
      .as_ref()
      .map(|local| StorageDetails::Local {
        root_path: local.root_path.display().to_string(),
      })
      .unwrap_or(StorageDetails::Local {
        root_path: String::new(),
      }),
  }
}

/// Container of all configured backends with a designated default. Lenient:
/// entries that fail to init land in `invalid` rather than aborting startup,
/// **except** the default storage — without a working default the server
/// can't serve a single request, so init bails in that case.
pub struct BackendRegistry {
  pub backends: HashMap<String, NamedBackend>,
  pub invalid: HashMap<String, InvalidStorageEntry>,
  /// Display order from the config file — includes both valid and invalid
  /// entries so the UI can render the full roster.
  pub order: Vec<String>,
  pub default_name: String,
}

/// Build all backends declared in configuration. The default is the entry with
/// `active = true`; if none is active, it falls back to the first defined
/// storage.
///
/// Failure handling:
/// - The default storage MUST init successfully — otherwise the server has
///   nothing to serve by default and we bail.
/// - Any other storage that fails to init is logged at `warn` level and
///   recorded in `invalid`. The UI receives `valid = false` for it, and any
///   request targeting it returns 503 with the failure reason. This lets a
///   single config file describe storages across environments (e.g. an S3
///   bucket reachable in prod but not on a dev workstation) without taking
///   down the whole process.
pub async fn create_registry(cfg: &Config) -> anyhow::Result<BackendRegistry> {
  if cfg.storages.is_empty() {
    bail!("no storages defined in configuration");
  }

  let default = cfg
    .active_storage()
    .ok_or_else(|| anyhow!("no storages defined in configuration"))?;
  let default_name = default.name.clone();

  let mut backends: HashMap<String, NamedBackend> = HashMap::new();
  let mut invalid: HashMap<String, InvalidStorageEntry> = HashMap::new();
  let mut order: Vec<String> = Vec::with_capacity(cfg.storages.len());
  let mut seen: std::collections::HashSet<String> =
    std::collections::HashSet::with_capacity(cfg.storages.len());

  for entry in &cfg.storages {
    // Duplicate names are still a hard error — we can't even tell which entry
    // the operator meant when traffic comes in with `?storage=<name>`.
    if !seen.insert(entry.name.clone()) {
      bail!("duplicate storage name: '{}'", entry.name);
    }

    let is_default = entry.name == default_name;
    tracing::info!(
        storage.name = entry.name.as_str(),
        storage.r#type = ?entry.r#type,
        storage.default = is_default,
        "registering storage backend"
    );

    // Extract once — details are independent of whether the backend init
    // succeeds, and both NamedBackend and InvalidStorageEntry carry them.
    let details = extract_details(entry);

    match build_one(entry).await {
      Ok(backend) => {
        backends.insert(
          entry.name.clone(),
          NamedBackend {
            name: entry.name.clone(),
            r#type: entry.r#type,
            backend,
            details,
          },
        );
      }
      Err(e) => {
        if is_default {
          // Adding context here matches the previous strict-mode error so
          // downstream tooling that grepped the message still works.
          return Err(e)
            .with_context(|| format!("default storage '{}' failed to initialize", entry.name));
        }
        // anyhow's Display walks the chain, which we want here so the warn
        // log captures both the top-level summary and the root cause.
        let reason = format!("{e:#}");
        tracing::warn!(
          storage.name = entry.name.as_str(),
          storage.r#type = ?entry.r#type,
          reason = %reason,
          "skipping invalid storage; UI will mark it [invalid] and requests targeting it return 503",
        );
        invalid.insert(
          entry.name.clone(),
          InvalidStorageEntry {
            name: entry.name.clone(),
            r#type: entry.r#type,
            reason,
            details,
          },
        );
      }
    }
    order.push(entry.name.clone());
  }

  Ok(BackendRegistry {
    backends,
    invalid,
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
      validate_local_root(&local.root_path)
        .with_context(|| format!("invalid root_path for storage '{}'", entry.name))?;
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
