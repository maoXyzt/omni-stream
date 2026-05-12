/// Human-friendly byte size: "1.2 MB", "512 KB", etc. Uses 1024-base units to
/// match what most file managers display (vs. SI 1000-base).
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

/// Convert the storage backend's `last_modified` (HTTP-date from S3, or unix
/// seconds string from local FS) into the user's locale. Returns "—" for
/// missing values and the raw string for inputs we couldn't parse.
export function formatTime(value: string | null): string {
  if (!value) return '—'
  const asNumber = Number(value)
  const date =
    Number.isFinite(asNumber) && /^\d+$/.test(value)
      ? new Date(asNumber * 1000)
      : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}
