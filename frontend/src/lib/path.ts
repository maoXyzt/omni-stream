/// Last path segment of a storage key — strips trailing slashes first so
/// directory keys (`foo/bar/`) return `bar` instead of an empty string.
/// Pure string op; works for both POSIX-style storage paths and S3 keys.
export function basenameOf(key: string): string {
  const stripped = key.replace(/\/+$/, '')
  const slash = stripped.lastIndexOf('/')
  return slash < 0 ? stripped : stripped.slice(slash + 1)
}

/// Encode a storage key for use in a path-wildcard API route
/// (`/api/proxy/{*key}`, `/api/files/{*key}`, …). Each segment is
/// percent-encoded individually so `/` separators stay literal (the backend
/// wildcard wants raw slashes) while spaces, `#`, `?`, non-ASCII, etc. inside
/// a segment are escaped. Trailing slashes are stripped first.
export function encodeKey(key: string): string {
  return key
    .replace(/\/+$/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
}

/// Absolute, human-pasteable location of an entry on its backing storage.
///   S3 (single bucket):    `s3://<bucket>/<key>`
///   S3 (multi-bucket):     `s3://<key>`  — first key segment IS the bucket
///   Local FS:              `<root_path>/<key>`
/// Trailing `/` on directory keys is preserved so it's obvious the path is
/// a folder. Returns `null` when the storage lacks the identifying fields
/// (invalid storages, or descriptor not yet loaded).
export function absolutePathOf(
  storage: { type: string; s3?: { bucket: string | null } | null; local?: { root_path: string } | null },
  key: string,
): string | null {
  if (storage.type === 's3' && storage.s3) {
    if (storage.s3.bucket !== null) {
      return `s3://${storage.s3.bucket}/${key}`
    }
    // Multi-bucket: the entry key already starts with `<bucket>/…`
    return `s3://${key}`
  }
  if (storage.type === 'local' && storage.local?.root_path) {
    const root = storage.local.root_path.replace(/\/+$/, '')
    return `${root}/${key}`
  }
  return null
}

/// Lowercase file extension of a storage key, without the leading dot.
/// Returns `null` for directory keys (trailing `/`), extension-less keys,
/// and keys whose final `.` is the last character (e.g. `Makefile`, `archive.tar.`).
export function extensionOf(key: string): string | null {
  if (key.endsWith('/')) return null
  const dot = key.lastIndexOf('.')
  if (dot < 0 || dot === key.length - 1) return null
  return key.slice(dot + 1).toLowerCase()
}
