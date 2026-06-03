import type { ReactNode } from 'react'
import {
  Copy,
  Download,
  ExternalLink,
  FolderTree,
  Link as LinkIcon,
} from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useStorages } from '@/hooks/use-storage'
import { basenameOf } from '@/lib/path'
import type { FileEntry, StorageDescriptor } from '@/types/storage'

interface EntryContextMenuProps {
  entry: FileEntry
  storageName: string
  children: ReactNode
}

/// Right-click menu for any directory entry. Shared across grid tiles, list
/// rows, and the sidebar's folder list so users see the same actions
/// regardless of view. Folder entries get only the name/URL pair; files add
/// open-in-new-tab and download.
export function EntryContextMenu({
  entry,
  storageName,
  children,
}: EntryContextMenuProps) {
  const name = basenameOf(entry.key)
  // Cached forever (see useStorages) — cheap to read from any tile / row.
  const { data: storagesData } = useStorages()
  const storage = storagesData?.storages.find((s) => s.name === storageName)
  const absPath = storage ? absolutePathOf(storage, entry.key) : null

  function copyText(text: string) {
    void navigator.clipboard?.writeText(text)
  }

  function entryUrl(): string {
    // Folders → the route URL that takes the user into that directory in the
    // UI (shareable). Files → the proxy endpoint that streams the raw bytes
    // (useful for direct-preview / download links).
    if (entry.is_dir) {
      return `${window.location.origin}/s/${encodeURIComponent(
        storageName,
      )}/${entry.key}`
    }
    return (
      window.location.origin + proxyUrl(entry.key, storageName || undefined)
    )
  }

  function openInNewTab() {
    window.open(
      proxyUrl(entry.key, storageName || undefined),
      '_blank',
      'noreferrer',
    )
  }

  function downloadFile() {
    // The `download` attribute on a same-origin anchor triggers a download
    // dialog instead of rendering inline. The backend doesn't set
    // Content-Disposition so this client-side trick is the simplest cross-
    // browser approach.
    const link = document.createElement('a')
    link.href = proxyUrl(entry.key, storageName || undefined)
    link.download = name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => copyText(name)}>
          <Copy />
          Copy name
        </ContextMenuItem>
        {absPath && (
          <ContextMenuItem onClick={() => copyText(absPath)}>
            <FolderTree />
            Copy path
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => copyText(entryUrl())}>
          <LinkIcon />
          Copy URL
        </ContextMenuItem>
        {!entry.is_dir && (
          <>
            <ContextMenuItem onClick={openInNewTab}>
              <ExternalLink />
              Open in new tab
            </ContextMenuItem>
            <ContextMenuItem onClick={downloadFile}>
              <Download />
              Download
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}


/// Absolute, human-pasteable location of an entry on its backing storage.
///   S3 (single bucket):    `s3://<bucket>/<key>`
///   S3 (multi-bucket):     `s3://<key>`  — first key segment IS the bucket
///   Local FS:              `<root_path>/<key>`
/// Trailing `/` on directory keys is preserved so it's obvious the path is
/// a folder. Returns `null` when the storage lacks the identifying fields
/// (invalid storages, or descriptor not yet loaded).
function absolutePathOf(storage: StorageDescriptor, key: string): string | null {
  if (storage.type === 's3' && storage.s3) {
    if (storage.s3.bucket !== null) {
      return `s3://${storage.s3.bucket}/${key}`
    }
    // Multi-bucket: the entry key already starts with `<bucket>/…`, so the
    // bucket segment doesn't need to be re-attached.
    return `s3://${key}`
  }
  if (storage.type === 'local' && storage.local?.root_path) {
    const root = storage.local.root_path.replace(/\/+$/, '')
    return `${root}/${key}`
  }
  return null
}
