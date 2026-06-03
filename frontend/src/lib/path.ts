/// Last path segment of a storage key — strips trailing slashes first so
/// directory keys (`foo/bar/`) return `bar` instead of an empty string.
/// Pure string op; works for both POSIX-style storage paths and S3 keys.
export function basenameOf(key: string): string {
  const stripped = key.replace(/\/+$/, '')
  const slash = stripped.lastIndexOf('/')
  return slash < 0 ? stripped : stripped.slice(slash + 1)
}
