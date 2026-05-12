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

        let (start, end, is_partial, content_range) = if let Some(range) = opts.range {
            let (s, e) = parse_range(&range, total_size)?;
            file.seek(SeekFrom::Start(s)).await?;
            (s, e, true, Some(format!("bytes {s}-{e}/{total_size}")))
        } else {
            let end = total_size.saturating_sub(1);
            (0, end, false, None)
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

    async fn list_files(
        &self,
        prefix: &str,
        token: Option<String>,
    ) -> Result<ListResult, AppError> {
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
            if key.as_str() <= cursor {
                continue;
            }
            // Skip work for entries the heap would immediately evict.
            if heap.len() == cap {
                if let Some(top) = heap.peek() {
                    if key >= top.0.key {
                        continue;
                    }
                }
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
        let mut entries: Vec<FileEntry> =
            heap.into_sorted_vec().into_iter().map(|w| w.0).collect();
        let has_more = entries.len() > LIST_PAGE_SIZE;
        if has_more {
            entries.truncate(LIST_PAGE_SIZE);
        }
        let next_token = if has_more {
            entries.last().map(|e| e.key.clone())
        } else {
            None
        };

        Ok(ListResult {
            entries,
            next_token,
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
}
