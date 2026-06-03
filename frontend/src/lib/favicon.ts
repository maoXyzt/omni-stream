import type { StorageDescriptor } from '@/types/storage'

/// Pick the favicon href for the active route. Mirrors `buildTitle`'s view of
/// the URL: anything that isn't a storage-scoped route falls back to the
/// brand favicon, as does an unknown storage name or the brief window before
/// `useStorages()` has resolved on first load.
const ROUTE_RE = /^\/[sr]\/([^/]+)(?:\/.*)?$/

export function buildFaviconHref(
  pathname: string,
  storages: StorageDescriptor[] | undefined,
): string {
  const m = pathname.match(ROUTE_RE)
  if (!m || !storages) return '/favicon.svg'
  const name = safeDecode(m[1])
  const s = storages.find((x) => x.name === name)
  if (!s) return '/favicon.svg'
  return s.type === 'local' ? '/favicon-local.svg' : '/favicon-s3.svg'
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
