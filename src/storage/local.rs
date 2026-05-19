use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use async_trait::async_trait;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use super::{FileEntry, FileMeta, GetOptions, ListResult, StorageBackend, StorageResponse};
use crate::error::AppError;

const LIST_PAGE_SIZE: usize = 1000;

/// Heap wrapper that orders `FileEntry` by `key` only, so a bounded max-heap
/// can keep just the smallest `LIST_PAGE_SIZE + 1` keys greater than the
/// cursor — memory stays O(page_size) instead of O(directory_size).
struct ByKey(FileEntry);

impl PartialEq for ByKey {
  fn eq(&self, other: &Self) -> bool {
    self.0.key == other.0.key
  }
}

impl Eq for ByKey {}

impl PartialOrd for ByKey {
  fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
    Some(self.cmp(other))
  }
}

impl Ord for ByKey {
  fn cmp(&self, other: &Self) -> Ordering {
    self.0.key.cmp(&other.0.key)
  }
}

pub struct LocalFsBackend {
  root: PathBuf,
  follow_symlinks: bool,
}

impl LocalFsBackend {
  pub fn new(root: impl Into<PathBuf>, follow_symlinks: bool) -> Self {
    Self {
      root: root.into(),
      follow_symlinks,
    }
  }

  async fn leaf_metadata(&self, full: &Path) -> std::io::Result<std::fs::Metadata> {
    if self.follow_symlinks {
      fs::metadata(full).await
    } else {
      fs::symlink_metadata(full).await
    }
  }

  fn resolve(&self, path: &str) -> Result<PathBuf, AppError> {
    let trimmed = path.trim_start_matches('/');
    let mut full = self.root.clone();
    for component in Path::new(trimmed).components() {
      match component {
        Component::Normal(c) => full.push(c),
        Component::CurDir => {}
        // Reject ParentDir / RootDir / Prefix to prevent escaping the root.
        _ => return Err(AppError::InvalidPath(path.to_string())),
      }
    }
    Ok(full)
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
    let dir_path = self.resolve(prefix)?;

    // The directory we list at must itself be a directory. We follow it if
    // configured to, so a symlinked root subdir works as expected.
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

    // Keyset cursor: `token` is the last `key` from the previous page.
    // We only admit entries whose key sorts strictly after it, then keep
    // a bounded max-heap of the smallest LIST_PAGE_SIZE + 1 candidates.
    // The +1 element tells us whether another page exists without a
    // second scan. Tokens are opaque to clients, so changing the encoding
    // (offset → key) is a backend-internal detail.
    let cursor = token.as_deref().unwrap_or("");
    let cap = LIST_PAGE_SIZE + 1;
    let mut heap: BinaryHeap<ByKey> = BinaryHeap::with_capacity(cap);
    // Count every visible entry in the directory regardless of cursor, so
    // the response can advertise the total page count. We scan the full dir
    // anyway (the cursor only narrows the heap), so this is essentially
    // free — one branch per entry, no allocations.
    let mut total_entries: u64 = 0;

    let mut read = fs::read_dir(&dir_path).await?;
    while let Some(entry) = read.next_entry().await? {
      let entry_path = entry.path();
      // For each child resolve type with follow/no-follow semantics. On
      // a dangling symlink with follow=true, fall back to lstat so the
      // entry stays visible rather than disappearing from the listing.
      let m = if self.follow_symlinks {
        match fs::metadata(&entry_path).await {
          Ok(m) => m,
          Err(_) => entry.metadata().await?,
        }
      } else {
        entry.metadata().await?
      };
      let is_dir = m.is_dir();
      let key = self.relative_key(&entry_path, is_dir);
      // Count every entry — even ones the cursor filter will skip below —
      // so the count reflects the directory total, not "remaining after
      // cursor". Pagination's `next_token` is opaque to clients, but the
      // total is shared metadata about the same listing.
      total_entries += 1;
      if key.as_str() <= cursor {
        continue;
      }
      // Skip work for entries the heap would immediately evict.
      if heap.len() == cap
        && let Some(top) = heap.peek()
        && key >= top.0.key
      {
        continue;
      }
      let (size, last_modified) = if is_dir {
        (0u64, None)
      } else {
        (
          m.len(),
          m.modified().ok().and_then(system_time_to_unix_string),
        )
      };
      heap.push(ByKey(FileEntry {
        key,
        size,
        last_modified,
        is_dir,
      }));
      if heap.len() > cap {
        heap.pop();
      }
    }

    // into_sorted_vec yields ascending order by key.
    let mut entries: Vec<FileEntry> = heap.into_sorted_vec().into_iter().map(|w| w.0).collect();
    let has_more = entries.len() > LIST_PAGE_SIZE;
    if has_more {
      entries.truncate(LIST_PAGE_SIZE);
    }
    let next_token = if has_more {
      entries.last().map(|e| e.key.clone())
    } else {
      None
    };

    // ceil(total_entries / LIST_PAGE_SIZE), with 0 → 0 (`Pager` hides
    // itself for empty dirs so 0 won't render).
    let total_pages = total_entries.div_ceil(LIST_PAGE_SIZE as u64);

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
    // The naïve trait default would call `list_files` `skip + 1` times, and
    // each call here re-scans the entire directory — for ~30k entries that's
    // 30 stat-heavy passes and easily a minute of wall time. This override
    // reads the dir *once*, keeps the smallest `(skip + 1)` pages' worth of
    // keys past the cursor in the bounded heap, then slices the sorted vec
    // into pages.
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

    let cursor = token.as_deref().unwrap_or("");
    // (skip + 1) full pages of entries + a lookahead element to detect
    // whether there's anything after the target page. The heap stays bounded
    // by request input — with `MAX_SKIP_PAGES = 100` the worst case is
    // ~100k FileEntry records (~10 MB), comfortably fits per-request.
    let cap = (skip as usize + 1) * LIST_PAGE_SIZE + 1;
    let mut heap: BinaryHeap<ByKey> = BinaryHeap::with_capacity(cap);
    let mut total_entries: u64 = 0;

    let mut read = fs::read_dir(&dir_path).await?;
    while let Some(entry) = read.next_entry().await? {
      let entry_path = entry.path();
      let m = if self.follow_symlinks {
        match fs::metadata(&entry_path).await {
          Ok(m) => m,
          Err(_) => entry.metadata().await?,
        }
      } else {
        entry.metadata().await?
      };
      let is_dir = m.is_dir();
      let key = self.relative_key(&entry_path, is_dir);
      total_entries += 1;
      if key.as_str() <= cursor {
        continue;
      }
      if heap.len() == cap
        && let Some(top) = heap.peek()
        && key >= top.0.key
      {
        continue;
      }
      let (size, last_modified) = if is_dir {
        (0u64, None)
      } else {
        (
          m.len(),
          m.modified().ok().and_then(system_time_to_unix_string),
        )
      };
      heap.push(ByKey(FileEntry {
        key,
        size,
        last_modified,
        is_dir,
      }));
      if heap.len() > cap {
        heap.pop();
      }
    }

    let entries: Vec<FileEntry> = heap.into_sorted_vec().into_iter().map(|w| w.0).collect();
    let total_pages = total_entries.div_ceil(LIST_PAGE_SIZE as u64);

    // Empty short-circuit: no entries past cursor at all.
    if entries.is_empty() {
      return Ok(ListResult {
        entries: Vec::new(),
        next_token: None,
        walked_tokens: Vec::new(),
        total_pages: Some(total_pages),
      });
    }

    // Slice the sorted vec into pages. The last present page might be the
    // target (skip-th) or — when the listing ran out before the target —
    // a smaller index. Either way, walked_tokens lists one token per
    // earlier page, and next_token is set only when the target was reached
    // *and* there's lookahead beyond.
    let last_present_page = (entries.len() - 1) / LIST_PAGE_SIZE;
    let final_page_idx = last_present_page.min(skip as usize);
    let final_start = final_page_idx * LIST_PAGE_SIZE;
    let final_end = (final_start + LIST_PAGE_SIZE).min(entries.len());
    let final_entries: Vec<FileEntry> = entries[final_start..final_end].to_vec();

    let mut walked = Vec::with_capacity(final_page_idx);
    for i in 0..final_page_idx {
      // Token of page i+2 (1-indexed) = last key of page i+1.
      walked.push(entries[(i + 1) * LIST_PAGE_SIZE - 1].key.clone());
    }

    let reached_target = final_page_idx == skip as usize;
    let has_more_after_target = reached_target && entries.len() > final_end;
    let next_token = if has_more_after_target {
      Some(final_entries.last().unwrap().key.clone())
    } else {
      None
    };

    Ok(ListResult {
      entries: final_entries,
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
    let p2 = backend
      .list_files("", p1.next_token.clone())
      .await
      .unwrap();

    // Same starting state, single shot.
    let walked = backend.list_files_walking("", None, 1).await.unwrap();
    assert_eq!(
      walked.entries.iter().map(|e| &e.key).collect::<Vec<_>>(),
      p2.entries.iter().map(|e| &e.key).collect::<Vec<_>>(),
    );
    assert_eq!(walked.next_token, p2.next_token);
    assert_eq!(
      walked.walked_tokens,
      vec![p1.next_token.clone().unwrap()],
    );
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
}
