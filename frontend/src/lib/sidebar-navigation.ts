import { basenameOf } from '@/lib/path'
import type { StorageEntryRef } from '@/types/storage'

export function getSidebarEntryPresentation(
  entry: StorageEntryRef,
  storageName: string,
  prefix: string,
) {
  const sameFolder =
    entry.storage === storageName && entry.type === 'folder'

  return {
    label: basenameOf(entry.key) || entry.storage,
    location: `${entry.storage} · ${entry.key || '/'}`,
    isActive:
      sameFolder && (prefix === entry.key || prefix.startsWith(entry.key)),
    isCurrent: sameFolder && prefix === entry.key,
  }
}
