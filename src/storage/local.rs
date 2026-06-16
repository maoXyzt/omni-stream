use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use bytes::Bytes;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use super::{
  FileEntry, FileMeta, GetOptions, ListResult, PutOptions, StorageBackend, StorageResponse,
};
use crate::error::AppError;

const LIST_PAGE_SIZE: usize = 1000;

/// Safely join a storage-relative `key` onto `root`, rejecting `..` and other
/// path components that would escape the root directory. Shared by
/// `LocalFsBackend` and the SQL convert handler.
pub(crate) fn safe_join(root: &Path, key: &str) -> Result<PathBuf, AppError> {
  let trimmed = key.trim_start_matches('/');
  let mut full = root.to_path_buf();
  for component in Path::new(trimmed).components() {
    match component {
      Component::Normal(c) => full.push(c),
      Component::CurDir => {}
      // Reject ParentDir / RootDir / Prefix to prevent escaping the root.
      _ => return Err(AppError::InvalidPath(key.to_string())),
    }
  }
  Ok(full)
}

/// How long a sorted listing stays cached. Short enough that external file
/// changes are visible within seconds; long enough to absorb the typical
/// "click through pages 1..N" browsing pattern without re-scanning.
const CACHE_TTL: Duration = Duration::from_secs(10);

/// Per-listing entry cap. Above this we still scan to serve the request but
/// don't keep the result around — a million-entry dir's keys would consume
/// ~80 MiB just in the cache, which is more than the cache is worth.
const CACHE_MAX_ENTRIES_PER_PREFIX: usize = 50_000;

/// How many distinct prefixes the cache holds at once. Insertion past this
/// cap evicts the oldest. Browsing a few directories rarely exceeds this.
const CACHE_MAX_PREFIXES: usize = 32;

/// Cached sorted view of a directory. We keep only `(key, is_dir,
/// is_symlink)` per entry — size and mtime are fetched on demand for the
/// page actually returned, so the cache never holds N stat() results worth
/// of memory.
struct CachedListing {
  keys: Arc<Vec<(String, bool, bool)>>,
  inserted_at: Instant,
}

#[derive(Default)]
pub struct ListingCache {
  inner: Mutex<HashMap<String, CachedListing>>,
}

impl ListingCache {
  fn get(&self, prefix: &str) -> Option<Arc<Vec<(String, bool, bool)>>> {
    let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
    let entry = guard.get(prefix)?;
    if entry.inserted_at.elapsed() >= CACHE_TTL {
      return None;
    }
    Some(entry.keys.clone())
  }

  /// Drop the cached listing for `prefix` so the next list re-scans. Called
  /// after a write / delete / move changed that directory's contents — the
  /// 10s TTL would otherwise serve a stale snapshot right after the user's
  /// own edit.
  fn invalidate(&self, prefix: &str) {
    self
      .inner
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .remove(prefix);
  }

  fn put(&self, prefix: &str, keys: Arc<Vec<(String, bool, bool)>>) {
    if keys.len() > CACHE_MAX_ENTRIES_PER_PREFIX {
      return;
    }
    let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
    // Drop anything past TTL on every write — keeps the table from growing
    // unbounded between requests, and the cost is bounded by `cap`.
    guard.retain(|_, v| v.inserted_at.elapsed() < CACHE_TTL);
    if guard.len() >= CACHE_MAX_PREFIXES {
      let oldest = guard
        .iter()
        .min_by_key(|(_, v)| v.inserted_at)
        .map(|(k, _)| k.clone());
      if let Some(k) = oldest {
        guard.remove(&k);
      }
    }
    guard.insert(
      prefix.to_string(),
      CachedListing {
        keys,
        inserted_at: Instant::now(),
      },
    );
  }
}

pub struct LocalFsBackend {
  root: PathBuf,
  follow_symlinks: bool,
  cache: Arc<ListingCache>,
}

impl LocalFsBackend {
  pub fn new(root: impl Into<PathBuf>, follow_symlinks: bool) -> Self {
    Self {
      root: root.into(),
      follow_symlinks,
      cache: Arc::new(ListingCache::default()),
    }
  }

  async fn leaf_metadata(&self, full: &Path) -> std::io::Result<std::fs::Metadata> {
    if self.follow_symlinks {
      fs::metadata(full).await
    } else {
      fs::symlink_metadata(full).await
    }
  }

  /// Cheap is_dir probe used during listing. Reads `d_type` from the
  /// readdir buffer on Linux/macOS without a stat syscall on every entry —
  /// dropping per-entry cost from "stat + open dirent" to "just dirent" when
  /// the FS reports the type. Filesystems that hand back `DT_UNKNOWN` (NFS
  /// over some servers, some FUSE backends) make `file_type()` fall back to
  /// `stat` internally; we tolerate that, just no win.
  ///
  /// Symlinks: when `follow_symlinks=true` we need the target's type, which
  /// `entry.file_type()` won't give us (it reports `Symlink`). Do a single
  /// follow `stat` only in that case. Most entries aren't symlinks so the
  /// extra branch costs nothing per file.
  /// Returns `(is_dir, is_symlink)`. `is_symlink` is taken directly from the
  /// dirent `d_type` — no extra syscall. When `follow_symlinks=true` and the
  /// entry is a symlink, a single follow `stat` determines the real target
  /// type (already happening in the original code; no new cost added).
  async fn quick_is_dir(
    &self,
    entry: &fs::DirEntry,
    entry_path: &Path,
  ) -> std::io::Result<(bool, bool)> {
    let ft = entry.file_type().await?;
    let is_symlink = ft.is_symlink();
    if is_symlink && self.follow_symlinks {
      // Resolve the link to find the real type. Fall back to lstat (i.e.
      // is_dir = false because we already know it's a symlink) if the
      // target's gone, so the entry still appears.
      let is_dir = fs::metadata(entry_path)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);
      return Ok((is_dir, true));
    }
    Ok((ft.is_dir(), is_symlink))
  }

  /// Resolve `prefix` to its filesystem path and confirm it's an existing
  /// directory. Pulled out because both `list_files` and `list_files_walking`
  /// need the same pre-flight check before they touch the cache or scan.
  async fn validate_dir(&self, prefix: &str) -> Result<PathBuf, AppError> {
    let dir_path = self.resolve(prefix)?;
    let metadata = match self.leaf_metadata(&dir_path).await {
      Ok(m) => m,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
        return Err(AppError::NotFound(prefix.to_string()));
      }
      Err(e) => return Err(AppError::Io(e)),
    };
    if !metadata.is_dir() {
      return Err(AppError::Unsupported(format!("not a directory: {prefix}")));
    }
    Ok(dir_path)
  }

  /// Return the sorted `(key, is_dir, is_symlink)` listing for `prefix`,
  /// hitting the shared cache when fresh and falling back to one `read_dir`
  /// pass + `quick_is_dir` probes (no per-entry stat) when not.
  async fn ensure_keys_cached(
    &self,
    prefix: &str,
    dir_path: &Path,
  ) -> Result<Arc<Vec<(String, bool, bool)>>, AppError> {
    if let Some(hit) = self.cache.get(prefix) {
      return Ok(hit);
    }
    let mut keys: Vec<(String, bool, bool)> = Vec::new();
    let mut read = fs::read_dir(dir_path).await?;
    while let Some(entry) = read.next_entry().await? {
      let entry_path = entry.path();
      let (is_dir, is_symlink) = self.quick_is_dir(&entry, &entry_path).await?;
      let key = self.relative_key(&entry_path, is_dir);
      keys.push((key, is_dir, is_symlink));
    }
    keys.sort_by(|a, b| a.0.cmp(&b.0));
    let arc = Arc::new(keys);
    self.cache.put(prefix, arc.clone());
    Ok(arc)
  }

  /// Stat the entries in `slice` and assemble FileEntry values. Only the
  /// entries we're about to return go through `stat` — the rest of the
  /// listing stays as cheap (key, is_dir) pairs in the cache. Directories
  /// don't need a stat (size + mtime are conventionally 0 / null).
  ///
  /// Vanished files (mtime stat fails between scan and now) are kept in
  /// the listing with size=0 / mtime=null so the UI still shows them. The
  /// next refresh will drop them.
  async fn materialize_entries(
    &self,
    slice: &[(String, bool, bool)],
  ) -> Result<Vec<FileEntry>, AppError> {
    let mut out = Vec::with_capacity(slice.len());
    for (key, is_dir, is_symlink) in slice {
      let (size, last_modified) = if *is_dir {
        (0u64, None)
      } else {
        let entry_path = self.root.join(key.trim_end_matches('/'));
        let meta = if self.follow_symlinks {
          fs::metadata(&entry_path).await
        } else {
          fs::symlink_metadata(&entry_path).await
        };
        match meta {
          Ok(m) => (
            m.len(),
            m.modified().ok().and_then(system_time_to_unix_string),
          ),
          Err(_) => (0, None),
        }
      };
      out.push(FileEntry {
        key: key.clone(),
        size,
        last_modified,
        is_dir: *is_dir,
        is_symlink: *is_symlink,
      });
    }
    Ok(out)
  }

  fn resolve(&self, path: &str) -> Result<PathBuf, AppError> {
    safe_join(&self.root, path)
  }

  fn relative_key(&self, full: &Path, is_dir: bool) -> String {
    let rel = full
      .strip_prefix(&self.root)
      .unwrap_or(full)
      .to_string_lossy()
      .replace('\\', "/");
    if is_dir && !rel.is_empty() && !rel.ends_with('/') {
      format!("{rel}/")
    } else {
      rel
    }
  }
}

fn parse_range(header: &str, total_size: u64) -> Result<(u64, u64), AppError> {
  let raw = header
    .trim()
    .strip_prefix("bytes=")
    .ok_or_else(|| AppError::InvalidRange(header.to_string()))?;

  // Multi-range is not supported; only honor the first spec.
  let part = raw.split(',').next().unwrap_or("").trim();
  if part.is_empty() {
    return Err(AppError::InvalidRange(header.to_string()));
  }

  let (s, e) = part
    .split_once('-')
    .ok_or_else(|| AppError::InvalidRange(header.to_string()))?;

  if total_size == 0 {
    return Err(AppError::InvalidRange(header.to_string()));
  }

  let (start, end) = match (s.is_empty(), e.is_empty()) {
    (true, true) => return Err(AppError::InvalidRange(header.to_string())),
    // Suffix range: bytes=-N → last N bytes.
    (true, false) => {
      let suffix: u64 = e
        .parse()
        .map_err(|_| AppError::InvalidRange(header.to_string()))?;
      if suffix == 0 {
        return Err(AppError::InvalidRange(header.to_string()));
      }
      let suffix = suffix.min(total_size);
      (total_size - suffix, total_size - 1)
    }
    // Open-ended range: bytes=N- → from N to end.
    (false, true) => {
      let start: u64 = s
        .parse()
        .map_err(|_| AppError::InvalidRange(header.to_string()))?;
      (start, total_size - 1)
    }
    (false, false) => {
      let start: u64 = s
        .parse()
        .map_err(|_| AppError::InvalidRange(header.to_string()))?;
      let end: u64 = e
        .parse()
        .map_err(|_| AppError::InvalidRange(header.to_string()))?;
      (start, end.min(total_size - 1))
    }
  };

  if start >= total_size || start > end {
    return Err(AppError::InvalidRange(header.to_string()));
  }

  Ok((start, end))
}

fn system_time_to_unix_string(t: SystemTime) -> Option<String> {
  t.duration_since(SystemTime::UNIX_EPOCH)
    .ok()
    .map(|d| d.as_secs().to_string())
}

/// The directory prefix a key lives under, in the same form the listing cache
/// is keyed by (trailing slash, or `""` for the root). `"a/b/c.txt"` →
/// `"a/b/"`, `"c.txt"` → `""`. Used to invalidate the right cache entry after
/// a write / delete / move.
fn parent_prefix(key: &str) -> String {
  let trimmed = key.trim_end_matches('/');
  match trimmed.rfind('/') {
    Some(i) => trimmed[..=i].to_string(),
    None => String::new(),
  }
}

/// A unique-enough temp filename for the write-then-rename atomic publish.
/// Lives in the target's own directory so the rename stays on one filesystem.
fn temp_name() -> String {
  let nanos = SystemTime::now()
    .duration_since(SystemTime::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  format!(".omni-tmp-{}-{}", std::process::id(), nanos)
}

#[async_trait]
impl StorageBackend for LocalFsBackend {
  async fn get_file(&self, path: &str, opts: GetOptions) -> Result<StorageResponse, AppError> {
    let full = self.resolve(path)?;

    let metadata = match self.leaf_metadata(&full).await {
      Ok(m) => m,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
        return Err(AppError::NotFound(path.to_string()));
      }
      Err(e) => return Err(AppError::Io(e)),
    };

    if !self.follow_symlinks && metadata.file_type().is_symlink() {
      return Err(AppError::Forbidden(format!(
        "symlink traversal disabled: {path}"
      )));
    }

    if metadata.is_dir() {
      return Err(AppError::Unsupported(format!(
        "path is a directory: {path}"
      )));
    }

    let total_size = metadata.len();
    let mut file = fs::File::open(&full).await?;

    // Empty files: ignore any Range and return an empty 200. RFC 7233 lets us
    // 416 here, but that's user-hostile — the text previewer would surface
    // "Range Not Satisfiable" for a perfectly valid 0-byte file.
    let (start, end, is_partial, content_range) = if total_size == 0 {
      (0, 0, false, None)
    } else if let Some(range) = opts.range {
      let (s, e) = parse_range(&range, total_size)?;
      file.seek(SeekFrom::Start(s)).await?;
      (s, e, true, Some(format!("bytes {s}-{e}/{total_size}")))
    } else {
      (0, total_size - 1, false, None)
    };

    let length = if total_size == 0 { 0 } else { end - start + 1 };
    let limited = file.take(length);
    let stream = ReaderStream::new(limited);

    let content_type = mime_guess::from_path(&full).first_raw().map(str::to_string);
    let last_modified = metadata
      .modified()
      .ok()
      .and_then(system_time_to_unix_string);

    Ok(StorageResponse {
      body: Box::pin(stream),
      content_length: Some(length),
      content_type,
      etag: None,
      last_modified,
      content_range,
      is_partial,
    })
  }

  async fn list_files(&self, prefix: &str, token: Option<String>) -> Result<ListResult, AppError> {
    let dir_path = self.validate_dir(prefix).await?;
    let keys = self.ensure_keys_cached(prefix, &dir_path).await?;
    let cursor = token.as_deref().unwrap_or("");
    let start = keys.partition_point(|(k, _, _)| k.as_str() <= cursor);
    let end = (start + LIST_PAGE_SIZE).min(keys.len());
    let entries = self.materialize_entries(&keys[start..end]).await?;
    let next_token = if end < keys.len() {
      entries.last().map(|e| e.key.clone())
    } else {
      None
    };
    let total_pages = (keys.len() as u64).div_ceil(LIST_PAGE_SIZE as u64);
    Ok(ListResult {
      entries,
      next_token,
      walked_tokens: Vec::new(),
      total_pages: Some(total_pages),
    })
  }

  async fn list_files_walking(
    &self,
    prefix: &str,
    token: Option<String>,
    skip: u32,
  ) -> Result<ListResult, AppError> {
    // Shares `list_files`'s sorted-keys cache, so walking to any page is
    // bookkeeping over an already-sorted vec plus one stat pass over the
    // returned slice — no per-page fs scans.
    let dir_path = self.validate_dir(prefix).await?;
    let keys = self.ensure_keys_cached(prefix, &dir_path).await?;
    let cursor = token.as_deref().unwrap_or("");
    let start = keys.partition_point(|(k, _, _)| k.as_str() <= cursor);
    let total_pages = (keys.len() as u64).div_ceil(LIST_PAGE_SIZE as u64);
    let after_cursor = &keys[start..];

    if after_cursor.is_empty() {
      return Ok(ListResult {
        entries: Vec::new(),
        next_token: None,
        walked_tokens: Vec::new(),
        total_pages: Some(total_pages),
      });
    }

    // The last present page might be the target (skip-th) or — when the
    // listing ran out before the target — a smaller index. walked_tokens
    // lists one token per earlier page; next_token is set only when we
    // reached the target *and* there's a key past the page boundary.
    let last_present_page = (after_cursor.len() - 1) / LIST_PAGE_SIZE;
    let final_page_idx = last_present_page.min(skip as usize);
    let final_start = final_page_idx * LIST_PAGE_SIZE;
    let final_end = (final_start + LIST_PAGE_SIZE).min(after_cursor.len());
    let entries = self
      .materialize_entries(&after_cursor[final_start..final_end])
      .await?;

    let mut walked = Vec::with_capacity(final_page_idx);
    for i in 0..final_page_idx {
      // Token of page i+2 (1-indexed) = last key of page i+1.
      walked.push(after_cursor[(i + 1) * LIST_PAGE_SIZE - 1].0.clone());
    }

    let reached_target = final_page_idx == skip as usize;
    let has_more_after_target = reached_target && after_cursor.len() > final_end;
    let next_token = if has_more_after_target {
      entries.last().map(|e| e.key.clone())
    } else {
      None
    };

    Ok(ListResult {
      entries,
      next_token,
      walked_tokens: walked,
      total_pages: Some(total_pages),
    })
  }

  async fn stat(&self, path: &str) -> Result<FileMeta, AppError> {
    let full = self.resolve(path)?;
    let metadata = match self.leaf_metadata(&full).await {
      Ok(m) => m,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
        return Err(AppError::NotFound(path.to_string()));
      }
      Err(e) => return Err(AppError::Io(e)),
    };

    let is_dir = metadata.is_dir();
    let content_type = if is_dir {
      None
    } else {
      mime_guess::from_path(&full).first_raw().map(str::to_string)
    };

    Ok(FileMeta {
      path: path.to_string(),
      size: if is_dir { 0 } else { metadata.len() },
      etag: None,
      content_type,
      last_modified: metadata
        .modified()
        .ok()
        .and_then(system_time_to_unix_string),
      is_dir,
    })
  }

  async fn put_file(
    &self,
    path: &str,
    body: Bytes,
    opts: PutOptions,
  ) -> Result<FileMeta, AppError> {
    let full = self.resolve(path)?;

    // Inspect any existing entry with lstat (never follow): writing *through*
    // a symlink could land outside the root, so a symlink at the target is
    // always refused, regardless of `follow_symlinks`.
    match fs::symlink_metadata(&full).await {
      Ok(m) => {
        if m.file_type().is_symlink() {
          return Err(AppError::Forbidden(format!(
            "refusing to write through a symlink: {path}"
          )));
        }
        if m.is_dir() {
          return Err(AppError::Unsupported(format!(
            "path is a directory: {path}"
          )));
        }
        if !opts.overwrite {
          return Err(AppError::Conflict(format!(
            "file already exists: '{path}'. Set overwrite=true to replace it."
          )));
        }
      }
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
      Err(e) => return Err(AppError::Io(e)),
    }

    let parent = full
      .parent()
      .ok_or_else(|| AppError::InvalidPath(path.to_string()))?;
    fs::create_dir_all(parent).await?;

    // Atomic publish: write a temp file in the same directory, then rename it
    // over the target. Readers never observe a half-written file, and the
    // rename is atomic on a single filesystem. Clean up the temp on failure.
    //
    // `create_new(true)` (O_CREAT|O_EXCL) refuses to open if the temp path
    // already exists — including as a symlink, which it will NOT follow. That
    // closes a symlink-swap window: even though the temp lives inside the
    // storage root (not a world-writable dir), an attacker who could pre-plant
    // a symlink there must not be able to redirect our write through it.
    let tmp = parent.join(temp_name());
    let write_res = async {
      let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .await?;
      file.write_all(&body).await?;
      file.sync_all().await
    }
    .await;
    if let Err(e) = write_res {
      let _ = fs::remove_file(&tmp).await;
      return Err(AppError::Io(e));
    }
    if let Err(e) = fs::rename(&tmp, &full).await {
      let _ = fs::remove_file(&tmp).await;
      return Err(AppError::Io(e));
    }

    self.cache.invalidate(&parent_prefix(path));
    self.stat(path).await
  }

  async fn delete_file(&self, path: &str) -> Result<(), AppError> {
    let full = self.resolve(path)?;
    let meta = match fs::symlink_metadata(&full).await {
      Ok(m) => m,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
        return Err(AppError::NotFound(path.to_string()));
      }
      Err(e) => return Err(AppError::Io(e)),
    };
    if meta.file_type().is_symlink() {
      return Err(AppError::Forbidden(format!(
        "refusing to delete a symlink: {path}"
      )));
    }
    if meta.is_dir() {
      return Err(AppError::Unsupported(format!(
        "refusing to delete a directory: {path}"
      )));
    }
    fs::remove_file(&full).await?;
    self.cache.invalidate(&parent_prefix(path));
    Ok(())
  }

  async fn move_file(&self, from: &str, to: &str, opts: PutOptions) -> Result<FileMeta, AppError> {
    let from_full = self.resolve(from)?;
    let to_full = self.resolve(to)?;

    let from_meta = match fs::symlink_metadata(&from_full).await {
      Ok(m) => m,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
        return Err(AppError::NotFound(from.to_string()));
      }
      Err(e) => return Err(AppError::Io(e)),
    };
    if from_meta.file_type().is_symlink() {
      return Err(AppError::Forbidden(format!(
        "refusing to move a symlink: {from}"
      )));
    }
    if from_meta.is_dir() {
      return Err(AppError::Unsupported(format!(
        "refusing to move a directory: {from}"
      )));
    }

    match fs::symlink_metadata(&to_full).await {
      Ok(m) => {
        if m.file_type().is_symlink() {
          return Err(AppError::Forbidden(format!(
            "refusing to overwrite a symlink: {to}"
          )));
        }
        if m.is_dir() {
          return Err(AppError::Unsupported(format!(
            "target is a directory: {to}"
          )));
        }
        if !opts.overwrite {
          return Err(AppError::Conflict(format!(
            "file already exists: '{to}'. Set overwrite=true to replace it."
          )));
        }
      }
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
      Err(e) => return Err(AppError::Io(e)),
    }

    if let Some(parent) = to_full.parent() {
      fs::create_dir_all(parent).await?;
    }
    fs::rename(&from_full, &to_full).await?;

    self.cache.invalidate(&parent_prefix(from));
    self.cache.invalidate(&parent_prefix(to));
    self.stat(to).await
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::UNIX_EPOCH;

  fn tempdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "omni-list-test-{}-{}",
      std::process::id(),
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos(),
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn seed_files(root: &Path, names: &[&str]) {
    for name in names {
      std::fs::write(root.join(name), b"x").unwrap();
    }
  }

  #[tokio::test]
  async fn list_files_returns_sorted_single_page() {
    let dir = tempdir();
    // Insertion order intentionally not sorted so we exercise ordering.
    seed_files(&dir, &["c.txt", "a.txt", "b.txt"]);
    let backend = LocalFsBackend::new(&dir, false);

    let res = backend.list_files("", None).await.unwrap();
    let keys: Vec<&str> = res.entries.iter().map(|e| e.key.as_str()).collect();
    assert_eq!(keys, vec!["a.txt", "b.txt", "c.txt"]);
    assert!(res.next_token.is_none());
    // 3 entries fit in one LIST_PAGE_SIZE-sized page.
    assert_eq!(res.total_pages, Some(1));
  }

  #[tokio::test]
  async fn list_files_total_pages_spans_multiple_pages() {
    let dir = tempdir();
    let total = LIST_PAGE_SIZE + LIST_PAGE_SIZE / 2; // 1500
    for i in 0..total {
      std::fs::write(dir.join(format!("f-{i:06}.bin")), b"x").unwrap();
    }
    let backend = LocalFsBackend::new(&dir, false);

    let first = backend.list_files("", None).await.unwrap();
    assert_eq!(first.total_pages, Some(2));
    // Same count surfaces on subsequent pages so the client can render
    // "Page X / Y" on any page, not just the first.
    let second = backend
      .list_files("", first.next_token.clone())
      .await
      .unwrap();
    assert_eq!(second.total_pages, Some(2));
  }

  #[tokio::test]
  async fn list_files_walking_matches_repeated_list_files() {
    // 1500 files → 2 pages. Verify the single-scan override produces the
    // same entries + tokens the naïve "call list_files twice" path would,
    // but in one scan instead of two.
    let dir = tempdir();
    let total = LIST_PAGE_SIZE + LIST_PAGE_SIZE / 2;
    for i in 0..total {
      std::fs::write(dir.join(format!("f-{i:06}.bin")), b"x").unwrap();
    }
    let backend = LocalFsBackend::new(&dir, false);

    // Baseline: walk via list_files twice.
    let p1 = backend.list_files("", None).await.unwrap();
    let p2 = backend.list_files("", p1.next_token.clone()).await.unwrap();

    // Same starting state, single shot.
    let walked = backend.list_files_walking("", None, 1).await.unwrap();
    assert_eq!(
      walked.entries.iter().map(|e| &e.key).collect::<Vec<_>>(),
      p2.entries.iter().map(|e| &e.key).collect::<Vec<_>>(),
    );
    assert_eq!(walked.next_token, p2.next_token);
    assert_eq!(walked.walked_tokens, vec![p1.next_token.clone().unwrap()],);
    assert_eq!(walked.total_pages, Some(2));
  }

  #[tokio::test]
  async fn list_files_walking_skip_zero_matches_list_files() {
    let dir = tempdir();
    seed_files(&dir, &["a.txt", "b.txt", "c.txt"]);
    let backend = LocalFsBackend::new(&dir, false);

    let one_shot = backend.list_files("", None).await.unwrap();
    let walked = backend.list_files_walking("", None, 0).await.unwrap();
    assert_eq!(
      walked.entries.iter().map(|e| &e.key).collect::<Vec<_>>(),
      one_shot.entries.iter().map(|e| &e.key).collect::<Vec<_>>(),
    );
    assert_eq!(walked.next_token, one_shot.next_token);
    assert!(walked.walked_tokens.is_empty());
    assert_eq!(walked.total_pages, one_shot.total_pages);
  }

  #[tokio::test]
  async fn list_files_walking_truncates_when_listing_ends_early() {
    // 1500 files → 2 pages. Asking to skip 5 should yield the last page
    // (page 2) with walked_tokens = [token-of-page-1] (truncated).
    let dir = tempdir();
    let total = LIST_PAGE_SIZE + LIST_PAGE_SIZE / 2;
    for i in 0..total {
      std::fs::write(dir.join(format!("f-{i:06}.bin")), b"x").unwrap();
    }
    let backend = LocalFsBackend::new(&dir, false);
    let p1_token = backend.list_files("", None).await.unwrap().next_token;

    let walked = backend.list_files_walking("", None, 5).await.unwrap();
    // Last actual page is page 2, half-full.
    assert_eq!(walked.entries.len(), LIST_PAGE_SIZE / 2);
    assert!(walked.next_token.is_none());
    // We only walked off the end of one real page before running out.
    assert_eq!(walked.walked_tokens.len(), 1);
    assert_eq!(walked.walked_tokens[0], p1_token.unwrap());
    assert_eq!(walked.total_pages, Some(2));
  }

  #[tokio::test]
  async fn list_files_total_pages_zero_for_empty_dir() {
    let dir = tempdir();
    let backend = LocalFsBackend::new(&dir, false);

    let res = backend.list_files("", None).await.unwrap();
    assert!(res.entries.is_empty());
    assert_eq!(res.total_pages, Some(0));
  }

  #[tokio::test]
  async fn listing_cache_serves_a_second_call_from_memory() {
    // The first call scans the dir and primes the cache; the second call
    // shouldn't touch the dir at all. We verify that by mutating the dir
    // *between* the two calls — the second call's entries should still
    // reflect the pre-mutation state (cache hit), proving the second call
    // never re-scanned. This is a stronger assertion than just comparing
    // results, which would pass even if both calls re-scanned independently.
    let dir = tempdir();
    seed_files(&dir, &["a.txt", "b.txt", "c.txt"]);
    let backend = LocalFsBackend::new(&dir, false);

    let first = backend.list_files("", None).await.unwrap();
    assert_eq!(first.entries.len(), 3);

    // Add a file *after* the cache was warmed.
    std::fs::write(dir.join("d.txt"), b"x").unwrap();

    let second = backend.list_files("", None).await.unwrap();
    // Cache hit: still 3 entries, no `d.txt`.
    assert_eq!(second.entries.len(), 3);
    assert!(second.entries.iter().all(|e| e.key != "d.txt"));
  }

  #[tokio::test]
  async fn listing_cache_shared_between_list_files_and_walking() {
    // `ensure_keys_cached` is used by both APIs. Warming the cache via
    // `list_files` should let `list_files_walking` reuse it — confirmed
    // by mutating the dir between the two and observing the walk uses the
    // pre-mutation snapshot.
    let dir = tempdir();
    let total = LIST_PAGE_SIZE + LIST_PAGE_SIZE / 2;
    for i in 0..total {
      std::fs::write(dir.join(format!("f-{i:06}.bin")), b"x").unwrap();
    }
    let backend = LocalFsBackend::new(&dir, false);

    let _warm = backend.list_files("", None).await.unwrap();
    // Drop a single file to invalidate the snapshot for the would-be live
    // listing. The cache still holds the original 1500-entry view.
    std::fs::remove_file(dir.join("f-000000.bin")).unwrap();

    let walked = backend.list_files_walking("", None, 1).await.unwrap();
    // Total pages still derives from the cached 1500 entries, not the
    // current 1499.
    assert_eq!(walked.total_pages, Some(2));
    assert_eq!(walked.walked_tokens.len(), 1);
  }

  #[tokio::test]
  async fn listing_cache_each_prefix_is_independent() {
    // Two different prefixes don't share cache state. Mutating one mustn't
    // shadow the other.
    let dir = tempdir();
    std::fs::create_dir_all(dir.join("a")).unwrap();
    std::fs::create_dir_all(dir.join("b")).unwrap();
    std::fs::write(dir.join("a").join("x.txt"), b"x").unwrap();
    let backend = LocalFsBackend::new(&dir, false);

    // Warm cache for both prefixes.
    let a1 = backend.list_files("a/", None).await.unwrap();
    let b1 = backend.list_files("b/", None).await.unwrap();
    assert_eq!(a1.entries.len(), 1);
    assert!(b1.entries.is_empty());

    // Add a file under `b/` — `a`'s cache and `b`'s cache are separate so
    // `a`'s next call still hits its own (unchanged) snapshot.
    std::fs::write(dir.join("b").join("y.txt"), b"y").unwrap();
    let a2 = backend.list_files("a/", None).await.unwrap();
    assert_eq!(a2.entries.len(), 1);
  }

  #[tokio::test]
  async fn list_files_cursor_returns_only_keys_after_token() {
    let dir = tempdir();
    seed_files(&dir, &["a.txt", "b.txt", "c.txt", "d.txt"]);
    let backend = LocalFsBackend::new(&dir, false);

    let res = backend
      .list_files("", Some("b.txt".to_string()))
      .await
      .unwrap();
    let keys: Vec<&str> = res.entries.iter().map(|e| e.key.as_str()).collect();
    assert_eq!(keys, vec!["c.txt", "d.txt"]);
    assert!(res.next_token.is_none());
  }

  #[tokio::test]
  async fn list_files_paginates_with_keyset_cursor() {
    // Force at least two full pages plus a partial tail to exercise the
    // heap eviction, `+1` lookahead, and cursor handoff between calls.
    let dir = tempdir();
    let total = LIST_PAGE_SIZE + LIST_PAGE_SIZE / 2;
    let names: Vec<String> = (0..total).map(|i| format!("f-{i:06}.bin")).collect();
    for name in &names {
      std::fs::write(dir.join(name), b"x").unwrap();
    }
    let backend = LocalFsBackend::new(&dir, false);

    let mut seen: Vec<String> = Vec::with_capacity(total);
    let mut token: Option<String> = None;
    let mut pages = 0;
    loop {
      pages += 1;
      assert!(pages <= 10, "pagination did not terminate");
      let res = backend.list_files("", token.clone()).await.unwrap();
      assert!(
        res.entries.len() <= LIST_PAGE_SIZE,
        "page exceeded LIST_PAGE_SIZE: {}",
        res.entries.len()
      );
      for e in &res.entries {
        seen.push(e.key.clone());
      }
      match res.next_token {
        Some(t) => token = Some(t),
        None => break,
      }
    }

    let mut expected: Vec<String> = names.clone();
    expected.sort();
    assert_eq!(seen, expected, "all keys returned exactly once, in order");
  }

  #[tokio::test]
  async fn get_file_empty_with_range_returns_ok_not_416() {
    // Regression: the text previewer always sends Range: bytes=0-1048575,
    // including for 0-byte files. Old behavior was 416 → "Failed to load
    // text" in the UI. We now ignore the Range header and serve an empty
    // 200 OK instead.
    let dir = tempdir();
    std::fs::write(dir.join("empty.txt"), b"").unwrap();
    let backend = LocalFsBackend::new(&dir, false);

    let resp = backend
      .get_file(
        "empty.txt",
        GetOptions {
          range: Some("bytes=0-1048575".into()),
        },
      )
      .await
      .expect("empty file with Range must not error");
    assert_eq!(resp.content_length, Some(0));
    assert!(!resp.is_partial);
    assert!(resp.content_range.is_none());
  }

  // --- writes ------------------------------------------------------------

  #[test]
  fn parent_prefix_strips_basename() {
    assert_eq!(parent_prefix("a/b/c.txt"), "a/b/");
    assert_eq!(parent_prefix("c.txt"), "");
    assert_eq!(parent_prefix("a/b/"), "a/");
    assert_eq!(parent_prefix("top/"), "");
  }

  #[tokio::test]
  async fn put_creates_new_file_and_nested_dirs() {
    let dir = tempdir();
    let backend = LocalFsBackend::new(&dir, true);

    let meta = backend
      .put_file(
        "sub/deep/new.txt",
        Bytes::from_static(b"hello"),
        PutOptions::default(),
      )
      .await
      .expect("create");
    assert_eq!(meta.size, 5);
    assert!(!meta.is_dir);
    assert_eq!(
      std::fs::read(dir.join("sub/deep/new.txt")).unwrap(),
      b"hello"
    );
  }

  #[tokio::test]
  async fn put_without_overwrite_conflicts_on_existing() {
    let dir = tempdir();
    seed_files(&dir, &["a.txt"]);
    let backend = LocalFsBackend::new(&dir, true);

    let err = backend
      .put_file("a.txt", Bytes::from_static(b"new"), PutOptions::default())
      .await
      .expect_err("should conflict");
    assert!(matches!(err, AppError::Conflict(_)));
    // Original content untouched.
    assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"x");
  }

  #[tokio::test]
  async fn put_with_overwrite_replaces() {
    let dir = tempdir();
    seed_files(&dir, &["a.txt"]);
    let backend = LocalFsBackend::new(&dir, true);

    backend
      .put_file(
        "a.txt",
        Bytes::from_static(b"replaced"),
        PutOptions {
          overwrite: true,
          ..Default::default()
        },
      )
      .await
      .expect("overwrite");
    assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"replaced");
  }

  #[tokio::test]
  async fn put_rejects_parent_traversal() {
    let dir = tempdir();
    let backend = LocalFsBackend::new(&dir, true);
    let err = backend
      .put_file(
        "../escape.txt",
        Bytes::from_static(b"x"),
        PutOptions::default(),
      )
      .await
      .expect_err("should reject ..");
    assert!(matches!(err, AppError::InvalidPath(_)));
  }

  #[tokio::test]
  async fn put_invalidates_listing_cache() {
    let dir = tempdir();
    seed_files(&dir, &["a.txt"]);
    let backend = LocalFsBackend::new(&dir, true);

    // Warm the cache.
    let first = backend.list_files("", None).await.unwrap();
    assert_eq!(first.entries.len(), 1);

    backend
      .put_file("b.txt", Bytes::from_static(b"x"), PutOptions::default())
      .await
      .unwrap();

    // Without invalidation the 10s TTL would still report 1 entry.
    let second = backend.list_files("", None).await.unwrap();
    assert_eq!(second.entries.len(), 2);
  }

  #[tokio::test]
  async fn delete_removes_file_and_404s_when_missing() {
    let dir = tempdir();
    seed_files(&dir, &["a.txt"]);
    let backend = LocalFsBackend::new(&dir, true);

    backend.delete_file("a.txt").await.expect("delete");
    assert!(!dir.join("a.txt").exists());

    let err = backend.delete_file("a.txt").await.expect_err("missing");
    assert!(matches!(err, AppError::NotFound(_)));
  }

  #[tokio::test]
  async fn delete_refuses_directory() {
    let dir = tempdir();
    std::fs::create_dir(dir.join("d")).unwrap();
    let backend = LocalFsBackend::new(&dir, true);
    let err = backend.delete_file("d").await.expect_err("dir");
    assert!(matches!(err, AppError::Unsupported(_)));
  }

  #[tokio::test]
  async fn move_renames_file() {
    let dir = tempdir();
    seed_files(&dir, &["a.txt"]);
    let backend = LocalFsBackend::new(&dir, true);

    let meta = backend
      .move_file("a.txt", "sub/b.txt", PutOptions::default())
      .await
      .expect("move");
    assert_eq!(meta.path, "sub/b.txt");
    assert!(!dir.join("a.txt").exists());
    assert_eq!(std::fs::read(dir.join("sub/b.txt")).unwrap(), b"x");
  }

  #[tokio::test]
  async fn move_onto_itself_keeps_the_file() {
    // Local rename(x, x) is a safe no-op, so a same-path move with overwrite
    // must leave the file intact — unlike S3, where move is copy+delete and a
    // self-move is guarded against in the backend to avoid data loss.
    let dir = tempdir();
    std::fs::write(dir.join("a.txt"), b"keep").unwrap();
    let backend = LocalFsBackend::new(&dir, true);

    backend
      .move_file(
        "a.txt",
        "a.txt",
        PutOptions {
          overwrite: true,
          ..Default::default()
        },
      )
      .await
      .expect("self-move is a no-op");
    assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"keep");
  }

  #[tokio::test]
  async fn move_conflicts_on_existing_target() {
    let dir = tempdir();
    seed_files(&dir, &["a.txt", "b.txt"]);
    let backend = LocalFsBackend::new(&dir, true);

    let err = backend
      .move_file("a.txt", "b.txt", PutOptions::default())
      .await
      .expect_err("should conflict");
    assert!(matches!(err, AppError::Conflict(_)));
    // Both still present.
    assert!(dir.join("a.txt").exists());
    assert!(dir.join("b.txt").exists());
  }

  #[cfg(unix)]
  #[tokio::test]
  async fn put_refuses_to_write_through_symlink() {
    let dir = tempdir();
    std::fs::write(dir.join("real.txt"), b"orig").unwrap();
    std::os::unix::fs::symlink(dir.join("real.txt"), dir.join("link.txt")).unwrap();
    let backend = LocalFsBackend::new(&dir, true);

    let err = backend
      .put_file(
        "link.txt",
        Bytes::from_static(b"pwn"),
        PutOptions {
          overwrite: true,
          ..Default::default()
        },
      )
      .await
      .expect_err("should refuse symlink");
    assert!(matches!(err, AppError::Forbidden(_)));
    // Target of the symlink was not modified.
    assert_eq!(std::fs::read(dir.join("real.txt")).unwrap(), b"orig");
  }
}
