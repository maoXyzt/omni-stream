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

/// Format an integer returned as a decimal string without passing it through
/// JavaScript's 53-bit Number range.
export function formatDecimalInteger(value: string): string {
  try {
    return BigInt(value).toLocaleString()
  } catch {
    return value
  }
}

/// Format a decimal byte count using binary units while retaining exact
/// integer arithmetic for large model files.
export function formatDecimalBytes(value: string): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  try {
    let scaled = BigInt(value) * 10n
    let unit = 0
    while (scaled >= 10240n && unit < units.length - 1) {
      scaled = (scaled + 512n) / 1024n
      unit += 1
    }
    const whole = scaled / 10n
    const fraction = scaled % 10n
    return `${whole}${fraction === 0n ? '' : `.${fraction}`} ${units[unit]}`
  } catch {
    return `${value} B`
  }
}

/// Compact a slash-separated path for a header label: shows the last two
/// segments prefixed with `…/` once it would otherwise be longer than
/// that. Callers should still hand the full path to the surrounding
/// `title` attribute so hover reveals it intact.
export function shortenPath(path: string): string {
  const segs = path.split('/').filter((s) => s.length > 0)
  if (segs.length <= 2) return path
  return '…/' + segs.slice(-2).join('/')
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
