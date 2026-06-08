// Thumbnail strategy — which extensions and sizes are worth routing through
// the backend thumbnail pipeline. API contract (URL builders) lives in
// `api/storage.ts`; this module owns the front-end decision logic only.

// Formats the backend thumbnail pipeline either can't decode or wouldn't
// benefit from shrinking. SVG is its own thumbnail; ICO/AVIF would 415.
export const THUMB_SKIP_EXTS = new Set(['svg', 'ico', 'avif'])

// Grid tiles (320 px webp ~10–15 KB): serving the original is cheaper when
// the original is smaller than the thumbnail would be.
export const GRID_THUMB_MIN_BYTES = 64 * 1024

// Full-screen preview (640 px webp): the thumbnail doesn't replace the
// original — it's purely a fast placeholder while the real image loads. Only
// worth inserting when the original is large enough that the browser would
// visibly stall without it.
export const PREVIEW_THUMB_MIN_BYTES = 512 * 1024

/// Returns true when the file extension is one the backend thumbnail pipeline
/// can handle. Pass `null` (from `extensionOf`) for extension-less keys —
/// those are not in the skip list, so we optimistically try the thumbnail
/// and let the server decide (the fallback-to-proxy path handles any 404/415).
/// This matches the original FileTile `(!ext || !THUMB_SKIP_EXTS.has(ext))`
/// semantics, preserving zero behavioral change after the refactor.
export function canThumbnail(ext: string | null): boolean {
  if (ext === null) return true
  return !THUMB_SKIP_EXTS.has(ext)
}
