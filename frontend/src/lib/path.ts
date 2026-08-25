/// Last path segment of a storage key — strips trailing slashes first so
/// directory keys (`foo/bar/`) return `bar` instead of an empty string.
/// Pure string op; works for both POSIX-style storage paths and S3 keys.
export function basenameOf(key: string): string {
  const stripped = key.replace(/\/+$/, '')
  const slash = stripped.lastIndexOf('/')
  return slash < 0 ? stripped : stripped.slice(slash + 1)
}

export interface InvisibleChar {
  index: number
  codePoint: number
  label: string
}

const INVISIBLE_NAMES: ReadonlyMap<number, string> = new Map([
  [0x00ad, 'SOFT HYPHEN'],
  [0x061c, 'ARABIC LETTER MARK'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'WORD JOINER'],
  [0x2061, 'FUNCTION APPLICATION'],
  [0x2062, 'INVISIBLE TIMES'],
  [0x2063, 'INVISIBLE SEPARATOR'],
  [0x2064, 'INVISIBLE PLUS'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE / BOM'],
])

function isHighRiskInvisible(codePoint: number): boolean {
  return (
    (codePoint >= 0x0000 && codePoint <= 0x001f) ||
    codePoint === 0x007f ||
    INVISIBLE_NAMES.has(codePoint)
  )
}

export function findInvisibleChars(value: string): InvisibleChar[] {
  const chars: InvisibleChar[] = []
  let index = 0
  for (const char of value) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && isHighRiskInvisible(codePoint)) {
      chars.push({
        index,
        codePoint,
        label: INVISIBLE_NAMES.get(codePoint) ?? 'CONTROL CHARACTER',
      })
    }
    index += char.length
  }
  return chars
}

export function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

export function describeInvisibleChars(value: string): string {
  const unique = new Map<number, InvisibleChar>()
  for (const char of findInvisibleChars(value)) unique.set(char.codePoint, char)
  return [...unique.values()]
    .map((char) => `${codePointLabel(char.codePoint)} ${char.label}`)
    .join(', ')
}

export function visualizeInvisibleChars(value: string): string {
  return [...value]
    .map((char) => {
      const codePoint = char.codePointAt(0)
      return codePoint !== undefined && isHighRiskInvisible(codePoint)
        ? `⟦${codePointLabel(codePoint)}⟧`
        : char
    })
    .join('')
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
