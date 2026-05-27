/// Percent-encode each path segment for use in a React Router `pathname`,
/// keeping the `/` separators (and any trailing slash) literal. Without this,
/// a key containing `#`, `?`, or spaces breaks routing — `#` would start the
/// URL hash and truncate the path. React Router decodes `params['*']` on read,
/// so this round-trips back to the original value and is a no-op for the
/// alphanumeric segments that make up most keys.
export function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
