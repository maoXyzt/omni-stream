//! Read-only Lance object store scoped to one storage-relative dataset.
use std::fmt;
use std::sync::{
  Arc,
  atomic::{AtomicBool, AtomicU64, Ordering},
};

use async_trait::async_trait;
use futures::{
  StreamExt, TryStreamExt,
  stream::{self, BoxStream},
};
use lance_io::object_store::{ObjectStore as LanceStore, ObjectStoreParams, ObjectStoreProvider};
use object_store::{path::Path, *};
use url::Url;

use crate::{
  error::AppError,
  storage::{GetOptions as StorageGet, StorageBackend},
};

const REQUEST_BYTES: u64 = 32 << 20;

#[derive(Clone)]
pub(super) struct DatasetStore {
  backend: Arc<dyn StorageBackend>,
  root: String,
  remaining: Arc<AtomicU64>,
  pub(super) read_limit_hit: Arc<AtomicBool>,
}

impl DatasetStore {
  pub fn new(backend: Arc<dyn StorageBackend>, root: &str) -> Self {
    Self {
      backend,
      root: root.to_owned(),
      remaining: Arc::new(AtomicU64::new(REQUEST_BYTES)),
      read_limit_hit: Default::default(),
    }
  }

  pub fn bytes_requested(&self) -> u64 {
    REQUEST_BYTES - self.remaining.load(Ordering::Relaxed)
  }

  fn key(&self, path: &Path) -> Result<String> {
    if path.as_ref() == "selected-file" {
      return Ok(self.root.clone());
    }
    let suffix = path
      .as_ref()
      .strip_prefix("dataset/")
      .ok_or_else(|| failure("invalid dataset path"))?;
    if suffix
      .split('/')
      .any(|p| p.is_empty() || p == "." || p == ".." || p.contains('\\'))
    {
      return Err(failure("invalid dataset member"));
    }
    Ok(format!("{}/{suffix}", self.root))
  }
}

impl fmt::Debug for DatasetStore {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("DatasetStore")
  }
}
impl fmt::Display for DatasetStore {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("OmniStream")
  }
}

fn failure(message: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Error {
  Error::Generic {
    store: "OmniStream",
    source: message.into(),
  }
}

fn modification_time(value: Option<&str>) -> chrono::DateTime<chrono::Utc> {
  value
    .and_then(|s| {
      s.parse::<i64>()
        .ok()
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
        .or_else(|| s.parse().ok())
    })
    .unwrap_or_default()
}

fn storage_error(path: &Path, error: AppError) -> Error {
  let path = path.to_string();
  if matches!(error, AppError::NotFound(_))
    || matches!(&error, AppError::Io(e) if e.kind() == std::io::ErrorKind::NotFound)
  {
    Error::NotFound {
      path,
      source: Box::new(error),
    }
  } else {
    failure(error)
  }
}

#[async_trait]
impl ObjectStoreProvider for DatasetStore {
  async fn new_store(&self, base: Url, params: &ObjectStoreParams) -> lance::Result<LanceStore> {
    // A private registry binds this virtual URI exclusively to the selected
    // backend. The SDK cannot resolve any other URI scheme from a manifest.
    Ok(LanceStore::new(
      Arc::new(self.clone()),
      base,
      Some(4096),
      None,
      false,
      false,
      4,
      0,
      params.storage_options(),
    ))
  }
}

#[async_trait]
impl ObjectStore for DatasetStore {
  async fn get_opts(&self, location: &Path, options: GetOptions) -> Result<GetResult> {
    let key = self.key(location)?;
    self
      .backend
      .check_read_scope(&self.root, &key)
      .await
      .map_err(|e| storage_error(location, e))?;
    let info = self
      .backend
      .stat(&key)
      .await
      .map_err(|e| storage_error(location, e))?;
    let meta = ObjectMeta {
      location: location.clone(),
      size: info.size,
      last_modified: modification_time(info.last_modified.as_deref()),
      e_tag: info.etag,
      version: None,
    };
    options.check_preconditions(&meta)?;
    let range = match options.range {
      Some(r) => r.as_range(meta.size).map_err(failure)?,
      None => 0..meta.size,
    };
    let payload = if options.head || range.is_empty() {
      stream::empty().boxed()
    } else {
      let length = range.end - range.start;
      self
        .remaining
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
          n.checked_sub(length)
        })
        .map_err(|_| {
          self.read_limit_hit.store(true, Ordering::Relaxed);
          failure("Lance preview read budget exceeded")
        })?;
      let response = self
        .backend
        .get_scoped_file(
          &self.root,
          &key,
          StorageGet {
            range: Some(format!("bytes={}-{}", range.start, range.end - 1)),
          },
        )
        .await
        .map_err(|e| storage_error(location, e))?;
      let expected_range = format!("bytes {}-{}/{}", range.start, range.end - 1, meta.size);
      if !response.is_partial
        || response.content_length != Some(length)
        || response.content_range.as_deref() != Some(&expected_range)
      {
        return Err(failure("storage did not honor the requested range"));
      }
      response.body.map_err(failure).boxed()
    };
    Ok(GetResult {
      payload: GetResultPayload::Stream(payload),
      meta,
      range,
      attributes: Default::default(),
      extensions: Default::default(),
    })
  }

  fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, Result<ObjectMeta>> {
    let store = self.clone();
    let prefix = prefix.cloned().unwrap_or_default();
    Box::pin(async_stream::try_stream! {
      // Version discovery only. Never enumerate dataset payloads.
      if prefix.as_ref() != "dataset/_versions" { Err(failure("unsupported Lance listing"))?; }
      let member = store.key(&prefix)?;
      let key = format!("{member}/");
      store.backend.check_read_scope(&store.root, &key).await.map_err(|e| storage_error(&prefix,e))?;
      let mut token = None;
      loop {
        let page = store.backend.list_files(&key, token).await.map_err(|e| storage_error(&prefix,e))?;
        for entry in page.entries.into_iter().filter(|e| !e.is_dir) {
          let name = entry.key.strip_prefix(&key).ok_or_else(|| failure("invalid listing entry"))?;
          yield ObjectMeta {location: prefix.clone().join(name), size: entry.size, last_modified: modification_time(entry.last_modified.as_deref()), e_tag: None, version: None};
        }
        token = page.next_token;
        if token.is_none() { break; }
      }
    })
  }

  async fn list_with_delimiter(&self, prefix: Option<&Path>) -> Result<ListResult> {
    let objects: Vec<_> = self.list(prefix).take(10001).try_collect().await?;
    if objects.len() > 10000 {
      return Err(failure("too many manifests to list in one preview"));
    }
    Ok(ListResult {
      extensions: Default::default(),
      common_prefixes: Vec::new(),
      objects,
    })
  }

  async fn put_opts(&self, _: &Path, _: PutPayload, _: PutOptions) -> Result<PutResult> {
    Err(failure("read-only"))
  }
  async fn put_multipart_opts(
    &self,
    _: &Path,
    _: PutMultipartOptions,
  ) -> Result<Box<dyn MultipartUpload>> {
    Err(failure("read-only"))
  }
  fn delete_stream(&self, _: BoxStream<'static, Result<Path>>) -> BoxStream<'static, Result<Path>> {
    stream::once(async { Err(failure("read-only")) }).boxed()
  }
  async fn copy_opts(&self, _: &Path, _: &Path, _: CopyOptions) -> Result<()> {
    Err(failure("read-only"))
  }
}

#[cfg(test)]
mod tests {
  use super::modification_time;
  #[test]
  fn accepts_both_backend_timestamp_formats() {
    assert_eq!(
      modification_time(Some("1712345678")).timestamp(),
      1712345678
    );
    assert_eq!(
      modification_time(Some("2024-04-05T19:34:38Z")).timestamp(),
      1712345678
    );
  }
}
