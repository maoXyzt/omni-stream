import type { StorageEntryRef } from '@/types/storage'

/// Percent-encode each path segment for use in a React Router `pathname`,
/// keeping the `/` separators (and any trailing slash) literal. Without this,
/// a key containing `#`, `?`, or spaces breaks routing — `#` would start the
/// URL hash and truncate the path. React Router decodes `params['*']` on read,
/// so this round-trips back to the original value and is a no-op for the
/// alphanumeric segments that make up most keys.
export function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function getSidebarEntryRoute(
  entry: StorageEntryRef,
  view?: string,
): { pathname: string; search: string; cleanKey: string } {
  const { storage, key, type } = entry
  const cleanKey = key.replace(/^\/+/, '')
  const params = new URLSearchParams()
  if (view) params.set('view', view)

  let prefix = cleanKey
  if (type === 'folder') {
    if (prefix && !prefix.endsWith('/')) prefix += '/'
  } else {
    const slash = cleanKey.lastIndexOf('/')
    prefix = slash >= 0 ? cleanKey.slice(0, slash + 1) : ''
    params.set('preview', slash >= 0 ? cleanKey.slice(slash + 1) : cleanKey)
  }

  return {
    pathname: `/s/${encodeURIComponent(storage)}/${encodePathSegments(prefix)}`,
    search: params.size > 0 ? `?${params.toString()}` : '',
    cleanKey,
  }
}
