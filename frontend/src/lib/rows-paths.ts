// Path / URL resolver for path-bearing widgets (image / video / audio / link).
//
// Two responsibilities:
//   1. Render the `src` template — substitute `{value}` with the cell value's
//      string form, leave the rest of the template verbatim.
//   2. Classify the rendered string and produce something an `<img>` /
//      `<video>` / `<a>` can use:
//        * absolute http(s) URL  → returned as-is (CDN / external case)
//        * leading-`/` storage key → proxied via `proxyUrl`
//        * everything else        → resolved relative to the source data
//          file's directory (`..` walks up, escape past root rejected),
//          then proxied
//
// Pure logic outside of the proxy URL builder; testable without React.

import { proxyUrl } from '@/api/storage'

export type SrcResolution =
  | { ok: true; url: string }
  | { ok: false; reason: string }

/// Resolve a widget's `src` template + cell value into a final URL.
///
/// `template` is the widget's `src` field (defaulting to `"{value}"` upstream
/// when the user didn't set one). When the template contains the literal
/// `{value}`, the cell's value is substituted in. Otherwise the template is
/// taken verbatim — useful for "all rows show this static URL" cases.
export function resolveSrc(
  template: string,
  value: unknown,
  fileKey: string,
  storage: string | undefined,
): SrcResolution {
  if (template.length === 0) {
    // Defensive: schema rejects empty src, but keep a clear runtime message.
    return { ok: false, reason: 'empty src' }
  }
  const needsValue = template.includes('{value}')

  let rendered: string
  if (needsValue) {
    const asStr = cellValueToPath(value)
    if (asStr === null) {
      return { ok: false, reason: 'no usable path in value' }
    }
    rendered = template.split('{value}').join(asStr)
  } else {
    rendered = template
  }

  if (rendered.length === 0) {
    return { ok: false, reason: 'rendered src is empty' }
  }

  // External http(s) URL → use as-is. Lets the CDN-template case work
  // without dragging the storage proxy in.
  if (/^https?:\/\//i.test(rendered)) {
    return { ok: true, url: rendered }
  }

  if (rendered.startsWith('/')) {
    // Absolute from storage root — strip the leading slash and proxy.
    const key = rendered.slice(1)
    if (key.length === 0) {
      return { ok: false, reason: 'path resolves to storage root with no file' }
    }
    return { ok: true, url: proxyUrl(key, storage) }
  }

  // Relative — anchor at the source file's directory.
  const resolved = resolveStorageKey(fileKey, rendered)
  if (!resolved.ok) return resolved
  return { ok: true, url: proxyUrl(resolved.key, storage) }
}

/// Pull a usable path string out of a cell value. Most parquet image columns
/// are plain strings, but some pipelines wrap them as `{path: ...}` / `{uri:
/// ...}` / `{url: ...}` / `{src: ...}` structs — try those before giving up.
export function cellValueToPath(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number' || typeof value === 'boolean') return null
  if (typeof value === 'bigint') return null
  if (value instanceof Date) return null
  if (value instanceof Uint8Array) return null
  if (Array.isArray(value)) return null
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    for (const key of ['path', 'uri', 'url', 'src']) {
      const candidate = v[key]
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
  }
  return null
}

type KeyResolution =
  | { ok: true; key: string }
  | { ok: false; reason: string }

/// Resolve a relative storage path against the source file's directory.
///
/// Rules:
///   * `.` segments are dropped, `..` pops a directory off the stack
///   * Popping past the storage root is rejected — we never want a rendered
///     config to coerce the proxy into reading paths outside the storage's
///     wildcard scope. The backend would refuse anyway, but failing early
///     gives the renderer a meaningful inline error instead of an opaque
///     404 from the proxy.
export function resolveStorageKey(
  sourceFileKey: string,
  relative: string,
): KeyResolution {
  if (relative.length === 0) {
    return { ok: false, reason: 'empty path' }
  }
  // Parent directory of the source file: drop the last slash-segment.
  const parts = sourceFileKey.split('/').filter((s) => s.length > 0)
  parts.pop()
  const stack = parts
  for (const seg of relative.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) {
        return { ok: false, reason: 'path escapes storage root' }
      }
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  if (stack.length === 0) {
    return { ok: false, reason: 'path resolves to storage root with no file' }
  }
  return { ok: true, key: stack.join('/') }
}
