use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use bytes::{Bytes, BytesMut};
use directories::ProjectDirs;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use crate::config::ThumbConfig;
use crate::error::AppError;
use crate::storage::{ByteStream, FileMeta, GetOptions, StorageBackend};

/// Materialized thumbnail runtime. `ThumbState::build` returns `None` when
/// thumbnails are disabled in config; the handler then short-circuits to 404.
pub struct ThumbState {
    cache_root: PathBuf,
    quality: u8,
    max_source_bytes: u64,
    sizes: Vec<u32>,
    default_size: u32,
    max_cache_bytes: u64,
    max_age: Duration,
    sweep_interval: Duration,
    in_flight: Mutex<HashMap<PathBuf, Arc<Notify>>>,
}

impl ThumbState {
    pub fn build(cfg: &ThumbConfig) -> anyhow::Result<Option<Arc<Self>>> {
        if !cfg.enabled {
            return Ok(None);
        }
        if cfg.sizes.is_empty() {
            return Err(anyhow!("thumbnails.sizes must list at least one width"));
        }
        if cfg.quality == 0 || cfg.quality > 100 {
            return Err(anyhow!("thumbnails.quality must be 1-100"));
        }

        let mut sizes = cfg.sizes.clone();
        sizes.sort_unstable();
        sizes.dedup();

        let default_size = if sizes.contains(&cfg.default_size) {
            cfg.default_size
        } else {
            // Snap to the smallest configured size ≥ the requested default,
            // falling back to the largest if none is large enough. Keeps the
            // resolver simple: `default_size` is always a member of `sizes`.
            *sizes
                .iter()
                .find(|s| **s >= cfg.default_size)
                .unwrap_or_else(|| sizes.last().unwrap())
        };

        let cache_root = resolve_cache_root(cfg.cache_path.as_deref())
            .context("resolve thumbnail cache_path")?;
        std::fs::create_dir_all(&cache_root)
            .with_context(|| format!("create thumb cache dir {}", cache_root.display()))?;

        tracing::info!(cache = %cache_root.display(), sizes = ?sizes, "thumbnails enabled");

        // Minimum 60s sweep interval so misconfigured runaway loops can't
        // peg a core; zero/very-small values almost always indicate a typo.
        let sweep_interval = Duration::from_secs(cfg.sweep_interval_secs.max(60));
        let max_age = Duration::from_secs(u64::from(cfg.max_age_days) * 86_400);

        Ok(Some(Arc::new(Self {
            cache_root,
            quality: cfg.quality,
            max_source_bytes: cfg.max_source_bytes,
            sizes,
            default_size,
            max_cache_bytes: cfg.max_cache_bytes,
            max_age,
            sweep_interval,
            in_flight: Mutex::new(HashMap::new()),
        })))
    }

    pub fn sweep_interval(&self) -> Duration {
        self.sweep_interval
    }

    /// Run one full eviction pass. Safe to call from a `spawn_blocking` task
    /// since it does sync filesystem walks. Returns counts so the caller can
    /// log how much was reclaimed.
    pub fn sweep_once(&self) -> std::io::Result<SweepStats> {
        sweep_cache(&self.cache_root, self.max_cache_bytes, self.max_age)
    }

    /// Snap an arbitrary requested width onto the configured ladder. We always
    /// round *up* so clients asking for "at least 200" get 320 (sharper), not
    /// 160 (blurry on retina).
    pub fn resolve_width(&self, requested: Option<u32>) -> u32 {
        match requested {
            None => self.default_size,
            Some(w) => *self
                .sizes
                .iter()
                .find(|s| **s >= w)
                .unwrap_or_else(|| self.sizes.last().unwrap()),
        }
    }

    fn cache_path_for(&self, storage_name: &str, key: &str, width: u32, version: &str) -> PathBuf {
        // One hash captures (key, width, source-version) — that triple is the
        // cache identity. Storage name lives in the dir prefix so operators can
        // wipe a single backend's thumbs with `rm -rf <cache>/<storage>`.
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        hasher.update(b"|");
        hasher.update(width.to_le_bytes());
        hasher.update(b"|");
        hasher.update(version.as_bytes());
        let digest = hasher.finalize();
        let hex = hex_encode(&digest);

        let mut p = self.cache_root.clone();
        p.push(sanitize_segment(storage_name));
        p.push(&hex[..2]);
        p.push(format!("{}.webp", &hex[2..]));
        p
    }

    /// Resolve (and generate if missing) the cache file for `key` at `width`.
    /// Returns the path of a JPEG on disk that the handler can stream.
    pub async fn ensure_thumb(
        self: &Arc<Self>,
        backend: &Arc<dyn StorageBackend>,
        storage_name: &str,
        key: &str,
        width: u32,
    ) -> Result<PathBuf, AppError> {
        let meta = backend.stat(key).await?;
        if meta.is_dir {
            return Err(AppError::Unsupported("cannot thumbnail a directory".into()));
        }
        let version = source_version(&meta);
        let cache_path = self.cache_path_for(storage_name, key, width, &version);

        if tokio::fs::try_exists(&cache_path).await.unwrap_or(false) {
            touch_on_hit(&cache_path).await;
            return Ok(cache_path);
        }

        // Singleflight: if another task is already generating this exact thumb,
        // wait on its notify and then re-read the cache. Without this, opening
        // five tabs to the same fresh directory does 5× the CPU and 5× the
        // backend GETs.
        let notify = match self.acquire_slot(&cache_path) {
            Slot::Wait(n) => {
                n.notified().await;
                return if tokio::fs::try_exists(&cache_path).await.unwrap_or(false) {
                    Ok(cache_path)
                } else {
                    Err(AppError::Backend("sibling thumbnail task failed".into()))
                };
            }
            Slot::Owned(n) => n,
        };

        // Guard releases the slot + notifies waiters even if generation panics
        // or returns early. Drop runs in any path leaving this fn.
        let _guard = SlotGuard {
            state: self.clone(),
            path: cache_path.clone(),
            notify,
        };

        // Double-check after locking the slot: a sibling may have just
        // finished and released between our first check and our acquire.
        if tokio::fs::try_exists(&cache_path).await.unwrap_or(false) {
            touch_on_hit(&cache_path).await;
            return Ok(cache_path);
        }

        // Pull the full source. Thumbnails need the whole bitmap (no useful
        // range trick) — but we cap the read so a malicious 4 GiB TIFF can't
        // OOM the server.
        let resp = backend.get_file(key, GetOptions::default()).await?;
        let bytes = collect_capped(resp.body, self.max_source_bytes).await?;

        let cp = cache_path.clone();
        let quality = self.quality;
        tokio::task::spawn_blocking(move || generate_webp(bytes, width, quality, &cp))
            .await
            .map_err(|e| AppError::Backend(format!("thumbnail task join: {e}")))??;

        Ok(cache_path)
    }

    fn acquire_slot(&self, path: &Path) -> Slot {
        let mut map = self
            .in_flight
            .lock()
            .expect("thumb in_flight mutex poisoned");
        if let Some(existing) = map.get(path) {
            Slot::Wait(existing.clone())
        } else {
            let n = Arc::new(Notify::new());
            map.insert(path.to_path_buf(), n.clone());
            Slot::Owned(n)
        }
    }
}

enum Slot {
    Owned(Arc<Notify>),
    Wait(Arc<Notify>),
}

struct SlotGuard {
    state: Arc<ThumbState>,
    path: PathBuf,
    notify: Arc<Notify>,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.state.in_flight.lock() {
            map.remove(&self.path);
        }
        self.notify.notify_waiters();
    }
}

fn source_version(meta: &FileMeta) -> String {
    let raw = meta
        .etag
        .as_deref()
        .or(meta.last_modified.as_deref())
        .unwrap_or("noversion");
    // ETags often arrive quoted (`"abc123"`); the literal quotes don't add
    // information and would noise up the cache-path hash inputs if logged.
    raw.trim_matches('"').to_string()
}

async fn collect_capped(mut body: ByteStream, cap: u64) -> Result<Bytes, AppError> {
    let mut buf = BytesMut::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(AppError::Io)?;
        if (buf.len() as u64).saturating_add(chunk.len() as u64) > cap {
            return Err(AppError::Unsupported(format!(
                "source exceeds thumbnails.max_source_bytes ({cap} bytes)"
            )));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf.freeze())
}

fn generate_webp(src: Bytes, width: u32, quality: u8, output: &Path) -> Result<(), AppError> {
    let img = image::load_from_memory(&src)
        .map_err(|e| AppError::Unsupported(format!("decode image: {e}")))?;

    // `thumbnail(w, w)` fits the source inside a width × width box preserving
    // aspect ratio. The grid tile uses `object-cover` so the result is
    // center-cropped client-side; we deliberately don't crop server-side to
    // keep the cache reusable at different aspect ratios later.
    let thumb = img.thumbnail(width, width);
    let rgb = thumb.to_rgb8();

    // libwebp's encoder takes f32 quality 0-100. We accept u8 in config and
    // upcast here so the validation already done in build() applies.
    let encoded =
        webp::Encoder::from_rgb(rgb.as_raw(), rgb.width(), rgb.height()).encode(quality as f32);

    let parent = output.parent().ok_or_else(|| {
        AppError::Backend(format!(
            "thumbnail output has no parent: {}",
            output.display()
        ))
    })?;
    std::fs::create_dir_all(parent).map_err(AppError::Io)?;

    // Atomic publish: write to tmp + rename. Without this, a partial write
    // visible to a sibling task would be served as a corrupt thumbnail.
    let tmp = output.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    ));

    if let Err(e) = std::fs::write(&tmp, &*encoded).map_err(AppError::Io) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    std::fs::rename(&tmp, output).map_err(AppError::Io)?;
    Ok(())
}

fn resolve_cache_root(configured: Option<&str>) -> anyhow::Result<PathBuf> {
    if let Some(s) = configured {
        return Ok(expand_tilde(s));
    }
    if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
        return Ok(PathBuf::from(xdg).join("omni-stream").join("thumbs"));
    }
    if let Some(dirs) = ProjectDirs::from("", "", "omni-stream") {
        return Ok(dirs.cache_dir().join("thumbs"));
    }
    // Last-ditch fallback: a relative dir in cwd. Operators running headless
    // with no HOME/XDG should set cache_path explicitly.
    Ok(PathBuf::from(".omni-stream-thumbs"))
}

/// CLI-side helper: resolve the cache path from a config value even when
/// thumbnails are disabled (so `cache clear` still works after toggling off).
pub fn resolve_cache_root_for(configured: Option<&str>) -> anyhow::Result<PathBuf> {
    resolve_cache_root(configured)
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SweepStats {
    pub files_deleted: u64,
    pub bytes_freed: u64,
    pub files_remaining: u64,
    pub bytes_remaining: u64,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct CacheInventory {
    pub files: u64,
    pub bytes: u64,
    pub oldest: Option<SystemTime>,
    pub newest: Option<SystemTime>,
}

/// Walk `root` collecting every `.webp` entry's stats. Missing dir → empty
/// inventory (not an error), so the CLI doesn't crash on a clean install.
pub fn inventory_cache(root: &Path) -> std::io::Result<CacheInventory> {
    let mut inv = CacheInventory::default();
    walk_files(root, &mut |_, meta| {
        inv.files += 1;
        inv.bytes += meta.len();
        if let Ok(mtime) = meta.modified() {
            inv.oldest = Some(match inv.oldest {
                Some(prev) if prev <= mtime => prev,
                _ => mtime,
            });
            inv.newest = Some(match inv.newest {
                Some(prev) if prev >= mtime => prev,
                _ => mtime,
            });
        }
    })?;
    Ok(inv)
}

/// One eviction pass. Two-phase: (1) hard-delete anything beyond `max_age`,
/// (2) if the surviving total still exceeds `max_bytes`, delete by mtime
/// ascending (oldest first) until under cap. Touch-on-hit refreshes mtime so
/// this approximates LRU without any sidecar database.
pub fn sweep_cache(root: &Path, max_bytes: u64, max_age: Duration) -> std::io::Result<SweepStats> {
    let now = SystemTime::now();
    let age_check = !max_age.is_zero();
    let mut stats = SweepStats::default();
    let mut survivors: Vec<(PathBuf, SystemTime, u64)> = Vec::new();

    walk_files(root, &mut |path, meta| {
        // Only act on .webp cache entries. Anything else (tmp files,
        // unrelated content) is left untouched.
        if path.extension().and_then(|e| e.to_str()) != Some("webp") {
            // Reap stale tmp files (matching `.tmp.*` suffix on the stem)
            // older than a day so crashes don't leave junk forever.
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.contains(".tmp."))
            {
                let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
                if now.duration_since(mtime).unwrap_or_default() > Duration::from_secs(86_400) {
                    let _ = std::fs::remove_file(path);
                }
            }
            return;
        }

        let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
        let size = meta.len();
        let age = now.duration_since(mtime).unwrap_or_default();

        if age_check && age > max_age {
            if std::fs::remove_file(path).is_ok() {
                stats.files_deleted += 1;
                stats.bytes_freed += size;
            }
            return;
        }
        survivors.push((path.to_path_buf(), mtime, size));
    })?;

    let mut total: u64 = survivors.iter().map(|(_, _, s)| s).sum();

    if total > max_bytes {
        survivors.sort_by_key(|(_, mtime, _)| *mtime);
        let mut idx = 0;
        while total > max_bytes && idx < survivors.len() {
            let (path, _, size) = &survivors[idx];
            if std::fs::remove_file(path).is_ok() {
                stats.files_deleted += 1;
                stats.bytes_freed += *size;
                total = total.saturating_sub(*size);
            }
            idx += 1;
        }
        stats.files_remaining = (survivors.len() - idx) as u64;
        stats.bytes_remaining = survivors[idx..].iter().map(|(_, _, s)| s).sum();
    } else {
        stats.files_remaining = survivors.len() as u64;
        stats.bytes_remaining = total;
    }

    Ok(stats)
}

fn walk_files<F: FnMut(&Path, &std::fs::Metadata)>(
    root: &Path,
    visit: &mut F,
) -> std::io::Result<()> {
    let dir = match std::fs::read_dir(root) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in dir {
        let entry = entry?;
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            walk_files(&path, visit)?;
        } else if meta.is_file() {
            visit(&path, &meta);
        }
    }
    Ok(())
}

async fn touch_on_hit(path: &Path) {
    // Refreshing mtime on cache hit lets the sweep treat mtime as access
    // time, approximating LRU. set_modified is a single inode metadata
    // write; we offload it to spawn_blocking so a stuck fs doesn't stall
    // the request loop. Errors are deliberately swallowed — failing to
    // touch only risks an extra regeneration later, not correctness.
    let path = path.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let f = std::fs::OpenOptions::new().write(true).open(&path)?;
        f.set_modified(SystemTime::now())
    })
    .await;
}

fn expand_tilde(s: &str) -> PathBuf {
    if let Some(rest) = s.strip_prefix('~') {
        if rest.is_empty() || rest.starts_with('/') {
            if let Some(home) = std::env::var_os("HOME") {
                let mut p = PathBuf::from(home);
                let trimmed = rest.strip_prefix('/').unwrap_or(rest);
                if !trimmed.is_empty() {
                    p.push(trimmed);
                }
                return p;
            }
        }
    }
    PathBuf::from(s)
}

fn sanitize_segment(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "_".into()
    } else {
        cleaned
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(sizes: Vec<u32>, default: u32) -> Arc<ThumbState> {
        ThumbState::build(&ThumbConfig {
            enabled: true,
            cache_path: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            sizes,
            default_size: default,
            ..ThumbConfig::default()
        })
        .expect("build")
        .expect("enabled")
    }

    /// Materialise a few `.webp` files at known ages/sizes for the sweep tests.
    fn seed_cache(root: &Path, files: &[(&str, u64, SystemTime)]) {
        for (name, size, mtime) in files {
            let p = root.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, vec![0u8; *size as usize]).unwrap();
            std::fs::File::open(&p)
                .unwrap()
                .set_modified(*mtime)
                .unwrap();
        }
    }

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omni-thumbs-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_width_uses_default_when_unspecified() {
        let s = state(vec![160, 320, 640], 320);
        assert_eq!(s.resolve_width(None), 320);
    }

    #[test]
    fn resolve_width_rounds_up_to_ladder() {
        let s = state(vec![160, 320, 640], 320);
        assert_eq!(s.resolve_width(Some(200)), 320);
        assert_eq!(s.resolve_width(Some(160)), 160);
        assert_eq!(s.resolve_width(Some(1)), 160);
    }

    #[test]
    fn resolve_width_clamps_above_max() {
        let s = state(vec![160, 320, 640], 320);
        assert_eq!(s.resolve_width(Some(4000)), 640);
    }

    #[test]
    fn cache_paths_differ_per_width_and_version() {
        let s = state(vec![160, 320], 160);
        let a = s.cache_path_for("local", "foo/bar.jpg", 160, "v1");
        let b = s.cache_path_for("local", "foo/bar.jpg", 320, "v1");
        let c = s.cache_path_for("local", "foo/bar.jpg", 160, "v2");
        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn storage_segment_is_sanitized() {
        let s = state(vec![160], 160);
        let p = s.cache_path_for("weird/name with spaces", "k", 160, "v");
        // The storage segment should not contain `/` or spaces — those would
        // make `rm -rf <root>/<storage>` ambiguous.
        let seg = p
            .strip_prefix(&s.cache_root)
            .unwrap()
            .components()
            .next()
            .unwrap()
            .as_os_str()
            .to_string_lossy()
            .into_owned();
        assert!(!seg.contains('/'));
        assert!(!seg.contains(' '));
    }

    #[test]
    fn default_size_snaps_into_ladder() {
        let s = state(vec![160, 320, 640], 250);
        // 250 is not in the ladder; build() should have snapped to 320.
        assert_eq!(s.resolve_width(None), 320);
    }

    #[test]
    fn sweep_deletes_oldest_until_under_cap() {
        let root = tempdir();
        let now = SystemTime::now();
        seed_cache(
            &root,
            &[
                ("a/x.webp", 400, now - Duration::from_secs(300)),
                ("a/y.webp", 400, now - Duration::from_secs(200)),
                ("a/z.webp", 400, now - Duration::from_secs(100)),
            ],
        );

        // Cap = 600 bytes; oldest (x = 400) gets deleted, leaving 800… still
        // over, so y goes too. z (newest) survives.
        let stats = sweep_cache(&root, 600, Duration::ZERO).unwrap();
        assert_eq!(stats.files_deleted, 2);
        assert_eq!(stats.bytes_freed, 800);
        assert_eq!(stats.files_remaining, 1);
        assert!(!root.join("a/x.webp").exists());
        assert!(!root.join("a/y.webp").exists());
        assert!(root.join("a/z.webp").exists());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sweep_drops_entries_past_max_age() {
        let root = tempdir();
        let now = SystemTime::now();
        seed_cache(
            &root,
            &[
                ("old.webp", 100, now - Duration::from_secs(86_400 * 100)),
                ("new.webp", 100, now - Duration::from_secs(60)),
            ],
        );

        let stats = sweep_cache(&root, u64::MAX, Duration::from_secs(86_400 * 30)).unwrap();
        assert_eq!(stats.files_deleted, 1);
        assert!(!root.join("old.webp").exists());
        assert!(root.join("new.webp").exists());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sweep_below_cap_is_noop() {
        let root = tempdir();
        let now = SystemTime::now();
        seed_cache(&root, &[("a.webp", 100, now), ("b.webp", 100, now)]);

        let stats = sweep_cache(&root, 10_000, Duration::ZERO).unwrap();
        assert_eq!(stats.files_deleted, 0);
        assert_eq!(stats.files_remaining, 2);
        assert_eq!(stats.bytes_remaining, 200);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sweep_ignores_non_webp_files() {
        let root = tempdir();
        let now = SystemTime::now();
        seed_cache(&root, &[("keep.txt", 9_999, now), ("evict.webp", 50, now)]);

        let stats = sweep_cache(&root, 0, Duration::ZERO).unwrap();
        // Only the .webp is counted toward the cap or deletable.
        assert_eq!(stats.files_deleted, 1);
        assert!(root.join("keep.txt").exists());
        assert!(!root.join("evict.webp").exists());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn inventory_reports_counts_and_range() {
        let root = tempdir();
        let now = SystemTime::now();
        let old = now - Duration::from_secs(7_200);
        seed_cache(&root, &[("a.webp", 100, old), ("b.webp", 250, now)]);

        let inv = inventory_cache(&root).unwrap();
        assert_eq!(inv.files, 2);
        assert_eq!(inv.bytes, 350);
        assert_eq!(inv.oldest, Some(old));
        assert_eq!(inv.newest, Some(now));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn inventory_on_missing_dir_is_empty_not_error() {
        let root = std::env::temp_dir().join("omni-thumbs-test-doesnotexist-xyz");
        let inv = inventory_cache(&root).unwrap();
        assert_eq!(inv.files, 0);
        assert_eq!(inv.bytes, 0);
    }
}
