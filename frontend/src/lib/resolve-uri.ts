import type { StorageDescriptor } from '@/types/storage'

export type ResolvedUri =
  | { ok: true; path: string }
  | { ok: false; reason: string }

// S3 URI schemes we accept. `s3a` / `s3n` are the Hadoop/EMR variants of
// `s3://` that users routinely copy out of Spark configs and pipeline logs.
const S3_SCHEMES = new Set(['s3', 's3a', 's3n'])

// `scheme://rest` — scheme per RFC 3986 (letter, then letters/digits/+-.).
// Requires the `//` authority marker, so only the canonical `s3://bucket/key`
// form is treated as a URI. The non-standard single-colon `s3:bucket/key`
// shorthand (seen in a few boto contexts) falls through as a relative path.
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/

/**
 * Returns true when `input` begins with a `scheme://` authority prefix.
 * Used by the RowsView src resolver to decide whether to route a rendered
 * src template through `resolveStorageUri` rather than the relative-path
 * or leading-`/` branches. Exported so callers share the same regex
 * rather than duplicating the pattern.
 */
export function hasUriScheme(input: string): boolean {
  return SCHEME_RE.test(input.trim())
}

/**
 * Resolves a pasted "Go to path" value into a path relative to the *current*
 * storage root.
 *
 * - Input without a `scheme://` is already relative — returned unchanged.
 * - A full `s3://bucket/key` URI is matched against the active storage and
 *   rewritten to a relative path: for a single-bucket storage the bucket must
 *   equal the pinned bucket and the key is the relative path; for a
 *   multi-bucket storage the bucket is just the first path segment, so it maps
 *   to `<bucket>/<key>`.
 * - A URI that doesn't belong to this storage (wrong scheme, wrong bucket,
 *   non-S3 storage) is rejected with a human-readable `reason` so the caller
 *   can surface it instead of issuing a request that would 404.
 *
 * Resolution is scoped to the current storage only — cross-storage matching
 * is intentionally out of scope.
 */
// Maps an absolute local path to a key relative to `rootPath`. Mirrors the
// inverse operation in `absolutePathOf` (EntryContextMenu). Paths outside the
// root are rejected like a mismatched S3 bucket.
function resolveLocalAbsolute(input: string, rootPath: string): ResolvedUri {
  const root = rootPath.replace(/\/+$/, '')
  if (input === root || input === `${root}/`) {
    return { ok: true, path: '' }
  }
  if (input.startsWith(`${root}/`)) {
    return { ok: true, path: input.slice(root.length + 1) }
  }
  return {
    ok: false,
    reason: `That path is outside this storage's root "${rootPath}".`,
  }
}

export function resolveStorageUri(
  input: string,
  storage: StorageDescriptor | undefined,
): ResolvedUri {
  const trimmed = input.trim()
  const m = SCHEME_RE.exec(trimmed)
  if (!m) {
    // Local storage + absolute input: strip the root prefix so the caller
    // gets a root-relative key (same convention as S3 bucket stripping).
    if (
      storage?.type === 'local' &&
      storage.local?.root_path?.startsWith('/') &&
      trimmed.startsWith('/')
    ) {
      return resolveLocalAbsolute(trimmed, storage.local.root_path)
    }
    // Not a full URI — treat as already relative to the current storage.
    return { ok: true, path: trimmed }
  }

  const scheme = m[1].toLowerCase()
  const remainder = m[2]

  if (!S3_SCHEMES.has(scheme)) {
    return {
      ok: false,
      reason: `Unsupported URI scheme "${scheme}://". Paste an s3:// URI or a path relative to the storage root.`,
    }
  }

  // s3://bucket/key… — the first segment is the bucket, the rest is the key.
  const slash = remainder.indexOf('/')
  const bucket = slash < 0 ? remainder : remainder.slice(0, slash)
  const key = slash < 0 ? '' : remainder.slice(slash + 1)

  if (!bucket) {
    return { ok: false, reason: 'That s3:// URI is missing a bucket name.' }
  }
  if (!storage || storage.type !== 's3') {
    return {
      ok: false,
      reason:
        'The current storage is not S3, so an s3:// path cannot be resolved here.',
    }
  }
  // Multi-bucket storage (`s3.bucket === null`): the bucket is the first path
  // segment, so any bucket belongs to this storage and maps to `<bucket>/<key>`.
  if (storage.s3?.bucket == null) {
    return { ok: true, path: key ? `${bucket}/${key}` : `${bucket}/` }
  }
  // Single-bucket storage: the URI's bucket must match the pinned one; the key
  // is already relative to the storage root. Compared case-insensitively (S3
  // bucket names are lowercase by spec, and we match the scheme that way too),
  // so a stray uppercase paste still resolves.
  if (bucket.toLowerCase() !== storage.s3.bucket.toLowerCase()) {
    return {
      ok: false,
      reason: `That path is in bucket "${bucket}", but this storage is bucket "${storage.s3.bucket}".`,
    }
  }
  return { ok: true, path: key }
}
