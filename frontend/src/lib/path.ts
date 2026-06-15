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

/// Lowercase file extension of a storage key, without the leading dot.
/// Returns `null` for directory keys (trailing `/`), extension-less keys,
/// and keys whose final `.` is the last character (e.g. `Makefile`, `archive.tar.`).
export function extensionOf(key: string): string | null {
  if (key.endsWith('/')) return null
  const dot = key.lastIndexOf('.')
  if (dot < 0 || dot === key.length - 1) return null
  return key.slice(dot + 1).toLowerCase()
}
