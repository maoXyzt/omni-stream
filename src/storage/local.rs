use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use async_trait::async_trait;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use super::{
    FileEntry, FileMeta, GetOptions, ListResult, StorageBackend, StorageResponse,
};
use crate::error::AppError;

const LIST_PAGE_SIZE: usize = 1000;

pub struct LocalFsBackend {
    root: PathBuf,
}

impl LocalFsBackend {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
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
    async fn get_file(
        &self,
        path: &str,
        opts: GetOptions,
    ) -> Result<StorageResponse, AppError> {
        let full = self.resolve(path)?;

        let metadata = match fs::metadata(&full).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::NotFound(path.to_string()));
            }
            Err(e) => return Err(AppError::Io(e)),
        };

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
            (
                s,
                e,
                true,
                Some(format!("bytes {s}-{e}/{total_size}")),
            )
        } else {
            let end = total_size.saturating_sub(1);
            (0, end, false, None)
        };

        let length = if total_size == 0 { 0 } else { end - start + 1 };
        let limited = file.take(length);
        let stream = ReaderStream::new(limited);

        let content_type = mime_guess::from_path(&full)
            .first_raw()
            .map(str::to_string);
        let last_modified = metadata.modified().ok().and_then(system_time_to_unix_string);

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

        let metadata = match fs::metadata(&dir_path).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::NotFound(prefix.to_string()));
            }
            Err(e) => return Err(AppError::Io(e)),
        };

        if !metadata.is_dir() {
            return Err(AppError::Unsupported(format!(
                "not a directory: {prefix}"
            )));
        }

        let mut read = fs::read_dir(&dir_path).await?;
        let mut all: Vec<FileEntry> = Vec::new();
        while let Some(entry) = read.next_entry().await? {
            let ft = entry.file_type().await?;
            let entry_path = entry.path();
            let is_dir = ft.is_dir();
            let key = self.relative_key(&entry_path, is_dir);
            let (size, last_modified) = if is_dir {
                (0u64, None)
            } else {
                let m = entry.metadata().await?;
                (
                    m.len(),
                    m.modified().ok().and_then(system_time_to_unix_string),
                )
            };
            all.push(FileEntry {
                key,
                size,
                last_modified,
                is_dir,
            });
        }

        all.sort_by(|a, b| a.key.cmp(&b.key));

        let offset: usize = token
            .as_deref()
            .and_then(|t| t.parse().ok())
            .unwrap_or(0);
        let end = (offset + LIST_PAGE_SIZE).min(all.len());
        let entries: Vec<FileEntry> = if offset >= all.len() {
            Vec::new()
        } else {
            all[offset..end].to_vec()
        };
        let next_token = if end < all.len() {
            Some(end.to_string())
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
        let metadata = match fs::metadata(&full).await {
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
            mime_guess::from_path(&full)
                .first_raw()
                .map(str::to_string)
        };

        Ok(FileMeta {
            path: path.to_string(),
            size: if is_dir { 0 } else { metadata.len() },
            etag: None,
            content_type,
            last_modified: metadata.modified().ok().and_then(system_time_to_unix_string),
            is_dir,
        })
    }
}
